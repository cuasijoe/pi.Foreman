/**
 * Configuration loading + model resolution.
 *
 * Config file: `.pi/foreman.json` (project) overrides
 * `~/.pi/agent/foreman.json` (global). Both optional — defaults work
 * with zero config. Files may use JSONC (comments allowed).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

export interface ToolConfig {
	/** pi model pattern (e.g. "deepseek-v4-flash", "anthropic/claude-sonnet-4-5"). Resolved through the model registry. */
	model?: string;
	maxTurns: number;
	timeoutMs: number;
}

export interface ContextPressureConfig {
	enabled: boolean;
	/** Inject below this context percent. */
	warnAt: number;
	/** Inject stronger above this context percent. */
	strongAt: number;
}

export interface TuneConfig {
	/** Auto-apply tuning recommendations at session start. */
	enabled: boolean;
	/** Minimum runs per tool before its numbers are eligible for tuning. */
	minRuns: number;
	/** Raise timeoutMs when the timeout rate of recent runs exceeds this. */
	timeoutRate: number;
	/** Raise maxTurns when the max_turns stop rate of recent runs exceeds this. */
	maxTurnsRate: number;
	/** Caps so a tuning loop can never set dangerous values. */
	maxTimeoutMs: number;
	maxMaxTurns: number;
}

/** Explicit model patterns per tier, overriding the name-based heuristic. */
export interface TierConfig {
	fast?: string;
	mid?: string;
	strong?: string;
}

export interface ForemanConfig {
	explore: ToolConfig;
	review: ToolConfig;
	verify: ToolConfig;
	maxReturnChars: number;
	logging: boolean;
	disabled: string[];
	contextPressure: ContextPressureConfig;
	tune: TuneConfig;
	tiers: TierConfig;
}

export const DEFAULT_CONFIG: ForemanConfig = {
	explore: { model: undefined, maxTurns: 15, timeoutMs: 120_000 },
	review: { model: undefined, maxTurns: 25, timeoutMs: 300_000 },
	verify: { model: undefined, maxTurns: 10, timeoutMs: 600_000 },
	maxReturnChars: 8000,
	logging: true,
	disabled: [],
	contextPressure: { enabled: true, warnAt: 60, strongAt: 80 },
	tune: {
		enabled: false,
		minRuns: 8,
		timeoutRate: 0.2,
		maxTurnsRate: 0.2,
		maxTimeoutMs: 1_200_000,
		maxMaxTurns: 60,
	},
	tiers: {},
};

