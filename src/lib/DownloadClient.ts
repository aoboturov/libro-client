import path from "path";
import fs from "fs";
import { createHash } from "crypto";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream } from "stream/web";
import yauzl from "yauzl";

import APIHandler from "../APIHandler";
import logger, { LogMethod } from "./Logger";
import { CACHE_DIR, DOWNLOAD_DIR } from "./Directories";
import {
	isLibroFmUrl,
	isWithin,
	tempPathFor,
	writeFileAtomic,
} from "./Security";

const scope = "DownloadClient";

/** Helper class for downloading and unzipping files */
export default class DownloadCLient {
	/** Hidden folder in the download directory where books are unpacked. */
	static readonly stagingDirName = ".libro-partial";

	/**
	 * Give up on a part when no data has arrived for this long. A connection
	 * that silently stalls would otherwise hold the book (and, in the service,
	 * every later check) forever.
	 */
	static stallTimeoutMs = 60_000;

	/**
	 * Downloads a list of files and returns the paths.
	 * This assumes that the urls are meant to compile for one book.
	 * (multi-part zip files, etc.)
	 * */
	@LogMethod({ scope, message: "Downloading files...", secretArgs: [2] })
	static async downloadFiles(
		filename: string,
		urls: string[],
		authToken: string,
		keepZip = false,
		directory?: string,
	): Promise<[string, string[] | false]> {
		const baseDir = directory || DOWNLOAD_DIR;
		const finalPath = path.join(baseDir, filename);
		if (
			!isWithin(baseDir, finalPath) ||
			!isWithin(CACHE_DIR, path.join(CACHE_DIR, filename))
		) {
			throw new Error(
				`Refusing to write outside the download directory: ${filename}`
			);
		}

		// Stream each part to disk, unpack the parts into a staging folder, then
		// move the book into place with renames only. Nothing is held in memory
		// whole, so memory use stays small whatever the book's size, and a
		// failed or interrupted download never leaves a partial book in the
		// download directory.
		const staging = DownloadCLient.stagingPath(baseDir, filename);
		const book = path.join(staging, "book");
		// Left behind by an interrupted attempt at the same book.
		fs.rmSync(staging, { recursive: true, force: true });
		try {
			fs.mkdirSync(book, { recursive: true });
			// Kept zips go straight to the cache; others live in staging.
			const zips = urls.map((_, idx) =>
				keepZip
					? path.join(CACHE_DIR, `${filename}-${idx}.zip`)
					: path.join(staging, `part-${idx}.zip`)
			);
			// The first failure stops the other parts, and staging is only
			// removed once every download has stopped writing to it.
			const abort = new AbortController();
			let failure: { error: unknown } | undefined;
			await Promise.all(
				urls.map(async (url, idx) => {
					try {
						await DownloadCLient.download(
							url,
							authToken,
							zips[idx],
							abort.signal
						);
					} catch (error) {
						failure ??= { error };
						abort.abort();
					}
				})
			);
			if (failure) throw failure.error;

			// In part order, so a later part wins a name clash, as before.
			for (const zip of zips) {
				await DownloadCLient.unzip(zip, book);
			}
			DownloadCLient.moveIntoPlace(book, finalPath);

			return [finalPath, keepZip && zips];
		} finally {
			fs.rmSync(staging, { recursive: true, force: true });
			DownloadCLient.removeIfEmpty(path.dirname(staging));
		}
	}

	/**
	 * Staging folder for one book, inside the download directory so the final
	 * move is a rename on the same filesystem. Stable per book, so the next
	 * attempt clears what an interrupted one left.
	 */
	static stagingPath(baseDir: string, filename: string): string {
		const id = createHash("sha256").update(filename).digest("hex");
		return path.join(baseDir, DownloadCLient.stagingDirName, id.slice(0, 16));
	}

	/**
	 * Save Audiobook object as JSON file alongside the downloaded files.
	 */
	@LogMethod({ scope, message: "Saving metadata..." })
	static async saveMetadata(
		book: Audiobook,
		fileData: DownloadMetadata,
		filepath: string
	): Promise<void> {
		const metadataPath = path.join(filepath, "metadata.json");
		writeFileAtomic(
			metadataPath,
			JSON.stringify({ book, fileData }, null, 2)
		);
	}

