# How the shipped thread kinds reach each host (JCAB-725)

A review of the declaration path for `task`, `issue` and `job`, on `main` at `529d35c4`
(2026-11-28), asked by JCAB-724: can these kinds and their workflow policy leave generic core
for the extension contract, and what is the smallest design that keeps every host right. ADR
[0012](adr/0012-shipped-kinds-stay-declared-in-core.md) records the proposal. This note holds the
evidence. `thread-kind-workflow-boundary.md` (JCAB-709) is the audit this builds on.

## A kind's declaration has three ways in, and only core's carries policy

| Declared by | Where | Shape | Reaches the hub |
|---|---|---|---|
| Core | `CORE_THREAD_KINDS`, `packages/core/schemas/thread-kind.ts:39` | `ThreadKind` plus a private `initialState` and `unlisted` | yes, it is core |
| A module, first-party or an extension's | `KabaneModule.threadKinds`, `packages/core/module.ts:134` | `ThreadKind`, strict: name, label, description | first-party only (`packages/worker/src/hub.ts:95` lists five; the hub never loads an extension) |
| A scope | `registry_thread_kinds` rows, `packages/registry/index.ts:75` | `ThreadKind`, strict, replicated | yes, through sync |

Policy has two readers in generic core: `initialStateOf` (`storage/tasks.ts:257`, for an edit
and the `state: null` refusal at `:259`, and `:272`, for creation) and `UNLISTED_KINDS` (`storage/task-selection.ts:34`),
a constant computed at import from `CORE_THREAD_KINDS`.

## What a real declaration does today, in the sandbox

