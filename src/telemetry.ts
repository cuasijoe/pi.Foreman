/**
 * Per-run telemetry: append-only JSONL at .pi/foreman/telemetry.jsonl.
 *
 * One line per completed subagent run: cost, duration, tokens, stop reason,
 * and a derived outcome. Survives restarts (unlike the in-memory session
 * spend in state.ts) and is the raw material for `/foreman stats` and
 * `/foreman tune`.
 *
 * Two behavior-based quality signals replace any "was this useful?" prompt
 * (we deliberately never ask the user):
 *
 *  - formatCompliant: the child returned its required output format
 *    (explore: ANSWER:/LOCATIONS: with real path:line refs, review:
 *    VERDICT:/FINDINGS:/NOTES: with a valid verdict, verify:
 *    COMMAND:/RESULT:/SUMMARY: with a valid result). A non-compliant result
 *    is unusable by definition — the parent cannot act on it regardless of
 *    how "useful" it felt.
 *  - retried: the parent re-invoked the same tool shortly after a *successful*
 *    run in the same session (marked by a tool_call hook in index.ts).
 *    Re-invocation is behavioral evidence the result was not sufficient.
 *    Only recent successful runs count — a retry after a failed/timeout run
 *    is already captured by `outcome`, and two unrelated questions asked
 *    minutes apart are not retries. Marking is append-only (a `_retryOf`
 *    marker referencing the run id), so no read-modify-write can lose data.
 *
 * All file I/O is synchronous and best-effort: telemetry must never break
 * a tool call.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ToolKind } from "./render.ts";

export type Outcome = "success" | "partial" | "failed" | "timeout" | "max_turns" | "aborted";

export interface TelemetryRecord {
	ts: string;
	cwd: string;
	sessionId?: string;
	/** Unique run id; retry markers reference it (see markRetried). */
	id?: string;
	tool: ToolKind;
	tier: "fast" | "mid" | "strong";
	model?: string;
	provider?: string;
	/** First 8 hex chars of the sha1 of the child system prompt. Any prompt
	 *  edit changes it, so prompt A/B comparisons work without manual
	 *  versioning. */
	promptVersion: string;
	maxTurns: number;
	timeoutMs: number;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	durationMs: number;
	stoppedBy: string;
	exitCode: number;
	formatCompliant: boolean;
	outcome: Outcome;
	retried: boolean;
	explicitVerifyCommand?: boolean;
	error?: string;
}

export function telemetryPath(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "foreman", "telemetry.jsonl");
}

/**
 * Did the child return its required output format? The prompts demand a
 * strict format ("Output format, and nothing else"); a result that skips a
 * required section — or fills one with malformed entries — is unusable no
 * matter how the parent felt about it.
 *
 * Strengthened beyond mere section presence:
 *  - explore LOCATIONS entries must look like `path:line` when any are listed;
 *  - review VERDICT must be one of the allowed values;
 *  - verify RESULT must be pass/fail/error, and a fail result must name at
 *    least one `path:line` failure.
 */
export function checkFormatCompliance(tool: ToolKind, text: string): boolean {
	const PATH_LINE = /^\s*-\s*\S+:\d+/m;
	const HAS_BULLET = /^\s*-/m;
	switch (tool) {
		case "explore": {
			if (!/\bANSWER:/.test(text) || !/\bLOCATIONS:/.test(text)) return false;
			// If any location bullets are listed, at least one must be a real path:line.
			return HAS_BULLET.test(text) ? PATH_LINE.test(text) : true;
		}
		case "review":
			return (
				/\bVERDICT:\s*(ship|fix-first|needs-discussion)\b/.test(text) &&
				/\bFINDINGS:/.test(text) &&
				/\bNOTES:/.test(text)
			);
		case "verify": {
			const result = text.match(/\bRESULT:\s*(pass|fail|error)\b/i)?.[1]?.toLowerCase();
			if (!/\bCOMMAND:/.test(text) || !result || !/\bSUMMARY:/.test(text)) return false;
			if (result === "fail") {
				const failures = text.split(/\bFAILURES:/)[1] ?? "";
				return PATH_LINE.test(failures);
			}
			return true;
		}
	}
}

export function deriveOutcome(r: {
	stoppedBy: string;
	exitCode: number;
	error?: string;
	formatCompliant: boolean;
}): Outcome {
	switch (r.stoppedBy) {
		case "aborted":
			return "aborted";
		case "timeout":
			return "timeout";
		case "max_turns":
			return "max_turns";
	}
	if (r.error || r.exitCode !== 0) return "failed";
	return r.formatCompliant ? "success" : "partial";
}

/** Keep telemetry bounded: prune the oldest records when the file grows past
 *  this byte size, down to the most recent MAX_TELEMETRY_LINES. */
const MAX_TELEMETRY_LINES = 5000;
const PRUNE_BYTES = 1_000_000;

export function appendTelemetry(cwd: string, record: TelemetryRecord): void {
	try {
		const p = telemetryPath(cwd);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.appendFileSync(p, JSON.stringify(record) + "\n");
		// Retention (amortized: only once the file is large). Pruning from the
		// front can only drop a retry marker's target (the marker then dangles
		// harmlessly) or a marker itself (a retry signal lost) — never a newer
		// record, so stats stay correct for the retained window.
		if (fs.statSync(p).size > PRUNE_BYTES) {
			const lines = fs.readFileSync(p, "utf8").split("\n");
			if (lines.length > MAX_TELEMETRY_LINES) {
				fs.writeFileSync(p, lines.slice(-MAX_TELEMETRY_LINES).join("\n"));
			}
		}
	} catch {
		/* telemetry must never break a tool call */
	}
}

/** Parse raw JSONL text into records, folding `_retryOf` markers into their
 *  target records (shared by full and tail reads). */
