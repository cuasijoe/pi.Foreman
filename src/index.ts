/**
 * Foreman — three subagent tools (explore, review, verify) for pi.
 *
 * One primitive (spawn a child `pi` process with a fresh empty message
 * array, its own system prompt, and a restricted tool subset), three
 * configurations. See README.md and NOTES.md.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import registerExplore from "./agents/explore.ts";
import registerReview from "./agents/review.ts";
import registerVerify from "./agents/verify.ts";
import type { ForemanConfig, ToolConfig } from "./config.ts";
import {
	applyTuningOverlay,
	explicitConfigKeys,
	loadConfig,
	loadUserConfig,
	logDirPath,
	tuningPath,
} from "./config.ts";
import { livePanel } from "./live-panel.ts";
import type { ToolKind } from "./render.ts";
import { resetSessionSpend, sessionSpend, sessionTotal } from "./state.ts";
import { buildStats, markRetried, median, readTelemetry, telemetryPath } from "./telemetry.ts";
import { applyTuning, computeRecommendations, readTuning } from "./tune.ts";

function fmtToolCfg(cfg: ToolConfig): string {
	const parts = [
		`turns:${cfg.maxTurns}`,
		`timeout:${Math.round(cfg.timeoutMs / 1000)}s`,
		`model:${cfg.model ?? "(tier default)"}`,
	];
	return parts.join(" · ");
}

function fmtCost(cost: number): string {
	if (cost <= 0) return "$0.00";
	return cost >= 0.01 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`;
}

function fmtDur(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function pct(n: number, d: number): string {
	return d === 0 ? "0%" : `${Math.round((n / d) * 100)}%`;
}

function pctF(f: number): string {
	return `${Math.round(f * 100)}%`;
}

/** Show a text panel (TUI custom component) or plain console output. */
async function showText(ctx: ExtensionContext, lines: string): Promise<void> {
	if (ctx.mode !== "tui") {
		console.log(lines);
		return;
	}
	await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
		const text = new Text(theme.fg("dim", lines), 1, 1);
		// Text has no handleInput by default; attach one so any key dismisses.
		(text as Component & { handleInput?: (data: string) => void }).handleInput = () => done();
		return text;
	});
}

