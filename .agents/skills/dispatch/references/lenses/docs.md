# Docs lens

Check that everything a person or an agent reads to use kabane says what the work now does.
The code can be right while the help still describes yesterday.

- List what the work changed that someone outside the code can see: a command, a flag, a
  default, an output or JSON field, an error, a setting, a file kabane reads or writes, a
  board key or view, an MCP tool or its inputs. Take it from the diff, not from the briefs.
- For each, find every place that describes it, and read each as someone who has never seen
  the code:
  - the root `README.md`, `docs/`, and the changed package's `README.md`;
  - the CLI's own help: `bun run sandbox <command> --help`, usage lines, and the errors that
    name a flag or a next step;
  - what an agent reads: MCP tool descriptions and input descriptions, the server
    instructions, the copilot's instructions (`packages/acp/src/instructions.ts`), and the
    templates kabane ships (`packages/acp/templates/`);
  - the board: the `?` sheet, the footer hints, the keymap registry, empty states;
  - a setting's `.describe()` text, which is what `kabane config list` shows;
  - `AGENTS.md`, when a package, a command or the gate changed.
- Run the examples the docs give, in `bun run sandbox`. An example that no longer runs, or
  prints something else, is a finding.
- Search the repository for the old name of anything renamed or removed (`grep`), in docs,
  help text, error messages and templates.
- Check the docs are in the right place and say the right kind of thing. `docs/` and the
  READMEs are for people who use kabane: usage, behaviour, configuration, as it is now. Plans,
  design records and how it used to work go in `wiki/`. A doc that tells the history of a
  change instead of the behaviour is a finding.
- Check that one word means one thing across the docs, the help and the output. A term a
  brief defines (a layer's name, say) is used the same way everywhere a user meets it.

Severity:

- **p1**: a doc, help text or tool description tells the reader to do something that now
  fails, does something else, or writes somewhere else; or a new command, flag, setting or
  tool that a user needs is described nowhere they would look.
- **p2**: a description is stale or incomplete but would not mislead into a wrong action: an
  old name still shown, a default not updated, a new option missing from one of several
  places, internal notes placed in `docs/`.
- **p3**: wording: an unclear sentence, an inconsistent term, an example that works but shows
  the less useful case.

A finding names the file and line (or the command whose help it is), quotes what it says, says
what is true now, and gives the text that would be right.
