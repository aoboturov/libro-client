import fs from "fs";
import os from "os";
import path from "path";
import { CONFIG_PATH } from "./Directories";
import { LogMethod } from "./Logger";
import { readJsonObject, registerSecret, writePrivateFile } from "./Security";

const scope = "Config";

/**
 * The fields written to config.json. The password is deliberately left out:
 * the cached authToken is enough to stay logged in, and a fresh login takes
 * the password from LIBROFM_PASSWORD or an interactive prompt.
 */
export function persistedConfig(config: Partial<Config>) {
	const { username, authToken, downloadDir } = config;
	return { username, authToken, downloadDir };
}

/** Minutes between library checks in the background service. */
export const DEFAULT_POLL_MINUTES = 15;
// setInterval fires immediately for delays above 2^31 - 1 ms (~24.8 days).
const MAX_POLL_MS = 2 ** 31 - 1;

/**
 * Milliseconds between the background service's library checks: the
 * LIBROFM_POLL_MINUTES env var (fractions allowed), or 15 minutes if unset.
 */
export function pollIntervalMs(
	minutes: string | undefined = process.env.LIBROFM_POLL_MINUTES
): number {
	if (minutes === undefined || minutes.trim() === "") {
		return DEFAULT_POLL_MINUTES * 60_000;
	}
	const ms = Number(minutes) * 60_000;
	if (!(ms > 0 && ms <= MAX_POLL_MS)) {
		throw new Error(
			`LIBROFM_POLL_MINUTES must be a number of minutes above 0 and at most ${Math.floor(MAX_POLL_MS / 60_000)}, got "${minutes}"`
		);
	}
	return ms;
}

/** New books the background service downloads at the same time. */
export const DEFAULT_PARALLEL_DOWNLOADS = 4;

/**
 * How many new books the background service downloads at once: the
 * LIBROFM_PARALLEL_DOWNLOADS env var (a whole number, 1 or more), or 4 if unset.
 */
export function parallelDownloads(
	value: string | undefined = process.env.LIBROFM_PARALLEL_DOWNLOADS
): number {
	if (value === undefined || value.trim() === "") {
		return DEFAULT_PARALLEL_DOWNLOADS;
	}
	const count = Number(value);
	if (!Number.isInteger(count) || count < 1) {
		throw new Error(
			`LIBROFM_PARALLEL_DOWNLOADS must be a whole number of 1 or more, got "${value}"`
		);
	}
	return count;
}

/**
 * A directory as the user typed it (`~/Books`, `../books`) made absolute, so
 * it means the same folder whatever the working directory is later.
 */
export function resolveDir(dir: string): string {
	const expanded =
		dir === "~" || dir.startsWith("~/")
			? path.join(os.homedir(), dir.slice(1))
			: dir;
	return path.resolve(expanded);
}

/** Configuration for the app */
export default class Config {
	username: string | undefined;
	password: string | undefined;
	authToken: string | undefined;
	downloadDir: string | undefined;

	/** `configPath` and `env` default to data/config/config.json and process.env; tests pass their own. */
	constructor(
		config?: Partial<Config>,
		private readonly configPath: string = CONFIG_PATH,
		env: NodeJS.ProcessEnv = process.env
	) {
		this.load(env);
		Object.assign(this, config);
		this.registerSecrets();
	}

	/** Changes the config */
	@LogMethod({ scope })
	change(config: Partial<Config>): void {
		Object.assign(this, config);
		if (this.downloadDir) this.downloadDir = resolveDir(this.downloadDir);
		this.registerSecrets();
		this.save();
	}

	/**
	 * Loads the config: the saved file first, then the environment, which
	 * takes precedence (LIBROFM_USERNAME, LIBROFM_PASSWORD, LIBROFM_DOWNLOAD_DIR).
	 */
	@LogMethod({ scope })
	private load(env: NodeJS.ProcessEnv): void {
		const saved: Partial<Config> = fs.existsSync(this.configPath)
			? readJsonObject(this.configPath)
			: {};
		this.username = saved.username;
		this.authToken = saved.authToken;
		this.downloadDir = saved.downloadDir;

		if (env.LIBROFM_USERNAME) this.username = env.LIBROFM_USERNAME;
		if (env.LIBROFM_PASSWORD) this.password = env.LIBROFM_PASSWORD;
		if (env.LIBROFM_DOWNLOAD_DIR) this.downloadDir = env.LIBROFM_DOWNLOAD_DIR;
		if (this.downloadDir) this.downloadDir = resolveDir(this.downloadDir);

		// The saved token belongs to the saved username. After a switch of
		// accounts it must not be reused: it would open the old library.
		if (saved.username && this.username && saved.username !== this.username) {
			this.authToken = undefined;
		}

		// Write the file when it is missing, still holds a password (older
		// versions saved it) or no longer matches what is in effect.
		const current = JSON.stringify(persistedConfig(this));
		if ("password" in saved || current !== JSON.stringify(persistedConfig(saved))) {
			this.save();
		}
	}

	/** Keep credentials out of the logs wherever they appear. */
	private registerSecrets(): void {
		registerSecret(this.username);
		registerSecret(this.password);
		registerSecret(this.authToken);
	}

	/** Saves the config to the file system */
	@LogMethod({ scope })
	private save(): void {
		writePrivateFile(
			this.configPath,
			JSON.stringify(persistedConfig(this), null, 2)
		);
	}
}
