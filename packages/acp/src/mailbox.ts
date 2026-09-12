// A queue a turn's generator drains alongside the harness's own stream.
//
// It exists for exactly one reason: a `session/request_permission` arrives on its own JSON-RPC
// call, and the agent is BLOCKED on the answer — so no further session update can come until the
// human has answered. Anything appended to the outgoing stream at that moment therefore has to
// wake the generator itself; waiting to piggyback on the next harness update would deadlock, the
// update being precisely what the unsent answer is holding up.
export namespace Mailbox {
	export type Mailbox<T> = {
		push: (item: T) => void;
		// Everything queued, in arrival order, leaving the box empty.
		drain: () => T[];
		// Settles the next time something is pushed — already settled when the box is not empty, so
		// racing it never sleeps on items already in hand.
		filled: () => Promise<void>;
	};

	export const create = <T>(): Mailbox<T> => {
		const queue: T[] = [];
		let wake: (() => void) | null = null;
		return {
			push: (item) => {
				queue.push(item);
				const waiting = wake;
				wake = null;
				waiting?.();
			},
			drain: () => queue.splice(0),
			filled: () =>
				queue.length > 0
					? Promise.resolve()
					: new Promise<void>((resolve) => {
							wake = resolve;
						}),
		};
	};
}
