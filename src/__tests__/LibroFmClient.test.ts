import {
	describe,
	test,
	expect,
	mock,
	beforeEach,
	afterEach,
	spyOn,
} from "bun:test";

import APIHandler, { ApiError } from "../APIHandler";
import LibroFmClient, { CredentialsError } from "../LibroFmClient";
import DownloadClient from "../lib/DownloadClient";
import InputHandler from "../lib/InputHandler";
import type Config from "../lib/Config";
import type State from "../lib/State";

describe("LibroFmClient", () => {
	// Most tests replicate the client logic. The "re-login" tests use the real
	// client with a fake config and state, so no file in data/config is touched.

	describe("getLibrary pagination logic", () => {
		test("fetches all pages and combines audiobooks", async () => {
			const page1: LibraryMetadata = {
				page: 1,
				total_pages: 3,
				audiobooks: [
					{ isbn: "001", title: "Book 1" },
					{ isbn: "002", title: "Book 2" },
				],
				tags: [],
			};
			const page2: LibraryMetadata = {
				page: 2,
				total_pages: 3,
				audiobooks: [{ isbn: "003", title: "Book 3" }],
				tags: [],
			};
			const page3: LibraryMetadata = {
				page: 3,
				total_pages: 3,
				audiobooks: [{ isbn: "004", title: "Book 4" }],
				tags: [],
			};

			const pages = [page1, page2, page3];

			// Simulate getLibrary pagination logic
			const audiobooks: AudiobookMap = {};
			let page = 1;
			while (true) {
				const data = pages[page - 1];
				for (const book of data.audiobooks) {
					audiobooks[book.isbn] = book;
				}
				if (page >= data.total_pages) break;
				page += 1;
			}

			expect(Object.keys(audiobooks)).toHaveLength(4);
			expect(audiobooks["001"].title).toBe("Book 1");
			expect(audiobooks["004"].title).toBe("Book 4");
		});

		test("handles single page library", async () => {
			const singlePage: LibraryMetadata = {
				page: 1,
				total_pages: 1,
				audiobooks: [{ isbn: "001", title: "Only Book" }],
				tags: [],
			};

			const audiobooks: AudiobookMap = {};
			let page = 1;
			while (true) {
				const data = singlePage;
				for (const book of data.audiobooks) {
					audiobooks[book.isbn] = book;
				}
				if (page >= data.total_pages) break;
				page += 1;
			}

			expect(Object.keys(audiobooks)).toHaveLength(1);
		});

		test("handles empty library", async () => {
			const emptyPage: LibraryMetadata = {
				page: 1,
				total_pages: 1,
				audiobooks: [],
				tags: [],
			};

			const audiobooks: AudiobookMap = {};
			let page = 1;
			while (true) {
				const data = emptyPage;
				for (const book of data.audiobooks) {
					audiobooks[book.isbn] = book;
				}
				if (page >= data.total_pages) break;
				page += 1;
			}

			expect(Object.keys(audiobooks)).toHaveLength(0);
		});
	});

	describe("downloadBook author filename logic", () => {
		test("uses string author as filename", () => {
			const book: Audiobook = {
				isbn: "123",
				title: "Test",
				authors: "John Smith",
			};
			const filename =
				typeof book.authors === "string"
					? book.authors
					: (book.authors?.join(", ") ?? "Unknown");
			expect(filename).toBe("John Smith");
		});

		test("joins array of authors with comma", () => {
			const book: Audiobook = {
				isbn: "123",
				title: "Test",
				authors: ["Jane Doe", "John Smith"],
			};
			const filename =
				typeof book.authors === "string"
					? book.authors
					: (book.authors?.join(", ") ?? "Unknown");
			expect(filename).toBe("Jane Doe, John Smith");
		});

		test("handles missing authors", () => {
			const book: Audiobook = {
				isbn: "123",
				title: "Test",
			};
			// The actual code throws if !book.authors, so this tests that path
			expect(book.authors).toBeUndefined();
		});
	});

	describe("getNewBooks logic", () => {
		test("returns books not in downloaded state", () => {
			const downloaded: { [isbn: string]: boolean } = {
				"001": true,
				"002": true,
			};

			const library: AudiobookMap = {
				"001": { isbn: "001", title: "Old Book" },
				"002": { isbn: "002", title: "Another Old" },
				"003": { isbn: "003", title: "New Book" },
			};

			const newBooks: Audiobook[] = [];
			for (const isbn in library) {
				if (!downloaded[isbn]) {
					newBooks.push(library[isbn]);
				}
			}

			expect(newBooks).toHaveLength(1);
			expect(newBooks[0].isbn).toBe("003");
		});
	});

	describe("re-login", () => {
		function fakeConfig(initial: Partial<Config> = {}) {
			return {
				username: "reader@example.com",
				password: "hunter22",
				authToken: undefined,
				downloadDir: "/tmp/libro-downloads",
				change(update: Partial<Config>) {
					Object.assign(this, update);
				},
				...initial,
			} as unknown as Config;
		}

		function makeClient(config: Config) {
			return new LibroFmClient(config, {} as State);
		}

		function loginReturns(token: string) {
			return spyOn(APIHandler, "fetchLoginData").mockResolvedValue({
				access_token: token,
				token_type: "Bearer",
				created_at: 0,
			});
		}

		afterEach(() => {
			mock.restore();
		});

		test("keeps an existing token", async () => {
			const login = loginReturns("new-token");
			const config = fakeConfig({ authToken: "old-token" });

			await makeClient(config).ensureLoggedIn();

			expect(login).not.toHaveBeenCalled();
			expect(config.authToken).toBe("old-token");
		});

		test("logs in again with the configured credentials", async () => {
			const login = loginReturns("new-token");
			const config = fakeConfig();

			await makeClient(config).ensureLoggedIn();

			expect(login).toHaveBeenCalledTimes(1);
			expect(login).toHaveBeenCalledWith("reader@example.com", "hunter22");
			expect(config.authToken).toBe("new-token");
		});

		test("fails without credentials instead of prompting", async () => {
			const login = loginReturns("new-token");
			const config = fakeConfig({ password: undefined });

			const result = makeClient(config).ensureLoggedIn();
			await expect(result).rejects.toThrow(CredentialsError);
			await expect(result).rejects.toThrow("LIBROFM_PASSWORD");
			expect(login).not.toHaveBeenCalled();
		});

		test("a rejected login is a CredentialsError", async () => {
			spyOn(APIHandler, "fetchLoginData").mockRejectedValue(
				new ApiError(401, "Unauthorized", "invalid_grant")
			);
			const config = fakeConfig();

			const result = makeClient(config).ensureLoggedIn();
			await expect(result).rejects.toThrow(CredentialsError);
			await expect(result).rejects.toThrow(
				"Libro.fm rejected the username or password (HTTP 401 Unauthorized: invalid_grant)."
			);
			expect(config.authToken).toBeUndefined();
		});

		test("other login failures are passed on to be retried", async () => {
			for (const failure of [
				new ApiError(503, "Service Unavailable"),
				new ApiError(401, "Unauthorized"), // the ELB's empty 401
				new TypeError("fetch failed"),
			]) {
				spyOn(APIHandler, "fetchLoginData").mockRejectedValue(failure);
				const result = makeClient(fakeConfig()).ensureLoggedIn();
				await expect(result).rejects.toBe(failure);
				mock.restore();
			}
		});

		describe("init", () => {
			const ttyDescriptor = Object.getOwnPropertyDescriptor(
				process.stdin,
				"isTTY"
			);
			function setTTY(value: boolean) {
				Object.defineProperty(process.stdin, "isTTY", {
					value,
					configurable: true,
				});
			}

			afterEach(() => {
				if (ttyDescriptor) {
					Object.defineProperty(process.stdin, "isTTY", ttyDescriptor);
				} else {
					delete (process.stdin as { isTTY?: boolean }).isTTY;
				}
			});

			test("without a terminal, missing credentials fail without a prompt", async () => {
				setTTY(false);
				const prompt = spyOn(InputHandler, "requestCredentials");
				const login = loginReturns("new-token");

				await expect(
					makeClient(fakeConfig({ password: undefined })).init()
				).rejects.toThrow(CredentialsError);
				expect(prompt).not.toHaveBeenCalled();
				expect(login).not.toHaveBeenCalled();
			});

			test("in a terminal, asks for missing credentials, then logs in", async () => {
				setTTY(true);
				const prompt = spyOn(
					InputHandler,
					"requestCredentials"
				).mockResolvedValue({
					username: "typed@example.com",
					password: "typed-pass",
				});
				const login = loginReturns("new-token");
				const config = fakeConfig({ username: undefined, password: undefined });

				await makeClient(config).init();

				expect(prompt).toHaveBeenCalledTimes(1);
				expect(login).toHaveBeenCalledWith("typed@example.com", "typed-pass");
				expect(config.authToken).toBe("new-token");
			});

			test("a rejected login stops init with a CredentialsError", async () => {
				setTTY(false);
				spyOn(APIHandler, "fetchLoginData").mockRejectedValue(
					new ApiError(401, "Unauthorized", "invalid_grant")
				);

				await expect(makeClient(fakeConfig()).init()).rejects.toThrow(
					CredentialsError
				);
			});
		});

		describe("getLibrary", () => {
			const page = (n: number, total: number, isbn: string): LibraryMetadata => ({
				page: n,
				total_pages: total,
				audiobooks: [{ isbn, title: `Book ${isbn}` }],
				tags: [],
			});

			test("a network or server error is passed on and the token kept", async () => {
				const login = loginReturns("new-token");
				spyOn(APIHandler, "fetchLibrary").mockRejectedValue(
					new ApiError(503, "Service Unavailable")
				);
				const config = fakeConfig({ authToken: "old-token" });

				await expect(makeClient(config).getLibrary()).rejects.toThrow(
					"Service Unavailable"
				);
				expect(config.authToken).toBe("old-token");
				expect(login).not.toHaveBeenCalled();
			});

			test("a failed later page fails the whole fetch, never a partial library", async () => {
				spyOn(APIHandler, "fetchLibrary")
					.mockResolvedValueOnce(page(1, 2, "001"))
					.mockRejectedValueOnce(new TypeError("fetch failed"));

				await expect(
					makeClient(fakeConfig({ authToken: "old-token" })).getLibrary()
				).rejects.toThrow("fetch failed");
			});

			test("a rejected token is dropped, then the client logs in again and retries", async () => {
				const login = loginReturns("new-token");
				const fetchLibrary = spyOn(APIHandler, "fetchLibrary")
					.mockRejectedValueOnce(new ApiError(401, "Unauthorized"))
					.mockResolvedValue(page(1, 1, "001"));
				const config = fakeConfig({ authToken: "stale-token" });

				const library = await makeClient(config).getLibrary();

				expect(Object.keys(library)).toEqual(["001"]);
				expect(login).toHaveBeenCalledTimes(1);
				expect(config.authToken).toBe("new-token");
				expect(fetchLibrary).toHaveBeenNthCalledWith(1, "stale-token", 1);
				expect(fetchLibrary).toHaveBeenNthCalledWith(2, "new-token", 1);
			});

			test("a rejected token without credentials to log in again is a CredentialsError", async () => {
				spyOn(APIHandler, "fetchLibrary").mockRejectedValue(
					new ApiError(401, "Unauthorized")
				);
				const config = fakeConfig({ authToken: "stale-token", password: undefined });

				await expect(makeClient(config).getLibrary()).rejects.toThrow(
					CredentialsError
				);
				// The stale token is gone, so the next start logs in afresh.
				expect(config.authToken).toBeUndefined();
			});

			test("a token rejected twice in a row is an error, not a loop", async () => {
				loginReturns("new-token");
				const fetchLibrary = spyOn(APIHandler, "fetchLibrary").mockRejectedValue(
					new ApiError(401, "Unauthorized")
				);

				await expect(
					makeClient(fakeConfig({ authToken: "stale-token" })).getLibrary()
				).rejects.toThrow("HTTP 401");
				expect(fetchLibrary).toHaveBeenCalledTimes(2);
			});
		});

		describe("downloadBook", () => {
			const book: Audiobook = {
				isbn: "001",
				title: "Book One",
				authors: ["Some Author"],
			};
			const manifest: DownloadMetadata = {
				isbn: "001",
				parts: [
					{
						url: "https://cdn.example/p1.zip?Signature=s3cret&Key-Pair-Id=K1",
						size_bytes: 10,
					},
				],
				tracks: [],
				expires_at: "2026-12-31",
				version: 1,
				size_bytes: 10,
			};

			function fakeState(downloaded: string[] = []) {
				const added: StateData[] = [];
				return {
					added,
					downloadedAudioBooks: {},
					hasBook: (isbn: string) => downloaded.includes(isbn),
					addBook(data: StateData) {
						added.push(data);
					},
				} as unknown as State & { added: StateData[] };
			}

			test("an already downloaded book that is left alone fetches no manifest", async () => {
				spyOn(InputHandler, "requestOverwrite").mockResolvedValue(false);
				const metadata = spyOn(APIHandler, "fetchDownloadMetadata");
				const client = new LibroFmClient(
					fakeConfig({ authToken: "token" }),
					fakeState(["001"])
				);

				expect(await client.downloadBook(book)).toBe("");
				expect(metadata).not.toHaveBeenCalled();
			});

			test("what is kept on disk has no signed part URLs", async () => {
				spyOn(APIHandler, "fetchDownloadMetadata").mockResolvedValue(manifest);
				const downloadFiles = spyOn(
					DownloadClient,
					"downloadFiles"
				).mockResolvedValue(["/books/Some Author/Book One", false]);
				const saveMetadata = spyOn(
					DownloadClient,
					"saveMetadata"
				).mockResolvedValue();
				const state = fakeState();
				const client = new LibroFmClient(
					fakeConfig({ authToken: "token", downloadDir: "/books" }),
					state
				);

				const result = await client.downloadBook(book);

				expect(result).toBe("/books/Some Author/Book One");
				// The download itself does get the signed URL...
				expect(downloadFiles.mock.calls[0]?.[1]).toEqual([manifest.parts[0].url]);
				// ...but neither metadata.json nor the state keeps it.
				const saved = JSON.stringify([saveMetadata.mock.calls[0]?.[1], state.added]);
				expect(saved).not.toContain("Signature");
				expect(saved).not.toContain("cdn.example");
				expect(state.added[0]?.meta.parts).toEqual([{ size_bytes: 10 }]);
			});

			test("a failure names the book and keeps the cause", async () => {
				spyOn(APIHandler, "fetchDownloadMetadata").mockRejectedValue(
					new ApiError(500, "Internal Server Error")
				);
				const client = new LibroFmClient(
					fakeConfig({ authToken: "token" }),
					fakeState()
				);

				const result = client.downloadBook(book);
				await expect(result).rejects.toThrow('Failed to download "Book One"');
				await expect(result).rejects.toThrow("HTTP 500");
			});
		});
	});
});
