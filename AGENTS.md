Read `CLAUDE.md` first for the repository map and the gate, then `CODING_PRINCIPLE.md`
for the rules and invariants the code holds. Both are versioned in this repository.

For project, code, or pull-request reviews, use
`.agents/skills/review-oss-typescript/SKILL.md` and judge the repository as a
public TypeScript project.

## Validating a UI change

Look at a component with the gallery. It prints the frame the render tests capture, at a
size and theme you pick. Add a story to `packages/board/src/stories/index.tsx` when the
state you changed has none, and build it from the fixtures in `stories/fixtures.ts`:

```bash
bun run gallery --list
bun run gallery --print form-described --width 80 --theme dark
bun run gallery --print permission --width 40 --theme light --ansi   # with its colors
```

Drive a flow in the real board under tmux, on its own socket and at fixed dimensions,
with the copilot on the scripted agent (keywords in `packages/acp/scripts/scripted-agent.ts`):

```bash
tmux -L ui new-session -d -s board -x 100 -y 30 'bun run sandbox --scripted board'
sleep 4
tmux -L ui send-keys -t board Tab
tmux -L ui send-keys -t board -l 'ask form'
tmux -L ui send-keys -t board Enter
sleep 2
tmux -L ui capture-pane -p -t board      # the form, as the human sees it
tmux -L ui send-keys -t board 2          # answer it the way a human would
tmux -L ui send-keys -t board Enter      # and leave its optional Other box empty
sleep 1
tmux -L ui capture-pane -p -t board      # the copilot's row says what the agent received
tmux -L ui send-keys -t board q          # quit the board, which ends the session
```

`o` on the board opens the copilot's transcript, with every turn and what the agent
received. Send `Escape` on its own and wait before the next key: an escape followed at once
by a key arrives as alt and that key. Use your own `-L` socket and never `kill-server`
without one: the default server holds the human's sessions. Mouse clicks are out of reach here; list them as a manual check.
A scripted ask does not prove a real harness sends that shape, so a change to how asks
arrive still needs a run against a real one.
