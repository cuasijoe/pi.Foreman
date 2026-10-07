/**
 * Shared glue between the three tools and the spawn primitive: model
 * resolution + fallback notice, log path, cost accounting, status bar,
 * and the usage/footer assembly every tool result carries.
 */

import { createHash, randomUUID } from "node:crypto";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { ActivityTracker } from "./activity.ts";
import type { ForemanConfig, ProgressMode, Tier, ToolConfig } from "./config.ts";
import { logDirPath, modelCliId, resolveToolModel } from "./config.ts";
import { livePanel } from "./live-panel.ts";
import { usageFooter, type ForemanToolDetails, type ToolKind } from "./render.ts";
import { spawn, type BashMode, type SpawnResult } from "./spawn.ts";
import { recordRun, sessionTotal } from "./state.ts";
import { appendTelemetry, deriveOutcome } from "./telemetry.ts";

export interface RunSubagentOptions {
	kind: ToolKind;
	config: ForemanConfig;
	toolConfig: ToolConfig;
	tier: Tier;
	bashMode: BashMode;
	systemPrompt: string;
	prompt: string;
	toolNames: string[];
	explicitVerifyCommand?: boolean;
	signal?: AbortSignal;
	onUpdate?: (partial: AgentToolResult<ForemanToolDetails>) => void;
	ctx: ExtensionContext;
}

export interface RunSubagentResult {
	content: string;
	details: ForemanToolDetails;
	usage: Usage;
	isError: boolean;
}

const MAX_PROGRESS_LINES = 8;
const MAX_PROGRESS_LINE_LENGTH = 120;

/** One bounded activity feed per invocation; partial updates are never part of the final result. */
export function createProgressReporter(
	mode: ProgressMode,
	onUpdate: RunSubagentOptions["onUpdate"],
	base: ForemanToolDetails,
): ((line: string) => void) | undefined {
	if (mode === "off" || !onUpdate) return undefined;
	const lines: string[] = [];
	return (line) => {
		const preview = line.split(/[\r\n]/, 1)[0].slice(0, MAX_PROGRESS_LINE_LENGTH);
		if (!preview) return;
		if (mode === "full") {
			lines.push(preview);
			if (lines.length > MAX_PROGRESS_LINES) lines.shift();
		}
		const progress = mode === "full" ? lines.join("\n") : preview;
		onUpdate({
			content: [{ type: "text", text: progress }],
			details: { ...base, progress },
		});
	};
}

function buildUsage(r: SpawnResult): Usage {
	const input = r.inputTokens;
	const output = r.outputTokens;
	const cacheRead = r.cacheReadTokens;
	const cacheWrite = r.cacheWriteTokens;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: r.costUsd },
	};
}

