/**
 * @kabane/dispatch
 *
 * The dispatch extension: the dispatch skill template, the setup-dispatch skill that fills a
 * project's dispatch skill from it, the grill skill that walks the human through open questions,
 * the `/setup-dispatch` shortcut, `kabane dispatch stamp`, and the `kabane doctor` checks that say a
 * project's copy is behind. Base kabane ships none of it; enabled, it loads from
 * `$KABANE_HOME/extensions/dispatch`.
 */

export { dispatch as default } from "./src/extension";
