/**
 * The shared spawn primitive: one child `pi` process per subagent call.
 *
 * - Fresh, empty message array (child process, `--no-session`, `-p`).
 * - Own system prompt via `--append-system-prompt` (temp file).
 * - Restricted tool subset via `--tools` allowlist (enforced by omission).
 * - Hard turn cap + wall-clock timeout, both enforced from the parent.
 * - Parent `AbortSignal` propagates: Ctrl-C kills the child process group
 *   (SIGTERM, then SIGKILL after 5s), taking in-flight bash with it.
 * - Bash calls are gated by `src/child-bash.ts` (loaded via `-e`), which
 *   enforces the read-only allowlist (explore/review) or watch-refusal +
 *   timeout clamp (verify) — see that file.
 * - Returns a single string; never throws into the parent loop. Failures
 *   come back as structured error text.
 */

import { spawn as childSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { checkFormatCompliance } from "./telemetry.ts";

export type BashMode = "explore" | "review" | "verify";

export interface SpawnOptions {
	systemPrompt: string;
	/** Subset of the built-in tool names; never explore/review/verify. */
	toolNames: string[];
	/** The task, written by the parent. The child sees only this. */
	prompt: string;
	/** "provider/id" for --model, or undefined to let the child use its default. */
	modelCliId?: string;
	maxTurns: number;
	timeoutMs: number;
	/** Parent tool execute() AbortSignal. Ctrl-C must kill children immediately. */
	signal?: AbortSignal;
	/** Stream child activity lines to the TUI (never into the parent's message array). */
	onUpdate?: (line: string) => void;
	cwd: string;
	bashMode: BashMode;
	/** If the parent passed an explicit one-shot verify command. */
	explicitVerifyCommand: boolean;
	/** Return value truncation cap. */
	maxReturnChars: number;
	/** Path to write the full child transcript ("" disables). */
	logPath?: string;
	/** First 8 hex chars of the sha1 of systemPrompt (telemetry prompt version). */
	promptVersion?: string;
}

export interface SpawnResult {
	/** Last assistant text, truncated to maxReturnChars. */
	text: string;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	stoppedBy: "complete" | "max_turns" | "timeout" | "aborted";
	/** Wall-clock child runtime in ms (spawn to process close). */
	durationMs: number;
	exitCode: number;
	/** Did the child return its required output format (checked pre-truncation)? */
	formatCompliant: boolean;
	model?: string;
	provider?: string;
	/** Structured failure info when the run did not complete cleanly. */
	error?: string;
}

const FORBIDDEN_TOOLS = new Set(["explore", "review", "verify"]);
const SUPPORTED_TOOLS = new Set(["read", "bash"]);

type StopReason = "complete" | "max_turns" | "timeout" | "aborted";

const CHILD_BASH_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "child-bash.ts");

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

interface ChildMessage {
	role: string;
	content: Array<{ type: string; text?: string; name?: string; arguments?: unknown }>;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: { total?: number };
	};
	model?: string;
	provider?: string;
	stopReason?: string;
	errorMessage?: string;
}

export function getFinalOutput(messages: ChildMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text) return part.text;
			}
		}
	}
	return "";
}

export function formatToolCallLine(toolName: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	switch (toolName) {
		case "bash": {
			const cmd = typeof a.command === "string" ? a.command : "...";
			const preview = cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd;
			return `bash $ ${preview}`;
		}
		case "read": {
			const p = typeof (a.path ?? a.file_path) === "string" ? (a.path ?? a.file_path) : "...";
			return `read ${p}`;
		}
		default: {
			const s = JSON.stringify(a);
			return `${toolName} ${s.length > 60 ? `${s.slice(0, 60)}…` : s}`;
		}
	}
}

export function truncateReturn(text: string, max: number): string {
	if (max <= 0) return text;
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= max) return text;
	// Don't split a multi-byte codepoint: back off to a UTF-8 boundary.
	let end = max;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
	const kept = buf.toString("utf8", 0, end);
	const omitted = text.length - kept.length;
	return `${kept}\n[truncated: ${omitted} chars omitted]`;
}

function writeLog(logPath: string, data: Record<string, unknown>): void {
	try {
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		fs.writeFileSync(logPath, JSON.stringify(data, null, 2));
		// Cap at the last 50 logs in the session log directory. Only stat/sort
		// when the cap could actually be exceeded (the common case is a handful
		// of files, so the O(files) stat scan is skipped entirely).
		const dir = path.dirname(logPath);
		const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
		if (files.length > 50) {
			const withTime = files.map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }));
			withTime.sort((a, b) => b.t - a.t);
			for (const old of withTime.slice(50)) {
				try {
					fs.unlinkSync(path.join(dir, old.f));
				} catch {
					/* ignore */
				}
			}
		}
	} catch {
		/* logging must never break a tool call */
	}
}

