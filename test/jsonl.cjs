#!/usr/bin/env node
// Analyze a pi --mode json event stream for acceptance checks.
// Usage: node test/jsonl.js <file> [--tools] [--final] [--errors] [--toolresult <toolName>]
const [file, ...args] = process.argv.slice(2);
const opts = new Set(args);
const lines = require("fs").readFileSync(file, "utf8").split("\n").filter(Boolean);
const events = lines
	.map((l) => {
		try {
			return JSON.parse(l);
		} catch {
			return null;
		}
	})
	.filter(Boolean);

if (opts.has("--tools")) {
	const tools = new Map();
	for (const e of events) {
		if (e.type === "tool_execution_start")
			tools.set(e.toolName, (tools.get(e.toolName) ?? 0) + 1);
	}
	console.log("TOOLS:", [...tools.entries()].map(([k, v]) => `${k}:${v}`).join("  ") || "(none)");
}

if (opts.has("--final")) {
	const final = [...events]
		.reverse()
		.find((e) => e.type === "message_end" && e.message?.role === "assistant");
	if (final) {
		const text = (final.message.content ?? [])
			.filter((p) => p.type === "text")
			.map((p) => p.text)
			.join("\n");
		console.log("--- final assistant text (" + text.length + " chars) ---");
		console.log(text);
	}
}

for (const arg of args) {
	if (arg.startsWith("--toolresult=")) {
		const tool = arg.split("=")[1];
		for (const e of events) {
			if (
				e.type === "message_end" &&
				e.message?.role === "toolResult" &&
				e.message?.toolName === tool
			) {
				console.log(`--- ${tool} result ---`);
				console.log(e.message.content.map((p) => p.text ?? "").join(""));
			}
		}
	}
}
