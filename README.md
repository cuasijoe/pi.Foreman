# Foreman

> A [pi](https://pi.dev) package that adds exactly three subagent tools — `explore`, `review`, `verify` — to the coding agent.

Foreman restores the three subagent patterns that justify their cost in a coding agent, and nothing else. Pi's default direct tools are `read`, `write`, `edit`, and `bash`; Foreman adds only the three subagents that pay for themselves.

| Tool | Justification |
|---|---|
| `explore` | **Context economy** — reads many tokens, returns few (a `file:line` map). |
| `review` | **Adversarial stance** — must *not* share the parent's beliefs about code it just wrote. |
| `verify` | **Context economy** — build/test output is the single noisiest thing that enters an agent's context. |

Every call spawns a fresh `pi` process: an empty message array, its own system prompt, a tool list restricted to `read` + a gated `bash`, a turn cap, and a hard wall-clock timeout. The parent writes the task; the child returns a single string. Nothing else is shared.

---

## Why only three

A subagent is justified only when it satisfies one of: **context economy**, **parallelism**, or **adversarial stance**. "Expertise" is not a justification.

There is deliberately no planner, architect, documenter, language/framework specialist, or security reviewer — `focus` is a lens on the single `review` agent, not a new agent. If you are tempted to bolt on a fourth tool, stop: the value of this package is what it leaves out.

---

## Installation

Foreman is a normal pi package: the `pi` key in `package.json` points at the extension entry (`./src/index.ts`), and pi loads the rest of the source relative to the package root. Install it through any of the sources pi supports.

### From a local checkout

```bash
# Global — available to every project on this machine
pi install "$(pwd)"

# Project-scoped — recorded in this repo's .pi/settings.json only
pi install "$(pwd)" -l
```

Local paths are added to settings without copying; pi reads the files in place, so edits take effect on the next session. Children resolve `src/child-bash.ts` and `src/prompts/*.md` relative to the package root, so a local-path install keeps those intact.

### From npm

```bash
# After the package is published to the npm registry
pi install npm:foreman@0.1.0
```

User installs are placed under `~/.pi/agent/npm/`; project installs (`-l`) under `.pi/npm/`.

### From git

```bash
# Pin a tag or commit for reproducible installs
pi install git:github.com/<owner>/pi.Foreman@v0.1.0

# HTTPS URLs work without the git: prefix
pi install https://github.com/<owner>/pi.Foreman@v0.1.0
```

Git clones live under `~/.pi/agent/git/<host>/<path>` (global) or `.pi/git/<host>/<path>` (project). Pinned refs are not moved by `pi update --extensions`; re-install with a new ref to move an existing clone.

### Temporary (no install)

Try the package for a single run without recording it anywhere:

```bash
pi -e ./src/index.ts          # local checkout
pi -e npm:foreman@0.1.0       # npm
pi -e git:github.com/<owner>/pi.Foreman@v0.1.0
```

`-e` installs the source to a temporary directory for that run only.

### Managing installs

```bash
pi list                       # show packages recorded via pi install
pi remove /absolute/path/to/pi.Foreman   # local installs are keyed by resolved path
pi remove npm:foreman
pi update --extensions        # update packages and reconcile pinned git refs
```

**Two caveats:**

- `pi list` shows only packages recorded through `pi install`. Symlinking the repo into `~/.pi/agent/extensions/` also loads the extension, but such auto-discovered extensions never appear in `pi list` — and combining both mechanisms double-loads it (tools register twice). Pick one.
- Project-scoped installs (`-l`) are honored only after the project is trusted; on startup pi installs any missing project packages automatically once trust is established.

---

## Building & packaging

The extension is plain TypeScript that pi loads directly (pi strips types at load time), so there is **no compile step**. "Building" means validating the source and producing a distributable tarball.

### Prerequisites

- Node.js 22.6+ (for `node --experimental-strip-types` used by the offline tests)
- npm 9+
- `pi` on `PATH` (required only for the model-tier acceptance suite)
- A dev checkout with dependencies installed: `npm install`

### Verify the source

```bash
npm run check                 # prettier + tsc --noEmit (format & typecheck)
npm test                      # offline test tier — no model, no network, <1s
```

### Produce a distributable tarball

```bash
npm pack
# -> foreman-0.1.0.tgz
```

The `files` field in `package.json` restricts the tarball to `src/` and `README.md`, so `src/child-bash.ts`, `src/activity.ts`, `src/live-panel.ts`, and `src/prompts/*.md` are included automatically. `package.json` itself is always included. Historical design notes under `design/` are not included in the tarball.

### Publish to npm

```bash
# 1. remove "private": true from package.json
# 2. publish
npm publish
```

`private: true` blocks `npm publish` (it does not block `npm pack`), so it is left set to prevent accidental publication.

### Publish via git

The repository itself is the package source. Tag a release so installs can pin a ref:

```bash
git tag v0.1.0
git push origin v0.1.0
# install with: pi install git:github.com/<owner>/pi.Foreman@v0.1.0
```

### One-command build

`npm run build` runs `check` + the offline test tier + `npm pack` in sequence.

---

## The three tools

### `explore` — locate code

Use when the target is unknown and likely spans more than three files, when two targeted searches have already missed, or when answering yourself would mean reading several large files. Returns real `file:line` references plus a short map of how they connect.

- **Tools:** `read`, `bash` (read-only allowlist: `rg grep find ls cat head tail wc`, `git log/show/blame`)
- **Model:** fast/cheap tier · **maxTurns** 15 · **timeout** 120s · parallel-safe
- **Returns few, not many.** The child reads broadly, then reports only the locations — the context-economy tool.

### `review` — adversarial read of a change

Use before declaring any non-trivial change done. The parent passes **intent, not the diff** — the reviewer reads `git diff` itself, keeping the diff out of the parent's context on the way in as well as out. `focus` biases the single reviewer (e.g. `"security"`, `"concurrency"`, `"error handling"`).

- **Tools:** `read`, `bash` (explore allowlist plus `git diff`/`git status`)
- **Model:** strongest tier · **maxTurns** 25 · **timeout** 300s
- **Requires a git repository.** Outside one, `review` returns a clear "not inside a git repo" message instead of spawning a child that just runs `git diff` and fails.
- `VERDICT: ship` with no findings is a valid, expected outcome — it does not manufacture nitpicks.

### `verify` — absorb build/test noise

Use when running a full suite or build, when output volume is unknown, or after a long failure trace. Returns pass/fail, a count, and each distinct failure as location + one-line cause. Watch/dev/serve commands are refused at two layers (parent and child), every command is clamped to 80% of the child's wall-clock budget, and runs are serialized (builds fight over lockfiles and ports).

- **Tools:** `bash` (unrestricted but watch-refused), `read`
- **Model:** mid tier · **maxTurns** 10 · **timeout** 600s · **never concurrent**
- Serialized by an in-process flag plus a cross-process lockfile (`.pi/foreman/verify.lock`), so two pi sessions in the same repo cannot run concurrent builds either.

---

## Delegation policy

The default is the main thread; delegation is the exception, taken on evidence. The tool descriptions and prompt guidelines encode:

- **Escalate, don't pre-plan.** Start the work directly; delegate when it proves larger than expected (on the second failed search, not the first).
- **Scale with the task.** A one-file change needs zero subagents. A cross-cutting refactor might need parallel `explore`s and a `review`.
- **Context pressure lowers the threshold.** Above 60% context utilization the extension injects a line steering the parent toward `explore`/`verify` delegation; above 80% it states it more strongly; below 40% it says nothing.

Named anti-patterns (encoded in the tool descriptions): exploring a file already in context, chaining `explore` → `explore`, reviewing a diff `verify` already proved broken, spawning anything on a one-file task already read, and parallel `explore`s with overlapping questions.

---

## Configuration

`.pi/foreman.json` (project) overrides `~/.pi/agent/foreman.json` (global). Both are optional — defaults work with zero config. JSONC comments are allowed.

```jsonc
{
  "explore": { "model": "deepseek-v4-flash", "maxTurns": 15, "timeoutMs": 120000 },
  "review":  { "model": "anthropic/claude-opus-4-5", "maxTurns": 25, "timeoutMs": 300000 },
  "verify":  { "model": "<mid-tier>", "maxTurns": 10, "timeoutMs": 600000 },
  "maxReturnChars": 8000,
  "progress": "line",                    // "line" (default), "full", or "off"
  "livePanel": false,                     // opt-in overview for concurrent agents
  "logging": true,
  "disabled": [],                        // e.g. ["verify"] to turn one off
  "contextPressure": { "warnAt": 60, "strongAt": 80 },  // or false to disable entirely
  "tune": { "enabled": false, "minRuns": 8, "timeoutRate": 0.2, "maxTurnsRate": 0.2, "maxTimeoutMs": 1200000, "maxMaxTurns": 60 },
  "tiers": { "fast": "openai/gpt-4o-mini", "mid": "anthropic/claude-sonnet-4-5", "strong": "anthropic/claude-opus-4-5" }
}
```

Model names resolve through pi's model registry (any provider). With no `model` set, the extension picks by tier: a fast/cheap model for `explore`, the strongest available for `review`, a mid-tier for `verify`. The name-based tier heuristic is fragile across providers, so `tiers` overrides it per tier (per-tool `model` still wins over `tiers`). If a configured model doesn't resolve, Foreman falls back to the parent's model and emits one notice — a model config problem never fails a tool call.

### Where settings and state are saved

Config layers, from lowest to highest precedence (`defaults < global < project < tuning`), each optional and JSONC-compatible:

| Precedence | File | Written by |
|---|---|---|
| base | built-in defaults | — |
| 2 | `~/.pi/agent/foreman.json` | you — global, applies to every project |
| 3 | `<project>/.pi/foreman.json` | you — project, overrides global (honored only once the project is trusted) |
| 4 (top) | `<project>/.pi/foreman/tuning.json` | `/foreman tune` — auto-tuned values only; never touches fields you wrote explicitly |

Everything else Foreman writes lives under `<project>/.pi/foreman/`:

| Path | Contents |
|---|---|
| `.pi/foreman/telemetry.jsonl` | One JSON line per completed run — the raw data behind `/foreman stats` and `/foreman tune`. Append-only, pruned to the last 5000 runs (once the file passes ~1 MB). |
| `.pi/foreman/tuning.json` | Auto-tuned `timeoutMs`/`maxTurns` values (only what tuning itself set). |
| `.pi/foreman/logs/<session>/<tool>-<timestamp>.json` | Full child transcripts (last 50 kept per session) — for debugging, never shown to the parent. |
| `.pi/foreman/verify.lock` | Transient verify mutex: `pid` + timestamp so two pi sessions never run concurrent builds. Removed when the call ends; stale locks are stolen. |

`/foreman` prints the resolved config (including `progress`, `livePanel`, tune, and tiers) plus the log, telemetry, and tuning paths for the current session. Consider gitignoring `.pi/foreman/`.

---

## Commands

Foreman registers one slash command with three modes:

| Command | What it does |
|---|---|
| `/foreman` | Resolved config (including `progress`, `livePanel`, tune + tiers), per-tool spend this session, and the log/telemetry/tuning paths. |
| `/foreman stats` | Cross-session aggregates: outcome rates, retry rate, avg/median duration, avg cost and **cost per successful run**, top models, per-prompt-version breakdown, and a 7-day vs prior-30-day drift comparison (✓/✗ per tool). Append `--json` for machine-readable output. |
| `/foreman tune` | Computes tuning recommendations from recent telemetry and writes them to `.pi/foreman/tuning.json`. Use `/foreman tune -n` (or `--dry-run`) to preview without writing; append `--json` for machine-readable output. Also prints a **model advisory** when a model costs ≥2× per success at comparable success rate (informational — never auto-applied). |

---

## Visibility & cost

- Set `progress` in `.pi/foreman.json` (project) or `~/.pi/agent/foreman.json` (global): `"line"` (default) keeps the running tool row compact (phase, elapsed time, time since last event, last action); press Ctrl+O to expand a bounded live timeline. `"full"` shows that timeline even when collapsed; `"off"` hides live updates. The timeline holds up to 24 recent events, displaying the latest 8; individual previews are capped at 160 characters. Observable events include tool calls, brief result previews, and streamed assistant text. Raw private reasoning and full tool output are never shown. A silent provider wait is reported honestly with an increasing timer. `→ read done` means the child **tool** finished, not the subagent: it remains in the timeline while the agent continues. Once the agent finishes, the collapsed row becomes its final summary; Ctrl+O can still show the answer and recent activity. The parent model receives only the final answer, not live activity.
- `"livePanel": true` adds a small non-modal overview above the editor **only while two or more Foreman agents run concurrently**. Single-agent activity belongs in its own tool row; the overview shows up to three running agents and counts any others. It disappears when fewer than two remain. `livePanel` applies only to the interactive TUI.
- Every result carries a footer such as `[explore: 4 turns, 9.8k in / 1.1k out, $0.03, 42s]`, and child usage is returned as the tool's `usage`, so pi's own `/session` totals include subagent spend.
- Full child transcripts are written **when each call finishes** to `.pi/foreman/logs/<session>/<tool>-<timestamp>.json` (last 50 kept per session) and include `durationMs`, `promptVersion`, and the config snapshot the child ran under. They are not a live log to tail while the child runs. The parent sees the summary; the log is for debugging why a subagent returned something odd. Consider gitignoring `.pi/foreman/`.

---

## Telemetry & tuning

Every run appends one line to `.pi/foreman/telemetry.jsonl` (when `logging: true`): timestamp, tool, tier, model/provider, turn/token/cost totals, **wall-clock duration**, stop reason, exit code, and a derived `outcome` — `success | partial | failed | timeout | max_turns | aborted` — plus two behavior-based quality signals:

- **`formatCompliant`** — each child must return a strict output format; a non-compliant result is unusable by definition. The check validates more than section presence: `explore` `LOCATIONS` entries must be real `path:line` refs (when any are listed), `review` `VERDICT` must be `ship|fix-first|needs-discussion`, and a `verify` `RESULT: fail` must name at least one `path:line` failure. This and `retried` replace any "was this useful?" prompt — Foreman never asks.
- **`retried`** — when the parent re-invokes the same tool shortly after a **successful** run in the same session, that run's line is marked retried (behavioral evidence the result wasn't sufficient). Precision guards: re-invocation after a failed/timeout run is already captured by `outcome`, and only runs completed within the last 10 minutes count, so two unrelated questions in one session are not mislabeled as retries.
- **`promptVersion`** — a sha1 prefix of the child system prompt, so prompt edits are automatically A/B-versioned in the data. `/foreman stats` breaks down runs/success rate per prompt version when a tool has seen more than one.

