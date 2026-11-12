// The control channel of a running board: a Unix socket named after the board's pid, which takes
// one request per connection and answers it on the same one. `kabane board` listens while its board
// runs, and `kabane board --issue <id> --to <pid>` sends `{"open":"<id>"}\n`. The board answers
// `{"opened":"<shortId>"}\n` or `{"error":"<one line>"}\n`. Nothing here knows the board: the host
// hands `listen` what opening an id does.
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "@cabane/core";
import { z } from "zod";

export namespace BoardControl {
	// A Unix socket's path fits in `sun_path`: 104 bytes on macOS with the trailing NUL, 108 on Linux.
	const SUN_PATH_MAX = 103;
	// A board answers from its own tracker, so a reply slower than this is a board that is stuck.
	const REPLY_TIMEOUT_MS = 5000;
	// An id is a few dozen bytes; a request this long without its newline is not one.
	const REQUEST_MAX = 4096;

	const Request = z.object({ open: z.string().min(1) });
	const Reply = z.union([
		z.object({ opened: z.string() }),
		z.object({ error: z.string() }),
	]);
	type Reply = z.infer<typeof Reply>;

	/**
	 * Where the board running as `pid` listens: `<home>/run/board-<pid>.sock`, else the temp dir when
	 * that path is too long for a socket. Client and board both derive it, so a client finds the
	 * boards of its own KABANE_HOME.
	 */
	export const socketPath = (home: string, pid: number): string => {
		const own = join(home, "run", `board-${pid}.sock`);
		return Buffer.byteLength(own) <= SUN_PATH_MAX
			? own
			: join(tmpdir(), `kabane-board-${pid}.sock`);
	};

	type Listener = { close(): void };

	/** What opening an id does: the opened task's short id, or why it did not open, in one line. */
	type Open = (id: string) => Promise<Result<string>>;

	const line = (reply: Reply): string => `${JSON.stringify(reply)}\n`;

	const json = (text: string): unknown => {
		try {
			return JSON.parse(text);
		} catch {
			return undefined;
		}
	};

	const BAD_REQUEST: Reply = { error: 'expected {"open":"<id>"}' };

	const answer = async (request: string, open: Open): Promise<Reply> => {
		const parsed = Request.safeParse(json(request));
		if (!parsed.success) return BAD_REQUEST;
		const opened = await open(parsed.data.open);
		return opened.ok
			? { opened: opened.value }
			: { error: opened.error.message };
	};

	/**
	 * Listen at `path` until `close`. A socket left there by a board that died with this pid is
	 * replaced. The socket goes on `close`, and on any exit of the process that skips it (an uncaught
	 * error); only SIGKILL leaves it behind, and `send` clears that one.
	 */
	export const listen = (path: string, open: Open): Result<Listener> => {
		const remove = (): void => rmSync(path, { force: true });
		let server: { stop(closeActive: boolean): void } | undefined;
		try {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			remove();
			// `request` is null once the connection's one request is being answered.
			server = Bun.listen<{ request: string | null }>({
				unix: path,
				socket: {
					open: (socket) => {
						socket.data = { request: "" };
					},
					data: (socket, chunk) => {
						if (socket.data.request === null) return;
						const received = socket.data.request + chunk.toString();
						const end = received.indexOf("\n");
						if (end === -1 && received.length <= REQUEST_MAX) {
							socket.data.request = received;
							return;
						}
						socket.data.request = null;
						if (end === -1) {
							socket.end(line(BAD_REQUEST));
							return;
						}
						void answer(received.slice(0, end), open).then((reply) => {
							socket.end(line(reply));
						});
					},
				},
			});
			// Only this user opens issues in their board.
			chmodSync(path, 0o600);
			process.once("exit", remove);
			const listening = server;
			return ok({
				close: () => {
					process.off("exit", remove);
					listening.stop(true);
					remove();
				},
			});
		} catch (cause) {
			server?.stop(true);
			remove();
			return err(
				new Error(
					`could not listen at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
				),
			);
		}
	};

	const codeOf = (cause: unknown): unknown =>
		typeof cause === "object" && cause !== null && "code" in cause
			? cause.code
			: undefined;

	/**
	 * Ask the board running as `pid` to open `id`: the short id it opened, or why not, in one line.
	 * A socket nobody listens on is a board that was killed outright, so it is removed.
	 */
	export const send = async (
		home: string,
		pid: number,
		id: string,
	): Promise<Result<string>> => {
		const path = socketPath(home, pid);
		const none = new Error(`no board running as pid ${pid}`);
		let received = "";
		let finish: (reply: string) => void = () => {};
		const replied = new Promise<string>((resolve) => {
			finish = resolve;
		});
		let socket: { end(): void };
		try {
			socket = await Bun.connect({
				unix: path,
				socket: {
					open: (socket) => {
						socket.write(`${JSON.stringify({ open: id })}\n`);
					},
					data: (_socket, chunk) => {
						received += chunk.toString();
					},
					close: () => finish(received),
					error: () => finish(received),
				},
			});
		} catch (cause) {
			const code = codeOf(cause);
			// Nothing at the path, or a socket left by a board that was killed outright.
			if (code === "ENOENT") return err(none);
			if (code === "ECONNREFUSED") {
				rmSync(path, { force: true });
				return err(none);
			}
			return err(
				new Error(
					`could not reach board pid ${pid} at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
				),
			);
		}
		const timeout = new Promise<null>((resolve) =>
			setTimeout(resolve, REPLY_TIMEOUT_MS, null).unref(),
		);
		const reply = await Promise.race([replied, timeout]);
		socket.end();
		if (reply === null || reply === "")
			return err(new Error(`board pid ${pid} did not answer`));
		const parsed = Reply.safeParse(json(reply));
		if (!parsed.success)
			return err(
				new Error(`board pid ${pid} answered ${JSON.stringify(reply)}`),
			);
		return "opened" in parsed.data
			? ok(parsed.data.opened)
			: err(new Error(parsed.data.error));
	};
}
