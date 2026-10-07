import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ToolKind } from "./render.ts";

/** Only observable phases, never the child's private reasoning or raw output. */
export interface ChildActivity {
	phase:
		| "waiting"
		| "reasoning"
		| "responding"
		| "preparing_tool"
		| "running_tool"
		| "tool_finished"
		| "tool_failed";
	action?: string;
	/** Visible assistant text only; never thinking content. */
	textDelta?: string;
}

interface RunningAgent {
	kind: ToolKind;
	model: string;
	startedAt: number;
	phase: string;
	lastAction?: string;
}

const WIDGET_KEY = "foreman-live";
const MAX_VISIBLE_AGENTS = 3;

function safeLabel(text: string, max = 80): string {
	// Tool arguments and paths can come from repo content. Never pass control
	// characters, ANSI escapes, or multiline output into a persistent widget.
	return text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

function elapsed(startedAt: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
	const minutes = Math.floor(seconds / 60);
	return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

const PHASE_LABELS: Record<ChildActivity["phase"], string> = {
	waiting: "Waiting for model",
	reasoning: "Reasoning stream active",
	responding: "Receiving response",
	preparing_tool: "Preparing tool call",
	running_tool: "Running tool",
	tool_finished: "Tool finished",
	tool_failed: "Tool failed",
};

export function formatPanelLines(agents: RunningAgent[], now: number): string[] {
	const lines = [`Foreman  ·  ${agents.length} agent${agents.length === 1 ? "" : "s"} running`];
	for (const agent of agents.slice(0, MAX_VISIBLE_AGENTS)) {
		lines.push(
			`${agent.kind}  ${elapsed(agent.startedAt, now)}  ·  ${agent.phase}  ·  ${safeLabel(agent.model, 35)}`,
		);
		if (agent.lastAction) lines.push(`  ${safeLabel(agent.lastAction)}`);
	}
	if (agents.length > MAX_VISIBLE_AGENTS) {
		lines.push(`  +${agents.length - MAX_VISIBLE_AGENTS} more running`);
	}
	return lines;
}

/** A single non-modal widget shared by concurrently running Foreman calls. */
export class LivePanel {
	private agents = new Map<symbol, RunningAgent>();
	private ui: ExtensionUIContext | undefined;
	private timer: NodeJS.Timeout | undefined;
	private visible = false;
	private now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	start(
		ui: ExtensionUIContext,
		kind: ToolKind,
		model: string,
	): { update: (activity: ChildActivity) => void; end: () => void } {
		const id = Symbol(kind);
		this.ui = ui;
		this.agents.set(id, { kind, model, startedAt: this.now(), phase: "Starting child" });
		if (!this.timer) {
			this.timer = setInterval(() => this.render(), 1000);
			this.timer.unref?.();
		}
		this.render();
		return {
			update: (activity) => {
				const agent = this.agents.get(id);
				if (!agent) return; // session changed or call already completed
				const phase = PHASE_LABELS[activity.phase];
				const action = activity.action ? safeLabel(activity.action) : agent.lastAction;
				if (phase === agent.phase && action === agent.lastAction) return;
				agent.phase = phase;
				agent.lastAction = action;
				this.render();
			},
			end: () => {
				if (!this.agents.delete(id)) return;
				if (this.agents.size === 0) this.reset();
				else this.render();
			},
		};
	}

	reset(): void {
		this.agents.clear();
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		try {
			if (this.visible) this.ui?.setWidget(WIDGET_KEY, undefined);
		} catch {
			// UI may have been disposed during a session switch or shutdown.
		}
		this.visible = false;
		this.ui = undefined;
	}

	private render(): void {
		if (!this.ui) return;
		try {
			// The inline tool row owns single-agent activity. Pin an overview only
			// when concurrent agents make it hard to track which call is active.
			if (this.agents.size < 2) {
				if (this.visible) this.ui.setWidget(WIDGET_KEY, undefined);
				this.visible = false;
			} else {
				this.ui.setWidget(
					WIDGET_KEY,
					formatPanelLines([...this.agents.values()], this.now()),
					{
						placement: "aboveEditor",
					},
				);
				this.visible = true;
			}
		} catch {
			// Display failures must not affect the child or its final result.
		}
	}
}

export const livePanel = new LivePanel();