Telemetry is retained to the last 5000 runs (pruned once the file grows past ~1 MB), so stats and tuning stay bounded and the file never balloons in long-lived projects.

### The tuning loop

Tuning is mechanical and reversible: `timeoutMs` is raised when the timeout rate of recent runs exceeds `tune.timeoutRate`, and reverted toward the default when recent runs are clean; `maxTurns` behaves the same on `max_turns` stops. Guards:

- **Evidence window** — only runs newer than the last tuning application count, so stale telemetry can't ratchet a value upward forever.
- **Explicit user settings are never auto-adjusted** (auto mode tracks which fields you actually wrote); reverts only undo values tuning itself set.
- **Hard caps** (`maxTimeoutMs`, `maxMaxTurns`). Model switching is never auto-applied — `/foreman stats` surfaces success rate and cost per success by model and you decide.
- With `tune.enabled: true`, recommendations auto-apply at session start (a notification reports what changed); `tuning.json` is layered last (defaults < global < project < tuning).

---

## Safety & security model

- **Depth limit.** Children never receive `explore`/`review`/`verify` — enforced by an assertion in the spawn primitive and by the `--tools` allowlist, not by prompt.
- **Children have no `write`/`edit`.** The bash gate is a **structural allowlist**: shell control operators are rejected outside quotes (so `;`, `&&`, `&`, newline, backticks, `$(`, and redirection cannot chain commands), each pipe segment's binary must be on the read-only list (`rg grep find ls cat head tail wc git log/show/blame`), and per-binary exec/hang flags are blocked (`find -exec*`, `rg --pre*`, `tail -f`, `git -c`).
- **Threat model.** Read-only children are a firewall against *accidental* mutation and against a model that decides to write or run arbitrary binaries — the structural allowlist makes shell-driven code execution and file writes unreachable. It is **not** a sandbox against a determined adversary on untrusted repo content: an `explore`/`review` child can still *read* any file the process can read and echo its contents back (that is their purpose), so do not point them at a repo containing secrets you would not want surfaced, and treat child output as potentially containing repo file contents. `verify` is deliberately the opposite — unrestricted `bash` so it can run the build, which by definition may mutate state; it is serialized (in-process flag + cross-process lockfile) and watch-refused, not sandboxed.
- **Ctrl-C propagates.** The parent's abort kills the child process group (SIGTERM, then SIGKILL after 5s), including in-flight build processes. No orphans.
- **Timeout and turn cap are hard.** A hung build cannot hang the parent.

