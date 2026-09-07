#!/usr/bin/env bun
/** `cabane` binary. Everything lives in src/. */
import { main } from "./src/main";

process.exit(await main(process.argv.slice(2)));