/** Strip // and /* *​/ comments from JSONC, respecting string literals. */
function stripJsoncComments(text: string): string {
	let out = "";
	let inString = false;
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		const next = text[i + 1];
		if (inString) {
			out += ch;
			if (ch === "\\") {
				out += next ?? "";
				i += 2;
				continue;
			}
			if (ch === '"') inString = false;
			i++;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			i++;
			continue;
		}
		if (ch === "/" && next === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

function readJsoncFile(filePath: string): Record<string, unknown> | null {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		return JSON.parse(stripJsoncComments(raw)) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mergeToolConfig(over: unknown, base: ToolConfig): ToolConfig {
	if (!isRecord(over)) return { ...base };
	return {
		model: typeof over.model === "string" ? over.model : base.model,
		maxTurns: typeof over.maxTurns === "number" ? over.maxTurns : base.maxTurns,
		timeoutMs: typeof over.timeoutMs === "number" ? over.timeoutMs : base.timeoutMs,
	};
}

function mergeContextPressure(over: unknown, base: ContextPressureConfig): ContextPressureConfig {
	if (over === false) return { ...base, enabled: false };
	if (!isRecord(over)) return { ...base };
	return {
		enabled: typeof over.enabled === "boolean" ? over.enabled : base.enabled,
		warnAt: typeof over.warnAt === "number" ? over.warnAt : base.warnAt,
		strongAt: typeof over.strongAt === "number" ? over.strongAt : base.strongAt,
	};
}

function mergeTuneConfig(over: unknown, base: TuneConfig): TuneConfig {
	if (over === false) return { ...base, enabled: false };
	if (!isRecord(over)) return { ...base };
	return {
		enabled: typeof over.enabled === "boolean" ? over.enabled : base.enabled,
		minRuns: typeof over.minRuns === "number" ? over.minRuns : base.minRuns,
		timeoutRate: typeof over.timeoutRate === "number" ? over.timeoutRate : base.timeoutRate,
		maxTurnsRate: typeof over.maxTurnsRate === "number" ? over.maxTurnsRate : base.maxTurnsRate,
		maxTimeoutMs: typeof over.maxTimeoutMs === "number" ? over.maxTimeoutMs : base.maxTimeoutMs,
		maxMaxTurns: typeof over.maxMaxTurns === "number" ? over.maxMaxTurns : base.maxMaxTurns,
	};
}

function mergeTiersConfig(over: unknown, base: TierConfig): TierConfig {
	if (!isRecord(over)) return { ...base };
	return {
		fast: typeof over.fast === "string" ? over.fast : base.fast,
		mid: typeof over.mid === "string" ? over.mid : base.mid,
		strong: typeof over.strong === "string" ? over.strong : base.strong,
	};
}

export function mergeConfig(
	raw: Record<string, unknown> | null,
	base: ForemanConfig,
): ForemanConfig {
	if (!raw) return { ...base };
	return {
		explore: mergeToolConfig(raw.explore, base.explore),
		review: mergeToolConfig(raw.review, base.review),
		verify: mergeToolConfig(raw.verify, base.verify),
		maxReturnChars:
			typeof raw.maxReturnChars === "number" ? raw.maxReturnChars : base.maxReturnChars,
		logging: typeof raw.logging === "boolean" ? raw.logging : base.logging,
		disabled: Array.isArray(raw.disabled)
			? raw.disabled.filter((d): d is string => typeof d === "string")
			: base.disabled,
		contextPressure: mergeContextPressure(raw.contextPressure, base.contextPressure),
		tune: mergeTuneConfig(raw.tune, base.tune),
		tiers: mergeTiersConfig(raw.tiers, base.tiers),
	};
}

/** Global config path: ~/.pi/agent/foreman.json */
export function globalConfigPath(): string {
	return path.join(getAgentDir(), "foreman.json");
}

/** Project config path: <cwd>/.pi/foreman.json */
export function projectConfigPath(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "foreman.json");
}

/**
 * Load config: global + project (project wins). Project config is only
 * honored when the project is trusted. `loadConfig` applies auto-tuned
 * values (tuning.json) on top; `loadUserConfig` returns what the user
 * actually configured, used to protect explicit user settings from
 * auto-tuning.
 */
export function loadUserConfig(cwd: string, projectTrusted: boolean): ForemanConfig {
	let cfg = mergeConfig(readJsoncFile(globalConfigPath()), DEFAULT_CONFIG);
	if (projectTrusted) {
		cfg = mergeConfig(readJsoncFile(projectConfigPath(cwd)), cfg);
	}
	return cfg;
}

export function loadConfig(cwd: string, projectTrusted: boolean): ForemanConfig {
	const cfg = loadUserConfig(cwd, projectTrusted);
	if (projectTrusted) {
		// Auto-tuned values apply last: defaults < global < project < tuning.
		return applyTuningOverlay(cwd, cfg);
	}
	return cfg;
}

/**
 * Merge just the tuning.json layer over a pre-tuned user config. Used by
 * session_start so a post-auto-tune refresh only re-reads tuning.json — not
 * global/project config, which did not change.
 */
export function applyTuningOverlay(cwd: string, userConfig: ForemanConfig): ForemanConfig {
	return mergeConfig(readJsoncFile(tuningPath(cwd)), userConfig);
}

export function logDirPath(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "foreman", "logs");
}

export function tuningPath(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "foreman", "tuning.json");
}

// ---------------------------------------------------------------------------
// Explicit-field tracking (for auto-tune provenance)
// ---------------------------------------------------------------------------

const TOOL_KEYS = ["explore", "review", "verify"] as const;
const TOOL_FIELDS = ["model", "maxTurns", "timeoutMs"] as const;

export type ToolField = (typeof TOOL_FIELDS)[number];

function collectExplicitKeys(raw: Record<string, unknown> | null, out: Set<string>): void {
	if (!raw) return;
	for (const tool of TOOL_KEYS) {
		const t = raw[tool];
		if (!isRecord(t)) continue;
		for (const field of TOOL_FIELDS) {
			if (t[field] !== undefined) out.add(`${tool}.${field}`);
		}
	}
}

/**
 * Set of "tool.field" keys the user explicitly wrote in global/project config
 * (defaults never count). Auto-tuning skips these: user intent wins.
 */
