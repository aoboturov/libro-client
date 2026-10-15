#! /usr/bin/env bun

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import LibroFmClient from "@/LibroFmClient";
import { mapWithLimit } from "@/lib/Concurrency";
import { downloadFormat, parallelDownloads } from "@/lib/Config";
import InputHandler from "@/lib/InputHandler";
import logger, { exitAfterLogs } from "@/lib/Logger";
import { toCsv, toJson, toText } from "@/lib/History";
import { writePrivateFile } from "@/lib/Security";

const SCRIPT_NAME = "libro";

// Created and logged in by the middleware below, once the command line has
// been checked: `--help` and a mistyped command never prompt or go online.
let client: LibroFmClient;

const printBooks = (books: Audiobook[]) => {
	for (const ab of books) {
		logger.info(`Title: ${ab.title}`);
		logger.info(`ISBN: ${ab.isbn}`);
		logger.info(`Duration: ${ab.audiobook_info?.duration}`);
		logger.info(`Narrators: ${ab.audiobook_info?.narrators?.join(", ")}`);
		logger.info("");
	}
};

const parser = yargs(hideBin(process.argv))
	.scriptName(SCRIPT_NAME)
	.strict()
	.demandCommand(1, "Pick a command.")
	// Errors are thrown to the catch below, not printed by yargs: it would
	// carry on into the middleware (and a login) after a usage error.
	.fail(false)
	.middleware(async () => {
		client = new LibroFmClient();
		await client.init();
	})
	.command({
		command: "list",
		aliases: ["ls"],
		describe: "Fetch list of books in library",
		handler: async () => {
			const audiobooks = Object.values(await client.getLibrary());
			logger.info(`Found ${audiobooks.length} audiobooks in library\n`);
			printBooks(audiobooks);
		},
	})
	.command(
		"get [isbns...]",
		"Download a book. Optionally provide ISBNs to download specific books.",
		(yargs) =>
			yargs
				.positional("isbns", {
					describe: "ISBN of the book to download",
					type: "string",
				})
				.array("isbns")
				.options({
					overwrite: {
						describe: "Should overwrite existing files",
						type: "boolean",
						default: false,
					},
					keepZip: {
						describe: "Keep the downloaded zip file (MP3 downloads)",
						type: "boolean",
						default: false,
					},
					format: {
						describe:
							"mp3 tracks, or a single m4b where Libro.fm has one (default: LIBROFM_FORMAT, else mp3)",
						choices: ["mp3", "m4b"] as const,
					},
					ignoreLocal: {
						describe: "Ignore local state and download all books",
						type: "boolean",
						default: false,
					},
				}),
		async (argv) => {
			const format = argv.format ?? downloadFormat();
			const library = await client.getLibrary();
			const requested = (argv.isbns ?? []).map(String);
			const missing = requested.filter((isbn) => !library[isbn]);
			for (const isbn of missing) {
				logger.error(`No book found with ISBN: ${isbn}`, { fn: "Command.get" });
			}

			// With ISBNs, download those books; otherwise let the user pick one.
			let books = requested
				.filter((isbn) => library[isbn])
				.map((isbn) => library[isbn]);
			if (requested.length === 0) {
				const choice = await InputHandler.requestDownloadChoice(
					Object.values(library)
				);
				books = library[choice] ? [library[choice]] : [];
			}

			// Ask about books already downloaded here, one at a time: inside
			// parallel downloads the prompts would interleave.
			if (!argv.overwrite) {
				const kept: Audiobook[] = [];
				for (const book of books) {
					if (
						!client.state.hasBook(book.isbn) ||
						(await InputHandler.requestOverwrite(book))
					) {
						kept.push(book);
					} else {
						logger.info(`Skipped ${book.title}`);
					}
				}
				books = kept;
			}

			let downloaded = 0;
			let failed = 0;
			await mapWithLimit(books, parallelDownloads(), async (book) => {
				logger.info(`Downloading: ${book.title}`);
				try {
					const filepath = await client.downloadBook(
						book,
						true,
						argv.keepZip,
						format
					);
					downloaded++;
					logger.info(`Downloaded ${book.title} to ${filepath}`);
				} catch (error) {
					failed++;
					logger.error((error as Error).message, { fn: "Command.get" });
				}
			});

			logger.info(`Downloaded ${downloaded} new books.`);
			const problems = failed + missing.length;
			if (problems > 0) {
				throw new Error(
					`${problems} of ${books.length + missing.length} books could not be downloaded.`
				);
			}
		}
	)
	.command({
		command: "check",
		describe: "Check for new books in library",
		builder: (yargs) =>
			yargs.options({
				json: {
					describe: "Should output as JSON",
					type: "boolean",
					default: false,
				},
			}),
		handler: async (argv) => {
			const audiobooks = await client.getNewBooks();
			if (argv.json) {
				// Plain stdout (not the logger) so the JSON can be piped.
				process.stdout.write(JSON.stringify(audiobooks, null, 2) + "\n");
				return;
			}
			logger.info(`Found ${audiobooks.length} new audiobooks in library\n`);
			printBooks(audiobooks);
		},
	})
	.command(
		"history [isbns...]",
		"Show listening history per title: added, last played, finished, position, bookmarks",
		(yargs) =>
			yargs
				.positional("isbns", {
					describe: "Limit to these ISBNs (default: whole library)",
					type: "string",
				})
				.array("isbns")
				.options({
					format: {
						describe: "Output format",
						choices: ["text", "json", "csv"] as const,
						default: "text" as const,
					},
					output: {
						alias: "o",
						describe: "Write to this file instead of stdout",
						type: "string",
					},
				}),
		async (argv) => {
			const isbns = (argv.isbns ?? []).map(String);
			const history = await client.getHistory(isbns);
			for (const isbn of isbns) {
				if (!history.some((entry) => entry.isbn === isbn)) {
					logger.error(`No book found with ISBN: ${isbn}`, {
						fn: "Command.history",
					});
				}
			}

			const render = { text: toText, json: toJson, csv: toCsv }[argv.format];
			const text = render(history);
			if (argv.output) {
				// Personal data: keep the export readable only by this user.
				writePrivateFile(argv.output, text);
				logger.info(`Wrote ${history.length} titles to ${argv.output}`);
			} else {
				// Plain stdout (not the logger) so JSON/CSV can be piped.
				process.stdout.write(text);
			}
		}
	);

try {
	await parser.parseAsync();
} catch (error) {
	// A command line that made no sense (yargs' own YError) or a command that
	// failed: say why, with exit status 1, instead of a stack trace.
	if ((error as Error)?.name === "YError") parser.showHelp();
	logger.error((error as Error)?.message ?? String(error), { fn: "cli" });
	exitAfterLogs(1);
}
