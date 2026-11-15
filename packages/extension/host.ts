/** The versioned host supplied to an extension factory. */
export type Host = {
	readonly api: 1;
	readonly kabane: {
		readonly version: string;
		readonly executable: string;
	};
};