	/**
	 * Streams a URL to `file`, through a temp file renamed into place when the
	 * download is complete. Only a small buffer is held in memory.
	 */
	@LogMethod({ scope, message: "Downloading file...", secretArgs: [1] })
	private static async download(
		url: string,
		authToken: string,
		file: string,
		signal?: AbortSignal
	): Promise<void> {
		const tmp = tempPathFor(file);
		// Abort when no bytes arrive for `stallTimeoutMs`. The timer runs from
		// before the request, so a server that never answers is caught too.
		const stall = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const rearm = () => {
			clearTimeout(timer);
			timer = setTimeout(
				() =>
					stall.abort(
						new Error(
							`Download stalled: no data for ${DownloadCLient.stallTimeoutMs / 1000}s`
						)
					),
				DownloadCLient.stallTimeoutMs
			);
		};
		const combined = signal
			? AbortSignal.any([signal, stall.signal])
			: stall.signal;
		try {
			// Only libro.fm itself gets the bearer token; part URLs on a CDN
			// (or a lookalike such as evillibro.fm) are fetched without it.
			const opts = isLibroFmUrl(url)
				? { headers: APIHandler.getHeaders(authToken), signal: combined }
				: { signal: combined };

			rearm();
			const response = await fetch(url, opts);
			// An error page (e.g. an expired signed URL) is not a zip.
			if (!response.ok) {
				throw new Error(
					`Download failed: HTTP ${response.status} ${response.statusText}`.trim()
				);
			}
			if (!response.body) throw new Error("Download failed: empty response");

			fs.mkdirSync(path.dirname(file), { recursive: true });
			// Rejects if the connection drops before the advertised length.
			await pipeline(
				Readable.fromWeb(response.body as ReadableStream),
				new Transform({
					transform(chunk, _encoding, callback) {
						rearm();
						callback(null, chunk);
					},
				}),
				fs.createWriteStream(tmp),
				{ signal: combined }
			);
			fs.renameSync(tmp, file);
		} catch (error) {
			fs.rmSync(tmp, { force: true });
			// An abort surfaces as a bare AbortError; name the stall instead.
			const cause = stall.signal.aborted ? stall.signal.reason : error;
			logger.error({ error: cause, fn: "DownloadClient.download" });
			throw cause;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Unzips a zip file into a directory, one entry at a time, streaming each
	 * entry from the zip on disk to its file.
	 */
	@LogMethod({ scope, message: "Unzipping file to filesystem..." })
	static async unzip(zipPath: string, outputPath: string): Promise<string> {
		let zip: yauzl.ZipFile | undefined;
		try {
			fs.mkdirSync(outputPath, { recursive: true });
			// yauzl rejects entry names that are absolute or contain `..`, and
			// checks each entry's size against the zip's directory.
			zip = await yauzl.openPromise(zipPath);
			for await (const entry of zip.eachEntry()) {
				// Directory entries: their files create the folders they need.
				if (entry.fileName.endsWith("/")) continue;

				const filePath = path.join(outputPath, entry.fileName);
				// Zip-slip guard: never write outside the extraction dir.
				if (!isWithin(outputPath, filePath)) {
					logger.warn(`Skipping unsafe zip entry: ${entry.fileName}`, {
						fn: "DownloadClient.unzip",
					});
					continue;
				}
				fs.mkdirSync(path.dirname(filePath), { recursive: true });
				await pipeline(
					await zip.openReadStreamPromise(entry),
					fs.createWriteStream(filePath)
				);
			}

			return outputPath;
		} catch (error) {
			logger.error({ error, fn: "DownloadClient.unzip" });
			throw error;
		} finally {
			zip?.close();
		}
	}

	/**
	 * Move `src` to `dest` with renames only. A new book appears in one step.
	 * Into an existing folder (a re-download), each file is replaced in one
	 * step, and files that aren't in the download are kept, as before.
	 */
	@LogMethod({ scope })
	private static moveIntoPlace(src: string, dest: string): void {
		if (!fs.existsSync(dest)) {
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.renameSync(src, dest);
			return;
		}
		for (const name of fs.readdirSync(src)) {
			const from = path.join(src, name);
			const to = path.join(dest, name);
			if (fs.statSync(from).isDirectory() && fs.existsSync(to)) {
				DownloadCLient.moveIntoPlace(from, to);
			} else {
				fs.renameSync(from, to);
			}
		}
	}

	/**
	 * Remove `dir` if it is empty. Best effort: other downloads may still be
	 * using it, and a failure here must not hide the download's own error.
	 */
	private static removeIfEmpty(dir: string) {
		try {
			fs.rmdirSync(dir);
		} catch {}
	}
}
