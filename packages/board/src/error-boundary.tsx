/** @jsxImportSource @opentui/react */
// A React error boundary. React requires error boundaries to be CLASS components
// (`getDerivedStateFromError` + `render`); `@opentui/react` runs on react-reconciler, which supports
// them. This is the one sanctioned class exception in the TUI — it exists to keep a render throw
// (a bad brief, a markdown parse failure) from tearing down the whole app and stranding the terminal.
import { Component, type ReactNode } from "react";

export type ErrorBoundaryProps = {
	children: ReactNode;
	// Rendered on catch — a static node, or a builder given the thrown error.
	fallback: ReactNode | ((error: Error) => ReactNode);
};

type ErrorBoundaryState = { error: Error | null };

export class ErrorBoundary extends Component<
	ErrorBoundaryProps,
	ErrorBoundaryState
> {
	override state: ErrorBoundaryState = { error: null };

	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { error };
	}

	override render(): ReactNode {
		const { error } = this.state;
		if (error !== null) {
			return typeof this.props.fallback === "function"
				? this.props.fallback(error)
				: this.props.fallback;
		}
		return this.props.children;
	}
}
