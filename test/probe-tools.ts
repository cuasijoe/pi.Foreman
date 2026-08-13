/**
 * Deterministic acceptance probe.
 *
 * Writes the parent's active tool names to a file at session start so the
 * acceptance suite can assert that explore/review/verify are registered
 * without depending on the model's free-form answer (which is inherently
 * non-deterministic). Loaded as a second `-e` alongside the foreman entry.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";

export default function (pi: ExtensionAPI) {
	const file = process.env.FOREMAN_TOOLS_PROBE;
	if (!file) return;
	pi.on("session_start", () => {
		try {
			fs.writeFileSync(file, [...pi.getActiveTools()].sort().join("\n") + "\n");
		} catch {
			/* a probe must never break the run */
		}
	});
}