export async function runSubagent(opts: RunSubagentOptions): Promise<RunSubagentResult> {
	const { ctx, kind, config } = opts;
	const sessionId = ctx.sessionManager.getSessionId();

	const resolved = resolveToolModel(
		ctx.modelRegistry,
		opts.toolConfig,
		opts.tier,
		ctx.model,
		config.tiers,
	);
	let notice: string | undefined = resolved.notice;
	if (notice) {
		try {
			ctx.ui.notify?.(notice, "warning");
		} catch {
			/* non-TUI modes */
		}
	}

	const logPath =
		config.logging && sessionId
			? `${logDirPath(ctx.cwd)}/${sessionId}/${kind}-${Date.now()}.json`
			: "";

	// Prompt version = content hash of the child system prompt. Any prompt
	// edit changes it, so stats can A/B prompt variants without manual
	// versioning.
	const promptVersion = createHash("sha1").update(opts.systemPrompt).digest("hex").slice(0, 8);

	const detailsBase: ForemanToolDetails = {
		tool: kind,
		stoppedBy: "complete",
		turns: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
		model: resolved.model ? resolved.model.id : undefined,
		provider: resolved.model ? resolved.model.provider : undefined,
		logPath: logPath || undefined,
		progressMode: config.progress,
	};

	const tracker = config.progress !== "off" && opts.onUpdate ? new ActivityTracker() : undefined;
	let latestPartial: AgentToolResult<ForemanToolDetails> | undefined;
	const forward = (partial: AgentToolResult<ForemanToolDetails>) => {
		latestPartial = partial;
		opts.onUpdate?.({
			...partial,
			details: { ...partial.details, activity: tracker?.snapshot() },
		});
	};
	const refresh = () => {
		if (latestPartial && tracker) forward(latestPartial);
	};
	const reportProgress = createProgressReporter(config.progress, forward, detailsBase);
	tracker?.record(`→ starting ${kind} agent`);
	reportProgress?.(`→ starting ${kind} agent`);
	const panel =
		config.livePanel && ctx.mode === "tui"
			? livePanel.start(ctx.ui, kind, modelCliId(resolved.model) ?? "default model")
			: undefined;

	const timer = tracker ? setInterval(refresh, 1000) : undefined;
	timer?.unref?.();
	let lastStreamUpdate = 0;
	let r: SpawnResult;
	try {
		r = await spawn({
			systemPrompt: opts.systemPrompt,
			toolNames: opts.toolNames,
			prompt: opts.prompt,
			modelCliId: modelCliId(resolved.model),
			maxTurns: opts.toolConfig.maxTurns,
			timeoutMs: opts.toolConfig.timeoutMs,
			signal: opts.signal,
			onUpdate: (line) => {
				tracker?.record(line);
				reportProgress?.(line);
			},
			onActivity: (activity) => {
				tracker?.observe(activity);
				panel?.update(activity);
				const now = Date.now();
				if (tracker && (!activity.textDelta || now - lastStreamUpdate >= 250)) {
					lastStreamUpdate = now;
					refresh();
				}
			},
			cwd: ctx.cwd,
			bashMode: opts.bashMode,
			explicitVerifyCommand: opts.explicitVerifyCommand ?? false,
			maxReturnChars: config.maxReturnChars,
			logPath: logPath || undefined,
			promptVersion,
		});
	} finally {
		if (timer) clearInterval(timer);
		panel?.end();
	}

	const outcome = deriveOutcome({
		stoppedBy: r.stoppedBy,
		exitCode: r.exitCode,
		error: r.error,
		formatCompliant: r.formatCompliant,
	});

	const details: ForemanToolDetails = {
		tool: kind,
		stoppedBy: r.stoppedBy,
		turns: r.turns,
		inputTokens: r.inputTokens,
		outputTokens: r.outputTokens,
		cacheReadTokens: r.cacheReadTokens,
		cacheWriteTokens: r.cacheWriteTokens,
		costUsd: r.costUsd,
		durationMs: r.durationMs,
		outcome,
		model: r.model ?? detailsBase.model,
		provider: r.provider ?? detailsBase.provider,
		error: r.error,
		logPath: logPath || undefined,
		activity: tracker?.snapshot(),
	};

	// Telemetry: one JSONL line per run, survives restarts. Appended after
	// completion so the tool_call hook in index.ts can mark it retried later.
	if (config.logging) {
		appendTelemetry(ctx.cwd, {
			ts: new Date().toISOString(),
			cwd: ctx.cwd,
			sessionId,
			id: randomUUID(),
			tool: kind,
			tier: opts.tier,
			model: r.model,
			provider: r.provider,
			promptVersion,
			maxTurns: opts.toolConfig.maxTurns,
			timeoutMs: opts.toolConfig.timeoutMs,
			turns: r.turns,
			inputTokens: r.inputTokens,
			outputTokens: r.outputTokens,
			cacheReadTokens: r.cacheReadTokens,
			cacheWriteTokens: r.cacheWriteTokens,
			costUsd: r.costUsd,
			durationMs: r.durationMs,
			stoppedBy: r.stoppedBy,
			exitCode: r.exitCode,
			formatCompliant: r.formatCompliant,
			outcome,
			retried: false,
			explicitVerifyCommand: opts.explicitVerifyCommand ?? undefined,
			error: r.error,
		});
	}

	// Cost accounting: per-tool, per-session.
	recordRun(sessionId, kind, {
		turns: r.turns,
		inputTokens: r.inputTokens,
		outputTokens: r.outputTokens,
		costUsd: r.costUsd,
	});

	// Status bar: running total this session.
	try {
		const total = sessionTotal(sessionId);
		const totalText =
			total.costUsd > 0
				? `foreman: $${total.costUsd >= 0.01 ? total.costUsd.toFixed(2) : total.costUsd.toFixed(4)} · ${total.runs} run${total.runs === 1 ? "" : "s"}`
				: `foreman: ${total.runs} run${total.runs === 1 ? "" : "s"}`;
		ctx.ui.setStatus("foreman", totalText);
	} catch {
		/* ignore */
	}

	let content = r.text;
	if (notice) content += `\n\n${notice}`;
	content += `\n\n${usageFooter(details)}`;

	return {
		content,
		details,
		usage: buildUsage(r),
		isError: Boolean(r.error),
	};
}
