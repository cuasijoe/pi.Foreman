/**
 * The optimization loop: turn telemetry into config recommendations.
 *
 * Mechanical, reversible adjustments only:
 *  - timeoutMs: raised when the timeout rate in recent runs exceeds a
 *    threshold; reverted toward the default when recent runs show no
 *    timeouts at all.
 *  - maxTurns: the same, driven by max_turns stops (the child wanted more
 *    turns and hit the cap).
 *
 * Model switching is deliberately NOT auto-applied — it needs more data and
 * user judgement. `/foreman stats` surfaces success rate and cost per
 * successful run by model; the user decides.
 *
 * Recommendations are written to .pi/foreman/tuning.json, which loadConfig
 * applies last (defaults < global < project < tuning). Tuning only ever
 * changes numbers inside limits (tune.maxTimeoutMs / tune.maxMaxTurns), so a
 * runaway loop cannot set dangerous values.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CONFIG, tuningPath, type ForemanConfig, type ToolConfig } from "./config.ts";
import type { TelemetryRecord } from "./telemetry.ts";
import type { ToolKind } from "./render.ts";

export interface TuningRecommendation {
	tool: ToolKind;
	field: "timeoutMs" | "maxTurns";
	from: number;
	to: number;
	reason: string;
}

export interface TuningFile {
	explore?: Partial<ToolConfig>;
	review?: Partial<ToolConfig>;
	verify?: Partial<ToolConfig>;
	_appliedAt?: string;
}

export function readTuning(cwd: string): TuningFile {
	try {
		return JSON.parse(fs.readFileSync(tuningPath(cwd), "utf8")) as TuningFile;
	} catch {
		return {};
	}
}

/** Tune on the most recent runs per tool, so old history cannot veto a fix. */
const RECENT_WINDOW = 12;

function rate(runs: TelemetryRecord[], outcome: TelemetryRecord["outcome"]): number {
	return runs.length === 0 ? 0 : runs.filter((r) => r.outcome === outcome).length / runs.length;
}

/**
 * Compute tuning recommendations from telemetry. Both directions:
 *  - rate above threshold  -> raise (ratchet up to the cap)
 *  - rate exactly 0        -> revert toward the default (ratchet down)
 *
 * Evidence window: for a field whose current value came from tuning.json
 * (tuned provenance), only runs newer than the tuning application count —
 * stale telemetry cannot ratchet a value upward forever. For default/user
 * values all runs count. Windowed to the last RECENT_WINDOW runs and gated
 * by config.tune.minRuns per field.
 *
 * Provenance guards: when `explicit` (the set of "tool.field" keys the user
 * wrote in config) is provided, those fields are never adjusted. Reverts
 * only fire when the current value came from tuning.json, so a user's manual
 * value is never silently undone.
 */
export function computeRecommendations(
	config: ForemanConfig,
	records: TelemetryRecord[],
	opts: { explicit?: Set<string>; tuned?: TuningFile } = {},
): TuningRecommendation[] {
	const recs: TuningRecommendation[] = [];
	const tune = config.tune;
	const auto = opts.explicit !== undefined;

	for (const tool of ["explore", "review", "verify"] as const) {
		const toolRuns = records.filter((r) => r.tool === tool);
		const t = config[tool];
		const dflt = DEFAULT_CONFIG[tool];
		const userSet = (field: "timeoutMs" | "maxTurns"): boolean =>
			auto && opts.explicit!.has(`${tool}.${field}`);
		const tunedValue = (field: "timeoutMs" | "maxTurns"): number | undefined =>
			opts.tuned?.[tool]?.[field];

		// Evidence for a field = runs newer than when its current value took
		// effect (tuning._appliedAt when the value is tuned, otherwise all runs).
		const evidence = (field: "timeoutMs" | "maxTurns"): TelemetryRecord[] => {
			const applied = opts.tuned?._appliedAt ? Date.parse(opts.tuned._appliedAt) : 0;
			const from = tunedValue(field) === t[field] && Number.isFinite(applied) ? applied : 0;
			return toolRuns.filter((r) => Date.parse(r.ts) > from).slice(-RECENT_WINDOW);
		};

		// --- timeoutMs ---
		const timeoutRuns = evidence("timeoutMs");
		if (timeoutRuns.length >= tune.minRuns) {
			const timeoutRate = rate(timeoutRuns, "timeout");
			if (
				timeoutRate > tune.timeoutRate &&
				t.timeoutMs < tune.maxTimeoutMs &&
				!userSet("timeoutMs")
			) {
				const to = Math.min(
					Math.round((t.timeoutMs * 1.5) / 10_000) * 10_000,
					tune.maxTimeoutMs,
				);
				if (to > t.timeoutMs) {
					recs.push({
						tool,
						field: "timeoutMs",
						from: t.timeoutMs,
						to,
						reason: `timeout rate ${(timeoutRate * 100).toFixed(0)}% (${timeoutRuns.filter((r) => r.outcome === "timeout").length}/${timeoutRuns.length} runs) above ${(tune.timeoutRate * 100).toFixed(0)}%`,
					});
				}
			} else if (
				timeoutRate === 0 &&
				t.timeoutMs > dflt.timeoutMs &&
				tunedValue("timeoutMs") === t.timeoutMs
			) {
				recs.push({
					tool,
					field: "timeoutMs",
					from: t.timeoutMs,
					to: dflt.timeoutMs,
					reason: `no timeouts in the last ${timeoutRuns.length} runs; reverting toward default`,
				});
			}
		}

		// --- maxTurns ---
		const maxTurnsRuns = evidence("maxTurns");
		if (maxTurnsRuns.length >= tune.minRuns) {
			const maxTurnsRate = rate(maxTurnsRuns, "max_turns");
			if (
				maxTurnsRate > tune.maxTurnsRate &&
				t.maxTurns < tune.maxMaxTurns &&
				!userSet("maxTurns")
			) {
				const to = Math.min(Math.round(t.maxTurns * 1.5), tune.maxMaxTurns);
				if (to > t.maxTurns) {
					recs.push({
						tool,
						field: "maxTurns",
						from: t.maxTurns,
						to,
						reason: `max_turns stop rate ${(maxTurnsRate * 100).toFixed(0)}% (${maxTurnsRuns.filter((r) => r.outcome === "max_turns").length}/${maxTurnsRuns.length} runs) above ${(tune.maxTurnsRate * 100).toFixed(0)}%`,
					});
				}
			} else if (
				maxTurnsRate === 0 &&
				t.maxTurns > dflt.maxTurns &&
				tunedValue("maxTurns") === t.maxTurns
			) {
				recs.push({
					tool,
					field: "maxTurns",
					from: t.maxTurns,
					to: dflt.maxTurns,
					reason: `no max_turns stops in the last ${maxTurnsRuns.length} runs; reverting toward default`,
				});
			}
		}
	}

	return recs;
}

/** Write recommendations into .pi/foreman/tuning.json. Returns how many applied. */
export function applyTuning(cwd: string, recs: TuningRecommendation[]): number {
	if (recs.length === 0) return 0;
	const tuning = readTuning(cwd);
	for (const rec of recs) {
		const entry = tuning[rec.tool] ?? {};
		entry[rec.field] = rec.to;
		tuning[rec.tool] = entry;
	}
	tuning._appliedAt = new Date().toISOString();
	try {
		fs.mkdirSync(path.dirname(tuningPath(cwd)), { recursive: true });
		fs.writeFileSync(tuningPath(cwd), JSON.stringify(tuning, null, 2));
		return recs.length;
	} catch {
		return 0;
	}
}