---

## Project layout

```
src/
  index.ts        extension entry: tools, /foreman (+stats/tune), retry hook,
                  context-pressure injection, auto-tune at session start
  spawn.ts        the shared primitive (child process, caps, abort, logging,
                  duration + format-compliance measurement)
  child-bash.ts   child-side bash gate (allowlist / watch-refusal / timeout clamp)
  runner.ts       glue: model resolution, cost accounting, footers, status bar,
                  telemetry append
  live-panel.ts   parallel-agent overview widget (TUI only)
  activity.ts     bounded per-agent activity timeline
  config.ts       config load (jsonc), defaults, model tier selection, explicit-field tracking
  render.ts       renderCall / renderResult for the TUI
  state.ts        per-session spend registry + verify mutex
  telemetry.ts    telemetry.jsonl store: outcome derivation, format compliance,
                  retry marking, stats aggregation
  tune.ts         tuning loop: recommendations, tuning.json read/write
  agents/         explore.ts · review.ts · verify.ts
  prompts/        explore.md · review.md · verify.md  (edit these; they are the tuning surface)
test/
  offline.mjs     offline test tier (deterministic, no model, <1s)
  acceptance.sh   model test tier (end-to-end)
  jsonl.cjs       JSONL event-stream analyzer used by the suite
  probe-tools.ts  deterministic tool-registration probe
```

