// Manual check against a real adapter: `bun run packages/acp/scripts/smoke.ts claude` from any
// directory. Needs that harness installed and logged in; cold-starts npx on the first run.
import { AcpClient, Harnesses } from "../index";

const id = process.argv[2] ?? "claude";
if (!Harnesses.isId(id)) {
	console.error(`unknown harness ${id}; one of ${Harnesses.IDS.join(", ")}`);
	process.exit(2);
}

const conn = await AcpClient.spawn(id, process.cwd(), {
	onPermission: async (request) => {
		console.log(
			`\n[permission] ${request.title}: answering ${request.options[0]?.id}`,
		);
		const first = request.options[0];
		return first
			? { ok: true, value: first.id }
			: { ok: false, error: new Error("no options") };
	},
});
if (!conn.ok) {
	console.error(conn.error.message);
	process.exit(1);
}
const session = await AcpClient.newSession(conn.value, {
	cwd: process.cwd(),
	mcpServers: [],
	systemPromptAppend: "Answer in one short sentence.",
});
if (!session.ok) {
	console.error(session.error.message);
	AcpClient.close(conn.value);
	process.exit(1);
}
console.log(`session ${session.value.id} on ${id}`);
for await (const update of AcpClient.prompt(session.value, [
	{ type: "text", text: "Say hello and name the current directory." },
])) {
	if (update.type === "text") process.stdout.write(update.text);
	else console.log(`\n[${update.type}] ${JSON.stringify(update)}`);
}
console.log();
AcpClient.close(conn.value);
await conn.value.closed;
