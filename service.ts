import LibroFmClient, { CredentialsError } from "@/LibroFmClient";
import { parallelDownloads, pollIntervalMs } from "@/lib/Config";
import { mapWithLimit } from "@/lib/Concurrency";
import logger, { exitAfterLogs } from "@/lib/Logger";

// sysexits EX_CONFIG: a configuration problem that a restart won't fix.
const EX_CONFIG = 78;
const fn = "service";

let timer: ReturnType<typeof setInterval> | undefined;
let stopping = false;

/** Stop checking and exit once the logs are written. */
const stop = (code: number) => {
	stopping = true;
	clearInterval(timer);
	exitAfterLogs(code);
};

/** Logging in again with the same credentials is pointless: stop instead. */
const stopForCredentials = (error: CredentialsError) => {
	logger.error(
		`${error.message} Stopping the service: retrying with the same credentials won't help. ` +
			"Fix LIBROFM_USERNAME / LIBROFM_PASSWORD and start it again.",
		{ fn }
	);
	stop(EX_CONFIG);
};

async function main() {
	// Read before logging in, so a bad setting fails right away.
	const pollInterval = pollIntervalMs();
	const downloadsAtOnce = parallelDownloads();
	const client = new LibroFmClient();
	try {
		await client.init();
	} catch (error) {
		if (error instanceof CredentialsError) return stopForCredentials(error);
		// Network trouble or Libro.fm down: the first check logs in again.
		logger.error("Could not log in yet; trying again at the next check", {
			fn,
			error,
		});
	}

	const scanLibrary = async () => {
		logger.info("Checking for new books...", { fn });
		const newBooks = await client.getNewBooks();
		if (newBooks.length > 0) {
			logger.info(`Found ${newBooks.length} new books:`, { fn });
			newBooks.forEach((book, idx) => {
				logger.info(`${idx + 1}. ${book.title}`, { fn });
			});
		} else {
			logger.info("No new books found.", { fn });
		}
		return newBooks;
	};

	// The scan already holds each new book from the library; no second fetch.
	const downloadBooks = async (newBooks: Audiobook[]) => {
		logger.info("Downloading new books...", { fn });

		// At most `downloadsAtOnce` books at a time (a first run on a large
		// library would otherwise start them all at once); the next starts as
		// soon as one finishes. One book failing does not stop the others; it
		// is still new at the next check and is tried again then.
		const results = await mapWithLimit(newBooks, downloadsAtOnce, async (book) => {
			logger.info(`Downloading: ${book.title}`, { fn });
			try {
				const filepath = await client.downloadBook(book);
				logger.info(`Downloaded ${book.title} to ${filepath}`, { fn });
				return true;
			} catch (error) {
				logger.error(
					`${(error as Error).message} Trying again at the next check.`,
					{ fn }
				);
				logger.debug("Download failure", { fn, error });
				return false;
			}
		});
		const count = results.filter(Boolean).length;

		logger.info(`Downloaded ${count} of ${newBooks.length} new books.`, { fn });
	};

	let isRunning = false;
	const runService = async () => {
		// A check still running (a long download) skips the ones that come due.
		if (isRunning || stopping) return;
		isRunning = true;

		try {
			// A rejected token is cleared; log in again instead of failing
			// every check until the service is restarted.
			await client.ensureLoggedIn();
			const newBooks = await scanLibrary();
			if (newBooks.length > 0) await downloadBooks(newBooks);
		} catch (error) {
			if (error instanceof CredentialsError) return stopForCredentials(error);
			logger.error(
				`Check failed: ${(error as Error)?.message ?? error}. Trying again at the next check.`,
				{ fn }
			);
			logger.debug("Check failure", { fn, error });
		} finally {
			isRunning = false;
		}
	};

	logger.info(
		`Checking for new books every ${pollInterval / 60_000} minutes, downloading up to ${downloadsAtOnce} at a time.`,
		{ fn }
	);
	void runService();
	timer = setInterval(runService, pollInterval);
}

const shutdown = (signal: string) => {
	logger.info(
		`${signal} received, exiting. A download in progress is dropped; the next start picks the book up again.`,
		{ fn }
	);
	stop(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (error) => {
	logger.error("An unhandled rejection occurred", { fn, error });
	stop(1);
});

main().catch((error) => {
	logger.error(
		`The service could not start: ${(error as Error)?.message ?? error}`,
		{ fn }
	);
	logger.debug("Startup failure", { fn, error });
	stop(1);
});
