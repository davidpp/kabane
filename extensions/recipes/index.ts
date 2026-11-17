/**
 * @cabane/recipes
 *
 * The recipes extension: prompt recipes from a project's `.kabane/recipes/`, `kabane run` to start
 * one in an hc terminal, and `kabane runs` to list, read, send to, attach to and stop those runs.
 * Base kabane ships none of it; enabled, it loads from `$KABANE_HOME/extensions/recipes`.
 */

export { recipes as default } from "./src/extension";