export function explicitConfigKeys(cwd: string, projectTrusted: boolean): Set<string> {
	const out = new Set<string>();
	collectExplicitKeys(readJsoncFile(globalConfigPath()), out);
	if (projectTrusted) collectExplicitKeys(readJsoncFile(projectConfigPath(cwd)), out);
	return out;
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

export type Tier = "fast" | "mid" | "strong";

export interface ResolvedModel {
	/** The model to pass to the child, or undefined to use the child's default. */
	model: Model<any> | undefined;
	/** Human-readable notice when a fallback happened. */
	notice: string | undefined;
}

const FAST_PATTERN = /(flash|mini|haiku|lite|fast|nano|small|turbo)/i;
const STRONG_PATTERN = /(opus|max|ultra|pro|large|sonnet)/i;
const MID_PATTERN = /(sonnet|medium|mid)/i;

function modelScore(m: Model<any>, pattern: RegExp, priority: number): number {
	return pattern.test(`${m.provider}/${m.id} ${m.name}`) ? priority : 0;
}

function inputCost(m: Model<any>): number {
	return m.cost?.input ?? 0;
}

function pickFast(avail: Model<any>[]): Model<any> | undefined {
	const named = avail.filter((m) => modelScore(m, FAST_PATTERN, 1) > 0);
	const pool = named.length > 0 ? named : avail;
	return [...pool].sort(
		(a, b) => inputCost(a) - inputCost(b) || a.contextWindow - b.contextWindow,
	)[0];
}

function pickStrong(avail: Model<any>[]): Model<any> | undefined {
	const named = avail
		.map((m) => ({
			m,
			p: modelScore(
				m,
				STRONG_PATTERN,
				m.id.includes("opus") || m.id.includes("max") || m.id.includes("ultra")
					? 3
					: m.id.includes("pro") || m.id.includes("large")
						? 2
						: 1,
			),
		}))
		.filter((e) => e.p > 0)
		.sort((a, b) => b.p - a.p);
	const pool = named.length > 0 ? named.map((e) => e.m) : avail;
	return [...pool].sort(
		(a, b) => b.contextWindow - a.contextWindow || b.maxTokens - a.maxTokens,
	)[0];
}

function pickMid(avail: Model<any>[]): Model<any> | undefined {
	const named = avail.filter((m) => modelScore(m, MID_PATTERN, 1) > 0);
	const pool = named.length > 0 ? named : avail;
	const sorted = [...pool].sort((a, b) => inputCost(a) - inputCost(b));
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length / 2))];
}

function pickTier(avail: Model<any>[], tier: Tier): Model<any> | undefined {
	if (avail.length === 0) return undefined;
	switch (tier) {
		case "fast":
			return pickFast(avail);
		case "strong":
			return pickStrong(avail);
		case "mid":
			return pickMid(avail);
	}
}

function findConfigured(registry: ModelRegistry, pattern: string): Model<any> | undefined {
	const trimmed = pattern.trim();
	const slash = trimmed.lastIndexOf("/");
	if (slash > 0) {
		const provider = trimmed.slice(0, slash);
		const id = trimmed.slice(slash + 1);
		const found = registry.find(provider, id);
		if (found) return found;
	}
	const all = registry.getAvailable();
	const exact = all.find((m) => m.id === trimmed || `${m.provider}/${m.id}` === trimmed);
	if (exact) return exact;
	const fuzzy = all.find(
		(m) => m.id.includes(trimmed) || `${m.provider}/${m.id}`.includes(trimmed),
	);
	if (fuzzy) return fuzzy;
	return undefined;
}

/**
 * Resolve the model for a tool:
 * 1. explicit config.model, resolved through the registry;
 * 2. explicit tiers[tier] override, resolved through the registry;
 * 3. tier heuristic over available (authenticated) models;
 * 4. parent's model;
 * 5. undefined (child default).
 * Never throws over model config — the caller gets a notice.
 */
export function resolveToolModel(
	registry: ModelRegistry,
	cfg: ToolConfig,
	tier: Tier,
	parent: Model<any> | undefined,
	tiers?: TierConfig,
): ResolvedModel {
	if (cfg.model) {
		const found = findConfigured(registry, cfg.model);
		if (found) return { model: found, notice: undefined };
		return {
			model: parent,
			notice: `foreman: configured model "${cfg.model}" does not resolve; using the parent model`,
		};
	}
	const tierPattern = tiers?.[tier];
	if (tierPattern) {
		const found = findConfigured(registry, tierPattern);
		if (found) return { model: found, notice: undefined };
		// Fall through to the heuristic; the notice is attached below.
	}
	const available = registry.getAvailable().filter((m) => registry.hasConfiguredAuth(m));
	const picked = pickTier(available, tier);
	if (picked) {
		return tierPattern
			? {
					model: picked,
					notice: `foreman: tier "${tier}" model "${tierPattern}" does not resolve; using the heuristic tier pick`,
				}
			: { model: picked, notice: undefined };
	}
	if (parent)
		return {
			model: parent,
			notice: "foreman: no suitable model available; using the parent model",
		};
	return {
		model: undefined,
		notice: "foreman: no suitable model available; child will use its default",
	};
}

/** "provider/id" string for the --model CLI flag, or undefined. */
export function modelCliId(model: Model<any> | undefined): string | undefined {
	if (!model) return undefined;
	return `${model.provider}/${model.id}`;
}
