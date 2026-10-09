import { expect, test } from "bun:test";
import type { ProcessReply } from "../packages/cli/src/update-process";
import { ok, err, type Result } from "../packages/core/result";
import { discoverGitHubRelease } from "./release-github";

const TAG = "v0.2.0";
const release = (id = 1, tag_name = TAG, draft = true) => ({
	id,
	tag_name,
	draft,
	immutable: !draft,
	assets: [],
});
const response = (
	body: unknown,
	status = 200,
	link = "",
): Result<ProcessReply> =>
	ok({
		code: status === 200 ? 0 : 1,
		stdout: `HTTP/2.0 ${status} ${status === 200 ? "OK" : "Not Found"}\n${link ? `Link: ${link}\n` : ""}\n${JSON.stringify(body)}`,
	});
const next = (page: number) =>
	`<https://api.github.com/repos/davidpp/kabane/releases?per_page=100&page=${page}>; rel="next"`;
const repo = {
	id: 12,
	full_name: "davidpp/kabane",
	permissions: { push: true },
};
const listing =
	(...items: ReturnType<typeof release>[]) =>
	async (endpoint: string): Promise<Result<ProcessReply>> =>
		endpoint.includes("/tags/")
			? response({}, 404)
			: endpoint === "repos/davidpp/kabane"
				? response(repo)
				: response(items);

test("published lookup is direct; draft lookup requires authenticated listing", async () => {
	const published = await discoverGitHubRelease(TAG, async (endpoint) => {
		expect(endpoint).toContain("/tags/");
		return response(release(1, TAG, false));
	});
	expect(published.ok && published.value?.draft).toBe(false);
	const draft = await discoverGitHubRelease(TAG, listing(release()));
	expect(draft.ok && draft.value?.draft).toBe(true);
	const absent = await discoverGitHubRelease(
		TAG,
		listing(release(2, "v0.1.0", false)),
	);
	expect(absent.ok && absent.value).toBe(null);
});

test("consume every page even after a match; later duplicates cannot authorize publishing", async () => {
	const first = [
		release(),
		...Array.from({ length: 99 }, (_, index) =>
			release(index + 10, `vold-${index}`, false),
		),
	];
	let pages = 0;
	for (const duplicate of [false, true]) {
		const found = await discoverGitHubRelease(TAG, async (endpoint) => {
			if (endpoint.includes("/tags/")) return response({}, 404);
			if (endpoint === "repos/davidpp/kabane") return response(repo);
			pages++;
			return endpoint.endsWith("page=1")
				? response(first, 200, next(2))
				: response([release(300, duplicate ? TAG : "vother", false)]);
		});
		expect(found.ok).toBe(!duplicate);
	}
	expect(pages).toBe(4);
});

test("fail closed for conflicting metadata, auth and partial/oversized listings", async () => {
	for (const request of [
		listing(release(), release(2)),
		listing(release(1, TAG, false)),
		listing(release(), release()),
		async (endpoint: string) =>
			endpoint.includes("/tags/")
				? response({}, 404)
				: endpoint === "repos/davidpp/kabane"
					? response({ ...repo, permissions: { push: false } })
					: response([]),
		async (endpoint: string) =>
			endpoint.includes("/tags/")
				? response({}, 404)
				: endpoint === "repos/davidpp/kabane"
					? response(repo)
					: response([release()], 200, next(2)),
		async (endpoint: string) =>
			endpoint.includes("/tags/")
				? response({}, 404)
				: endpoint === "repos/davidpp/kabane"
					? response(repo)
					: response(
							Array.from({ length: 101 }, (_, index) =>
								release(index + 1, `v${index}`, false),
							),
						),
		async (endpoint: string) =>
			endpoint.includes("/tags/")
				? response({}, 404)
				: endpoint === "repos/davidpp/kabane"
					? response(repo)
					: response([{ tag_name: TAG, draft: true, assets: [] }]),
	])
		expect((await discoverGitHubRelease(TAG, request)).ok).toBe(false);
	expect(
		(
			await discoverGitHubRelease(TAG, async () =>
				err(new Error("limited output")),
			)
		).ok,
	).toBe(false);
	expect(
		(await discoverGitHubRelease(TAG, async () => response(release()))).ok,
	).toBe(false);
});

test("unsafe, missing and over-limit pagination never proves absence", async () => {
	const page = Array.from({ length: 100 }, (_, index) =>
		release(index + 1, `v${index}`, false),
	);
	for (const link of [
		next(3),
		next(2).replace("api.github.com", "evil.example"),
		next(2) + ", " + next(2),
		'<https://api.github.com/repos/davidpp/kabane/releases?per_page=100&page=2>; rel="last"',
	]) {
		const found = await discoverGitHubRelease(TAG, async (endpoint) =>
			endpoint.includes("/tags/")
				? response({}, 404)
				: endpoint === "repos/davidpp/kabane"
					? response(repo)
					: response(page, 200, link),
		);
		expect(found.ok).toBe(false);
	}
	let count = 0;
	const limited = await discoverGitHubRelease(TAG, async (endpoint) => {
		if (endpoint.includes("/tags/")) return response({}, 404);
		if (endpoint === "repos/davidpp/kabane") return response(repo);
		count++;
		return response(
			page.map((item) => ({ ...item, id: item.id + count * 100 })),
			200,
			next(count + 1),
		);
	});
	expect(limited.ok).toBe(false);
	expect(count).toBe(10);
});
