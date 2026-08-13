/**
 * review — adversarial read of a change by an agent that did not write it.
 * Strongest model, read + gated bash (git diff/status allowed), parallel-safe
 * but rarely needed. The parent passes INTENT, never the diff text — the
 * child reads the diff itself.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { makeRenderCall, renderResult, type ForemanToolDetails } from "../render.ts";
import { runSubagent } from "../runner.ts";

const SYSTEM_PROMPT = fs.readFileSync(
	path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "review.md"),
	"utf8",
);

const DESCRIPTION = [
	'Get an independent review of uncommitted changes from an agent with no memory of writing them. Use before declaring any non-trivial change done — you cannot review your own work, because you read the diff as what you meant rather than what it says. Provide what the change was meant to accomplish; the reviewer reads the diff itself. Optionally set focus to bias the review (e.g. "concurrency", "error handling"). Returns findings as severity/location/problem. Read-only: does not modify files.',
	"",
	"Prefer calling this over skipping it. Skip only for trivial changes: a typo, a version bump, a comment, or a rename the compiler already verifies. Do not call it on a change that verify has already shown to be broken — fix the failure first, then review once.",
].join("\n");

const GUIDELINES = [
	"Use review before declaring any change spanning >1 file, touching auth/data/concurrency/external input, or that you are about to declare done. Handle trivial edits in-thread: a typo, a version bump, a comment, or a rename the compiler verifies. Never review a change that verify already showed to be broken — fix the failure first, then review once.",
];

/** Walk up from cwd looking for a `.git` entry (dir or worktree file). */
function inGitRepo(cwd: string): boolean {
	let dir = path.resolve(cwd);
	for (;;) {
		if (fs.existsSync(path.join(dir, ".git"))) return true;
		const parent = path.dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
}

function emptyDetails(): ForemanToolDetails {
	return {
		tool: "review",
		stoppedBy: "complete",
		turns: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
	};
}

export default function registerReview(
	pi: ExtensionAPI,
	deps: { getConfig: (ctx: ExtensionContext) => import("../config.ts").ForemanConfig },
) {
	pi.registerTool({
		name: "review",
		label: "Review",
		description: DESCRIPTION,
		promptSnippet: "Independently review uncommitted changes",
		promptGuidelines: GUIDELINES,
		parameters: Type.Object({
			intent: Type.String({
				description:
					"What the change was supposed to accomplish. The reviewer reads the diff itself — do not paste the diff here.",
			}),
			diffSpec: Type.Optional(
				Type.String({
					description:
						"Git rev range or `--staged`. Defaults to unstaged + staged vs HEAD.",
				}),
			),
			focus: Type.Optional(
				Type.String({
					description:
						'Lens for the review, e.g. "security", "concurrency", "error handling".',
				}),
			),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// Preflight: review reads `git diff`; without a git repo there is
			// nothing to review — say so clearly instead of spawning a child
			// that just runs git and fails.
			if (!inGitRepo(ctx.cwd)) {
				return {
					content: [
						{
							type: "text",
							text: "review needs a git repository to read the diff, but this directory is not inside one. Initialize git (or run pi from a repo) and try again — nothing was reviewed.",
						},
					],
					details: emptyDetails(),
				};
			}

			const config = deps.getConfig(ctx);
			const prompt = [
				`The change under review was meant to accomplish:\n\n${params.intent}`,
				`Diff to read: ${params.diffSpec || "unstaged + staged changes vs HEAD (git diff, plus git diff --staged)"}`,
				params.focus ? `Focus this review on: ${params.focus}` : null,
				"Read the diff yourself, judge against the stated intent, and return the required format.",
			]
				.filter(Boolean)
				.join("\n\n");

			const result = await runSubagent({
				kind: "review",
				config,
				toolConfig: config.review,
				tier: "strong",
				bashMode: "review",
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

		renderCall: makeRenderCall("review"),
		renderResult,
	});
}
