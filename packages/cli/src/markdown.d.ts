// A markdown file imported `with { type: "text" }` is its text (src/skills.ts).
declare module "*.md" {
	const text: string;
	export default text;
}
