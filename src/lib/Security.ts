import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";

// Side-effect free on purpose: Logger, Config, DownloadClient and the tests all
// import this module.

export const REDACTED = "[REDACTED]";

/** Object keys whose values never reach a log line. */
const SENSITIVE_KEY = /pass(word)?|token|secret|authorization|cookie|username/i;

/** Query parameters that carry signatures or credentials (signed CDN URLs). */
const SENSITIVE_QUERY_PARAM =
	/sig|signature|token|key|policy|credential|auth|password/i;

const secrets = new Set<string>();

/**
 * Remember a credential so it is scrubbed from every log line, wherever it
 * appears — positional method args, request bodies, URLs.
 */
export function registerSecret(value: unknown): void {
	// Very short values would mangle unrelated log text.
	if (typeof value !== "string" || value.length < 4) return;
	secrets.add(value);
	// Also catch the value inside a JSON-encoded string (e.g. a request body).
	const escaped = JSON.stringify(value).slice(1, -1);
	if (escaped !== value) secrets.add(escaped);
}

/** Forget all registered secrets (tests only; the registry is process-wide). */
export function forgetSecrets(): void {
	secrets.clear();
}

/** Replace registered secrets, bearer tokens and signed URL parameters. */
export function scrubString(text: string): string {
	let out = text;
	for (const secret of secrets) out = out.split(secret).join(REDACTED);
	out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`);
	out = out.replace(
		/([?&])([^=&\s"'#]+)=([^&\s"'#]*)/g,
		(match, sep: string, name: string) =>
			SENSITIVE_QUERY_PARAM.test(name)
				? `${sep}${name}=${REDACTED}`
				: match
	);
	return out;
}

/** Deep-copy a log payload with credentials removed. */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof value === "string") return scrubString(value);
	if (value === null || typeof value !== "object") return value;
	if (value instanceof ArrayBuffer) return `[${value.byteLength} bytes]`;
	if (ArrayBuffer.isView(value)) return `[${value.byteLength} bytes]`;
	if (seen.has(value)) return "[Circular]";
	seen.add(value);

	if (value instanceof Error) {
		return {
			name: value.name,
			message: scrubString(value.message),
			...(value.stack ? { stack: scrubString(value.stack) } : {}),
		};
	}
	if (Array.isArray(value)) return value.map((item) => redact(item, seen));

	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		out[key] =
			SENSITIVE_KEY.test(key) && item !== undefined && item !== null
				? REDACTED
				: redact(item, seen);
	}
	return out;
}

/** True only for https URLs on libro.fm itself or one of its subdomains. */
export function isLibroFmUrl(url: string): boolean {
	try {
		const { protocol, hostname } = new URL(url);
		return (
			protocol === "https:" &&
			(hostname === "libro.fm" || hostname.endsWith(".libro.fm"))
		);
	} catch {
		return false;
	}
}

/** True when `child` resolves to `parent` or somewhere inside it. */
export function isWithin(parent: string, child: string): boolean {
	const rel = path.relative(path.resolve(parent), path.resolve(child));
	return (
		rel === "" ||
		(rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
	);
}

/**
 * Make an API-supplied name (author, series, title) safe to use as a single
 * path segment: no separators, control characters, or `.`/`..`. Characters
 * Windows forbids (`: * ? " < > |`) and trailing dots or spaces are dropped
 * too: an SMB share (a NAS) shows such a name as a mangled 8.3 name like
 * `C6UOFL~2`. "Title: Subtitle" becomes "Title - Subtitle".
 */
export function safePathSegment(name: string): string {
	const cleaned = name
		.replace(/[/\\\x00-\x1f]/g, "-")
		.replace(/\s*:\s*/g, " - ")
		.replace(/"/g, "'")
		.replace(/[*?<>|]/g, "")
		.replace(/\s+/g, " ")
		.replace(/[. ]+$/, "")
		.trim();
	return cleaned === "" ? "_" : cleaned;
}

/** Hidden temp file next to `file`, for writing it and renaming it over. */
export function tempPathFor(file: string): string {
	const suffix = randomBytes(6).toString("hex");
	return path.join(
		path.dirname(file),
		`.${path.basename(file)}.${suffix}.tmp`
	);
}

/**
 * chmod `target`, unless the file system refuses (EPERM): a mount the app
 * doesn't own, such as a NAS dataset that grants the app's group access, or
 * a ZFS dataset whose ACL forbids chmod (TrueNAS's SMB preset). The ACL its
 * owner set then decides who can read it. Returns whether the mode was set.
 */
export function chmodIfPermitted(target: string, mode: number): boolean {
	try {
		fs.chmodSync(target, mode);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
		throw error;
	}
}

/**
 * Write `data` to a temp file next to `file`, then rename it over `file`. The
 * old file stays intact until the new one is complete, so a crash mid-write
 * can't leave a truncated config or state file behind.
 */
export function writeFileAtomic(
	file: string,
	data: string | Uint8Array,
	mode?: number
): void {
	const tmp = tempPathFor(file);
	try {
		fs.writeFileSync(tmp, data, mode === undefined ? {} : { mode });
		// `mode` on write only applies when the file is created, and is
		// subject to the umask; set it outright.
		if (mode !== undefined) chmodIfPermitted(tmp, mode);
		fs.renameSync(tmp, file);
	} catch (error) {
		fs.rmSync(tmp, { force: true });
		throw error;
	}
}

/** Write a file readable only by the current user, replacing it in one step. */
export function writePrivateFile(file: string, data: string): void {
	writeFileAtomic(file, data, 0o600);
}

/**
 * Parse a JSON file that must hold an object, with an error that names the
 * file: a corrupt config or state file is a problem the user has to fix, not
 * a stack trace from JSON.parse.
 */
export function readJsonObject(file: string): Record<string, unknown> {
	const text = fs.readFileSync(file, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(
			`${file} is not valid JSON (${(error as Error).message}). Fix it, or move it aside to start afresh.`,
			{ cause: error }
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${file} must hold a JSON object. Fix it, or move it aside to start afresh.`);
	}
	return parsed as Record<string, unknown>;
}