function parseRecords(raw: string): TelemetryRecord[] {
	const records: TelemetryRecord[] = [];
	const retriedIds = new Set<string>();
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const obj = JSON.parse(line) as TelemetryRecord & { _retryOf?: string };
			if (obj && typeof obj._retryOf === "string") {
				retriedIds.add(obj._retryOf);
			} else {
				records.push(obj);
			}
		} catch {
			/* skip corrupt lines */
		}
	}
	for (const r of records) {
		if (r.id && retriedIds.has(r.id)) r.retried = true;
	}
	return records;
}

export function readTelemetry(cwd: string): TelemetryRecord[] {
	try {
		return parseRecords(fs.readFileSync(telemetryPath(cwd), "utf8"));
	} catch {
		return [];
	}
}

/**
 * Read only the most recent `maxLines` records (bounded I/O for hot paths
 * that only need recent runs — e.g. markRetried, which runs on every
 * subagent invocation and only looks within the retry window).
 */
export function readTelemetryTail(cwd: string, maxLines: number): TelemetryRecord[] {
	try {
		const raw = fs.readFileSync(telemetryPath(cwd), "utf8");
		const tail = raw
			.split("\n")
			.slice(-(maxLines + 1))
			.join("\n");
		return parseRecords(tail);
	} catch {
		return [];
	}
}

/**
 * Mark the most recent run of `tool` in `sessionId` as retried — called from
 * a tool_call hook when the parent invokes the same tool again. Append-only:
 * writes a `{"_retryOf": <id>}` marker line instead of rewriting the target
 * record in place, so concurrent processes appending runs cannot be lost to
 * a stale read-modify-write.
 *
 * Precision guards (against false-positive retries): only a *successful* run
 * that completed within RETRY_WINDOW_MS is marked. A re-invocation after a
 * failed/timeout/aborted run is already captured by `outcome`, and two
 * unrelated questions asked far apart in one session are not retries.
 */
const RETRY_WINDOW_MS = 10 * 60_000;
/** Tail window for markRetried: far more than any 10-minute run volume, and a
 *  small fraction of the retention cap, so the hot path never parses the
 *  whole file. */
const RETRY_TAIL_LINES = 1000;

export function markRetried(cwd: string, sessionId: string | undefined, tool: ToolKind): void {
	if (!sessionId) return;
	try {
		const p = telemetryPath(cwd);
		if (!fs.existsSync(p)) return;
		// Find the latest completed, not-yet-retried run for (sessionId, tool).
		let target: TelemetryRecord | undefined;
		for (const r of readTelemetryTail(cwd, RETRY_TAIL_LINES).reverse()) {
			if (r.sessionId === sessionId && r.tool === tool && !r.retried) {
				target = r;
				break;
			}
		}
		if (!target?.id) return;
		if (target.outcome !== "success") return;
		if (Date.now() - Date.parse(target.ts) > RETRY_WINDOW_MS) return;
		fs.appendFileSync(p, JSON.stringify({ _retryOf: target.id }) + "\n");
	} catch {
		/* best-effort */
	}
}

// ---------------------------------------------------------------------------
// Aggregation for /foreman stats
// ---------------------------------------------------------------------------

export function median(nums: number[]): number {
	if (nums.length === 0) return 0;
	const s = [...nums].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface PromptVersionStats {
	runs: number;
	successes: number;
	costUsd: number;
}

export interface ToolStats {
	runs: number;
	outcomes: Record<Outcome, number>;
	retried: number;
	costUsd: number;
	durationMs: number;
	durationsMs: number[];
	modelRuns: Map<string, number>;
	promptVersions: Map<string, PromptVersionStats>;
}

export interface Stats {
	totalRuns: number;
	totalCostUsd: number;
	totalDurationMs: number;
	firstTs?: string;
	perTool: Record<ToolKind, ToolStats>;
}

function emptyToolStats(): ToolStats {
	return {
		runs: 0,
		outcomes: { success: 0, partial: 0, failed: 0, timeout: 0, max_turns: 0, aborted: 0 },
		retried: 0,
		costUsd: 0,
		durationMs: 0,
		durationsMs: [],
		modelRuns: new Map(),
		promptVersions: new Map(),
	};
}

export function buildStats(records: TelemetryRecord[]): Stats {
	const perTool: Record<ToolKind, ToolStats> = {
		explore: emptyToolStats(),
		review: emptyToolStats(),
		verify: emptyToolStats(),
	};
	let totalCostUsd = 0;
	let totalDurationMs = 0;
	let firstTs: string | undefined;

	for (const r of records) {
		const s = perTool[r.tool] ?? emptyToolStats();
		s.runs += 1;
		s.outcomes[r.outcome] = (s.outcomes[r.outcome] ?? 0) + 1;
		if (r.retried) s.retried += 1;
		s.costUsd += r.costUsd;
		s.durationMs += r.durationMs;
		s.durationsMs.push(r.durationMs);
		if (r.model) {
			const key = r.model.split("/").pop() ?? r.model;
			s.modelRuns.set(key, (s.modelRuns.get(key) ?? 0) + 1);
		}
		if (r.promptVersion) {
			const pv = s.promptVersions.get(r.promptVersion) ?? {
				runs: 0,
				successes: 0,
				costUsd: 0,
			};
			pv.runs += 1;
			if (r.outcome === "success") pv.successes += 1;
			pv.costUsd += r.costUsd;
			s.promptVersions.set(r.promptVersion, pv);
		}
		perTool[r.tool] = s;
		totalCostUsd += r.costUsd;
		totalDurationMs += r.durationMs;
		if (!firstTs || r.ts < firstTs) firstTs = r.ts;
	}

	return { totalRuns: records.length, totalCostUsd, totalDurationMs, firstTs, perTool };
}
