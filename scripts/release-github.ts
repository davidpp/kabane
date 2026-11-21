import { z } from "zod";
import type { ProcessReply } from "../packages/cli/src/update-process";
import { compareVersions } from "../packages/cli/src/update-version";
import { err, ok, type Result } from "../packages/core/result";

const Release = z.object({
	id: z.number().int().positive().safe(),
	tag_name: z.string(),
	draft: z.boolean(),
	prerelease: z.boolean().optional(),
	immutable: z.boolean().optional(),
	assets: z.array(z.object({ name: z.string() })),
});
export type GitHubRelease = z.infer<typeof Release>;
type Request = (endpoint: string) => Promise<Result<ProcessReply>>;
const REPOSITORY = "repos/davidpp/kabane";
const MAX_PAGES = 10;
const PAGE_SIZE = 100;
const fail = (message: string): Result<never> => err(new Error(message));

type Response = { status: number; headers: string; body: unknown };
const decode = (reply: ProcessReply): Result<Response> => {
	try {
		const split = reply.stdout.search(/\r?\n\r?\n/);
		if (split < 0) return fail("Missing GitHub API response headers.");
		const headers = reply.stdout.slice(0, split);
		const status = Number(/^HTTP\/\S+ (\d{3})\b/.exec(headers)?.[1]);
		if (
			(status !== 200 && status !== 404) ||
			(status === 200 && reply.code !== 0)
		)
			return fail("GitHub API access/response failed; absence is not proven.");
		const body: unknown = JSON.parse(reply.stdout.slice(split).trim());
		return ok({ status, headers, body });
	} catch {
		return fail("Invalid GitHub API response JSON.");
	}
};

