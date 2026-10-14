import { format, transports, createLogger } from "winston";
import path from "path";

import { LOGS_DIR } from "./Directories";
import { redact, registerSecret, scrubString } from "./Security";

const sillyLogFile = path.join(LOGS_DIR, "silly.log");
const debugLogFile = path.join(LOGS_DIR, "debug.log");

const DEBUG_MODE = process.env.DEBUG === "true";
// Colour codes only for a terminal: a container's log viewer (docker logs,
// TrueNAS) or a log file would show them as `[31merror[39m`.
const COLOR = Boolean(process.stdout.isTTY || process.stderr.isTTY);

// Logs are kept across runs (a crash would otherwise take its own log with it
// at the next start) and rotated instead: at most LOG_FILES files of
// LOG_FILE_BYTES each per level, the newest always under the plain name.
const LOG_FILE_BYTES = 10 * 1024 * 1024;
const LOG_FILES = 3;

type Info = Parameters<Parameters<typeof format.printf>[0]>[0];

export function getFormat(fileTransport: boolean = false) {
	return format.printf((info: Info): string => {
		const {
			timestamp,
			level,
			message: rawMessage,
			fn,
			...rawRest
		} = info as Info & { timestamp?: string; fn?: string };
		// Never write credentials: LogMethod logs every argument, including
		// passwords, tokens and signed download URLs.
		const message = redact(rawMessage);
		const rest = redact(rawRest) as Record<string, unknown>;

		if (!DEBUG_MODE && !fileTransport && level.includes("info")) {
			return typeof message === "string" ? message : JSON.stringify(message);
		}

		const timeStr = timestamp ? `${timestamp} - ` : "";
		const fnStr = fn ? ` ${fn}` : "";

		let msg: string;
		if (typeof message === "object" && message !== null) {
			const { fn: messageFn, ...fields } = message as Record<string, unknown>;
			msg = `${timeStr}(${level})${messageFn ? ` ${messageFn}` : ""}`;
			for (const [key, value] of Object.entries(fields)) {
				msg += `\n${key}: ${JSON.stringify(value, null, 2)}`;
			}
		} else if (message) {
			msg = `${timeStr}(${level})${fnStr} | ${message}`;
		} else {
			// no message, try to render fn and rest
			msg = `${timeStr}(${level})${fnStr}`;
		}

		for (const [key, value] of Object.entries(rest)) {
			msg += `\n${key}: ${JSON.stringify(value, null, 2)}`;
		}

		return scrubString(msg);
	});
}

const fileTransport = (filename: string, level: string) =>
	new transports.File({
		format: format.combine(
			format.errors({ stack: true }),
			format.splat(),
			format.timestamp(),
			getFormat(true)
		),
		filename,
		level,
		maxsize: LOG_FILE_BYTES,
		maxFiles: LOG_FILES,
		tailable: true,
		options: { flags: "a", mode: 0o600 },
	});

const logger = createLogger({
	level: DEBUG_MODE ? "debug" : "info",

	transports: [
		new transports.Console({
			// Keep stdout clean for piped output (`history --format csv > f`).
			stderrLevels: ["error", "warn"],
			format: format.combine(
				format.errors({ stack: true }),
				format.splat(),
				...(COLOR ? [format.colorize()] : []),
				getFormat()
			),
		}),
		fileTransport(sillyLogFile, "silly"),
		fileTransport(debugLogFile, "debug"),
	],
});

type LogMethodOptions = {
	level?: string;
	scope?: string;
	message?: string;
	/** Positions of arguments that hold credentials; they are never logged. */
	secretArgs?: number[];
	[key: string]: any;
};

/**
 * Log a method call.
 * Default level is "silly".
 * */
export function LogMethod(
	{
		level = "silly",
		scope,
		message,
		secretArgs = [],
		...rest
	}: LogMethodOptions = { level: "silly" }
) {
	return function (
		target: any,
		propertyKey: string,
		descriptor: PropertyDescriptor
	) {
		const originalMethod = descriptor.value;

		descriptor.value = function (...args: any[]) {
			for (const index of secretArgs) registerSecret(args[index]);
			const fn = scope || target.constructor.name;
			if (message) {
				logger.verbose(message, {
					...rest,
					fn: `${fn}.${propertyKey}`,
				});
			}
			logger.log(level, {
				args,
				message,
				...rest,
				fn: `${fn}.${propertyKey}`,
			});

			// call the original method
			const result = originalMethod.apply(this, args);

			return result;
		};

		return descriptor;
	};
}

/**
 * Exit once every transport has written what it holds. A plain process.exit
 * right after a log call can drop the very line that explains the exit.
 */
export function exitAfterLogs(code: number): void {
	process.exitCode = code;
	// Anything still logging after this point (an in-flight download) must
	// not turn a clean exit into a crash.
	logger.on("error", () => {});
	const fallback = setTimeout(() => process.exit(code), 2_000);
	logger.once("finish", () => {
		clearTimeout(fallback);
		process.exit(code);
	});
	logger.end();
}

export default logger;
