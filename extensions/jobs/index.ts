/**
 * @kabane/jobs
 *
 * The jobs extension: recipes from a project's `.kabane/recipes/`, each naming a project skill
 * or carrying its own prompt, `kabane run` to start one in an hc terminal, `kabane runs` to list,
 * read, send to, attach to and stop those runs, and `kabane job` to start one on a schedule.
 * Base kabane ships none of it; enabled, it loads from `$KABANE_HOME/extensions/jobs`.
 */

export { jobs as default } from "./src/extension";
