// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Env } from "../types";

const FORWARDED_HEADER = "X-Mable-Agentic-Inbox-Forwarded";
const ORIGINAL_RECIPIENT_HEADER = "X-Original-Recipient";
const FORWARD_MARKER_PREFIX = "email-forward-markers";
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

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

function forwardHeaders(message: ForwardableEmailMessage) {
	const headers = new Headers();
	headers.set(FORWARDED_HEADER, "1");
	headers.set(ORIGINAL_RECIPIENT_HEADER, message.to);
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
): Promise<ForwardResult> {
	const markerKey = await forwardMarkerKey(message, destination);
	const existingMarker = await env.BUCKET.head(markerKey);

	if (existingMarker) {
		console.log(`Skipping duplicate forward of ${message.to} to ${destination}`);
		return "skipped";
	}

	await message.forward(destination, forwardHeaders(message));
	await markForwarded(env.BUCKET, markerKey, message, destination);

	return "forwarded";
}

export async function forwardConfiguredEmail(message: ForwardableEmailMessage, env: Env) {
	const destinations = parseForwardToEmails(env.FORWARD_TO_EMAILS);

	if (destinations.length === 0) return;

	assertNoForwardingLoops(message, env, destinations);

	const results = await Promise.allSettled(
		destinations.map((destination) => forwardOnce(message, env, destination)),
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
