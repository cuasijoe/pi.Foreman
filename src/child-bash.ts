/**
 * Child-side bash gate.
 *
 * Loaded into every child agent process via `-e` (explicit path, so it loads
 * even with `--no-extensions`). Overrides the built-in `bash` tool so the
 * child's command surface is enforced by omission, not by prompt:
 *
 * - explore / review modes: read-only allowlist (rg, grep, find, ls, cat,
 *   head, tail, wc, git log/show/blame, + git diff/status for review).
 *   Rejections are returned to the child as error text so it retries.
 * - verify mode: unrestricted, but watch/serve/dev commands are refused
 *   (unless the parent passed an explicit one-shot command), and every
 *   command is clamped to 80% of the child's wall-clock budget so a hung
 *   build cannot hang the child.
 *
 * Mode, budget, and the explicit-command flag arrive via env from the parent
 * (see src/spawn.ts). Result shape mirrors the built-in bash tool contract.
 */

import {
	createLocalBashOperations,
	truncateHead,
	truncateTail,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type BashMode = "explore" | "review" | "verify";

const MODE: BashMode = (process.env.FOREMAN_BASH_MODE as BashMode) || "explore";
/** 80% of the child's wall-clock budget, in seconds. */
const MAX_TIMEOUT_SECS =
	Number(process.env.FOREMAN_BASH_TIMEOUT_MS ?? 0) > 0
		? Number(process.env.FOREMAN_BASH_TIMEOUT_MS) / 1000
		: undefined;
/** Set when the parent passed an explicit one-shot verify command. */
const EXPLICIT = process.env.FOREMAN_VERIFY_EXPLICIT === "1";

const READERS = new Set(["rg", "grep", "find", "ls", "cat", "head", "tail", "wc", "git"]);
const EXPLORE_GIT = new Set(["log", "show", "blame"]);
const REVIEW_GIT = new Set(["log", "show", "blame", "diff", "status"]);

/** Per-binary flags that execute arbitrary commands or hang. Blocked even on
 *  allowlisted binaries: a read-only search has no use for them, and they are
 *  the remaining exec surface once shell control operators are rejected. */
const BLOCKED_FLAGS: Record<string, Set<string>> = {
	find: new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprintf"]),
	rg: new Set(["--pre", "--pre-glob"]),
	grep: new Set(["--pre", "--pre-glob"]),
	tail: new Set(["-f", "--follow", "-F", "--retry"]),
};

const WATCH_RE = /(^|\s)(--watch(=\S+)?|--watchAll|-w|watch|dev|serve|start)(\s|$)/;

/** Tokenize honoring single/double quotes. */
export function tokenize(cmd: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(cmd))) tokens.push(m[1] ?? m[2] ?? m[3]);
	return tokens;
}

/**
 * Reject shell control operators *outside quotes*. This is the structural
 * half of the allowlist: no chaining, substitution, or redirection survives,
 * so the only thing left to validate is each pipe segment's first token.
 * Redirection characters inside a quoted argument (e.g. `rg -n "a > b"`)
 * are search text and are allowed.
 */
export function shellControl(cmd: string): string | undefined {
	let inS = false;
	let inD = false;
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i];
		if (c === "'" && !inD) {
			inS = !inS;
			continue;
		}
		if (c === '"' && !inS) {
			inD = !inD;
			continue;
		}
		if (inS || inD) continue;
		if (c === "$" && cmd[i + 1] === "(") return "command substitution $(...) is not allowed";
		if (c === "`") return "command substitution (backticks) is not allowed";
		if (c === ";") return "command chaining (;) is not allowed";
		if (c === "&") return "command chaining (& or &&) is not allowed";
		if (c === "\n") return "command chaining (newline) is not allowed";
		if (c === "<" || c === ">") return "shell redirection (<, >, >>) is not allowed";
	}
	return undefined;
}

/** Split on pipes outside quotes, so `rg -n "a|b"` stays one segment. */
export function splitPipes(cmd: string): string[] {
	const parts: string[] = [];
	let cur = "";
	let inS = false;
	let inD = false;
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i];
		if (c === "'" && !inD) {
			inS = !inS;
			cur += c;
			continue;
		}
		if (c === '"' && !inS) {
			inD = !inD;
			cur += c;
			continue;
		}
		if (c === "|" && !inS && !inD) {
			parts.push(cur);
			cur = "";
			continue;
		}
		cur += c;
	}
	parts.push(cur);
	return parts;
}

