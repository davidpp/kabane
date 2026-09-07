/**
 * Result type for operations that can fail.
 * Use this instead of throwing exceptions for expected failures.
 */
export type Result<T, E = Error> =
	| { ok: true; value: T }
	| { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E = Error>(error: E): Result<never, E> => ({
	ok: false,
	error,
});

/** Normalize anything thrown into an Error. */
export const toError = (e: unknown): Error =>
	e instanceof Error ? e : new Error(String(e));

/**
 * Wrap a promise that might throw into a Result.
 *
 * @param errorMapper - Optional function to map caught errors to custom errors
 */
export const tryCatch = async <T>(
	fn: () => Promise<T>,
	errorMapper?: (error: unknown) => Error,
): Promise<Result<T>> => {
	try {
		return ok(await fn());
	} catch (e) {
		return err(errorMapper ? errorMapper(e) : toError(e));
	}
};

/** Synchronous counterpart to `tryCatch`. */
export const trySync = <T>(fn: () => T): Result<T> => {
	try {
		return ok(fn());
	} catch (e) {
		return err(toError(e));
	}
};

export const map = <T, U, E>(
	result: Result<T, E>,
	fn: (value: T) => U,
): Result<U, E> => (result.ok ? ok(fn(result.value)) : result);

export const flatMap = <T, U, E>(
	result: Result<T, E>,
	fn: (value: T) => Result<U, E>,
): Result<U, E> => (result.ok ? fn(result.value) : result);

export const unwrapOr = <T, E>(result: Result<T, E>, defaultValue: T): T =>
	result.ok ? result.value : defaultValue;
