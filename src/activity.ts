import type { ChildActivity } from "./live-panel.ts";

export interface ActivityEntry {
	atMs: number;
	text: string;
}

export interface ActivitySnapshot {
	elapsedMs: number;
	lastEventAgoMs: number;
	phase: string;
	lastAction?: string;
	entries: ActivityEntry[];
}

const MAX_ENTRIES = 24;
const MAX_ENTRY_CHARS = 160;

/** Never let child output inject terminal controls or grow an unbounded UI history. */
function preview(text: string): string {
	return text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_ENTRY_CHARS);
}

const PHASES: Record<ChildActivity["phase"], string> = {
	waiting: "Waiting for model",
	reasoning: "Reasoning stream active",
	responding: "Receiving response",
	preparing_tool: "Preparing tool call",
	running_tool: "Running tool",
	tool_finished: "Tool finished",
	tool_failed: "Tool failed",
};

/** A bounded, per-call view of observable events, never sent to the parent model. */
export class ActivityTracker {
	private startedAt: number;
	private lastEventAt: number;
	private phase = "Starting child";
	private lastAction?: string;
	private entries: ActivityEntry[] = [];
	private draft = "";
	private draftEntry?: ActivityEntry;
	private now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
		this.startedAt = now();
		this.lastEventAt = this.startedAt;
	}

	observe(activity: ChildActivity): void {
		this.lastEventAt = this.now();
		this.phase = PHASES[activity.phase];
		if (activity.action) this.lastAction = preview(activity.action);
		if (activity.phase !== "responding") {
			this.draft = "";
			this.draftEntry = undefined;
		}
		if (activity.textDelta) {
			// Only assistant text, never thinking_delta. Keep one updating
			// entry instead of an entry per token; cap the raw buffer too.
			this.draft = (this.draft + activity.textDelta).slice(-MAX_ENTRY_CHARS * 2);
			const text = preview(this.draft);
			if (this.draftEntry) this.draftEntry.text = `Response: ${text}`;
			else if (text) this.draftEntry = this.add(`Response: ${text}`);
		}
	}

	record(line: string): void {
		const text = preview(line);
		if (!text) return;
		this.lastEventAt = this.now();
		if (
			text.startsWith("→ ") &&
			!/waiting for child response|starting | done(?: |$)/.test(text)
		) {
			this.lastAction = text.slice(2);
		}
		if (text.includes("waiting for child response")) {
			this.add("Waiting for model");
		} else if (!this.draftEntry || !this.draft.startsWith(text)) {
			this.add(text);
		}
	}

	snapshot(now = this.now()): ActivitySnapshot {
		return {
			elapsedMs: Math.max(0, now - this.startedAt),
			lastEventAgoMs: Math.max(0, now - this.lastEventAt),
			phase: this.phase,
			lastAction: this.lastAction,
			entries: this.entries.map((entry) => ({ ...entry })),
		};
	}

	private add(text: string): ActivityEntry {
		const entry = { atMs: this.now() - this.startedAt, text };
		this.entries.push(entry);
		if (this.entries.length > MAX_ENTRIES) this.entries.shift();
		return entry;
	}
}