A throwaway extension `probe` in the sandbox's `KABANE_HOME`, enabled with `kabane config set
extensions probe --layer global`, whose `modules.ts` returns
`[{ name: "probe", threadKinds: [...] }]`. Outputs are trimmed to the relevant lines.

1. **Identity only.** `{ name: "routine", label: "Routine" }`: `registry kinds --json` lists it
   after core's four as `"source": "module:probe"`. `add --kind routine` stores `"kind":
   "routine"` with no `state`, and the default `list` shows `· 🟡 routine JGIT-1 probe routine`.
2. **With policy.** The same kind with `unlisted: true, initialState: "inbox"` stops every
   command that opens the database:
   `module "probe" thread kind "routine": the declaration Unrecognized keys: "unlisted", "initialState"`.
3. **Claiming a shipped name.** `{ name: "job", label: "Job" }` stops the same way:
   `the name is already a core thread kind; pick another`.
4. **A scope's name, then a module's.** `registry publish` of `{"name":"audit","label":"Audit
   (scope)"}`, a thread filed as `audit`, then the module declares `audit` too. Configure
   accepts it (it checks code declarations only). `registry kinds` lists the module's label and
   puts the scope's under `shadowed` with `"by": "module:probe"`. The stored thread is
   unchanged.
5. **Provider disabled.** `config set extensions ""`: `list` still shows both threads under
   their stored kind names, and `show JGIT-1` prints `Kind: routine`.
6. **Job with the jobs extension off.** `add --kind job --state next` stores it. `list --state
   next` answers `No tasks found.` and `list --kind job` shows `⏭️ 🟡 ⏱JGIT-3 a job`.
7. **State changes.** On `routine`: `edit --state done` gives `"state": "done"`, and `edit --state
   none` takes it away. `edit --kind issue` lands it in `"state": "inbox"`. On the job, `edit
   --state none` is refused: `A job keeps a state: only a kind with no workflow can have it taken
   away`.
8. **The board**, under tmux at 100×30. With the probe on, the `threads` section reads
   `JGIT-2 an audit · audit (module)` and `JGIT-1 probe routine · routine`, and the bar shows
   `1 tracker │ 2 jobs` with the jobs extension off. With the probe off, the same rows read
   `audit (scope)`, which is the shadowed scope label taking over, and `routine`, the stored name.

On the hub, `hub-mcp.test.ts` ("publishes a scope's thread kind and lists it with core's for a
hub-only agent") runs `kabane_threadKinds` through the Durable Object and gets
`core:thread, core:task, core:issue, core:job, scope:signal`. It passes on this tree
(`bunx vitest run src/hub-mcp.test.ts -t "thread kind"`). The hub honors job exclusion because
the listing code is the same core as on a device. No Worker test checks it, and this review did
not run `wrangler dev` to see it.

## Moving the policy out of core breaks three things

**The job has no owner outside core that every host registers.** ADR 0010 and JCAB-709 require a
job to stay out of default listings and work queues where the jobs extension is off, and on the
hub. The jobs extension can't carry that policy: when it is disabled its module is not
registered, and the hub never registers it. Only a first-party data module would work, and that
module would have to be on every host.

**Every host would have to remember the owner, and core cannot be one of them.**
`scripts/layers.ts:18-26` gives `@kabane/core` no dependencies and only `@kabane/sqlite` as a dev
dependency, so `packages/core/testing.ts:31` cannot register a data module package. Core's
storage tests would need their own copy of the declaration. With the three policy fields
stripped from `CORE_THREAD_KINDS`, `bun test packages` fails 32 of 2473 tests. That count is what
a forgotten registration looks like in tests. In a host, the same omission raises no error: it
creates stateless tasks and lists jobs. Today the hosts are `packages/cli/src/context.ts:77` and
`packages/worker/src/hub.ts:95`, and any test that calls `Runtime.configure` with its own
module list is a host too.

**`task` has no single owner.** The loop owns claim and ready for issues
(`extensions/loop/src/plan.ts`). The questions module requires an issue
(`packages/questions/storage.ts:290`). The jobs extension owns scheduling. Nothing owns `task`,
because a human's GTD work is the record's default (`ItemKindSchema.default("task")`,
`schemas/task.ts:159`). For context: on 2026-11-25, before JCAB-724 was filed, David said on
JCAB-702 that the task kind's own features can stay in core. `record-primitives.md` ("Kinds and
keys are declared as data") sets the precedent that core's own kinds are written "in the same
declaration format", not moved out of core.

## Where this sits against the North Stars and ADR 0010

North Star 1 puts practice outside the base. The practice tied to these kinds is already
outside it: claiming, scheduling, dispatch and questions. What stays in core is the record's
default reading of a kind, a starting state and a listing default. ADR 0010 says that reading
must hold without any extension.

ADR 0010's "Shipped and project-defined kinds use the same declaration contract" holds for
identity: name, label and description use one schema everywhere. It does not hold for policy,
which only core can declare. That gap is the one honest reason to change the API, and the
question to David is whether to close it before anything needs it.

## Which problem would justify an API change

Only one: a module or extension that wants a kind of its own to start in a state or to stay out
of default listings. Nothing in the repository asks for that today. The probe in step 2 shows
what an author gets now: a stop line, not silent misbehavior. The shipped kinds already use the
same identity contract that modules and scopes use. Their policy is the one difference, and it
is code-only so that it holds without the extension (ADR 0010).

If that need arrives, the smallest change is to let a code declaration carry the two fields:

```ts
// packages/core/schemas/thread-kind.ts: what code declares, core's and a module's
export type CodeThreadKind = ThreadKind & { initialState?: TaskState; unlisted?: true };
// KabaneModule.threadKinds?: readonly CodeThreadKind[]; initialStateOf and an unlistedKinds()
// read core's, then Runtime.threadKinds(), at call time instead of at import.
```

An extension author would then write, in `modules.ts`:

```ts
export default () => [
	{ name: "routines", threadKinds: [{ name: "routine", label: "Routine", initialState: "inbox", unlisted: true }] },
];
```

It is additive under api 1. The new fields are optional, and every declaration that loads today
still loads. A module that uses them will fail on a host older than the change, with the
`Unrecognized keys` stop line from step 2.

Acceptance for JCAB-726, if David picks it, using the sandbox probe above:

- `routine` with `initialState: "inbox", unlisted: true` loads, and `add --kind routine` lands in
  `inbox`.
- The default `list` leaves it out. `list --kind routine` shows it, and `edit --state none` is
  refused on it.
- With the probe disabled, a new `routine` is stateless and listed, and the stored row from
  before keeps its state.
- `registry kinds` still prints identity only, and the job steps 6 and 7 above are unchanged.

The costs, stated before anyone builds it:

- The hub would honor such a kind's policy only for a first-party module. An extension's
  `routine` would be listed by hub-only agents and created stateless there. This is the same
  default reading an unregistered entry kind gets (`ARCHITECTURE.md`, "Entry kinds").
- Disabling the extension sends new writes of the kind back to stateless and listed. Rows keep
  their state. `state: null` would no longer be refused on them.
- Scope declarations stay identity-only. A replicated `unlisted` would make every listing read
  registry rows per scope, and how declarations replicate is JCAB-704's question.

## Every remaining literal, with a verdict

| Where | What | Verdict |
|---|---|---|
| `core/schemas/thread-kind.ts` | the four declarations, `initialState`, `unlisted` | stays: the record's defaults, and the only owner every host and test has |
| `core/schemas/task.ts:159` | `kind` defaults to `task` | stays: record default (JCAB-709) |
| `core/storage/plans.ts:157` | `kabane_apply` threads default to `issue` | stays: record default (JCAB-709) |
| `core/mcp/tools.ts:140`, `:966` | tool and server text naming the kinds | stays: describes core's declarations |
| `core/storage/stats.ts:109` | stale `in_progress` counts issues only | stays: no production caller (JCAB-709) |
| `cli/src/first-run.ts:127` | the welcome thread is an issue | stays: host content |
| `board/src/data.ts:299` | Jobs tab reads `kind: "job"` | stays: ADR 0010 asks for stored jobs without the extension |
| `board/src/data.ts:381`, `registry/index.ts:70`, `:177` | merge core's with modules' | stays |
| `questions/storage.ts:290` | questions need an issue | stays: the module's own policy |
| `extensions/loop/src/*` | `kind === "issue"` in claim, plan, checks | stays: the loop's behavior on its kind |
| `extensions/jobs/src/*` | `kind === "job"` / `"issue"` | stays: the extension's behavior |

## How this meets the neighbouring issues

- **JCAB-702** (attribute keys as data): it adds a declaration seam for keys like the one
  modules have for kinds. Neither design here changes `ThreadKind`'s replicated shape, so 702 is
  not blocked. If 702 adds a schema to kind declarations, it adds it to `ThreadKind`, which both
  designs keep.
- **JCAB-704** (where declarations live and whether they sync): this review keeps scope
  declarations identity-only, so it decides nothing that 704 owns.
- **JCAB-461** (capabilities: first-party, off until enabled): a capability that is a data module
  runs on the hub. A switched-off `job` capability would still have to keep jobs out of default
  listings, so policy for kinds that must hold everywhere stays core's even with 461.
