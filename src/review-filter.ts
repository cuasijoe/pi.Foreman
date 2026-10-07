import type { ReviewSeverity } from "./config.ts";

const RANK: Record<ReviewSeverity, number> = { low: 0, medium: 1, high: 2 };

/**
 * Enforce the configured threshold on a structurally formatted review.
 * Leave malformed/partial answers untouched rather than risk hiding defects.
 * The full unfiltered child transcript remains in Foreman's debug log.
 */
export function filterReviewFindings(text: string, minSeverity: ReviewSeverity): string {
	if (minSeverity === "low") return text;
	const verdict = /^VERDICT:[ \t]*(ship|fix-first|needs-discussion)[ \t]*\r?$/m.exec(text);
	const findings = /^FINDINGS:[ \t]*\r?$/m.exec(text);
	const notes = /^NOTES:/m.exec(text);
	if (
		!verdict ||
		!findings ||
		!notes ||
		verdict.index >= findings.index ||
		findings.index >= notes.index
	) {
		return text;
	}

	const start = findings.index + findings[0].length;
	const section = text.slice(start, notes.index);
	const lines = section.split(/\r?\n/);
	const kept: string[] = [];
	let include = true;
	let seenFinding = false;
	let retained = 0;
	let removed = 0;
	for (const line of lines) {
		const match = /^\s*-\s*\[(high|medium|low)\]\s+/.exec(line);
		if (match) {
			seenFinding = true;
			include = RANK[match[1] as ReviewSeverity] >= RANK[minSeverity];
			if (include) retained++;
			else removed++;
		} else if (/^\s*-\s+/.test(line) || (line.trim() && !seenFinding)) {
			return text; // Unknown bullet or format: don't reinterpret the verdict.
		}
		if (include) kept.push(line);
	}
	if (removed === 0) return text;

	let sectionText = kept.join("\n");
	if (!sectionText.endsWith("\n")) sectionText += "\n";
	let filtered = text.slice(0, start) + sectionText + text.slice(notes.index);
	if (retained === 0 && verdict[1] === "fix-first") {
		filtered =
			filtered.slice(0, verdict.index) +
			filtered.slice(verdict.index).replace(/^VERDICT:[ \t]*fix-first/, "VERDICT: ship");
	}
	return filtered;
}
