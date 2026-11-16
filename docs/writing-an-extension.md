# Writing an extension

An extension is a directory with a `package.json` and an entry module whose default export is a
factory. Kabane calls the factory with a `host` object, API version 1, and the factory returns
what the extension adds. Any of these, all optional:

| Field | What kabane does with it |
|---|---|
| `commands` | lists each one in `kabane --help` and runs it as `kabane <name>` |
| `settings`, `looks` | a settings namespace named after the extension, in every [settings layer](../packages/cli/README.md#settings-layers), `kabane config` and the board's `,` screen |
| `mcp` | MCP tools named `kabane_<extension>_<verb>`, served by `kabane mcp` beside kabane's own |
| `doctor` | checks that `kabane doctor` runs, reported under the extension's name |
| `board` | an activity source, a dispatcher for `a`, and card headers on the board ([board README](../packages/board/README.md)) |

Two more come from files rather than the factory: markdown files under `copilot/` give the
board's copilot procedures and `/` shortcuts, and a second entry, `modules`, declares tables the
extension keeps in the tracker's database.

The walkthrough below builds the `notes` extension that kabane's own tests install
(`packages/cli/src/extension-fixture.ts`): a `kabane notes` command that keeps notes on a task in
a table of its own. It leaves out the two verbs that exist only to test transactions, and keeps
the task id in a constant so the file typechecks. It runs the same through Bun and on the
standalone binary.

## Make the directory and its manifest

Kabane loads an extension from `$KABANE_HOME/extensions/<name>/`, or from a symlink there. Keep
the source where you like and link it in:

```bash
mkdir notes && cd notes
mkdir -p "${KABANE_HOME:-$HOME/.kabane}/extensions"
ln -s "$PWD" "${KABANE_HOME:-$HOME/.kabane}/extensions/notes"
```

`package.json` holds the manifest under `kabane`: the entry, the API it is written against, and
the modules entry, which only an extension with tables of its own has.

```json
{
	"name": "notes",
	"kabane": {
		"extension": "./index.ts",
		"api": 1,
		"modules": "./modules.ts"
	}
}
```

Kabane reads the manifest and checks `api` before it imports any code, and it imports nothing
from a directory that is not enabled.

## Keep the extension's data in the tracker

`modules.ts` default-exports a factory that returns the extension's data modules. This one
creates one table and declares it replicated, so its rows sync to your other devices like
kabane's own:

```ts
import type { Host, KabaneModule } from "kabane/extension";
import { NOTES } from "./table.ts";

export default (host: Host): KabaneModule[] => [
	{
		name: "notes",
		migrations: [
			{
				name: "create-extension-notes",
				up: (db) =>
					db.run(
						`CREATE TABLE IF NOT EXISTS ${NOTES} (
						   id TEXT PRIMARY KEY,
						   task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
						   body TEXT NOT NULL,
						   updated_at TEXT NOT NULL,
						   updated_by TEXT,
						   version INTEGER NOT NULL DEFAULT 1,
						   visibility TEXT NOT NULL DEFAULT 'shared'
						 )`,
					),
			},
		],
		syncTables: [
			{ table: NOTES, family: "row-lww", clock: "updated_at", childOfTasks: true },
		],
	},
];
```

`table.ts` holds the table's name, which both entries import:

```ts
export const NOTES = "extension_notes";
```

A replicated table needs an `id` primary key and the columns `updated_by`, `version` and
`visibility`; a `private` row never leaves the device. `row-lww` keeps the row with the latest
`clock` value when two devices write the same one. `childOfTasks` says `task_id` points at a task,
so deleting the task deletes its notes on every device.

Every command that opens the database imports the modules entry of every enabled extension,
`kabane list` included. Keep it to what the modules need. When it fails to load, those commands
stop with one line that names the extension; `config`, `doctor` and `--help` still run, so you
can repair it or take it off the `extensions` list.

## Write the factory and a command

`index.ts` default-exports the factory. The extension's `name` must match its directory:

```ts
import type { Extension, Host } from "kabane/extension";
import { NOTES } from "./table.ts";

export default (host: Host): Extension => ({
	name: "notes",
	commands: [
		{
			name: "notes",
			usage: "kabane notes add <task> <text> | kabane notes list <task>",
			summary: "Notes on a task, kept by the notes extension's data module",
			run: async (args, ctx) => {
				const [verb, id, ...words] = args.positionals;
				if (!id) return host.outcome.usage("a task id is required", "kabane notes add <task> <text>");
				const task = await host.record.get({ id });
				if (!task.ok) return host.outcome.failure(task.error);
				if (!task.value) return host.outcome.failure(new Error("No task found: " + id));
				const taskId = task.value.id;
				if (verb === "add") {
					const noteId = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
					const written = await host.store.write((tx) => {
						tx.db.run(
							`INSERT INTO ${NOTES} (id, task_id, body, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)`,
							[noteId, taskId, words.join(" "), new Date().toISOString(), ctx.actor],
						);
						const captured = tx.afterWrite(NOTES, "insert", noteId);
						return captured.ok ? host.result.ok(noteId) : captured;
					});
					return written.ok
						? host.outcome.success({ id: written.value }, `noted ${written.value}`)
						: host.outcome.failure(written.error);
				}
				const read = await host.store.read((db) =>
					host.result.ok(
						db
							.query(`SELECT body FROM ${NOTES} WHERE task_id = ? ORDER BY updated_at, id`)
							.all(taskId)
							.map((row) => String((row as { body: unknown }).body)),
					),
				);
				return read.ok
					? host.outcome.success({ notes: read.value }, read.value.join("\n"))
					: host.outcome.failure(read.error);
			},
		},
	],
});
```

What the command uses from `host`:

- `host.record` calls kabane's MCP operations (`get`, `list`, `edit`, `comment`, `done` and the
  rest) as the invoking actor. `host.record.call(name, input)` reaches any registered tool.
