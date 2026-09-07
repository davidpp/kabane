/**
 * `traced()` — span wrapper for orchestration entry points.
 *
 * Delegates to the tracer the host configured through `Runtime`. The lookup
 * happens per call, not at definition time, so a module can wrap its exports
 * at import and a host can still configure tracing afterwards.
 */

import type { Result } from "./result";
import { Runtime, type TracedOptions } from "./runtime";

export type { TracedOptions } from "./runtime";

export const traced = <TArgs extends unknown[], TReturn>(
	spanName: string,
	fn: (...args: TArgs) => Promise<Result<TReturn>>,
	options?: TracedOptions<TArgs, TReturn>,
): ((...args: TArgs) => Promise<Result<TReturn>>) => {
	return (...args: TArgs) => Runtime.tracer()(spanName, fn, options)(...args);
};
