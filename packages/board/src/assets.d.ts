// What a `with { type: "file" }` import of a tree-sitter asset gives: the file's path.
declare module "*.scm" {
	const path: string;
	export default path;
}
declare module "*.wasm" {
	const path: string;
	export default path;
}
