import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

/**
 * Per-session spend registry (for /foreman and the status bar) and the
 * verify mutex.
 */

export interface RunStats {
	turns: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
}

export interface ToolSpend extends RunStats {
	runs: number;
}

const spendBySession = new Map<string, Map<string, ToolSpend>>();

export function recordRun(sessionId: string, tool: string, r: RunStats): void {
	let tools = spendBySession.get(sessionId);
	if (!tools) {
		tools = new Map();
		spendBySession.set(sessionId, tools);
	}
	const cur = tools.get(tool) ?? {
		runs: 0,
		turns: 0,
		inputTokens: 0,
		outputTokens: 0,
		costUsd: 0,
	};
	cur.runs += 1;
	cur.turns += r.turns;
	cur.inputTokens += r.inputTokens;
	cur.outputTokens += r.outputTokens;
	cur.costUsd += r.costUsd;
	tools.set(tool, cur);
}

export function sessionSpend(sessionId: string): Map<string, ToolSpend> {
	return spendBySession.get(sessionId) ?? new Map();
}

export function sessionTotal(sessionId: string): ToolSpend {
	let total: ToolSpend = { runs: 0, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
	for (const s of sessionSpend(sessionId).values()) {
		total = {
			runs: total.runs + s.runs,
			turns: total.turns + s.turns,
			inputTokens: total.inputTokens + s.inputTokens,
			outputTokens: total.outputTokens + s.outputTokens,
			costUsd: total.costUsd + s.costUsd,
		};
	}
	return total;
}

export function resetSessionSpend(sessionId: string): void {
	spendBySession.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Verify mutex — verify calls must never run concurrently (builds fight over
// lockfiles, ports, build dirs). Two layers:
//  1. an in-process flag (fast path, also covers reentrancy);
//  2. a lockfile at .pi/foreman/verify.lock so two pi sessions in the same
//     repo cannot run concurrent builds either.
// The lockfile records pid+timestamp. Staleness is primarily pid liveness
// (a crashed process's lock is stolen immediately); a 24h backstop covers pid
// reuse. Stealing is best-effort — a rare double-steal race could briefly
// admit two verifies, still far better than the always-concurrent status quo.
// ---------------------------------------------------------------------------

let verifyLocked = false;

function verifyLockPath(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "foreman", "verify.lock");
}

/** Backstop only (pid liveness is the primary signal); no verify runs 24h. */
const LOCK_STALE_MS = 24 * 60 * 60 * 1000;

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function lockIsStale(lockPath: string): boolean {
	try {
		const raw = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: number; ts?: number };
		const ts = typeof raw.ts === "number" ? raw.ts : 0;
		if (typeof raw.pid === "number" && raw.pid > 0) {
			return !pidAlive(raw.pid) || Date.now() - ts > LOCK_STALE_MS;
		}
		return Date.now() - ts > LOCK_STALE_MS;
	} catch {
		// Corrupt/unreadable lock: treat as stale so it can be replaced.
		return true;
	}
}

export function tryAcquireVerify(cwd: string): boolean {
	if (verifyLocked) return false;
	const lockPath = verifyLockPath(cwd);
	const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });
	try {
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.writeFileSync(lockPath, payload, { flag: "wx" }); // atomic create
		verifyLocked = true;
		return true;
	} catch {
		// Already exists (or unreadable dir): steal only if the holder is gone.
		if (lockIsStale(lockPath)) {
			try {
				fs.rmSync(lockPath, { force: true });
				fs.writeFileSync(lockPath, payload, { flag: "wx" });
				verifyLocked = true;
				return true;
			} catch {
				return false;
			}
		}
		return false;
	}
}

export function releaseVerify(cwd: string): void {
	verifyLocked = false;
	try {
		fs.rmSync(verifyLockPath(cwd), { force: true });
	} catch {
		/* best-effort */
	}
}
