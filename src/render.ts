/**
 * TUI rendering for the three subagent tools.
 *
 * - renderCall: one line — tool name + the parameter that matters.
 * - renderResult: collapsed to a compact 1-2 line summary (first line of the
 *   answer + a usage footer); expanded shows the full answer as Markdown.
 * - Streaming: while a child runs, renderResult(isPartial) shows the configured
 *   activity view (latest line or bounded rolling feed).
 */

import type {
	AgentToolResult,
	ToolRenderResultOptions,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import type { ActivitySnapshot } from "./activity.ts";
import type { ProgressMode } from "./config.ts";

export type ToolKind = "explore" | "review" | "verify";

export interface ForemanToolDetails {
	tool: ToolKind;
	stoppedBy: string;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	durationMs?: number;
	outcome?: string;
	model?: string;
	provider?: string;
	error?: string;
	logPath?: string;
	/** Latest activity line while streaming. */
	progress?: string;
	/** Bounded visible activity history, never sent to the parent model. */
	activity?: ActivitySnapshot;
	progressMode?: ProgressMode;
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatCost(cost: number): string {
	if (cost <= 0) return "$0.00";
	return cost >= 0.01 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`;
}

/** The compact footer appended to every tool result, e.g. `[explore: 4 turns, 18.2k in / 0.9k out, $0.03, 42s]`. */
export function usageFooter(
	d: Pick<
		ForemanToolDetails,
		"tool" | "turns" | "inputTokens" | "outputTokens" | "costUsd" | "stoppedBy" | "durationMs"
	>,
): string {
	const parts: string[] = [];
	if (d.turns > 0) parts.push(`${d.turns} turn${d.turns > 1 ? "s" : ""}`);
	if (d.inputTokens > 0) parts.push(`${formatTokens(d.inputTokens)} in`);
	if (d.outputTokens > 0) parts.push(`${formatTokens(d.outputTokens)} out`);
	parts.push(formatCost(d.costUsd));
	if (d.durationMs != null) parts.push(`${Math.round(d.durationMs / 1000)}s`);
	if (d.stoppedBy !== "complete") parts.push(`stopped:${d.stoppedBy}`);
	return `[${d.tool}: ${parts.join(", ")}]`;
}

export function getResultText(result: AgentToolResult<ForemanToolDetails>): string {
	for (const part of result.content) {
		if (part.type === "text" && part.text) return part.text;
	}
	return "(no output)";
}

function paramPreview(args: Record<string, unknown>, keys: string[]): string {
	for (const k of keys) {
		const v = args[k];
		if (typeof v === "string" && v.trim()) {
			const oneLine = v.replace(/\s+/g, " ").trim();
			return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
		}
	}
	return "...";
}

export function makeRenderCall(
	kind: ToolKind,
): (args: Record<string, unknown>, theme: Theme, context: RenderCallContext) => Component {
	const label = kind.charAt(0).toUpperCase() + kind.slice(1);
	return (args, theme, context) => {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		let content = theme.fg("toolTitle", theme.bold(`foreman:${kind} `));
		switch (kind) {
			case "explore":
				content += theme.fg(
					"accent",
					paramPreview(args as Record<string, unknown>, ["question"]),
				);
				break;
			case "review":
				content += theme.fg(
					"accent",
					paramPreview(args as Record<string, unknown>, ["intent"]),
				);
				break;
			case "verify": {
				const cmd = (args as Record<string, unknown>).command;
				content += theme.fg(
					"accent",
					typeof cmd === "string" && cmd.trim() ? cmd.trim() : "(discover command)",
				);
				break;
			}
		}
		if (!context.executionStarted) {
			content += theme.fg("dim", ` — ${label}`);
		}
		text.setText(content);
		return text;
	};
}

export interface RenderCallContext {
	args: unknown;
	lastComponent: Component | undefined;
	executionStarted: boolean;
	isError: boolean;
	state: Record<string, unknown>;
}

export type RenderResultFn = (
	result: AgentToolResult<ForemanToolDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderCallContext,
) => Component;

function activityLines(activity: ActivitySnapshot, expanded: boolean): string[] {
	const seconds = (ms: number) => `${Math.floor(ms / 1000)}s`;
	const lines = [
		`${activity.phase} · ${seconds(activity.elapsedMs)} elapsed · last event ${seconds(activity.lastEventAgoMs)} ago`,
	];
	if (expanded) {
		const skipped = Math.max(0, activity.entries.length - 8);
		if (skipped) lines.push(`  … ${skipped} earlier events`);
		for (const entry of activity.entries.slice(-8)) {
			lines.push(`  ${seconds(entry.atMs).padStart(4)}  ${entry.text}`);
		}
	} else {
		if (activity.lastAction) lines.push(`Last: ${activity.lastAction}`);
		lines.push("Ctrl+O for activity");
	}
	return lines;
}

export const renderResult: RenderResultFn = (result, options, theme, context) => {
	if (options.isPartial) {
		const activity = result.details?.activity;
		if (activity) {
			return new Text(
				activityLines(activity, options.expanded || result.details?.progressMode === "full")
					.map((s) => theme.fg("dim", s))
					.join("\n"),
				0,
				0,
			);
		}
		const text = result.details?.progress ?? getResultText(result).split("\n")[0].slice(0, 120);
		return new Text(theme.fg("dim", text), 0, 0);
	}

	const details = result.details;
	const full = getResultText(result);
	const isError = details?.error != null || context.isError;
	const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");

	const footer = details ? usageFooter(details) : "";
	const modelLine = details?.model ? theme.fg("dim", ` model: ${details.model}`) : "";

	if (options.expanded) {
		const container = new Container();
		container.addChild(
			new Text(
				`${icon} ${theme.fg("toolTitle", theme.bold(`foreman:${details?.tool ?? "subagent"}`))}${footer ? ` ${theme.fg("dim", footer)}` : ""}${modelLine}`,
				0,
				0,
			),
		);
		container.addChild(new Text("", 0, 0));
		if (isError) {
			container.addChild(
				new Text(theme.fg("error", (details?.error ?? "").split("\n")[0]), 0, 0),
			);
			container.addChild(new Text("", 0, 0));
		}
		container.addChild(new Markdown(full, 0, 0, getMarkdownTheme()));
		if (details?.activity?.entries.length) {
			container.addChild(new Text("", 0, 0));
			container.addChild(new Text(theme.fg("dim", "Recent activity:"), 0, 0));
			container.addChild(
				new Text(
					activityLines(details.activity, true)
						.slice(1)
						.map((s) => theme.fg("dim", s))
						.join("\n"),
					0,
					0,
				),
			);
		}
		if (details?.logPath) {
			container.addChild(new Text("", 0, 0));
			container.addChild(new Text(theme.fg("dim", `log: ${details.logPath}`), 0, 0));
		}
		return container;
	}

	// Collapsed: 1-2 lines.
	const firstLines = full
		.split("\n")
		.filter((l) => l.trim())
		.slice(0, 2)
		.join("\n");
	let text = `${icon} ${theme.fg("toolTitle", theme.bold(`foreman:${details?.tool ?? "subagent"}`))}`;
	if (isError && details?.error) text += ` ${theme.fg("error", "failed")}`;
	text += `\n${theme.fg("toolOutput", firstLines || "(no output)")}`;
	if (footer) text += `\n${theme.fg("dim", footer)}`;
	if (details?.logPath && options.expanded === false)
		text += theme.fg("dim", " (Ctrl+O to expand)");
	return new Text(text, 0, 0);
};