export function validateReadOnlySegment(
	seg: string,
	mode: "explore" | "review",
): string | undefined {
	const tokens = tokenize(seg);
	if (tokens.length === 0) return "empty command";
	const bin = tokens[0];
	if (!READERS.has(bin)) return `command "${bin}" is not on the read-only allowlist`;
	if (bin === "git") {
		const sub = tokens[1];
		const allowed = mode === "review" ? REVIEW_GIT : EXPLORE_GIT;
		if (!sub || !allowed.has(sub)) {
			return `git ${sub ?? ""} is not allowed here (allowed: ${[...allowed].join(", ")})`;
		}
	}
	const blocked = BLOCKED_FLAGS[bin];
	if (blocked) {
		for (const t of tokens) {
			const isPre = (bin === "rg" || bin === "grep") && t.startsWith("--pre");
			if (blocked.has(t) || isPre) {
				return `flag "${t}" is not allowed for ${bin}`;
			}
		}
	}
	return undefined;
}

export function validateReadOnly(cmd: string, mode: "explore" | "review"): string | undefined {
	const control = shellControl(cmd);
	if (control) return control;
	for (const seg of splitPipes(cmd)) {
		const rejection = validateReadOnlySegment(seg, mode);
		if (rejection) return rejection;
	}
	return undefined;
}

export function validateVerify(cmd: string, explicit: boolean): string | undefined {
	if (!explicit && WATCH_RE.test(cmd)) {
		return "this looks like a watch/dev/serve/start command. Pick a one-shot command instead (for example `npm test -- --run`, `jest --ci`, `go test ./...`).";
	}
	return undefined;
}

const local = createLocalBashOperations();

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "bash",
		label: "Bash",
		description:
			"Execute a bash command in the current working directory. Returns stdout and stderr. " +
			(MODE === "verify"
				? "Unrestricted, but watch/dev/serve commands are refused; commands time out automatically."
				: "Read-only search commands only (rg, grep, find, ls, cat, head, tail, wc, git log/show/blame)."),
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)" })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const command = params.command;

			const rejection =
				MODE === "verify"
					? validateVerify(command, EXPLICIT)
					: validateReadOnly(command, MODE as "explore" | "review");
			if (rejection) {
				throw new Error(
					`Command not allowed: ${rejection}\nPick a different command and try again. Do not try to modify files or bypass this restriction.`,
				);
			}

			// Clamp the per-command timeout to 80% of the child's wall-clock budget.
			const requestedSecs =
				typeof params.timeout === "number" && params.timeout > 0
					? params.timeout
					: undefined;
			const timeoutSecs =
				MAX_TIMEOUT_SECS !== undefined
					? Math.min(requestedSecs ?? MAX_TIMEOUT_SECS, MAX_TIMEOUT_SECS)
					: requestedSecs;

			let output = "";
			const env = { ...process.env, CI: "1", TERM: "dumb", FORCE_COLOR: "0", NO_COLOR: "1" };

			let exitCode: number | null;
			try {
				const result = await local.exec(command, ctx.cwd, {
					onData: (data) => {
						output += data.toString();
					},
					signal,
					timeout: timeoutSecs,
					env,
				});
				exitCode = result.exitCode;
			} catch (err) {
				if (err instanceof Error && err.message === "aborted") {
					throw new Error("Command aborted");
				}
				if (err instanceof Error && err.message.startsWith("timeout:")) {
					const secs = err.message.split(":")[1] ?? String(timeoutSecs ?? "?");
					throw new Error(`Command timed out after ${secs} seconds`);
				}
				throw err;
			}

			// Truncate: head for search output, tail for build/test output (errors live at the end).
			const truncated = MODE === "verify" ? truncateTail(output) : truncateHead(output);
			let text = truncated.content || "(no output)";
			if (truncated.truncated) {
				text += `\n\n[Output truncated: showing ${truncated.outputLines} of ${truncated.totalLines} lines (${truncated.outputBytes} of ${truncated.totalBytes} bytes)]`;
			}

			if (exitCode !== 0 && exitCode !== null) {
				throw new Error(`${text}\n\nCommand exited with code ${exitCode}`);
			}
			return {
				content: [{ type: "text", text }],
				details: {
					truncated: truncated.truncated,
					exitCode,
				},
			};
		},
	});
}
