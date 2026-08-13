/**
 * verify — absorb build/test noise, return a diagnosis. The single noisiest
 * thing that enters a coding agent's context is build output; verify distills
 * it. Unrestricted bash (it must run the build), serialized by a process-wide
 * mutex, with hang prevention at three layers:
 *
 *  1. parent-side refusal of watch-mode commands;
 *  2. child-side refusal (the bash gate) of watch/dev/serve/start commands
 *     the child invents during discovery;
 *  3. per-command timeout clamped to 80% of the child's wall-clock budget.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { makeRenderCall, renderResult, type ForemanToolDetails } from "../render.ts";
import { runSubagent } from "../runner.ts";
import { releaseVerify, tryAcquireVerify } from "../state.ts";

const SYSTEM_PROMPT = fs.readFileSync(
	path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "verify.md"),
	"utf8",
);

const DESCRIPTION = [
	"Run the build and test suite and return a distilled diagnosis. Use when running a full suite or build, when the output volume is unknown, or when a previous run produced a long failure trace — raw build output is large and mostly noise. Optionally specify the command; otherwise it is discovered from the project manifest. Returns pass/fail, failure count, and for each distinct failure a location and a one-line cause. Does not modify files. Do not call concurrently with itself.",
	"",
	"Do not use for a single targeted test whose output you expect to be short, or for a command you have already run this session that produced under ~30 lines — run those yourself.",
].join("\n");

const GUIDELINES = [
	"Use verify when running a full suite or build, when the command's output volume is unknown, or when a previous run produced a long failure trace. Run a single targeted test, or a command you have already run this session that produced <30 lines, directly instead. Do not call verify concurrently with itself.",
];

/** Watch/dev/serve/start patterns — a verify command must be one-shot. */
const WATCH_RE = /(^|\s)(--watch(=\S+)?|--watchAll|-w|watch|dev|serve|start)(\s|$)/;
/** One-shot indicators that override the watch refusal. */
const ONE_SHOT_RE = /(--run|--ci|--once|--single-run|--no-watch|--forceExit|--runInBand)/;

function isWatchCommand(command: string): boolean {
	return WATCH_RE.test(command) && !ONE_SHOT_RE.test(command);
}

function emptyDetails(kind: "verify"): ForemanToolDetails {
	return {
		tool: kind,
		stoppedBy: "complete",
		turns: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
	};
}

export default function registerVerify(
	pi: ExtensionAPI,
	deps: { getConfig: (ctx: ExtensionContext) => import("../config.ts").ForemanConfig },
) {
	pi.registerTool({
		name: "verify",
		label: "Verify",
		description: DESCRIPTION,
		promptSnippet: "Run builds/tests and return a distilled diagnosis",
		promptGuidelines: GUIDELINES,
		parameters: Type.Object({
			command: Type.Optional(
				Type.String({
					description:
						"One-shot command to run. Omit to have it discovered from package.json / Makefile / justfile. Watch/dev/serve commands are refused.",
				}),
			),
			expectation: Type.Optional(
				Type.String({
					description: 'What passing means, if not obvious (e.g. "all 3 suites green").',
				}),
			),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const config = deps.getConfig(ctx);

			// Layer 1: refuse watch-mode commands before any process is spawned.
			if (params.command && isWatchCommand(params.command)) {
				return {
					content: [
						{
							type: "text",
							text: `REFUSED: "${params.command}" looks like a watch/dev/serve command and would hang.\nPass a one-shot command instead (e.g. \`npm test -- --run\`, \`jest --ci\`, \`go test ./...\`), or omit command to have it discovered.`,
						},
					],
					details: emptyDetails("verify"),
				};
			}

			// Layer 0: verify is serialized — builds fight over lockfiles, ports, build dirs.
			if (!tryAcquireVerify(ctx.cwd)) {
				return {
					content: [
						{
							type: "text",
							text: "verify is already running. Concurrent verify calls are not allowed (builds fight over lockfiles, ports, and build dirs). Wait for it to finish, or run the command yourself.",
						},
					],
					details: emptyDetails("verify"),
				};
			}

			try {
				const prompt = [
					params.command
						? `Run this command: ${params.command}\n(If it is not a one-shot test/build command, stop and report an error instead of running a watcher.)`
						: "No command was given. Discover the test/build command from the project manifest (package.json scripts, Makefile, justfile, Cargo.toml, pyproject.toml) and state which one you chose. Prefer a one-shot test command over a watcher.",
					params.expectation ? `What passing means here: ${params.expectation}` : null,
					"Run it, diagnose failures, and return the required format.",
				]
					.filter(Boolean)
					.join("\n\n");

				const result = await runSubagent({
					kind: "verify",
					config,
					toolConfig: config.verify,
					tier: "mid",
					bashMode: "verify",
					systemPrompt: SYSTEM_PROMPT,
					prompt,
					toolNames: ["read", "bash"],
					explicitVerifyCommand: Boolean(
						params.command && !isWatchCommand(params.command),
					),
					signal,
					onUpdate,
					ctx,
				});

				return {
					content: [{ type: "text", text: result.content }],
					details: result.details as ForemanToolDetails,
					usage: result.usage,
				};
			} finally {
				releaseVerify(ctx.cwd);
			}
		},

		renderCall: makeRenderCall("verify"),
		renderResult,
	});
}
