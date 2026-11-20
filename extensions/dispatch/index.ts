/**
 * @cabane/dispatch
 *
 * The dispatch extension: the dispatch and grill skill templates, the setup-dispatch skill that
 * fills a project's dispatch skill from them, the copilot procedure that grills the human through
 * its open questions, the `/setup-dispatch` shortcut, `kabane dispatch stamp`, and the `kabane doctor` checks that say a
 * project's copy is behind. Base kabane ships none of it; enabled, it loads from
 * `$KABANE_HOME/extensions/dispatch`.
 */

export { dispatch as default } from "./src/extension";
