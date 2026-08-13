/**
 * explore — locate code. Highest volume, lowest return size.
 * Fast/cheap model, read + gated bash, parallel-safe.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { makeRenderCall, renderResult, type ForemanToolDetails } from "../render.ts";
import { runSubagent } from "../runner.ts";

const SYSTEM_PROMPT = fs.readFileSync(
	path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "explore.md"),
	"utf8",
);

const DESCRIPTION = [
	"Locate code across the repository and return file:line references with a one-line description of each, plus a short map of how they connect. Read-only: does not modify files.",
	"",
	"Delegate to explore when the target is unknown and likely spans >3 files, when two targeted searches have already missed, or when answering yourself would mean several searches and reading multiple large files — that costs many tool calls and tens of thousands of context tokens; explore does it in one call and returns only the summary. This is the context-economy tool: it reads many tokens, returns few.",
	"",
	"Do not use when: the file is already in your context, a single ripgrep would answer it, or you are looking for something you read earlier in this session — search directly instead, it is faster and you keep full fidelity. Do not chain this tool to refine a question; ask one better question. Do not issue parallel calls with overlapping questions.",
].join("\n");

const GUIDELINES = [
	"Use explore when the target is unknown and likely spans >3 files, two targeted searches have already missed, or the same question would require reading several large files. Reading many files in-thread when explore would answer in one call is the expensive error. Handle it in-thread when the file is already open in context, a single rg would answer it, or you are looking for something you read earlier this session. Do not chain explore to refine a question — ask one better question. Do not issue parallel explore calls with overlapping questions.",
];

const promptGuidelines: string[] = GUIDELINES;

export default function registerExplore(
	pi: ExtensionAPI,
	deps: { getConfig: (ctx: ExtensionContext) => import("../config.ts").ForemanConfig },
) {
	pi.registerTool({
		name: "explore",
		label: "Explore",
		description: DESCRIPTION,
		promptSnippet: "Locate code across the repository and return file:line references",
		promptGuidelines,
		parameters: Type.Object({
			question: Type.String({
				description:
					"What to locate, in the user's terms. Be specific: the exact symbol, behavior, or user-visible string.",
			}),
			hints: Type.Optional(
				Type.String({ description: "Known entry points or directories to start from." }),
			),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const config = deps.getConfig(ctx);
			const prompt = [
				`Find the answer to this question about the codebase:\n\n${params.question}`,
				params.hints
					? `Known entry points / directories to start from: ${params.hints}`
					: null,
				"Search and return the answer in the required format.",
			]
				.filter(Boolean)
				.join("\n\n");

			const result = await runSubagent({
				kind: "explore",
				config,
				toolConfig: config.explore,
				tier: "fast",
				bashMode: "explore",
				systemPrompt: SYSTEM_PROMPT,
				prompt,
				toolNames: ["read", "bash"],
				signal,
				onUpdate,
				ctx,
			});

			return {
				content: [{ type: "text", text: result.content }],
				details: result.details as ForemanToolDetails,
				usage: result.usage,
			};
		},

		renderCall: makeRenderCall("explore"),
		renderResult,
	});
}
