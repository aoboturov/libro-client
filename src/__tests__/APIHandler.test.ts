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

describe("APIHandler", () => {
	describe("getHeaders", () => {
		test("omits Authorization when no auth token is provided", () => {
			const headers = APIHandler.getHeaders();
			expect(headers["Content-Type"]).toBe("application/json");
			expect(headers).not.toHaveProperty("Authorization");
		});

		test("includes Authorization when auth token is provided", () => {
			const headers = APIHandler.getHeaders("test-token");
			expect(headers["Content-Type"]).toBe("application/json");
			expect(headers.Authorization).toBe("Bearer test-token");
		});

		test("always includes User-Agent and X-LibroFm-AppVer", () => {
			// /oauth/token returns 401 at the ELB without these headers,
			// so they must be sent on unauthed requests too.
			const unauthed = APIHandler.getHeaders();
			expect(unauthed["User-Agent"]).toBe("okhttp/4.12.0");
			expect(unauthed["X-LibroFm-AppVer"]).toBe("7.39.1");

			const authed = APIHandler.getHeaders("test-token");
			expect(authed["User-Agent"]).toBe("okhttp/4.12.0");
			expect(authed["X-LibroFm-AppVer"]).toBe("7.39.1");
		});

		test("includes the app's device and OS headers", () => {
			const headers = APIHandler.getHeaders();
			expect(headers["X-LibroFm-Device"]).toBe("libro-client");
			expect(headers["X-LibroFm-OsVer"]).toBe("Android 34");
		});
	});

	describe("static properties", () => {
		test("has correct base URL", () => {
			expect(APIHandler.baseUrl).toBe("https://libro.fm");
		});

		test("has correct login endpoint", () => {
			expect(APIHandler.loginEndpoint).toBe("/oauth/token");
		});

		test("has correct library endpoint", () => {
			expect(APIHandler.libraryEndpoint).toBe("/api/v12/library");
		});

		test("has correct download endpoint", () => {
			expect(APIHandler.downloadEndpoint).toBe("/api/v12/download-manifest");
		});
	});

	describe("requests", () => {
		type FetchArgs = [input: string | URL | Request, init?: RequestInit];
		const realFetch = globalThis.fetch;

		/** Replace fetch with a mock that answers every request with `response`. */
		function serve(response: Partial<Response>) {
			const fetchMock = mock((..._args: FetchArgs) =>
				Promise.resolve(response as Response)
			);
			globalThis.fetch = fetchMock as unknown as typeof fetch;
			return fetchMock;
		}

		/** The first request's URL and options, which must have been sent. */
		function firstCall(fetchMock: ReturnType<typeof serve>) {
			const [url, opts] = fetchMock.mock.calls[0] as FetchArgs;
			if (!opts) throw new Error("fetch was called without options");
			return { url, opts, headers: opts.headers as Record<string, string> };
		}

		afterEach(() => {
			globalThis.fetch = realFetch;
			mock.restore();
		});

		describe("fetchLoginData", () => {
			test("sends POST request with credentials", async () => {
				const mockResponse = {
					access_token: "abc123",
					token_type: "bearer",
					created_at: Date.now(),
				};
				const fetchMock = serve({
					ok: true,
					json: () => Promise.resolve(mockResponse),
				});

				const result = await APIHandler.fetchLoginData(
					"user@test.com",
					"pass123"
				);

				expect(fetchMock).toHaveBeenCalledTimes(1);
				const { url, opts } = firstCall(fetchMock);
				expect(url).toBe("https://libro.fm/oauth/token");
				expect(opts.method).toBe("POST");
				const body = JSON.parse(opts.body as string);
				expect(body.grant_type).toBe("password");
				expect(body.username).toBe("user@test.com");
				expect(body.password).toBe("pass123");
				expect(result.access_token).toBe("abc123");
			});

			test("every request carries a timeout, so a silent server cannot hang a check", async () => {
				const fetchMock = serve({
					ok: true,
					json: () => Promise.resolve({ access_token: "t", token_type: "bearer" }),
				});

				await APIHandler.fetchLoginData("user", "pass");

				const { opts } = firstCall(fetchMock);
				expect(opts.signal).toBeInstanceOf(AbortSignal);
				expect(opts.signal?.aborted).toBe(false);
			});

			test("throws on non-ok response", async () => {
				serve({ ok: false, statusText: "Unauthorized" });

				await expect(
					APIHandler.fetchLoginData("bad", "creds")
				).rejects.toThrow("Unauthorized");
			});

			test("throws on error response body", async () => {
				serve({
					ok: true,
					json: () => Promise.resolve({ error: "invalid_grant" }),
				});

				await expect(
					APIHandler.fetchLoginData("user", "pass")
				).rejects.toThrow("invalid_grant");
			});

			test("throws on empty response body", async () => {
				serve({ ok: true, json: () => Promise.resolve({}) });

				await expect(
					APIHandler.fetchLoginData("user", "pass")
				).rejects.toThrow("Empty response");
			});
		});

		describe("fetchLibrary", () => {
			test("sends GET request with auth token and page", async () => {
				const mockLibrary: LibraryMetadata = {
					page: 1,
					total_pages: 1,
					audiobooks: [{ isbn: "1234567890", title: "Test Book" }],
					tags: [],
				};
				const fetchMock = serve({
					ok: true,
					json: () => Promise.resolve(mockLibrary),
				});

				const result = await APIHandler.fetchLibrary("token123", 2);

				const { url, headers } = firstCall(fetchMock);
				expect(url).toBe("https://libro.fm/api/v12/library?page=2");
				expect(headers.Authorization).toBe("Bearer token123");
				expect(result.audiobooks).toHaveLength(1);
			});

			test("defaults to page 1", async () => {
				const fetchMock = serve({
					ok: true,
					json: () =>
						Promise.resolve({
							page: 1,
							total_pages: 1,
							audiobooks: [],
							tags: [],
						}),
				});

				await APIHandler.fetchLibrary("token123");

				expect(firstCall(fetchMock).url).toBe(
					"https://libro.fm/api/v12/library?page=1"
				);
			});

			test("normalizes numeric isbns to strings", async () => {
				// v12 types isbn as a long; numbers must still work as map keys.
				serve({
					ok: true,
					json: () =>
						Promise.resolve({
							page: 1,
							total_pages: 1,
							audiobooks: [{ isbn: 9781234567897, title: "Numeric" }],
							ebooks: [],
							tags: [],
						}),
				});

				const result = await APIHandler.fetchLibrary("token123");
				expect(result.audiobooks[0].isbn).toBe("9781234567897");
			});
		});

		describe("fetchDownloadMetadata", () => {
			test("sends GET request with isbn", async () => {
				const mockMeta: DownloadMetadata = {
					isbn: "1234567890",
					parts: [{ url: "https://example.com/part1.zip", size_bytes: 1000 }],
					tracks: [],
					expires_at: "2025-01-01",
					version: "1",
					size_bytes: 1000,
				};
				const fetchMock = serve({
					ok: true,
					json: () => Promise.resolve(mockMeta),
				});

				const result = await APIHandler.fetchDownloadMetadata(
					"token",
					"1234567890"
				);

				expect(firstCall(fetchMock).url).toBe(
					"https://libro.fm/api/v12/download-manifest?isbn=1234567890&client_version=7.39.1"
				);
				expect(result.isbn).toBe("1234567890");
			});

			test("normalizes a numeric isbn to a string", async () => {
				serve({
					ok: true,
					json: () =>
						Promise.resolve({
							isbn: 9781234567897,
							parts: [],
							tracks: [],
							expires_at: "2026-01-01",
							version: 3,
							size_bytes: 0,
						}),
				});

				const result = await APIHandler.fetchDownloadMetadata(
					"token",
					"9781234567897"
				);
				expect(result.isbn).toBe("9781234567897");
			});
		});
	});

	describe("isRejectedLogin", () => {
		afterEach(() => {
			mock.restore();
		});

		/** The error fetchLoginData throws for this response. */
		async function loginError(response: Response | Error): Promise<unknown> {
			const fetchSpy = spyOn(globalThis, "fetch");
			if (response instanceof Error) fetchSpy.mockRejectedValue(response);
			else fetchSpy.mockResolvedValue(response);
			try {
				await APIHandler.fetchLoginData("reader@example.com", "wrong");
			} catch (error) {
				return error;
			}
			throw new Error("login did not fail");
		}

		const json = (body: object, status: number) =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			});

		test("a JSON 401 with an OAuth error is a rejected login", async () => {
			const error = await loginError(
				json(
					{
						error: "invalid_grant",
						error_description: "The provided authorization grant is invalid",
					},
					401
				)
			);
			expect(error).toBeInstanceOf(ApiError);
			expect(error).toMatchObject({ status: 401, code: "invalid_grant" });
			expect((error as Error).message).toContain("HTTP 401");
			expect((error as Error).message).toContain("invalid_grant");
			expect(APIHandler.isRejectedLogin(error)).toBe(true);
		});

		test("so is a JSON 400, or an error in a 200 body", async () => {
			for (const status of [400, 200]) {
				const error = await loginError(json({ error: "invalid_grant" }, status));
				expect(error).toMatchObject({ status, code: "invalid_grant" });
				expect(APIHandler.isRejectedLogin(error)).toBe(true);
				mock.restore();
			}
		});

		test("the ELB's empty 401 (missing app-version header) is not", async () => {
			const error = await loginError(new Response(null, { status: 401 }));
			expect(error).toMatchObject({ status: 401, code: undefined });
			expect(APIHandler.isRejectedLogin(error)).toBe(false);
		});

		test("429 and 5xx are not, even with an error code", async () => {
			for (const status of [429, 500, 503]) {
				const error = await loginError(
					json({ error: "temporarily_unavailable" }, status)
				);
				expect(APIHandler.isRejectedLogin(error)).toBe(false);
				mock.restore();
			}
		});

		test("a network failure is not", async () => {
			const error = await loginError(new TypeError("fetch failed"));
			expect(APIHandler.isRejectedLogin(error)).toBe(false);
		});
	});
});