- `host.store.write` runs one transaction on the extension's own tables. End each insert or
  update with `tx.afterWrite`, which records the change for sync. The callback runs inside the
  database's write lock: do not await anything in it, and do not write again from inside it.
- `host.store.read` reads on a connection that refuses writes.
- `host.outcome.success(data, text)` prints `text`, or `data` as JSON under `--json`.
  `host.outcome.usage` and `host.outcome.failure` exit non-zero.
- `ctx` carries the invocation: `ctx.actor`, `ctx.cwd`, `ctx.home` and `ctx.settings`.

The full list of what the host provides is in [`packages/extension/README.md`](../packages/extension/README.md).

## Enable it and run the command

Add `notes` to the extensions you already have, since a `set` replaces the whole list:

```bash
kabane config set extensions loop,dispatch,notes --layer global
```

`kabane --help` now ends with:

```text
  notes     Notes on a task, kept by the notes extension's data module
```

From a project where you use kabane, on one of its tasks:

```text
$ kabane add "Write the README" --kind issue
✓ Created 📥 🟡 🔧JGIT-1  Write the README
$ kabane notes add JGIT-1 The install section is next
noted mwj1oing-5515e3ad-f06a-41bd-80e0-2b544ec8fa4b
$ kabane notes list JGIT-1 --json
{
  "notes": [
    "The install section is next"
  ]
}
$ kabane notes
Error: a task id is required
Usage: kabane notes add <task> <text>
```

The notes live in `kabane.db`, in the `extension_notes` table the migration created.

## Check it with TypeScript

`kabane/extension` is the extension contract's types, published in the `kabane` npm package. The
`1.0.0-beta.0` package on npm does not have them yet; until a release does, build kabane from a
checkout (`bun run build` at its root) and add that build as a dev dependency:

```bash
bun add -d /path/to/kabane/packages/cli/dist typescript@5.9.3 @types/bun@1.4.0
```

The imports are `import type`, so the extension loads with or without them installed. A
`tsconfig.json` such as this one typechecks the walkthrough's files with `bunx tsc -p .`:

```json
{ "compilerOptions": { "strict": true, "module": "Preserve", "moduleResolution": "bundler", "target": "ESNext", "noEmit": true, "allowImportingTsExtensions": true, "types": ["bun"] } }
```

## Add a setting and an MCP tool