const parseLink = (
	segment: string,
	repositoryId: number,
): Result<{ relation: string; page: number }> => {
	try {
		const syntax = /^<([^>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(
			segment.trim(),
		);
		const location = syntax?.[1];
		if (!location) return fail("Invalid GitHub releases pagination link.");
		const url = new URL(location);
		const parsed = z
			.object({
				relation: z.enum(["next", "prev", "first", "last"]),
				origin: z.literal("https://api.github.com"),
				username: z.literal(""),
				password: z.literal(""),
				hash: z.literal(""),
				pathname: z.enum([
					`/${REPOSITORY}/releases`,
					`/repositories/${repositoryId}/releases`,
				]),
				perPage: z.tuple([z.literal(String(PAGE_SIZE))]),
				pages: z.tuple([
					z
						.string()
						.regex(/^[1-9]\d*$/)
						.transform(Number)
						.refine(Number.isSafeInteger),
				]),
				keys: z.array(z.enum(["page", "per_page"])).length(2),
			})
			.safeParse({
				relation: syntax?.[2],
				origin: url.origin,
				username: url.username,
				password: url.password,
				hash: url.hash,
				pathname: url.pathname,
				perPage: url.searchParams.getAll("per_page"),
				pages: url.searchParams.getAll("page"),
				keys: [...url.searchParams.keys()],
			});
		return parsed.success
			? ok({ relation: parsed.data.relation, page: parsed.data.pages[0] })
			: fail("Unsafe or ambiguous GitHub releases pagination URL.");
	} catch {
		return fail("Invalid GitHub releases pagination URL.");
	}
};

const validateRelations = (
	relations: Map<string, number>,
	page: number,
): Result<number | null> => {
	const next = relations.get("next") ?? null;
	const last = relations.get("last");
	if (
		(next !== null && next !== page + 1) ||
		(relations.has("prev") && relations.get("prev") !== page - 1) ||
		(relations.has("first") && relations.get("first") !== 1) ||
		(last !== undefined &&
			(last < page ||
				(last > page && next === null) ||
				(next !== null && next > last)))
	)
		return fail("Inconsistent/incomplete GitHub releases pagination.");
	if (
		(next !== null && next > MAX_PAGES) ||
		(last !== undefined && last > MAX_PAGES)
	)
		return fail(
			"GitHub releases listing exceeds its bounded discovery limit; absence is not proven.",
		);
	return ok(next);
};

const nextPage = (
	headers: string,
	page: number,
	repositoryId: number,
): Result<number | null> => {
	const values = [...headers.matchAll(/^link:\s*(.*)$/gim)];
	if (!values.length) return ok(null);
	if (values.length !== 1)
		return fail("Ambiguous GitHub releases pagination headers.");
	const relations = new Map<string, number>();
	for (const segment of (values[0]?.[1] ?? "").split(/,\s*(?=<)/)) {
		const link = parseLink(segment, repositoryId);
		if (!link.ok) return link;
		if (relations.has(link.value.relation))
			return fail("Duplicate GitHub releases pagination relation.");
		relations.set(link.value.relation, link.value.page);
	}
	return validateRelations(relations, page);
};

/** Every release, drafts included, which only an authenticated listing with push access shows. */
const listReleases = async (
	request: Request,
): Promise<Result<GitHubRelease[]>> => {
	const access = await request(REPOSITORY);
	if (!access.ok) return access;
	const authenticated = decode(access.value);
	if (!authenticated.ok) return authenticated;
	const repository = z
		.object({
			id: z.number().int().positive().safe(),
			full_name: z.literal("davidpp/kabane"),
		})
		.safeParse(authenticated.value.body);
	// Public/read-only listings omit drafts, so the listing must be authenticated. The repository's
	// `permissions` can't prove push access: the Actions token that publishes, whose job holds
	// `contents: write` and does see drafts, is told every permission is false.
	if (authenticated.value.status !== 200 || !repository.success)
		return fail(
			"Authenticated push access is required to discover drafts; absence is not proven.",
		);
	const seen = new Set<number>();
	const all: GitHubRelease[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const result = await request(
			`${REPOSITORY}/releases?per_page=${PAGE_SIZE}&page=${page}`,
		);
		if (!result.ok) return result;
		const response = decode(result.value);
		if (!response.ok) return response;
		const releases = z
			.array(Release)
			.max(PAGE_SIZE)
			.safeParse(response.value.body);
		if (response.value.status !== 200 || !releases.success)
			return fail(
				"Invalid or incomplete GitHub releases listing; absence is not proven.",
			);
		const next = nextPage(response.value.headers, page, repository.data.id);
		if (!next.ok) return next;
		if (next.value !== null && releases.data.length !== PAGE_SIZE)
			return fail("Partial GitHub releases page; absence is not proven.");
		for (const release of releases.data) {
			if (seen.has(release.id))
				return fail(
					"Repeated release in GitHub listing; pagination is ambiguous.",
				);
			seen.add(release.id);
			all.push(release);
		}
		if (next.value === null) return ok(all);
	}
	return fail(
		"GitHub releases listing was not fully consumed; absence is not proven.",
	);
};

const listDraft = async (
	tag: string,
	request: Request,
): Promise<Result<GitHubRelease | null>> => {
	const releases = await listReleases(request);
	if (!releases.ok) return releases;
	const matching = releases.value.filter((release) => release.tag_name === tag);
	const [only] = matching;
	if (matching.length > 1 || (only && !only.draft))
		return fail(
			"Duplicate matching release or conflicting published/tag metadata.",
		);
	return ok(only ?? null);
};

const STABLE_TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;

/**
 * The highest `X.Y.Z` among the published releases' `vX.Y.Z` tags, or null when none is published:
 * where the next version starts and what a new release must pass. A draft or a beta does not count.
 */
export const highestStableRelease = (
	releases: readonly Pick<GitHubRelease, "tag_name" | "draft">[],
): string | null => {
	let highest: string | null = null;
	for (const release of releases) {
		const version = STABLE_TAG.exec(release.tag_name)?.[1];
		if (
			release.draft ||
			!version ||
			!version.split(".").every((part) => Number.isSafeInteger(Number(part)))
		)
			continue;
		if (highest === null || compareVersions(version, highest) > 0)
			highest = version;
	}
	return highest;
};

/** The highest published stable release on GitHub (`highestStableRelease`). */
export const readHighestStableRelease = async (
	request: Request,
): Promise<Result<string | null>> => {
	const releases = await listReleases(request);
	return releases.ok ? ok(highestStableRelease(releases.value)) : releases;
};

/** The tag endpoint returns published releases only; authenticated listing is the draft lookup. */
export const discoverGitHubRelease = async (
	tag: string | null,
	request: Request,
): Promise<Result<GitHubRelease | null>> => {
	if (!tag) return fail("A release tag is required for GitHub discovery.");
	const lookup = await request(
		`${REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`,
	);
	if (!lookup.ok) return lookup;
	const response = decode(lookup.value);
	if (!response.ok) return response;
	if (response.value.status === 404) return listDraft(tag, request);
	const published = Release.safeParse(response.value.body);
	return published.success &&
		published.data.tag_name === tag &&
		!published.data.draft
		? ok(published.data)
		: fail("Invalid/conflicting published GitHub release metadata.");
};
