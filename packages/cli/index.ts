#!/usr/bin/env -S bun --define process.env.NODE_ENV:"production"
/**
 * `kabane` binary. Everything lives in src/.
 *
 * Run from source, as a linked checkout is, Bun would load React's development build, which keeps
 * native memory for every element rendered: a board re-rendering a run's tab grew by gigabytes an
 * hour. The define gives the source run the production build the published bundle has, without
 * putting NODE_ENV in the environment every harness and gate this process starts inherits.
 */
import { main } from "./src/main";

process.exit(await main(process.argv.slice(2)));
