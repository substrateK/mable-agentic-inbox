// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Attachment, Address, Email as ParsedEmail } from "postal-mime";
import { sendEmail, type SendEmailParams } from "../email-sender";
import type { Env } from "../types";

const FORWARDED_HEADER = "X-Mable-Agentic-Inbox-Forwarded";
const ORIGINAL_RECIPIENT_HEADER = "X-Original-Recipient";
const ORIGINAL_SENDER_HEADER = "X-Original-Sender";
const FORWARD_MARKER_PREFIX = "email-forward-markers";
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
// Cloudflare Email Service has a 5 MiB send limit; keep margin for headers and MIME encoding.
const SEND_EMAIL_SOFT_LIMIT_BYTES = 4 * 1024 * 1024;

type ForwardResult = "forwarded" | "skipped";

function splitConfigList(value: string | string[] | undefined): string[] {
	if (!value) return [];
	if (Array.isArray(value)) return value;
	return value.split(",");
}

function normalizeEmail(email: string) {
	return email.trim().toLowerCase();
}

function getEmailDomain(email: string) {
	const at = email.lastIndexOf("@");
	return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

function normalizeDomain(domain: string) {
	return domain.trim().replace(/^@/, "").toLowerCase();
}

export function parseForwardToEmails(raw: string | undefined): string[] {
	const seen = new Set<string>();
	const emails: string[] = [];

	for (const entry of splitConfigList(raw)) {
		const email = normalizeEmail(entry);
		if (!email) continue;
		if (!EMAIL_RE.test(email)) {
			throw new Error(`Invalid FORWARD_TO_EMAILS address: ${entry}`);
		}
		if (!seen.has(email)) {
			seen.add(email);
			emails.push(email);
		}
	}

	return emails;
}

function getConfiguredDomains(env: Env) {
	return new Set(
		splitConfigList(env.DOMAINS)
			.map(normalizeDomain)
			.filter(Boolean),
	);
}

function getConfiguredInboundAddresses(env: Env) {
	return new Set(
		splitConfigList(env.EMAIL_ADDRESSES as string[] | string | undefined)
			.map(normalizeEmail)
			.filter(Boolean),
	);
}

function assertNoForwardingLoops(message: ForwardableEmailMessage, env: Env, destinations: string[]) {
	const inboundAddress = normalizeEmail(message.to);
	const configuredDomains = getConfiguredDomains(env);
	const configuredInboundAddresses = getConfiguredInboundAddresses(env);

	for (const destination of destinations) {
		const destinationDomain = getEmailDomain(destination);
		if (destination === inboundAddress || configuredInboundAddresses.has(destination)) {
			throw new Error(
				`FORWARD_TO_EMAILS destination ${destination} matches an inbound mailbox address and would likely loop.`,
			);
		}
		if (configuredDomains.has(destinationDomain)) {
			throw new Error(
				`FORWARD_TO_EMAILS destination ${destination} is on a routed domain and would likely loop.`,
			);
		}
	}
}

function getMailboxAddress(address: Address | undefined) {
	return address && "address" in address ? address.address : undefined;
}

function escapeHtml(value: string) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function htmlToText(html: string) {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

function truncateSubject(value: string) {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function forwardedSubject(message: ForwardableEmailMessage, parsedEmail: ParsedEmail) {
	const originalSender = getMailboxAddress(parsedEmail.from) || message.from || "unknown sender";
	const originalSubject = parsedEmail.subject?.trim() || "(no subject)";
	return truncateSubject(`Fwd from ${originalSender} to ${message.to}: ${originalSubject}`);
}

function attachmentSize(attachment: Attachment) {
	if (typeof attachment.content === "string") {
		if (attachment.encoding === "base64") return Math.ceil((attachment.content.length * 3) / 4);
		return new TextEncoder().encode(attachment.content).byteLength;
	}
	return attachment.content.byteLength;
}

function bytesToBase64(bytes: Uint8Array) {
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		const chunk = bytes.subarray(offset, offset + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

function attachmentToSendAttachment(attachment: Attachment): NonNullable<SendEmailParams["attachments"]>[number] {
	const content = typeof attachment.content === "string" && attachment.encoding === "base64"
		? attachment.content
		: bytesToBase64(
			typeof attachment.content === "string"
				? new TextEncoder().encode(attachment.content)
				: new Uint8Array(attachment.content),
		);

	return {
		content,
		filename: attachment.filename || "attachment",
		type: attachment.mimeType,
		disposition: attachment.disposition === "inline" ? "inline" : "attachment",
		...(attachment.contentId ? { contentId: attachment.contentId } : {}),
	};
}

function estimateBase64Size(attachment: Attachment) {
	return Math.ceil(attachmentSize(attachment) / 3) * 4;
}

function attachmentsForForward(
	parsedEmail: ParsedEmail,
	html: string,
	text: string,
): SendEmailParams["attachments"] | undefined {
	const attachments = parsedEmail.attachments || [];
	if (attachments.length === 0) return undefined;

	const estimatedSize =
		new TextEncoder().encode(html).byteLength +
		new TextEncoder().encode(text).byteLength +
		attachments.reduce((total, attachment) => total + estimateBase64Size(attachment), 0);

	if (estimatedSize > SEND_EMAIL_SOFT_LIMIT_BYTES) {
		return undefined;
	}

	return attachments.map(attachmentToSendAttachment);
}

function buildForwardContent(parsedEmail: ParsedEmail) {
	const text = parsedEmail.text || (parsedEmail.html ? htmlToText(parsedEmail.html) : "") || "(No text body)";
	const html =
		parsedEmail.html ||
		`<pre style="white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;">${escapeHtml(text)}</pre>`;

	return {
		html,
		text,
		attachments: attachmentsForForward(parsedEmail, html, text),
	};
}

function forwardHeaders(message: ForwardableEmailMessage, parsedEmail: ParsedEmail): Record<string, string> {
	const headers: Record<string, string> = {
		[FORWARDED_HEADER]: "1",
		[ORIGINAL_RECIPIENT_HEADER]: message.to,
	};
	const originalSender = getMailboxAddress(parsedEmail.from) || message.from;
	if (originalSender) headers[ORIGINAL_SENDER_HEADER] = originalSender;
	return headers;
}

async function sha256(value: string) {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function forwardMarkerKey(message: ForwardableEmailMessage, destination: string) {
	const messageIdentity = [
		message.headers.get("message-id") || "",
		message.headers.get("date") || "",
		message.headers.get("subject") || "",
		message.from,
		message.to,
		String(message.rawSize),
	].join("\0");
	const messageHash = await sha256(messageIdentity);
	const destinationHash = await sha256(destination);

	return `${FORWARD_MARKER_PREFIX}/${messageHash.slice(0, 2)}/${messageHash}/${destinationHash}.json`;
}

async function markForwarded(
	bucket: R2Bucket,
	key: string,
	message: ForwardableEmailMessage,
	destination: string,
) {
	await bucket.put(
		key,
		JSON.stringify({
			destination,
			from: message.from,
			to: message.to,
			messageId: message.headers.get("message-id"),
			forwardedAt: new Date().toISOString(),
		}),
		{
			httpMetadata: {
				contentType: "application/json",
			},
		},
	);
}

async function forwardOnce(
	message: ForwardableEmailMessage,
	env: Env,
	destination: string,
	parsedEmail: ParsedEmail,
): Promise<ForwardResult> {
	const markerKey = await forwardMarkerKey(message, destination);
	const existingMarker = await env.BUCKET.head(markerKey);

	if (existingMarker) {
		console.log(`Skipping duplicate forward of ${message.to} to ${destination}`);
		return "skipped";
	}

	const originalSender = getMailboxAddress(parsedEmail.from) || message.from;
	const content = buildForwardContent(parsedEmail);
	await sendEmail(env.EMAIL, {
		to: destination,
		from: { email: message.to, name: "Mable Forwarder" },
		subject: forwardedSubject(message, parsedEmail),
		html: content.html,
		text: content.text,
		replyTo: originalSender && EMAIL_RE.test(originalSender) ? originalSender : undefined,
		attachments: content.attachments,
		headers: forwardHeaders(message, parsedEmail),
	});
	await markForwarded(env.BUCKET, markerKey, message, destination);

	return "forwarded";
}

export async function forwardConfiguredEmail(
	message: ForwardableEmailMessage,
	env: Env,
	parsedEmail: ParsedEmail,
) {
	const destinations = parseForwardToEmails(env.FORWARD_TO_EMAILS);

	if (destinations.length === 0) return;

	assertNoForwardingLoops(message, env, destinations);

	const results = await Promise.allSettled(
		destinations.map((destination) => forwardOnce(message, env, destination, parsedEmail)),
	);
	const failures = results
		.map((result, index) => ({ result, destination: destinations[index] }))
		.filter(
			(entry): entry is { result: PromiseRejectedResult; destination: string } =>
				entry.result.status === "rejected",
		);

	if (failures.length > 0) {
		for (const failure of failures) {
			console.error(`Forwarding to ${failure.destination} failed:`, failure.result.reason);
		}

		throw new AggregateError(
			failures.map((failure) => failure.result.reason),
			`Failed to forward email to ${failures.length} destination(s).`,
		);
	}
}
