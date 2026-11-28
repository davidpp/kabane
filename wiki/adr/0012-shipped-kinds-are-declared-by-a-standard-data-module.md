# 0012: The shipped thread kinds are declared by a first-party data module that both standard hosts register

- Status: accepted
- Date: 2026-11-28
- Issue: JCAB-725, under JCAB-724
- Decided by: David chose the full move and the split between Kabane core and the standard
  distribution (JCAB-725:1, 2026-11-28). claude chose the package name, the field shape and
  the plain host's default kind while drafting; each is open to override.

## Context

JCAB-724 asked to take `task`, `issue` and `job`, and their workflow policy, out of generic
core and put them behind the extension contract. Their behavior already lives with its owners:
the loop claims issues, the jobs extension schedules jobs, and the questions module needs an
issue. Core still declares the three kinds in `CORE_THREAD_KINDS`, with two fields that only
core can set: `initialState`, read when a thread is created or edited, and `unlisted`, read by
default listings. Those fields must hold on a device where the jobs extension is off and on the
hub, which never loads an extension, so that a job never lands in a work queue (ADR 0010,
`wiki/thread-kind-workflow-boundary.md`). The evidence, with a sandbox run of a real extension,
is in `wiki/shipped-kind-declarations.md`.

## Decision

Kabane core declares only the plain `thread`. The standard distribution is core plus the
first-party data modules that both standard hosts register: the device (`MODULES` in
`packages/cli/src/context.ts`) and the hub (`packages/worker/src/hub.ts`). A new data module,
`@kabane/work`, declares `task`, `issue` and `job` with their policy. It is always registered,
so turning off an executable extension such as jobs or loop changes none of this policy.

A module's code declaration may carry the two policy fields, through one contract for every
module:

```ts
// packages/core/schemas/thread-kind.ts
export type CodeThreadKind = ThreadKind & { initialState?: TaskState; unlisted?: true };
// KabaneModule.threadKinds?: readonly CodeThreadKind[]
```

Core reads the policy from the registered declarations when it is needed
(`Modules.initialStateOf`, `Modules.unlistedKinds`), instead of a constant computed at import. Scope declarations stay identity-only (`ThreadKindSchema` strict, replicated).
The change is additive under extension api 1: every declaration that loads today still loads.

Why this design, and not the alternatives in the note:

- The jobs extension cannot own job exclusion, because it is absent wherever it is disabled.
  An always-registered data module is present on both hosts.
- Both hosts already list their data modules explicitly, so adding one changes nothing in how
  hosts are put together. Core's tests register the module as a dev dependency, as core already
  does with `@kabane/sqlite` (`scripts/layers.ts`), so no test keeps a copy of the declarations.
- `@kabane/registry` is a scope's vocabulary, not shipped kinds, so it is not the owner.

## Consequences

- Stored rows keep their kind names, and nothing migrates. On a host without `@kabane/work`,
  `task`, `issue` and `job` rows read under their stored names (ADR 0010), are created stateless
  and are listed.
- `kabane_threadKinds` and `registry kinds` report the three as `module:work`, not `core`.
  `packages/worker/src/hub-mcp.test.ts` asserts the old sources.
- Names are claimed by the module rules: an extension declaring `job` collides with
  `module:work` at configure, and a scope's `job` is shadowed. Core reserves only `thread`.
- The hub's job exclusion now depends on `hub.ts` registering the module, not on shared core
  code. A host that forgets it raises no error. Each standard host gets a test through its real
  entry point (CLI, and the Durable Object over MCP) that a default listing leaves a job out and
  that `add` puts a task in `inbox`.
- An extension can declare a workflow kind of its own. The hub honors that kind's policy only if
  it comes from a first-party module. A hub-only agent lists such a kind and creates it
  stateless, which is how the hub already treats an unregistered entry kind. Disabling that
  extension makes new threads of the kind stateless and listed. Existing rows keep their state.
- Open to override: `kabane_add` still defaults to `task` and `kabane_apply` to `issue`, as
  record defaults. On a plain-core host they name a kind nothing declares.
- Left undecided: whether the standard distribution enables executable extensions by default.
  That is JCAB-461's question, whose capabilities start off until enabled. No installer changes.

## Replaceable by

A per-host default creation kind supplied by the composition, which would remove the last kind
names from core's schemas. It needs a host that ships without `@kabane/work` first.