---

## Testing

The suite is split into two tiers:

```bash
npm test                        # offline tier — no model, no network, <1s
node --experimental-strip-types test/offline.mjs   # (same thing, explicit)

./test/acceptance.sh            # model tier — needs a provider, ~10–15 min
PI_MODEL=... ./test/acceptance.sh
```

- **Offline tier** (`test/offline.mjs`) — 84 deterministic checks of the pure logic: the bash gate's structural allowlist and watch refusal, telemetry format-compliance/outcome/retry/retention/aggregation, the tuning loop (raise/revert/evidence-window/provenance/caps for both `timeoutMs` and `maxTurns`), config merge + explicit-field tracking + tier→model resolution, the TUI footer, live progress modes, live panel and result extraction, the session spend registry, the spawn truncation/output helpers, and the verify mutex (lockfile, stale-steal, live-lock, re-entry). Runs in under a second with zero spend.
- **Model tier** (`test/acceptance.sh`) — builds fresh fixture repos in a temp dir and checks end to end: extension load and tool registration · `config.disabled` removing a tool · explore delegating once with real `file:line` references and a cost footer · correct non-delegation (in-context edit, typo, single test) · the bash gate rejecting `rm -rf`/`sed -i` while permitting `rg -n` · review finding a real bug and shipping a clean change with no nitpicks · verify distilling three failing tests in under 40 lines with no raw stack traces, and refusing watch-mode commands · context-pressure injection above threshold and absent when disabled · Ctrl-C leaving no orphans · `/foreman` totals matching footers · running with zero config. The live TUI timeline and parallel overview have offline tests, but no model-tier visual acceptance test yet.

For a **visual** check, start interactive `pi` from this repository (or `pi -e ./src/index.ts` if Foreman is not installed), accept project trust, and run `/foreman` to confirm the resolved `progress` and `livePanel` settings. Then ask: “Use explore once to map how Foreman configuration and TUI rendering connect across source files.” Watch the tool row; Ctrl+O toggles the timeline. `-p`/JSON mode does **not** display the TUI. If you still see old live rows after a call has finished and its result is collapsed, check pi's terminal mode: fullscreen redraws the transcript, whereas regular mode uses terminal scrollback (`/settings` → `tuiMode`).

Historical implementation and discovery notes are in `design/NOTES.md` in the source checkout (not part of the published tarball).