Kabane's tests load this extension to check both (`packages/cli/src/extensions.test.ts`):

```ts
import type { Extension, Host } from "kabane/extension";

export default (host: Host): Extension => ({
	name: "hostzod",
	settings: host.z.object({ word: host.z.string().default("hello") }),
	mcp: async () => ({
		tools: [
			host.defineTool({
				name: "kabane_hostzod_echo",
				description: "Echo a word",
				kind: "read",
				input: { word: host.z.string().min(1) },
				handler: async ({ word }) => host.result.ok({ word }),
			}),
		],
	}),
});
```

Build settings and tool inputs with `host.z`, kabane's own zod, even when the extension installs
zod itself. Every key needs a default or has to be optional, because each layer sets only some.
Once the extension is enabled, its keys are in `kabane config` like kabane's:

```text
$ kabane config set hostzod.word bonjour --layer global
hostzod.word = bonjour (global)
$ kabane config get hostzod.word
bonjour
```

A command, a check or a tool reads them for a project through `ctx.settings`, as the loop's
doctor check does (`extensions/loop/src/doctor.ts`):

```ts
const config = await ctx.settings(
	LoopConfig.NAMESPACE,
	LoopConfig.schemas(host.z).SettingsSchema,
	{ projectDir: root ?? ctx.cwd },
);
```

`kabane mcp` serves the tool to every coding agent connected to this device. A `tools/call` of
`kabane_hostzod_echo` with `{"word":"hi"}` returns `{"word": "hi"}`. The loop's
`kabane_loop_advise` (`extensions/loop/src/mcp.ts`) is a fuller one. A running `kabane mcp` picks
up a new tool only when it restarts, which for a coding agent means a new session.

## Add a doctor check

`doctor(ctx)` returns findings, each with a kebab-case `id` unique within the extension, a
`summary`, a `severity`, and, optionally, a `route` or a `fix`. This is the dispatch extension's
finding for a project with no dispatch skill (`extensions/dispatch/src/doctor.ts`):

```ts
{
	id: "dispatch-skill-missing",
	severity: "suggest",
	summary:
		"No dispatch skill in .agents/skills/dispatch or .claude/skills/dispatch.",
	route: `${SETUP} writes one`,
},
```

`kabane doctor` prints it under the extension's name:

```text
suggest:
  dispatch/dispatch-skill-missing: No dispatch skill in .agents/skills/dispatch or .claude/skills/dispatch. → /setup-dispatch writes one
```

The severities, fixes and reserved ids are in
[`packages/extension/README.md`](../packages/extension/README.md#doctor-checks).

## Teach the board's copilot

Markdown files in the extension's directory add to the copilot's instructions:
`copilot/procedures/<name>.md`, with a `title` in its frontmatter, and
`copilot/shortcuts/<name>.md`, with a `hint`, whose one-line body is what `/<name>` puts in the
prompt. The dispatch extension's `/setup-dispatch` is
`extensions/dispatch/copilot/shortcuts/setup-dispatch.md`:

```markdown
---
hint: write this project's dispatch skill
---
Set up a dispatch skill for this project: read its CLAUDE.md/AGENTS.md, gate commands and agents, then write .agents/skills/dispatch/ from the dispatch extension's template and show me what you wrote.
```

`{{extension}}` in a file becomes the extension directory's absolute path, so a procedure can
point the copilot at a file the extension ships. The `description` in `package.json` is how the
copilot describes the extension to you; keep it under 200 characters. What kabane refuses in
these files is in the [board README](../packages/board/README.md), under its copilot.

## Run it on the standalone binary

The binary loads TypeScript entries, and the walkthrough's `notes` runs on it unchanged. It
resolves no package from disk, though: an extension that imports one, as the loop imports
kabane's workspace packages, has to be bundled with its dependencies inlined. The loop and
dispatch each do that with a `scripts/build.ts` that calls `Bun.build` with `target: "bun"`,
writes a `package.json` whose `extension` is `./index.js`, and copies the `copilot/` files and
whatever else the extension reads at run time into `dist/`.

When an extension fails to load, kabane names it and the reason in one line, loads the others,
and lists it in `kabane doctor` as `<name>/extension-refused`.
