import path from "path";
import fs from "fs";
import os from "os";

// Where the app keeps its files. Run from source (`bun run`), Docker or the npm
// package, that is the project directory. A `bun build --compile` binary bakes
// its build directory into __dirname instead, so a binary copied to another
// machine falls back to the per-user XDG data directory. LIBROFM_DATA_DIR
// overrides the app data location either way.
const isCompiledBinary = /^(\/\$bunfs\/|[A-Za-z]:\\~BUN\\)/.test(import.meta.dir);
const buildDir = path.join(__dirname, "..", "..");

function rootDir(): string {
	if (!isCompiledBinary || fs.existsSync(buildDir)) return buildDir;
	const xdgData =
		process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
	return path.join(xdgData, "libro");
}

const ROOT_DIR = rootDir();

// Downloads
const DOWNLOAD_DIR = path.join(ROOT_DIR, "downloads");

// App data
const APP_DIR = process.env.LIBROFM_DATA_DIR
	? path.resolve(process.env.LIBROFM_DATA_DIR)
	: path.join(ROOT_DIR, "data");
const CACHE_DIR = path.join(APP_DIR, "cache");
const LOGS_DIR = path.join(APP_DIR, "logs");
const CONFIG_DIR = path.join(APP_DIR, "config");

// Create directories if they don't exist. App data (token, logs, cache) is
// private to the current user; downloads keep the default permissions.
const privateDirs = new Set([APP_DIR, LOGS_DIR, CACHE_DIR, CONFIG_DIR]);
for (const dir of [APP_DIR, LOGS_DIR, CACHE_DIR, CONFIG_DIR, DOWNLOAD_DIR]) {
	const isPrivate = privateDirs.has(dir);
	fs.mkdirSync(dir, { recursive: true, ...(isPrivate && { mode: 0o700 }) });
	// Tighten a directory created by an older version or by hand.
	if (isPrivate && (fs.statSync(dir).mode & 0o077) !== 0) {
		fs.chmodSync(dir, 0o700);
	}
}

const STATE_PATH = path.join(CONFIG_DIR, "state.json");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

export { APP_DIR, LOGS_DIR, CACHE_DIR, DOWNLOAD_DIR, STATE_PATH, CONFIG_PATH };
