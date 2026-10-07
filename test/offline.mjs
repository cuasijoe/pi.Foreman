#!/usr/bin/env node
/**
 * Offline test tier — deterministic, no LLM, no network, runs in well under
 * a second. Run with:
 *
 *   node --experimental-strip-types test/offline.mjs
 *
 * Covers the pure logic that the model-driven acceptance suite (the "model"
 * tier) cannot check cheaply or deterministically:
 *   - bash-gate validation (structural allowlist, watch refusal)
 *   - telemetry: format compliance, outcome derivation, retry marking,
 *     retention, aggregation
 *   - tuning: recommendations (raise/revert/evidence-window/provenance/caps)
 *   - config: merge, explicit-field tracking, tier→model resolution
 *
 * See REVIEW.md §5 (I1/I2). The extension modules use erasable TypeScript
 * syntax only, so Node's type stripping loads them directly.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Isolate global-config reads from the developer's real ~/.pi/agent.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-offline-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const telemetry = await import("../src/telemetry.ts");
const bash = await import("../src/child-bash.ts");
const tune = await import("../src/tune.ts");
const config = await import("../src/config.ts");
const state = await import("../src/state.ts");
const render = await import("../src/render.ts");
const { ActivityTracker } = await import("../src/activity.ts");
const { LivePanel } = await import("../src/live-panel.ts");
const runner = await import("../src/runner.ts");
const spawn = await import("../src/spawn.ts");

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
	try {
		fn();
		pass += 1;
		console.log(`  PASS  ${name}`);
	} catch (err) {
		fail += 1;
		failures.push({ name, err });
		console.log(`  FAIL  ${name} — ${err.message}`);
	}
}

function tmpdir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "foreman-offline-"));
}

function rec(over = {}) {
	return {
		ts: new Date().toISOString(),
		cwd: "/tmp/x",
		sessionId: "s",
		id: `id-${Math.random().toString(36).slice(2)}`,
		tool: "explore",
		tier: "fast",
		model: "p/model",
		provider: "p",
		promptVersion: "v1",
		maxTurns: 15,
		timeoutMs: 120000,
		turns: 2,
		inputTokens: 100,
		outputTokens: 50,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0.01,
		durationMs: 1000,
		stoppedBy: "complete",
		exitCode: 0,
		formatCompliant: true,
		outcome: "success",
		retried: false,
		...over,
	};
}

console.log("bash gate");
{
	const allow = [
		['rg -n "foo" src/', "explore"],
		['rg -i "foo" src/', "explore"],
		['rg -n "a > b" src/', "explore"],
		['rg -n "a|b" src/', "explore"],
		['grep "=>" f', "explore"],
		["cat file | grep foo", "explore"],
		["rg -n foo src/ | head", "explore"],
		['git log -S "rm -rf"', "explore"],
		["git show HEAD:file", "explore"],
		["git diff --staged", "review"],
		["git status", "review"],
	];
	const deny = [
		["rm -rf /tmp/x", "explore"],
		["sed -i s/a/b/ f", "explore"],
		['ls && node -e "x"', "explore"],
		['ls ; python3 -c "x"', "explore"],
		['cat $(node -e "1")', "explore"],
		["cat `node -e 1`", "explore"],
		["find . -exec node {} ;", "explore"],
		["find . -execdir node {} ;", "explore"],
		["find . -delete", "explore"],
		['ls\nnode -e "1"', "explore"],
		["echo hi > /tmp/x", "explore"],
		["cat < /etc/passwd", "explore"],
		["rg --pre node pat .", "explore"],
		["rg --pre=node pat .", "explore"],
		["tail -f log", "explore"],
		["git -c core.pager=x log", "explore"],
		["git diff", "explore"],
		["ls || perl -e 1", "explore"],
	];
	for (const [cmd, mode] of allow) {
		test(`allow ${JSON.stringify(cmd)}`, () =>
			assert.equal(bash.validateReadOnly(cmd, mode), undefined));
	}
	for (const [cmd, mode] of deny) {
		test(`deny ${JSON.stringify(cmd)}`, () =>
			assert.notEqual(bash.validateReadOnly(cmd, mode), undefined));
	}
	test("verify: watch refused when not explicit", () =>
		assert.ok(bash.validateVerify("npm run dev", false)));
	test("verify: watch allowed when parent passed explicit one-shot", () =>
		assert.equal(bash.validateVerify("npm run dev", true), undefined));
	test("verify: normal command passes", () =>
		assert.equal(bash.validateVerify("npm test", false), undefined));
}

console.log("bash gate primitives");
{
	test("tokenize honors single/double quotes", () => {
		assert.deepEqual(bash.tokenize('rg -n "a b" src/'), ["rg", "-n", "a b", "src/"]);
		assert.deepEqual(bash.tokenize("grep 'x y' f"), ["grep", "x y", "f"]);
	});
	test("shellControl blocks operators outside quotes only", () => {
		assert.equal(bash.shellControl("echo hi"), undefined);
		assert.ok(bash.shellControl("echo $(x)").includes("$("));
		assert.ok(bash.shellControl("echo `x`").includes("backticks"));
		assert.ok(bash.shellControl("a; b").includes(";"));
		assert.ok(bash.shellControl("a & b").includes("&"));
		assert.ok(bash.shellControl("a\nb").includes("newline"));
		assert.ok(bash.shellControl("a < b").includes("redirection"));
		assert.equal(bash.shellControl("echo 'a; b'"), undefined);
		assert.equal(bash.shellControl('echo "a > b"'), undefined);
	});
	test("splitPipes keeps quoted pipes intact", () => {
		assert.deepEqual(bash.splitPipes('rg -n "a|b" src/'), ['rg -n "a|b" src/']);
		assert.deepEqual(bash.splitPipes("cat file | grep foo"), ["cat file ", " grep foo"]);
	});
	test("validateReadOnlySegment: allowlist + git subcommand + blocked flags", () => {
		assert.ok(
			bash
				.validateReadOnlySegment("rm -rf /tmp/x", "explore")
				.includes("read-only allowlist"),
		);
		assert.ok(bash.validateReadOnlySegment("git push", "explore").includes("not allowed"));
		assert.ok(bash.validateReadOnlySegment("git diff", "explore").includes("not allowed"));
		assert.equal(bash.validateReadOnlySegment("git diff", "review"), undefined);
		assert.equal(bash.validateReadOnlySegment("git status", "review"), undefined);
		assert.ok(
			bash.validateReadOnlySegment("find . -exec node {} ;", "explore").includes("-exec"),
		);
		assert.equal(bash.validateReadOnlySegment("", "explore"), "empty command");
	});
}

console.log("telemetry");
{
	test("compliance: explore requires path:line bullets", () => {
		assert.equal(
			telemetry.checkFormatCompliance(
				"explore",
				"ANSWER: x\n\nLOCATIONS:\n- src/a.ts:1 — here\n\nUNCERTAIN: none",
			),
			true,
		);
		assert.equal(
			telemetry.checkFormatCompliance(
				"explore",
				"ANSWER: x\n\nLOCATIONS:\n- somewhere\n\nUNCERTAIN: none",
			),
			false,
		);
		assert.equal(
			telemetry.checkFormatCompliance(
				"explore",
				"ANSWER: not found\n\nLOCATIONS:\n\nUNCERTAIN: looked",
			),
			true,
		);
	});
	test("compliance: review verdict enum + sections", () => {
		assert.equal(
			telemetry.checkFormatCompliance("review", "VERDICT: ship\n\nFINDINGS:\n\nNOTES: none"),
			true,
		);
		assert.equal(
			telemetry.checkFormatCompliance(
				"review",
				"VERDICT: whatever\n\nFINDINGS:\n\nNOTES: none",
			),
			false,
		);
		assert.equal(
			telemetry.checkFormatCompliance(
				"review",
				"VERDICT: fix-first\n\nFINDINGS:\n- [high] a:1 — x",
			),
			false,
		); // missing NOTES
	});
	test("compliance: verify result enum + fail needs path:line", () => {
		assert.equal(
			telemetry.checkFormatCompliance(
				"verify",
				"COMMAND: npm test\nRESULT: pass\nSUMMARY: 5 passed",
			),
			true,
		);
		assert.equal(
			telemetry.checkFormatCompliance(
				"verify",
				"COMMAND: npm test\nRESULT: fail\nSUMMARY: 2 failed\n\nFAILURES:\n- a.test.ts:31 — x",
			),
			true,
		);
		assert.equal(
			telemetry.checkFormatCompliance(
				"verify",
				"COMMAND: npm test\nRESULT: fail\nSUMMARY: 2 failed\n\nFAILURES:\n- something broke",
			),
			false,
		);
		assert.equal(
			telemetry.checkFormatCompliance(
				"verify",
				"COMMAND: npm test\nRESULT: banana\nSUMMARY: x",
			),
			false,
		);
		assert.equal(
			telemetry.checkFormatCompliance(
				"verify",
				"COMMAND: npm test\nRESULT: error\nSUMMARY: hung",
			),
			true,
		); // error result needs no failure list
	});
	test("deriveOutcome priority", () => {
		assert.equal(
			telemetry.deriveOutcome({
				stoppedBy: "aborted",
				exitCode: 143,
				error: "x",
				formatCompliant: true,
			}),
			"aborted",
		);
		assert.equal(
			telemetry.deriveOutcome({
				stoppedBy: "timeout",
				exitCode: 143,
				formatCompliant: false,
			}),
			"timeout",
		);
		assert.equal(
			telemetry.deriveOutcome({
				stoppedBy: "max_turns",
				exitCode: 0,
				formatCompliant: false,
			}),
			"max_turns",
		);
		assert.equal(
			telemetry.deriveOutcome({ stoppedBy: "complete", exitCode: 1, formatCompliant: true }),
			"failed",
		);
		assert.equal(
			telemetry.deriveOutcome({
				stoppedBy: "complete",
				exitCode: 0,
				error: "boom",
				formatCompliant: true,
			}),
			"failed",
		);
		assert.equal(
			telemetry.deriveOutcome({ stoppedBy: "complete", exitCode: 0, formatCompliant: false }),
			"partial",
		);
		assert.equal(
			telemetry.deriveOutcome({ stoppedBy: "complete", exitCode: 0, formatCompliant: true }),
			"success",
		);
	});
	test("median", () => {
		assert.equal(telemetry.median([1, 2, 3, 4, 5]), 3);
		assert.equal(telemetry.median([1, 2, 3, 4]), 2.5);
		assert.equal(telemetry.median([]), 0);
	});

	const d = tmpdir();
	const r = (over = {}) => rec({ cwd: d, ...over });

	test("append/read round-trip + tail", () => {
		for (let i = 0; i < 10; i++)
			telemetry.appendTelemetry(
				d,
				r({ id: `r${i}`, ts: new Date(1000 + i * 1000).toISOString() }),
			);
		const all = telemetry.readTelemetry(d);
		assert.equal(all.length, 10);
		const tail = telemetry.readTelemetryTail(d, 4);
		assert.deepEqual(
			tail.map((x) => x.id),
			["r6", "r7", "r8", "r9"],
		);
	});

	test("markRetried: latest-first, session-scoped, success-only, windowed", () => {
		telemetry.appendTelemetry(
			d,
			r({
				id: "A",
				sessionId: "s",
				outcome: "success",
				ts: new Date(Date.now() - 1000).toISOString(),
			}),
		);
		telemetry.appendTelemetry(
			d,
			r({
				id: "B",
				sessionId: "s",
				outcome: "success",
				ts: new Date(Date.now() - 500).toISOString(),
			}),
		);
		telemetry.markRetried(d, "s", "explore");
		let recs = telemetry.readTelemetry(d);
		assert.equal(recs.find((x) => x.id === "B").retried, true);
		assert.equal(recs.find((x) => x.id === "A").retried, false);
		telemetry.markRetried(d, "s", "explore");
		recs = telemetry.readTelemetry(d);
		assert.equal(recs.find((x) => x.id === "A").retried, true);
		// failed run is not marked (outcome already signals insufficiency)
		telemetry.appendTelemetry(
			d,
			r({
				id: "C",
				sessionId: "s",
				outcome: "failed",
				ts: new Date(Date.now() - 100).toISOString(),
			}),
		);
		telemetry.markRetried(d, "s", "explore");
		assert.equal(telemetry.readTelemetry(d).find((x) => x.id === "C").retried, false);
		// old successful run (>10 min) is not marked
		telemetry.appendTelemetry(
			d,
			r({
				id: "D",
				sessionId: "s",
				outcome: "success",
				ts: new Date(Date.now() - 11 * 60000).toISOString(),
			}),
		);
		telemetry.markRetried(d, "s", "explore");
		assert.equal(telemetry.readTelemetry(d).find((x) => x.id === "D").retried, false);
		// other session untouched
		telemetry.appendTelemetry(
			d,
			r({
				id: "E",
				sessionId: "other",
				outcome: "success",
				ts: new Date(Date.now() - 100).toISOString(),
			}),
		);
		telemetry.markRetried(d, "s", "explore");
		assert.equal(telemetry.readTelemetry(d).find((x) => x.id === "E").retried, false);
	});

	test("retention: prunes to last 5000 lines when >1MB", () => {
		const d2 = tmpdir();
		const p = telemetry.telemetryPath(d2);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		let content = "";
		for (let i = 0; i < 6000; i++)
			content +=
				JSON.stringify(rec({ cwd: d2, id: `x${i}`, ts: new Date(i).toISOString() })) + "\n";
		fs.writeFileSync(p, content);
		telemetry.appendTelemetry(d2, rec({ cwd: d2, id: "new" }));
		const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean).length;
		assert.ok(lines <= 5000 && lines > 4900, `expected ~5000 lines, got ${lines}`);
		fs.rmSync(d2, { recursive: true, force: true });
	});

	test("buildStats aggregates outcomes/models/promptVersions", () => {
		const stats = telemetry.buildStats([
			rec({ tool: "explore", outcome: "success", model: "a/m1", promptVersion: "v1" }),
			rec({ tool: "explore", outcome: "timeout", model: "a/m1", promptVersion: "v2" }),
			rec({ tool: "explore", outcome: "success", model: "b/m2", promptVersion: "v2" }),
		]);
		const e = stats.perTool.explore;
		assert.equal(e.runs, 3);
		assert.equal(e.outcomes.success, 2);
		assert.equal(e.outcomes.timeout, 1);
		assert.equal(e.modelRuns.get("m1"), 2);
		assert.equal(e.modelRuns.get("m2"), 1);
		assert.equal(e.promptVersions.get("v1").runs, 1);
		assert.equal(e.promptVersions.get("v2").runs, 2);
	});

	fs.rmSync(d, { recursive: true, force: true });
}

console.log("tuning");
{
	const { DEFAULT_CONFIG, mergeConfig } = config;
	const mkRuns = (tool, outcomes, opts = {}) => {
		const now = Date.now();
		return outcomes.map((outcome, i) =>
			rec({
				tool,
				outcome,
				ts: new Date(now - (outcomes.length - i) * 60000).toISOString(),
				...opts,
			}),
		);
	};
	const timeoutRuns = () =>
		mkRuns("explore", [
			"timeout",
			"success",
			"success",
			"timeout",
			"success",
			"success",
			"timeout",
			"success",
			"success",
			"timeout",
			"success",
			"success",
		]);
	const maxTurnsRuns = () =>
		mkRuns("explore", [
			"max_turns",
			"success",
			"success",
			"max_turns",
			"success",
			"success",
			"max_turns",
			"success",
			"success",
			"max_turns",
			"success",
			"success",
		]);

	test("raise timeoutMs when rate above threshold", () => {
		const recs = tune.computeRecommendations(DEFAULT_CONFIG, timeoutRuns(), {
			explicit: new Set(),
			tuned: {},
		});
		assert.deepEqual(
			recs.map((x) => `${x.field}:${x.from}->${x.to}`),
			["timeoutMs:120000->180000"],
		);
	});
	test("minRuns guard", () => {
		const recs = tune.computeRecommendations(DEFAULT_CONFIG, timeoutRuns().slice(0, 7), {
			explicit: new Set(),
			tuned: {},
		});
		assert.equal(recs.length, 0);
	});
	test("explicit user-set field is never auto-adjusted", () => {
		const recs = tune.computeRecommendations(DEFAULT_CONFIG, timeoutRuns(), {
			explicit: new Set(["explore.timeoutMs"]),
			tuned: {},
		});
		assert.equal(recs.length, 0);
	});
	test("explicit maxTurns only protects maxTurns (timeoutMs still tunes)", () => {
		const recs = tune.computeRecommendations(DEFAULT_CONFIG, timeoutRuns(), {
			explicit: new Set(["explore.maxTurns"]),
			tuned: {},
		});
		assert.deepEqual(
			recs.map((x) => x.field),
			["timeoutMs"],
		);
	});
	test("revert only with tuned provenance", () => {
		const clean = mkRuns("explore", Array(10).fill("success"));
		const tunedCfg = mergeConfig({ explore: { timeoutMs: 180000 } }, DEFAULT_CONFIG);
		const recs = tune.computeRecommendations(tunedCfg, clean, {
			explicit: new Set(),
			tuned: { explore: { timeoutMs: 180000 } },
		});
		assert.deepEqual(
			recs.map((x) => `${x.field}:${x.to}`),
			["timeoutMs:120000"],
		);
		// same current value, but no tuned provenance (user set it) -> no revert
		const recs2 = tune.computeRecommendations(tunedCfg, clean, {
			explicit: new Set(["explore.timeoutMs"]),
			tuned: {},
		});
		assert.equal(recs2.length, 0);
	});
	test("evidence window: stale timeouts predating tuning do not ratchet", () => {
		const now = Date.now();
		const appliedAt = new Date(now - 5 * 86400000).toISOString();
		const tunedCfg = mergeConfig({ explore: { timeoutMs: 180000 } }, DEFAULT_CONFIG);
		const stale = timeoutRuns().map((r, i) => ({
			...r,
			ts: new Date(now - 10 * 86400000 - i * 60000).toISOString(),
		}));
		const recs = tune.computeRecommendations(tunedCfg, stale, {
			explicit: new Set(),
			tuned: { explore: { timeoutMs: 180000 }, _appliedAt: appliedAt },
		});
		assert.equal(recs.length, 0);
		// fresh timeouts after tuning -> raise again
		const fresh = timeoutRuns().map((r, i) => ({
			...r,
			ts: new Date(now - i * 60000).toISOString(),
		}));
		const recs2 = tune.computeRecommendations(tunedCfg, fresh, {
			explicit: new Set(),
			tuned: { explore: { timeoutMs: 180000 }, _appliedAt: appliedAt },
		});
		assert.deepEqual(
			recs2.map((x) => `${x.field}:${x.to}`),
			["timeoutMs:270000"],
		);
	});
	test("cap enforcement (maxTimeoutMs)", () => {
		const capped = mergeConfig({ tune: { maxTimeoutMs: 150000 } }, DEFAULT_CONFIG);
		const recs = tune.computeRecommendations(capped, timeoutRuns(), {
			explicit: new Set(),
			tuned: {},
		});
		assert.deepEqual(
			recs.map((x) => `${x.field}:${x.to}`),
			["timeoutMs:150000"],
		);
	});
	test("raise maxTurns when max_turns rate above threshold", () => {
		const recs = tune.computeRecommendations(DEFAULT_CONFIG, maxTurnsRuns(), {
			explicit: new Set(),
			tuned: {},
		});
		assert.deepEqual(
			recs.map((x) => `${x.field}:${x.from}->${x.to}`),
			["maxTurns:15->23"],
		);
	});
	test("explicit maxTurns prevents maxTurns raise", () => {
		const recs = tune.computeRecommendations(DEFAULT_CONFIG, maxTurnsRuns(), {
			explicit: new Set(["explore.maxTurns"]),
			tuned: {},
		});
		assert.equal(recs.length, 0);
	});
	test("revert maxTurns toward default with tuned provenance", () => {
		const clean = mkRuns("explore", Array(10).fill("success"));
		const tunedCfg = mergeConfig({ explore: { maxTurns: 60 } }, DEFAULT_CONFIG);
		const recs = tune.computeRecommendations(tunedCfg, clean, {
			explicit: new Set(),
			tuned: { explore: { maxTurns: 60 } },
		});
		assert.deepEqual(
			recs.map((x) => `${x.field}:${x.to}`),
			["maxTurns:15"],
		);
	});
	test("maxTurns respects maxMaxTurns cap", () => {
		const capped = mergeConfig({ tune: { maxMaxTurns: 20 } }, DEFAULT_CONFIG);
		const recs = tune.computeRecommendations(capped, maxTurnsRuns(), {
			explicit: new Set(),
			tuned: {},
		});
		assert.deepEqual(
			recs.map((x) => `${x.field}:${x.to}`),
			["maxTurns:20"],
		);
	});
	test("applyTuning/readTuning round-trip", () => {
		const d = tmpdir();
		tune.applyTuning(d, [
			{ tool: "explore", field: "timeoutMs", from: 120000, to: 180000, reason: "test" },
		]);
		const t = tune.readTuning(d);
		assert.equal(t.explore.timeoutMs, 180000);
		assert.ok(t._appliedAt);
		fs.rmSync(d, { recursive: true, force: true });
	});
}

console.log("config");
{
	test("mergeConfig layers over defaults", () => {
		const cfg = config.mergeConfig(
			{ explore: { maxTurns: 7 }, verify: { timeoutMs: 999 } },
			config.DEFAULT_CONFIG,
		);
		assert.equal(cfg.explore.maxTurns, 7);
		assert.equal(cfg.explore.timeoutMs, 120000); // untouched default
		assert.equal(cfg.verify.timeoutMs, 999);
		assert.equal(cfg.review.maxTurns, 25);
		assert.equal(cfg.progress, "line");
		assert.equal(cfg.livePanel, false);
	});

	test("progress mode accepts only known values and respects config layers", () => {
		const full = config.mergeConfig({ progress: "full" }, config.DEFAULT_CONFIG);
		assert.equal(full.progress, "full");
		assert.equal(config.mergeConfig({ progress: "off" }, full).progress, "off");
		assert.equal(config.mergeConfig({ progress: "line" }, full).progress, "line");
		assert.equal(config.mergeConfig({ progress: "verbose" }, full).progress, "full");
		assert.equal(config.mergeConfig({ progress: null }, full).progress, "full");
		assert.equal(config.mergeConfig({ livePanel: true }, full).livePanel, true);
		assert.equal(config.mergeConfig({ livePanel: "yes" }, full).livePanel, false);
	});

	test("explicitConfigKeys tracks only written fields", () => {
		const d = tmpdir();
		fs.mkdirSync(path.join(d, ".pi", "foreman"), { recursive: true });
		fs.writeFileSync(
			path.join(d, ".pi", "foreman.json"),
			JSON.stringify({ explore: { maxTurns: 40 }, contextPressure: { warnAt: 50 } }),
		);
		assert.deepEqual([...config.explicitConfigKeys(d, true)].sort(), ["explore.maxTurns"]);
		fs.rmSync(d, { recursive: true, force: true });
	});

	test("applyTuningOverlay merges only tuning over user config", () => {
		const d = tmpdir();
		fs.mkdirSync(path.dirname(config.tuningPath(d)), { recursive: true });
		fs.writeFileSync(config.tuningPath(d), JSON.stringify({ explore: { timeoutMs: 999000 } }));
		const user = config.loadUserConfig(d, true); // no project/global config -> defaults
		const merged = config.applyTuningOverlay(d, user);
		assert.equal(merged.explore.timeoutMs, 999000);
		assert.equal(merged.explore.maxTurns, 15); // default preserved
		fs.rmSync(d, { recursive: true, force: true });
	});

	test("resolveToolModel: per-tool model > tiers > heuristic > parent", () => {
		const models = [
			{
				provider: "openai",
				id: "gpt-4o-mini",
				name: "Mini",
				cost: { input: 0.0001 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
			{
				provider: "openai",
				id: "gpt-4o",
				name: "GPT-4o",
				cost: { input: 0.0025 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
			{
				provider: "anthropic",
				id: "claude-sonnet-4-5",
				name: "Sonnet",
				cost: { input: 0.003 },
				contextWindow: 200000,
				maxTokens: 64000,
			},
		];
		const registry = {
			find: (p, i) => models.find((m) => m.provider === p && m.id === i),
			getAvailable: () => models,
			hasConfiguredAuth: () => true,
		};
		const cfg = { model: undefined, maxTurns: 15, timeoutMs: 120000 };
		// tiers[tier] resolves
		assert.equal(
			config.resolveToolModel(registry, cfg, "fast", models[2], {
				fast: "openai/gpt-4o-mini",
			}).model.id,
			"gpt-4o-mini",
		);
		// per-tool model wins
		assert.equal(
			config.resolveToolModel(
				registry,
				{ model: "anthropic/claude-sonnet-4-5", maxTurns: 15, timeoutMs: 120000 },
				"fast",
				models[0],
				{ fast: "openai/gpt-4o-mini" },
			).model.id,
			"claude-sonnet-4-5",
		);
		// unresolvable tier -> heuristic fallback + notice
		const fallback = config.resolveToolModel(registry, cfg, "fast", models[2], {
			fast: "no/such-model",
		});
		assert.ok(fallback.model);
		assert.ok(fallback.notice);
	});

	test("modelCliId formats provider/id or undefined", () => {
		assert.equal(config.modelCliId(undefined), undefined);
		assert.equal(config.modelCliId({ provider: "p", id: "m" }), "p/m");
	});

	test("resolveToolModel: unresolved per-tool model falls back to parent", () => {
		const models = [
			{
				provider: "openai",
				id: "gpt-4o-mini",
				name: "Mini",
				cost: { input: 0.0001 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		];
		const registry = {
			find: () => undefined,
			getAvailable: () => models,
			hasConfiguredAuth: () => true,
		};
		const r = config.resolveToolModel(
			registry,
			{ model: "no/such", maxTurns: 15, timeoutMs: 120000 },
			"fast",
			models[0],
			{},
		);
		assert.equal(r.model.id, "gpt-4o-mini");
		assert.ok(r.notice.includes("does not resolve; using the parent model"));
	});

	test("resolveToolModel: no authenticated model -> parent, then undefined", () => {
		const models = [
			{
				provider: "openai",
				id: "gpt-4o-mini",
				name: "Mini",
				cost: { input: 0.0001 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		];
		const registry = {
			find: () => undefined,
			getAvailable: () => models,
			hasConfiguredAuth: () => false,
		};
		const withParent = config.resolveToolModel(
			registry,
			{ model: undefined, maxTurns: 15, timeoutMs: 120000 },
			"fast",
			models[0],
			{},
		);
		assert.equal(withParent.model.id, "gpt-4o-mini");
		assert.ok(
			withParent.notice.includes("no suitable model available; using the parent model"),
		);
		const withoutParent = config.resolveToolModel(
			registry,
			{ model: undefined, maxTurns: 15, timeoutMs: 120000 },
			"fast",
			undefined,
			{},
		);
		assert.equal(withoutParent.model, undefined);
		assert.ok(withoutParent.notice.includes("child will use its default"));
	});
}

console.log("render");
{
	test("progress reporter: off suppresses updates; line shows latest truncated preview", () => {
		const updates = [];
		const base = { tool: "explore" };
		assert.equal(
			runner.createProgressReporter("off", (r) => updates.push(r), base),
			undefined,
		);
		assert.equal(runner.createProgressReporter("line", undefined, base), undefined);
		assert.deepEqual(updates, []);
		const report = runner.createProgressReporter("line", (r) => updates.push(r), base);
		report("→ waiting for child response");
		report("→ read src/index.ts");
		report("x".repeat(150) + "\nsecret");
		assert.equal(updates.length, 3);
		assert.equal(updates[1].details.progress, "→ read src/index.ts");
		assert.equal(updates[1].content[0].text, updates[1].details.progress);
		assert.equal(updates[2].details.progress, "x".repeat(120));
	});
	test("progress reporter: full keeps only the last eight lines per invocation", () => {
		const updates = [];
		const base = { tool: "review" };
		const report = runner.createProgressReporter("full", (r) => updates.push(r), base);
		for (let i = 0; i < 10; i++) report(`→ read file-${i}.ts`);
		assert.equal(updates[0].details.progress, "→ read file-0.ts");
		assert.deepEqual(
			updates.at(-1).details.progress.split("\n"),
			Array.from({ length: 8 }, (_, i) => `→ read file-${i + 2}.ts`),
		);
		const other = [];
		runner.createProgressReporter("full", (r) => other.push(r), base)("→ bash $ git diff");
		assert.equal(other[0].details.progress, "→ bash $ git diff");
	});
	test("renderResult shows the live feed, then the unchanged final answer", () => {
		const theme = { fg: (_color, text) => text, bold: (text) => text };
		const context = { isError: false };
		const result = {
			content: [{ type: "text", text: "Final answer" }],
			details: {
				tool: "explore",
				progress: "→ read a.ts\n→ read b.ts",
				turns: 1,
				inputTokens: 0,
				outputTokens: 0,
				costUsd: 0,
				stoppedBy: "complete",
			},
		};
		const partial = render.renderResult(
			result,
			{ expanded: false, isPartial: true },
			theme,
			context,
		);
		assert.deepEqual(
			partial.render(80).map((s) => s.trim()),
			["→ read a.ts", "→ read b.ts"],
		);
		const final = render.renderResult(
			result,
			{ expanded: false, isPartial: false },
			theme,
			context,
		);
		assert.match(final.render(80).join("\n"), /Final answer/);
		assert.doesNotMatch(final.render(80).join("\n"), /→ read/);
	});
	test("inline activity uses compact and expanded timelines without changing the final answer", () => {
		const theme = { fg: (_color, text) => text, bold: (text) => text };
		const context = { isError: false };
		const activity = {
			elapsedMs: 21000,
			lastEventAgoMs: 8000,
			phase: "Waiting for model",
			lastAction: "read src/render.ts",
			entries: [{ atMs: 12000, text: "read src/render.ts" }],
		};
		const result = {
			content: [{ type: "text", text: "Final answer" }],
			details: {
				tool: "explore",
				activity,
				progressMode: "line",
				turns: 1,
				inputTokens: 0,
				outputTokens: 0,
				costUsd: 0,
				stoppedBy: "complete",
			},
		};
		const compact = render
			.renderResult(result, { expanded: false, isPartial: true }, theme, context)
			.render(120)
			.join("\n");
		assert.match(compact, /Waiting for model · 21s elapsed · last event 8s ago/);
		assert.match(compact, /Last: read src\/render.ts/);
		assert.doesNotMatch(compact, /12s  read/);
		const expanded = render
			.renderResult(result, { expanded: true, isPartial: true }, theme, context)
			.render(120)
			.join("\n");
		assert.match(expanded, /12s  read src\/render.ts/);
		result.details.progressMode = "full";
		assert.match(
			render
				.renderResult(result, { expanded: false, isPartial: true }, theme, context)
				.render(120)
				.join("\n"),
			/12s  read/,
		);
		const final = render
			.renderResult(result, { expanded: false, isPartial: false }, theme, context)
			.render(120)
			.join("\n");
		assert.match(final, /Final answer/);
		assert.doesNotMatch(final, /read src\/render.ts/);
		const expandedFinal = render
			.renderResult(result, { expanded: true, isPartial: false }, theme, context)
			.render(120)
			.join("\n");
		assert.match(expandedFinal, /Final answer/);
		assert.match(expandedFinal, /Recent activity:/);
		assert.match(expandedFinal, /read src\/render.ts/);
	});
	test("usageFooter: turns pluralization + token/cost/duration formatting", () => {
		assert.equal(
			render.usageFooter({
				tool: "explore",
				turns: 1,
				inputTokens: 0,
				outputTokens: 0,
				costUsd: 0,
				stoppedBy: "complete",
				durationMs: undefined,
			}),
			"[explore: 1 turn, $0.00]",
		);
		assert.equal(
			render.usageFooter({
				tool: "review",
				turns: 4,
				inputTokens: 18200,
				outputTokens: 900,
				costUsd: 0.03,
				stoppedBy: "complete",
				durationMs: 42000,
			}),
			"[review: 4 turns, 18k in, 900 out, $0.03, 42s]",
		);
		assert.equal(
			render.usageFooter({
				tool: "verify",
				turns: 2,
				inputTokens: 0,
				outputTokens: 0,
				costUsd: 0.005,
				stoppedBy: "timeout",
				durationMs: null,
			}),
			"[verify: 2 turns, $0.0050, stopped:timeout]",
		);
	});
	test("getResultText: first non-empty text part, or placeholder", () => {
		assert.equal(render.getResultText({ content: [{ type: "text", text: "hello" }] }), "hello");
		assert.equal(
			render.getResultText({
				content: [
					{ type: "text", text: "" },
					{ type: "text", text: "world" },
				],
			}),
			"world",
		);
		assert.equal(render.getResultText({ content: [{ type: "image" }] }), "(no output)");
	});
}

console.log("state spend registry");
{
	test("recordRun accumulates per tool and session", () => {
		const sid = `sess-${Math.random().toString(36).slice(2)}`;
		state.resetSessionSpend(sid);
		state.recordRun(sid, "explore", {
			turns: 3,
			inputTokens: 100,
			outputTokens: 50,
			costUsd: 0.01,
		});
		state.recordRun(sid, "explore", {
			turns: 5,
			inputTokens: 200,
			outputTokens: 80,
			costUsd: 0.02,
		});
		state.recordRun(sid, "verify", {
			turns: 2,
			inputTokens: 10,
			outputTokens: 5,
			costUsd: 0.001,
		});
		const spend = state.sessionSpend(sid);
		assert.equal(spend.get("explore").runs, 2);
		assert.equal(spend.get("explore").turns, 8);
		assert.equal(spend.get("explore").costUsd, 0.03);
		assert.equal(spend.get("verify").runs, 1);
		const total = state.sessionTotal(sid);
		assert.equal(total.runs, 3);
		assert.equal(total.turns, 10);
		assert.equal(total.inputTokens, 310);
		state.resetSessionSpend(sid);
		assert.equal(state.sessionSpend(sid).size, 0);
	});
	test("sessionSpend/sessionTotal for unknown session are empty", () => {
		assert.equal(state.sessionSpend("nope").size, 0);
		assert.deepEqual(state.sessionTotal("nope"), {
			runs: 0,
			turns: 0,
			inputTokens: 0,
			outputTokens: 0,
			costUsd: 0,
		});
	});
}

console.log("activity tracker");
{
	test("bounded timeline retains recent events, draft preview, and honest idle time", () => {
		let now = 0;
		const tracker = new ActivityTracker(() => now);
		tracker.observe({ phase: "waiting" });
		tracker.record("→ waiting for child response");
		now = 4000;
		tracker.observe({ phase: "running_tool", action: "read src/config.ts" });
		tracker.record("→ read src/config.ts");
		tracker.record("first line of result");
		now = 9000;
		tracker.observe({ phase: "reasoning" });
		tracker.observe({ phase: "responding", textDelta: "Hello " });
		tracker.observe({ phase: "responding", textDelta: "world" });
		assert.match(tracker.snapshot().entries.at(-1).text, /Hello world/);
		assert.equal(tracker.snapshot(21000).lastEventAgoMs, 12000);
		assert.equal(tracker.snapshot(21000).lastAction, "read src/config.ts");
		for (let i = 0; i < 30; i++) tracker.record(`event-${i}`);
		assert.equal(tracker.snapshot().entries.length, 24);
		assert.equal(tracker.snapshot().entries.at(-1).text, "event-29");
	});
}

console.log("live panel");
{
	test("non-modal widget tracks concurrent agents and clears when the last ends", () => {
		let now = 1000;
		const calls = [];
		const ui = { setWidget: (...args) => calls.push(args) };
		const panel = new LivePanel(() => now);
		const explore = panel.start(ui, "explore", "deepseek/deepseek-v4-pro");
		explore.update({ phase: "waiting" });
		assert.deepEqual(calls, []); // Single agent belongs in its tool row.
		now = 6000;
		const review = panel.start(ui, "review", "anthropic/opus");
		review.update({ phase: "running_tool", action: "bash $ git diff" });
		assert.equal(calls.at(-1)[0], "foreman-live");
		assert.deepEqual(calls.at(-1)[2], { placement: "aboveEditor" });
		assert.match(calls.at(-1)[1].join("\n"), /2 agents running/);
		assert.match(calls.at(-1)[1].join("\n"), /explore  0:05  ·  Waiting for model/);
		assert.match(calls.at(-1)[1].join("\n"), /review.*Running tool/);
		assert.match(calls.at(-1)[1].join("\n"), /bash \$ git diff/);
		explore.end();
		assert.deepEqual(calls.at(-1), ["foreman-live", undefined]);
		const cleared = calls.length;
		review.end();
		assert.equal(calls.length, cleared);
	});
	test("panel sanitizes tool arguments, bounds rows, and ignores updates after reset", () => {
		const calls = [];
		const ui = { setWidget: (...args) => calls.push(args) };
		const panel = new LivePanel(() => 0);
		const agents = Array.from({ length: 5 }, () => panel.start(ui, "explore", "model"));
		agents[0].update({ phase: "running_tool", action: "read secret\n\x1b[31mcolored" });
		const lines = calls.at(-1)[1];
		assert.ok(lines.length <= 10);
		assert.match(lines.join("\n"), /\+2 more running/);
		assert.doesNotMatch(lines.join("\n"), /\x1b|\n\[31m/);
		panel.reset();
		const after = calls.length;
		agents[0].update({ phase: "responding" });
		agents.forEach((agent) => agent.end());
		assert.equal(calls.length, after);
	});
}

console.log("spawn helpers");
{
	test("truncateReturn: passthrough, truncation, UTF-8 boundary", () => {
		assert.equal(spawn.truncateReturn("hello", 0), "hello"); // max<=0 disables cap
		assert.equal(spawn.truncateReturn("hello", 100), "hello");
		assert.equal(spawn.truncateReturn("hello world", 5), "hello\n[truncated: 6 chars omitted]");
		// 'é' is 2 bytes: a 2-byte cap must not split the codepoint
		assert.equal(spawn.truncateReturn("héllo", 2), "h\n[truncated: 4 chars omitted]");
	});
	test("getFinalOutput: last assistant text only", () => {
		assert.equal(
			spawn.getFinalOutput([
				{ role: "assistant", content: [{ type: "text", text: "done" }] },
			]),
			"done",
		);
		assert.equal(
			spawn.getFinalOutput([
				{ role: "assistant", content: [{ type: "text", text: "first" }] },
				{ role: "toolResult", content: [{ type: "text", text: "tool" }] },
				{ role: "assistant", content: [{ type: "text", text: "final" }] },
			]),
			"final",
		);
		assert.equal(
			spawn.getFinalOutput([{ role: "user", content: [{ type: "text", text: "q" }] }]),
			"",
		);
	});
	test("formatToolCallLine: bash/read/default previews", () => {
		assert.equal(spawn.formatToolCallLine("bash", { command: "npm test" }), "bash $ npm test");
		assert.equal(spawn.formatToolCallLine("read", { path: "src/a.ts" }), "read src/a.ts");
		assert.ok(spawn.formatToolCallLine("other", { x: 1 }).startsWith("other "));
	});
	test("child JSON events yield only phase metadata and tool calls", () => {
		assert.deepEqual(spawn.activityFromEvent({ type: "turn_start" }), { phase: "waiting" });
		assert.deepEqual(
			spawn.activityFromEvent({
				type: "message_update",
				assistantMessageEvent: { type: "thinking_delta", delta: "private thoughts" },
			}),
			{ phase: "reasoning" },
		);
		assert.deepEqual(
			spawn.activityFromEvent({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "draft answer" },
			}),
			{ phase: "responding", textDelta: "draft answer" },
		);
		assert.deepEqual(
			spawn.activityFromEvent({
				type: "tool_execution_start",
				toolName: "read",
				args: { path: "src/config.ts" },
			}),
			{ phase: "running_tool", action: "read src/config.ts" },
		);
		assert.deepEqual(
			spawn.activityFromEvent({
				type: "tool_execution_end",
				toolName: "bash",
				isError: true,
			}),
			{ phase: "tool_failed" },
		);
		assert.equal(spawn.activityFromEvent({ type: "message_end" }), undefined);
	});
}

console.log("verify mutex");
{
	test("acquire creates lockfile and blocks re-entry", () => {
		const d = tmpdir();
		assert.equal(state.tryAcquireVerify(d), true);
		assert.equal(state.tryAcquireVerify(d), false); // in-process flag
		assert.ok(fs.existsSync(path.join(d, ".pi", "foreman", "verify.lock")));
		state.releaseVerify(d);
		assert.ok(!fs.existsSync(path.join(d, ".pi", "foreman", "verify.lock")));
		fs.rmSync(d, { recursive: true, force: true });
	});
	test("stale lock (dead pid) is stolen", () => {
		const d = tmpdir();
		fs.mkdirSync(path.join(d, ".pi", "foreman"), { recursive: true });
		const { pid } = spawnSync(process.execPath, ["-e", ""]); // exits immediately -> dead pid
		fs.writeFileSync(
			path.join(d, ".pi", "foreman", "verify.lock"),
			JSON.stringify({ pid, ts: Date.now() }),
		);
		assert.equal(state.tryAcquireVerify(d), true);
		state.releaseVerify(d);
		fs.rmSync(d, { recursive: true, force: true });
	});
	test("corrupt lock is treated as stale", () => {
		const d = tmpdir();
		fs.mkdirSync(path.join(d, ".pi", "foreman"), { recursive: true });
		fs.writeFileSync(path.join(d, ".pi", "foreman", "verify.lock"), "not-json");
		assert.equal(state.tryAcquireVerify(d), true);
		state.releaseVerify(d);
		fs.rmSync(d, { recursive: true, force: true });
	});
	test("live lock (fresh ts, live pid) is not stolen", () => {
		const d = tmpdir();
		fs.mkdirSync(path.join(d, ".pi", "foreman"), { recursive: true });
		fs.writeFileSync(
			path.join(d, ".pi", "foreman", "verify.lock"),
			JSON.stringify({ pid: process.pid, ts: Date.now() }),
		);
		assert.equal(state.tryAcquireVerify(d), false);
		fs.rmSync(d, { recursive: true, force: true });
	});
}

console.log("");
console.log(`  PASS: ${pass}   FAIL: ${fail}`);
if (fail > 0) {
	for (const f of failures) console.log(`    - ${f.name}: ${f.err.message}`);
	process.exit(1);
}
fs.rmSync(agentDir, { recursive: true, force: true });