export async function spawn(opts: SpawnOptions): Promise<SpawnResult> {
	// Depth limiting: assert at construction, not at call time.
	for (const t of opts.toolNames) {
		if (FORBIDDEN_TOOLS.has(t)) {
			throw new Error(
				`foreman: tool "${t}" must never be given to a child agent (depth limit)`,
			);
		}
		if (!SUPPORTED_TOOLS.has(t)) {
			throw new Error(`foreman: unsupported child tool "${t}" (children only get read/bash)`);
		}
	}

	const empty: SpawnResult = {
		text: "",
		turns: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
		stoppedBy: "complete",
		durationMs: 0,
		exitCode: 0,
		formatCompliant: false,
	};

	const args: string[] = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"-e",
		CHILD_BASH_PATH,
		"--tools",
		opts.toolNames.join(","),
	];
	if (opts.modelCliId) args.push("--model", opts.modelCliId);

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const messages: ChildMessage[] = [];
	const stderrParts: string[] = [];
	const result: SpawnResult = { ...empty, model: undefined, provider: undefined };

	let stoppedBy: StopReason = "complete";
	let childError: string | undefined;
	let timer: NodeJS.Timeout | undefined;
	let killTimer: NodeJS.Timeout | undefined;
	let aborted = false;
	let proc: ReturnType<typeof childSpawn> | undefined;

	const emitLine = (line: string) => {
		opts.onUpdate?.(line);
	};

	const processLine = (line: string) => {
		if (!line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (!event || typeof event.type !== "string") return;

		if (event.type === "turn_start") {
			emitLine("→ waiting for child response");
		}
		if (event.type === "tool_execution_start" && event.toolName) {
			emitLine(`→ ${formatToolCallLine(event.toolName, event.args)}`);
		}
		if (event.type === "tool_execution_end" && event.toolName) {
			emitLine(`→ ${event.toolName} done${event.isError ? " (error)" : ""}`);
		}
		if (event.type === "message_end" && event.message) {
			const msg = event.message as ChildMessage;
			messages.push(msg);
			if (msg.role === "assistant") {
				result.turns += 1;
				const usage = msg.usage;
				if (usage) {
					result.inputTokens += usage.input ?? 0;
					result.outputTokens += usage.output ?? 0;
					result.cacheReadTokens += usage.cacheRead ?? 0;
					result.cacheWriteTokens += usage.cacheWrite ?? 0;
					result.costUsd += usage.cost?.total ?? 0;
				}
				if (!result.model && msg.model) result.model = msg.model;
				if (!result.provider && msg.provider) result.provider = msg.provider;
				if (msg.errorMessage) childError = msg.errorMessage;

				const text = getFinalOutput([msg]);
				if (text) emitLine(text.split("\n")[0].slice(0, 120));

				// Hard turn cap: the child wants another turn but has hit the cap.
				if (result.turns >= opts.maxTurns && msg.stopReason === "toolUse") {
					stoppedBy = "max_turns";
					killSoft();
				}
			}
			if (msg.role === "toolResult") {
				const text = getTextFromParts(msg);
				if (text) emitLine(text.split("\n")[0].slice(0, 120));
			}
		}
		if (event.type === "agent_end" || event.type === "agent_settled") {
			// The child loop ended on its own. Nothing to do — the turn cap only
			// fires when the child keeps requesting tool calls.
		}
	};

	function getTextFromParts(msg: ChildMessage): string {
		for (const part of msg.content) {
			if (part.type === "text" && part.text) return part.text;
		}
		return "";
	}

	const killGroup = (sig: NodeJS.Signals) => {
		if (proc?.pid) {
			try {
				process.kill(-proc.pid, sig);
			} catch {
				try {
					process.kill(proc.pid, sig);
				} catch {
					/* already dead */
				}
			}
		}
	};
	function killSoft(): void {
		killGroup("SIGTERM");
		if (!killTimer) {
			killTimer = setTimeout(() => killGroup("SIGKILL"), 5000);
			killTimer.unref?.();
		}
	}

	try {
		if (opts.systemPrompt.trim()) {
			tmpPromptDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-foreman-"));
			tmpPromptPath = path.join(tmpPromptDir, "system-prompt.md");
			fs.writeFileSync(tmpPromptPath, opts.systemPrompt, { encoding: "utf-8", mode: 0o600 });
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(opts.prompt);

		const startedAt = Date.now();
		const invocation = getPiInvocation(args);
		const child = childSpawn(invocation.command, invocation.args, {
			cwd: opts.cwd,
			detached: true, // own process group so we can kill bash grandchildren too
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				FOREMAN_BASH_MODE: opts.bashMode,
				FOREMAN_BASH_TIMEOUT_MS: String(Math.floor(0.8 * opts.timeoutMs)),
				FOREMAN_VERIFY_EXPLICIT: opts.explicitVerifyCommand ? "1" : "0",
				CI: "1",
				TERM: "dumb",
				FORCE_COLOR: "0",
				NO_COLOR: "1",
			},
		});
		proc = child;

		let buffer = "";
		child.stdout!.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		child.stderr!.on("data", (data) => {
			stderrParts.push(data.toString());
		});

		// Wall-clock timeout is hard.
		timer = setTimeout(() => {
			stoppedBy = "timeout";
			killSoft();
		}, opts.timeoutMs);
		timer.unref?.();

		// Parent abort propagates: Ctrl-C must kill the child immediately.
		const onAbort = () => {
			aborted = true;
			stoppedBy = "aborted";
			killSoft();
		};
		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}

		// Process-level fallback. Interactive mode handles Ctrl-C via the TUI
		// (agent abort -> ctx.signal above). Print mode has no SIGINT handling at
		// all, and pi's SIGTERM/SIGHUP handler in print mode exits without
		// waiting for us — so we kill the child process group ourselves, first.
		const onSigTerm = () => {
			aborted = true;
			stoppedBy = "aborted";
			killGroup("SIGTERM");
			setTimeout(() => killGroup("SIGKILL"), 1000);
		};
		const onSigInt = () => {
			onSigTerm();
			// A SIGINT listener disables Node's default exit; re-raise after the
			// child group has been signaled so the parent still terminates.
			setTimeout(() => {
				process.removeListener("SIGINT", onSigInt);
				process.kill(process.pid, "SIGINT");
			}, 1500);
		};
		process.on("SIGINT", onSigInt);
		process.prependListener("SIGTERM", onSigTerm);
		process.prependListener("SIGHUP", onSigTerm);

		const exitCode = await new Promise<number>((resolve) => {
			child.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				clearTimeout(timer);
				clearTimeout(killTimer);
				if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
				process.removeListener("SIGINT", onSigInt);
				process.removeListener("SIGTERM", onSigTerm);
				process.removeListener("SIGHUP", onSigTerm);
				resolve(code ?? 0);
			});
			child.on("error", () => {
				clearTimeout(timer);
				clearTimeout(killTimer);
				if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
				process.removeListener("SIGINT", onSigInt);
				process.removeListener("SIGTERM", onSigTerm);
				process.removeListener("SIGHUP", onSigTerm);
				resolve(1);
			});
		});

		result.stoppedBy = stoppedBy;
		result.durationMs = Date.now() - startedAt;
		result.exitCode = exitCode;

		let text = getFinalOutput(messages);
		if (!text && aborted) {
			text = "(aborted)";
		} else if (!text && (stoppedBy as StopReason) === "timeout") {
			text = "(timed out, no output)";
		} else if (!text) {
			// No assistant text: surface a structured error the parent can act on.
			const stderrTail = stderrParts.join("").trim().slice(-2000);
			const exitNote =
				exitCode !== 0 ? `\n[foreman: child exited with code ${exitCode}]` : "";
			text = `${(childError ?? stderrTail) || "(no output)"}${exitNote}`.trim();
			if (exitCode !== 0 || childError) result.error = text;
		} else if (childError && (exitCode !== 0 || (stoppedBy as StopReason) !== "complete")) {
			result.error = childError;
		}

		result.text = truncateReturn(text, opts.maxReturnChars);
		result.formatCompliant = checkFormatCompliance(opts.bashMode, text);

		if (opts.logPath) {
			writeLog(opts.logPath, {
				tool: opts.bashMode,
				model: result.model,
				provider: result.provider,
				prompt: opts.prompt,
				systemPrompt: opts.systemPrompt,
				promptVersion: opts.promptVersion,
				toolNames: opts.toolNames,
				config: {
					maxTurns: opts.maxTurns,
					timeoutMs: opts.timeoutMs,
					modelCliId: opts.modelCliId,
				},
				stoppedBy: result.stoppedBy,
				exitCode,
				durationMs: result.durationMs,
				usage: {
					turns: result.turns,
					input: result.inputTokens,
					output: result.outputTokens,
					cacheRead: result.cacheReadTokens,
					cacheWrite: result.cacheWriteTokens,
					costUsd: result.costUsd,
				},
				error: result.error,
				timestamp: new Date().toISOString(),
				cwd: opts.cwd,
				messages,
			});
		}

		return result;
	} catch (err) {
		// Synchronous setup failure (temp prompt, child spawn, filesystem) —
		// convert to a structured result rather than throwing into the parent
		// tool loop, per the brief's "never throw into the parent loop".
		const message = err instanceof Error ? err.message : String(err);
		return {
			...empty,
			text: `[foreman: failed to spawn child: ${message}]`,
			stoppedBy: "complete",
			exitCode: 1,
			error: `Failed to spawn child: ${message}`,
			formatCompliant: false,
			durationMs: 0,
		};
	} finally {
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		}
		if (tmpPromptDir) {
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		}
	}
}
