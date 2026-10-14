import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import {
	REDACTED,
	chmodIfPermitted,
	forgetSecrets,
	isLibroFmUrl,
	isWithin,
	readJsonObject,
	redact,
	registerSecret,
	safePathSegment,
	scrubString,
	writeFileAtomic,
	writePrivateFile,
} from "../lib/Security";

describe("Security", () => {
	beforeEach(() => forgetSecrets());

	describe("scrubString", () => {
		test("removes registered secrets wherever they appear", () => {
			registerSecret("hunter2-secret");
			const out = scrubString('args: ["me@example.com", "hunter2-secret"]');
			expect(out).not.toContain("hunter2-secret");
			expect(out).toContain(REDACTED);
		});

		test("removes a registered secret inside a JSON-encoded body", () => {
			registerSecret('pa"ss\\word');
			const body = JSON.stringify({ password: 'pa"ss\\word' });
			expect(scrubString(body)).not.toContain('pa\\"ss\\\\word');
		});

		test("ignores very short values", () => {
			registerSecret("abc");
			expect(scrubString("abc page")).toBe("abc page");
		});

		test("redacts bearer tokens", () => {
			expect(scrubString("Authorization: Bearer abc.DEF-123_xyz")).toBe(
				`Authorization: Bearer ${REDACTED}`
			);
		});

		test("redacts signature params in URLs but keeps harmless ones", () => {
			const url =
				"https://cdn.example.com/p1.zip?Expires=1&Signature=s1g&Key-Pair-Id=K9&isbn=978";
			const out = scrubString(url);
			expect(out).not.toContain("s1g");
			expect(out).not.toContain("K9");
			expect(out).toContain("Expires=1");
			expect(out).toContain("isbn=978");
		});

		test("keeps API paging params", () => {
			const url = "https://libro.fm/api/v12/library?page=2";
			expect(scrubString(url)).toBe(url);
		});
	});

	describe("redact", () => {
		test("redacts sensitive keys at any depth", () => {
			const out = redact({
				args: [
					{ username: "me@example.com", password: "pw-value-1" },
					{ headers: { Authorization: "Bearer t", "User-Agent": "ok" } },
				],
				authToken: "tok-value-1",
				title: "A Book",
			}) as any;
			expect(out.args[0].username).toBe(REDACTED);
			expect(out.args[0].password).toBe(REDACTED);
			expect(out.args[1].headers.Authorization).toBe(REDACTED);
			expect(out.args[1].headers["User-Agent"]).toBe("ok");
			expect(out.authToken).toBe(REDACTED);
			expect(out.title).toBe("A Book");
		});

		test("does not mutate the input", () => {
			const input = { password: "pw-value-2" };
			redact(input);
			expect(input.password).toBe("pw-value-2");
		});

		test("leaves undefined sensitive keys alone", () => {
			const out = redact({ authToken: undefined }) as any;
			expect(out.authToken).toBeUndefined();
		});

		test("summarizes binary buffers instead of dumping them", () => {
			expect(redact(new ArrayBuffer(16))).toBe("[16 bytes]");
			expect(redact(new Uint8Array(8))).toBe("[8 bytes]");
		});

		test("handles circular references", () => {
			const a: any = { name: "a" };
			a.self = a;
			expect((redact(a) as any).self).toBe("[Circular]");
		});

		test("keeps error messages, scrubbed", () => {
			registerSecret("err-secret-value");
			const out = redact(new Error("failed with err-secret-value")) as any;
			expect(out.message).toBe(`failed with ${REDACTED}`);
		});
	});

	describe("isLibroFmUrl", () => {
		test("accepts libro.fm and its subdomains over https", () => {
			expect(isLibroFmUrl("https://libro.fm/api/v12/library")).toBe(true);
			expect(isLibroFmUrl("https://cdn.libro.fm/p1.zip")).toBe(true);
		});

		test("rejects lookalike domains", () => {
			expect(isLibroFmUrl("https://evillibro.fm/p1.zip")).toBe(false);
			expect(isLibroFmUrl("https://libro.fm.evil.com/p1.zip")).toBe(false);
		});

		test("rejects plain http and invalid URLs", () => {
			expect(isLibroFmUrl("http://libro.fm/p1.zip")).toBe(false);
			expect(isLibroFmUrl("not a url")).toBe(false);
		});
	});

	describe("isWithin", () => {
		test("accepts the directory itself and paths inside it", () => {
			expect(isWithin("/data/downloads", "/data/downloads")).toBe(true);
			expect(isWithin("/data/downloads", "/data/downloads/a/b.mp3")).toBe(true);
			expect(isWithin("/data/downloads", "/data/downloads/..hidden")).toBe(true);
		});

		test("rejects paths that escape", () => {
			expect(isWithin("/data/downloads", "/data/downloads/../config")).toBe(false);
			expect(isWithin("/data/downloads", "/etc/passwd")).toBe(false);
		});
	});

	describe("safePathSegment", () => {
		test("keeps normal names", () => {
			expect(safePathSegment("Ursula K. Le Guin")).toBe("Ursula K. Le Guin");
		});

		test("replaces separators and control characters", () => {
			expect(safePathSegment("Either/Or")).toBe("Either-Or");
			expect(safePathSegment("..\\..\\x")).toBe("..-..-x");
			expect(safePathSegment("a\u0000b")).toBe("a-b");
		});

		test("neutralizes dot-only and empty names", () => {
			expect(safePathSegment("..")).toBe("_");
			expect(safePathSegment(".")).toBe("_");
			expect(safePathSegment("   ")).toBe("_");
		});
	});

	describe("writePrivateFile", () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "libro-sec-test-"));
		});

		afterEach(() => {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		test("creates files readable only by the owner", () => {
			const file = path.join(tmpDir, "config.json");
			writePrivateFile(file, "{}");
			expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		});

		test("tightens an existing world-readable file", () => {
			const file = path.join(tmpDir, "config.json");
			fs.writeFileSync(file, "{}", { mode: 0o644 });
			writePrivateFile(file, "{}");
			expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		});

		test("replaces the file in one step and leaves no temp file", () => {
			const file = path.join(tmpDir, "state.json");
			writePrivateFile(file, '{"old": true}');
			writePrivateFile(file, '{"new": true}');
			expect(fs.readFileSync(file, "utf-8")).toBe('{"new": true}');
			expect(fs.readdirSync(tmpDir)).toEqual(["state.json"]);
		});

		test("a write that fails leaves the old file and no temp file", () => {
			const file = path.join(tmpDir, "state.json");
			writePrivateFile(file, '{"old": true}');
			const rename = fs.renameSync;
			const spy = spyOn(fs, "renameSync").mockImplementation(() => {
				throw Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" });
			});
			try {
				expect(() => writePrivateFile(file, '{"new": true}')).toThrow("ENOSPC");
			} finally {
				spy.mockRestore();
				fs.renameSync = rename;
			}
			expect(fs.readFileSync(file, "utf-8")).toBe('{"old": true}');
			expect(fs.readdirSync(tmpDir)).toEqual(["state.json"]);
		});
	});

	describe("chmodIfPermitted", () => {
		let tmpDir: string;
		const chmod = fs.chmodSync;

		beforeEach(() => {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "libro-sec-test-"));
		});

		afterEach(() => {
			fs.chmodSync = chmod;
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		const refuseChmod = (code: string) =>
			spyOn(fs, "chmodSync").mockImplementation(() => {
				throw Object.assign(new Error(`${code}: chmod refused`), { code });
			});

		test("sets the mode", () => {
			expect(chmodIfPermitted(tmpDir, 0o700)).toBe(true);
			expect(fs.statSync(tmpDir).mode & 0o777).toBe(0o700);
		});

		test("leaves the mode to the owner of a mount it can't change", () => {
			// What a dataset owned by root with an ACL for the app's group, or
			// a ZFS dataset with aclmode=restricted, answers.
			const spy = refuseChmod("EPERM");
			try {
				expect(chmodIfPermitted(tmpDir, 0o700)).toBe(false);
			} finally {
				spy.mockRestore();
			}
		});

		test("still throws other errors", () => {
			expect(() => chmodIfPermitted(path.join(tmpDir, "missing"), 0o700)).toThrow(
				"ENOENT"
			);
		});

		test("a private file is still written where chmod is refused", () => {
			const file = path.join(tmpDir, "config.json");
			const spy = refuseChmod("EPERM");
			try {
				writePrivateFile(file, '{"username": "me"}');
			} finally {
				spy.mockRestore();
			}
			expect(fs.readFileSync(file, "utf-8")).toBe('{"username": "me"}');
			expect(fs.readdirSync(tmpDir)).toEqual(["config.json"]);
		});
	});

	describe("writeFileAtomic", () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "libro-sec-test-"));
		});

		afterEach(() => {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		test("keeps the default permissions when no mode is given", () => {
			const file = path.join(tmpDir, "metadata.json");
			writeFileAtomic(file, "{}");
			expect(fs.readFileSync(file, "utf-8")).toBe("{}");
			expect(fs.statSync(file).mode & 0o700).toBe(0o600);
			expect(fs.readdirSync(tmpDir)).toEqual(["metadata.json"]);
		});
	});

	describe("readJsonObject", () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "libro-sec-test-"));
		});

		afterEach(() => {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		test("returns the object in a well-formed file", () => {
			const file = path.join(tmpDir, "config.json");
			fs.writeFileSync(file, '{"username": "me"}');
			expect(readJsonObject(file)).toEqual({ username: "me" });
		});

		test("names the file in the error for truncated or non-object content", () => {
			const file = path.join(tmpDir, "state.json");
			fs.writeFileSync(file, '{"111": {"book": ');
			expect(() => readJsonObject(file)).toThrow(file);
			expect(() => readJsonObject(file)).toThrow("not valid JSON");

			fs.writeFileSync(file, "[]");
			expect(() => readJsonObject(file)).toThrow("must hold a JSON object");
			fs.writeFileSync(file, "");
			expect(() => readJsonObject(file)).toThrow("not valid JSON");
		});
	});
});