export default function (pi: ExtensionAPI) {
	let cachedConfig: ForemanConfig | null = null;
	let cachedCwd: string | null = null;

	const getConfig = (ctx: ExtensionContext): ForemanConfig => {
		if (!cachedConfig || cachedCwd !== ctx.cwd) {
			cachedConfig = loadConfig(ctx.cwd, ctx.isProjectTrusted());
			cachedCwd = ctx.cwd;
		}
		return cachedConfig;
	};

	pi.on("session_start", (_event, ctx) => {
		livePanel.reset();
		const trusted = ctx.isProjectTrusted();
		// Load global+project once; the tuning overlay is merged separately so a
		// post-auto-tune refresh only re-reads tuning.json, not global/project.
		const userConfig = loadUserConfig(ctx.cwd, trusted);
		cachedConfig = trusted ? applyTuningOverlay(ctx.cwd, userConfig) : userConfig;
		cachedCwd = ctx.cwd;
		resetSessionSpend(ctx.sessionManager.getSessionId());
		// Auto-tune: apply telemetry-driven recommendations when tune.enabled.
		// Only machine-owned values are adjusted — fields the user set
		// explicitly in config are never auto-overridden (explicitConfigKeys
		// tracks what the user actually wrote, defaults excluded). Tuning is
		// project-scoped state (.pi/foreman/tuning.json), so it is only
		// produced — and only announced — when project-local config is honored.
		if (cachedConfig.tune.enabled && trusted) {
			const explicit = explicitConfigKeys(ctx.cwd, trusted);
			const tuned = readTuning(ctx.cwd);
			const recs = computeRecommendations(cachedConfig, readTelemetry(ctx.cwd), {
				explicit,
				tuned,
			});
			if (recs.length > 0 && applyTuning(ctx.cwd, recs) > 0) {
				cachedConfig = applyTuningOverlay(ctx.cwd, userConfig);
				cachedCwd = ctx.cwd;
				try {
					ctx.ui.notify?.(`foreman: auto-tuned ${recs.length} setting(s)`, "info");
				} catch {
					/* non-TUI modes */
				}
			}
		}
		// Respect config.disabled: remove disabled tools from the active set so
		// they never appear in the system prompt and cannot be called. Warn when
		// a name that is not a foreman tool is listed — `disabled: ["read"]`
		// would silently strip a built-in via setActiveTools, which is almost
		// certainly a foot-gun rather than intent.
		if (cachedConfig.disabled.length > 0) {
			const known = new Set(["explore", "review", "verify"]);
			const unknown = cachedConfig.disabled.filter((d) => !known.has(d));
			if (unknown.length > 0) {
				try {
					ctx.ui.notify?.(
						`foreman: "disabled" lists non-foreman tool(s) [${unknown.join(", ")}] — only explore/review/verify are meant here`,
						"warning",
					);
				} catch {
					/* non-TUI modes */
				}
			}
			const disabled = new Set(cachedConfig.disabled);
			pi.setActiveTools(pi.getActiveTools().filter((name) => !disabled.has(name)));
		}
	});

	pi.on("session_shutdown", () => livePanel.reset());

	// Retry signal: when the parent re-invokes a foreman tool later in the
	// same session, the previous run of that tool was evidently not sufficient
	// — behavioral quality feedback, no "was this useful?" prompt. The new run
	// has no telemetry record yet, so this marks the previous completed one.
	pi.on("tool_call", (event, ctx) => {
		const name = event.toolName as string;
		if (name === "explore" || name === "review" || name === "verify") {
			markRetried(ctx.cwd, ctx.sessionManager.getSessionId(), name as ToolKind);
		}
	});

	const deps = { getConfig };

	// The three tools. Registration is at factory time; config is read lazily
	// per call (cwd + project trust are only known once a session exists).
	registerExplore(pi, deps);
	registerReview(pi, deps);
	registerVerify(pi, deps);

	// ------------------------------------------------------------------
	// Context-pressure injection: per-turn, before each LLM call.
	// Above warnAt%: prefer delegation. Above strongAt%: state it firmly.
	// Below 40% (or disabled): say nothing.
	// ------------------------------------------------------------------
	pi.on("context", (event, ctx) => {
		const config = getConfig(ctx);
		const cp = config.contextPressure;
		if (!cp.enabled) return;
		const usage = ctx.getContextUsage();
		if (!usage || usage.percent == null) return;
		if (usage.percent < cp.warnAt) return;

		const strong = usage.percent >= cp.strongAt;
		const line = strong
			? "[system note: context is heavily constrained. Prefer explore/verify delegation over reading large files or running long builds directly; keep all output small.]"
			: "[system note: context is getting constrained. Prefer explore/verify delegation over reading large files or running long builds directly.]";
		event.messages.push({
			role: "user",
			content: [{ type: "text", text: line }],
			timestamp: Date.now(),
		});
		return { messages: event.messages };
	});

	// ------------------------------------------------------------------
	// /foreman command: config · session spend · telemetry stats · tuning.
	//   /foreman            resolved config + per-tool spend this session
	//   /foreman stats      aggregate telemetry across sessions + drift
	//   /foreman tune       apply telemetry recommendations
	//   /foreman tune -n    dry run (show what would change)
	// ------------------------------------------------------------------
	pi.registerCommand("foreman", {
		description:
			"Show config/spend, telemetry stats, or apply tuning (try /foreman stats, /foreman tune)",
		handler: async (args, ctx) => {
			const [sub, ...rest] = (args ?? "").trim().split(/\s+/);
			if (sub === "stats") {
				if (rest.includes("--json")) {
					console.log(JSON.stringify(statsJson(ctx.cwd), null, 2));
					return;
				}
				return showText(ctx, statsLines(ctx.cwd));
			}
			if (sub === "tune") {
				if (rest.includes("--json")) {
					console.log(JSON.stringify(tuneJson(ctx), null, 2));
					return;
				}
				return showText(
					ctx,
					tuneLines(ctx, rest.includes("--dry-run") || rest.includes("-n")),
				);
			}
			return showText(ctx, configLines(ctx));
		},
	});

	// ------------------------------------------------------------------
	// /foreman default: resolved config + per-tool spend this session.
	// ------------------------------------------------------------------
	function configLines(ctx: ExtensionContext): string {
		const config = getConfig(ctx);
		const sessionId = ctx.sessionManager.getSessionId();
		const spend = sessionSpend(sessionId);
		const total = sessionTotal(sessionId);

		const spendLines =
			spend.size === 0
				? ["  (none yet)"]
				: [...spend.entries()].map(([tool, s]) => {
						const cost = fmtCost(s.costUsd);
						return `  ${tool}: ${s.runs} run${s.runs === 1 ? "" : "s"} · ${s.turns} turns · ${s.inputTokens} in / ${s.outputTokens} out · ${cost}`;
					});

		return [
			"foreman — resolved config",
			`  explore: ${fmtToolCfg(config.explore)}`,
			`  review:  ${fmtToolCfg(config.review)}`,
			`  verify:  ${fmtToolCfg(config.verify)}`,
			`  progress: ${config.progress} · livePanel: ${config.livePanel} · maxReturnChars: ${config.maxReturnChars} · logging: ${config.logging} · disabled: [${config.disabled.join(", ")}]`,
			`  contextPressure: ${config.contextPressure.enabled ? `warn ≥${config.contextPressure.warnAt}% · strong ≥${config.contextPressure.strongAt}%` : "disabled"}`,
			`  tune: ${config.tune.enabled ? "auto (enabled)" : "manual"} · minRuns ${config.tune.minRuns} · timeoutRate ${config.tune.timeoutRate} · maxTurnsRate ${config.tune.maxTurnsRate} · caps ${fmtDur(config.tune.maxTimeoutMs)}/${config.tune.maxMaxTurns} turns`,
			"",
			"spend this session",
			...spendLines,
			`  total: ${total.runs} run${total.runs === 1 ? "" : "s"} · ${fmtCost(total.costUsd)}`,
			"",
			`logs: ${logDirPath(ctx.cwd)}`,
			`telemetry: ${telemetryPath(ctx.cwd)}`,
			`tuning: ${tuningPath(ctx.cwd)}`,
		].join("\n");
	}

	// ------------------------------------------------------------------
	// /foreman stats: aggregate telemetry (survives restarts) + 7d vs 30d drift.
	// ------------------------------------------------------------------
	function statsLines(cwd: string): string {
		const records = readTelemetry(cwd);
		if (records.length === 0) {
			return "foreman — no telemetry yet. Runs are recorded when logging: true; see /foreman for the file path.";
		}
		const stats = buildStats(records);
		const lines: string[] = [
			`foreman — telemetry: ${stats.totalRuns} runs · ${fmtCost(stats.totalCostUsd)} · ${fmtDur(stats.totalDurationMs)} wall · since ${(stats.firstTs ?? "").slice(0, 10)}`,
		];
		for (const tool of ["explore", "review", "verify"] as const) {
			const s = stats.perTool[tool];
			const o = s.outcomes;
			lines.push(
				`  ${tool.padEnd(8)} ${s.runs} runs · success ${pct(o.success, s.runs)} · partial ${pct(o.partial, s.runs)} · failed ${pct(o.failed, s.runs)} · timeout ${pct(o.timeout, s.runs)} · max_turns ${pct(o.max_turns, s.runs)} · aborted ${pct(o.aborted, s.runs)}` +
					(s.retried > 0 ? ` · retried ${s.retried} (${pct(s.retried, s.runs)})` : ""),
			);
			const costPerRun = s.runs > 0 ? s.costUsd / s.runs : 0;
			const costPerSuccess = o.success > 0 ? s.costUsd / o.success : 0;
			const models = [...s.modelRuns.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 2)
				.map(([m, n]) => `${m} (${n})`)
				.join(" · ");
			lines.push(
				`             avg ${fmtDur(s.durationMs / Math.max(1, s.runs))} / med ${fmtDur(median(s.durationsMs))} · avg ${fmtCost(costPerRun)} · cost/success ${fmtCost(costPerSuccess)}` +
					(models ? ` · models: ${models}` : ""),
			);
			// Prompt A/B comparison: show when more than one prompt version is
			// present for a tool (the point of the promptVersion hash).
			const pvEntries = [...s.promptVersions.entries()];
			if (pvEntries.length >= 2) {
				lines.push(
					`             prompts: ${pvEntries
						.map(
							([v, p]) =>
								`${v} (${p.runs} runs, ${pct(p.successes, p.runs)} success)`,
						)
						.join(" · ")}`,
				);
			}
		}
		lines.push("  drift 7d vs prior 30d:");
		const DAY = 86_400_000;
		const now = Date.now();
		const seven = records.filter((r) => now - Date.parse(r.ts) <= 7 * DAY);
		const prior = records.filter((r) => {
			const age = now - Date.parse(r.ts);
			return age > 7 * DAY && age <= 37 * DAY;
		});
		let driftShown = false;
		for (const tool of ["explore", "review", "verify"] as const) {
			const a = seven.filter((r) => r.tool === tool);
			const b = prior.filter((r) => r.tool === tool);
			if (a.length < 3 || b.length < 3) continue;
			driftShown = true;
			const succ = (rs: typeof a) =>
				rs.filter((r) => r.outcome === "success").length / rs.length;
			const tmo = (rs: typeof a) =>
				rs.filter((r) => r.outcome === "timeout").length / rs.length;
			const sA = succ(a),
				sB = succ(b);
			const tA = tmo(a),
				tB = tmo(b);
			lines.push(
				`    ${tool.padEnd(8)} success ${pctF(sB)} → ${pctF(sA)} ${sA >= sB ? "✓" : "✗"} · timeout ${pctF(tB)} → ${pctF(tA)} ${tA <= tB ? "✓" : "✗"}`,
			);
		}
		if (!driftShown) lines.push("    (need ≥3 runs in both windows to compare)");
		return lines.join("\n");
	}

	// ------------------------------------------------------------------
	// /foreman tune: turn telemetry into config recommendations, apply or dry-run.
	// ------------------------------------------------------------------
	function tuneLines(ctx: ExtensionContext, dryRun: boolean): string {
		const config = getConfig(ctx);
		const records = readTelemetry(ctx.cwd);
		const recs = computeRecommendations(config, records, { tuned: readTuning(ctx.cwd) });
		const lines: string[] = [
			`foreman tune — ${recs.length === 0 ? "no recommendations" : `${recs.length} recommendation(s)`} (${records.length} telemetry runs)`,
		];
		for (const rec of recs) {
			lines.push(`  ${rec.tool}.${rec.field}: ${rec.from} → ${rec.to}`);
			lines.push(`    reason: ${rec.reason}`);
		}
		if (recs.length === 0) {
			lines.push("  rates within thresholds — nothing to change.");
		} else if (dryRun) {
			lines.push("  dry run — nothing written. Run `/foreman tune` to apply.");
		} else {
			const applied = applyTuning(ctx.cwd, recs);
			cachedConfig = loadConfig(ctx.cwd, ctx.isProjectTrusted());
			cachedCwd = ctx.cwd;
			lines.push(`  applied ${applied} change(s) → ${tuningPath(ctx.cwd)}`);
		}
		lines.push(
			config.tune.enabled
				? "  tune.enabled: true — recommendations also auto-apply at session start"
				: "  tune.enabled: false — set tune.enabled: true in .pi/foreman.json to auto-apply at session start",
		);
		const advisory = modelAdvisoryLines(records);
		if (advisory.length > 0) {
			lines.push("", "model advisory (informational — never auto-applied):", ...advisory);
		}
		return lines.join("\n");
	}

	// ------------------------------------------------------------------
	// Machine-readable output (for dashboards/CI).
	// ------------------------------------------------------------------
	function statsJson(cwd: string): unknown {
		const records = readTelemetry(cwd);
		const stats = buildStats(records);
		const perTool: Record<string, unknown> = {};
		for (const tool of ["explore", "review", "verify"] as const) {
			const s = stats.perTool[tool];
			perTool[tool] = {
				runs: s.runs,
				outcomes: { ...s.outcomes },
				retried: s.retried,
				costUsd: s.costUsd,
				durationMs: s.durationMs,
				avgDurationMs: s.runs > 0 ? Math.round(s.durationMs / s.runs) : 0,
				medianDurationMs: Math.round(median(s.durationsMs)),
				costPerRunUsd: s.runs > 0 ? s.costUsd / s.runs : 0,
				costPerSuccessUsd: s.outcomes.success > 0 ? s.costUsd / s.outcomes.success : null,
				models: Object.fromEntries(s.modelRuns),
				promptVersions: Object.fromEntries(
					[...s.promptVersions.entries()].map(([v, p]) => [
						v,
						{
							runs: p.runs,
							successes: p.successes,
							successRate: p.runs > 0 ? p.successes / p.runs : 0,
							costUsd: p.costUsd,
						},
					]),
				),
			};
		}
		return {
			totalRuns: stats.totalRuns,
			totalCostUsd: stats.totalCostUsd,
			totalDurationMs: stats.totalDurationMs,
			firstTs: stats.firstTs ?? null,
			perTool,
		};
	}

	function tuneJson(ctx: ExtensionContext): unknown {
		const config = getConfig(ctx);
		const records = readTelemetry(ctx.cwd);
		const recs = computeRecommendations(config, records, { tuned: readTuning(ctx.cwd) });
		return {
			recommendations: recs,
			count: recs.length,
			totalRuns: records.length,
			tuneEnabled: config.tune.enabled,
		};
	}

	// ------------------------------------------------------------------
	// Model advisory: flag a model that costs ≥2× per success with success
	// rate within 15 points of the cheapest — surfaced, never auto-applied.
	// ------------------------------------------------------------------
	function modelAdvisoryLines(records: ReturnType<typeof readTelemetry>): string[] {
		const lines: string[] = [];
		for (const tool of ["explore", "review", "verify"] as const) {
			const byModel = new Map<string, { runs: number; successes: number; cost: number }>();
			for (const r of records) {
				if (r.tool !== tool) continue;
				const key = r.model ? (r.model.split("/").pop() ?? r.model) : "unknown";
				const e = byModel.get(key) ?? { runs: 0, successes: 0, cost: 0 };
				e.runs += 1;
				if (r.outcome === "success") e.successes += 1;
				e.cost += r.costUsd;
				byModel.set(key, e);
			}
			if (byModel.size < 2) continue;
			const entries = [...byModel.entries()].map(([model, e]) => ({
				model,
				runs: e.runs,
				successRate: e.runs > 0 ? e.successes / e.runs : 0,
				cps: e.successes > 0 ? e.cost / e.successes : Infinity,
			}));
			const finite = entries.filter((e) => Number.isFinite(e.cps));
			if (finite.length < 2) continue;
			const cheapest = finite.reduce((a, b) => (a.cps <= b.cps ? a : b));
			for (const e of finite) {
				if (e.model === cheapest.model) continue;
				if (e.cps < cheapest.cps * 2) continue;
				if (e.runs < 3 || cheapest.runs < 3) continue;
				if (e.successRate > cheapest.successRate + 0.15) continue;
				lines.push(
					`    ${tool}: ${e.model} costs ${(e.cps / cheapest.cps).toFixed(1)}× ${cheapest.model} per success (${pctF(e.successRate)} vs ${pctF(cheapest.successRate)} success) — consider the cheaper model`,
				);
			}
		}
		return lines;
	}
}
