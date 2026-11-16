// The loop's on-disk question format: optional JSON metadata followed by the displayed text.
import { z } from "zod";

const PermissionSchema = z.object({
	toolCallId: z.string(),
	title: z.string(),
	options: z.array(
		z.object({ id: z.string(), label: z.string(), kind: z.string() }),
	),
});
export type PermissionRequestMeta = z.infer<typeof PermissionSchema>;
const Metadata = z.object({
	choices: z.array(z.string()).optional(),
	multiSelect: z.boolean().optional(),
	allowFreeform: z.boolean().optional(),
	questionIndex: z.number().optional(),
	totalQuestions: z.number().optional(),
	defaultAnswer: z.string().optional(),
	skipAnswer: z.string().trim().min(1).optional(),
	permission: PermissionSchema.optional(),
});
type Meta = z.infer<typeof Metadata>;
export type ParsedQuestion = Omit<
	Meta,
	"choices" | "multiSelect" | "allowFreeform"
> & {
	question: string;
	choices: string[];
	multiSelect: boolean;
	allowFreeform: boolean;
};
export const formatQuestionBody = (
	question: string,
	metadata: Meta = {},
): string =>
	Object.values(metadata).some((value) => value !== undefined)
		? `\`\`\`json\n${JSON.stringify(metadata)}\n\`\`\`\n\n${question}`
		: question;

export const parseQuestionBody = (body: string): ParsedQuestion => {
	const plain = {
		question: body,
		choices: [],
		multiSelect: false,
		allowFreeform: true,
	};
	const fence = /^```json\n([\s\S]*?)\n```\n?/.exec(body);
	if (!fence?.[1]) return plain;
	let raw: unknown;
	try {
		raw = JSON.parse(fence[1]);
	} catch {
		return plain;
	}
	const parsed = Metadata.safeParse(raw);
	if (!parsed.success) return plain;
	return {
		...parsed.data,
		question: body.slice(fence[0].length).trim(),
		choices: parsed.data.choices ?? [],
		multiSelect: parsed.data.multiSelect ?? false,
		allowFreeform: parsed.data.allowFreeform ?? true,
	};
};
export const answersContext = (id: string): string => `answers ${id}`;
export const isAnswerTo = (context: string | undefined, id: string): boolean =>
	context === answersContext(id);
