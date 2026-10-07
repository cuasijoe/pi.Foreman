# Foreman

**Focused subagents for [pi](https://pi.dev): find code, review changes, and diagnose builds without flooding your main conversation.**

Foreman adds three tools to pi. Each runs an independent agent and returns a concise answer to the main agent:

| Tool | Use it when… | What you get |
|---|---|---|
| `explore` | You don't know where a behavior lives, or finding it means searching several files. | A short code map with `file:line` references. |
| `review` | You want a second opinion on changes before shipping. | An independent verdict and actionable findings. It does **not** change files. |
| `verify` | A full build or test run may produce a lot of output. | Pass/fail and a concise diagnosis of distinct failures. |

Foreman is meant for work that benefits from delegation. For a known file, a quick search, or a small targeted test, pi's ordinary tools are usually faster.

## Install

You need [pi](https://pi.dev) with an authenticated model provider. Foreman is currently installed from a Git repository or a local checkout; **it has not been published to npm**.

**From GitHub** (installs the version pushed to the repository):

```bash
pi install git:github.com/cuasijoe/pi.Foreman
```

**From a local checkout** (loads files in place, including local changes):

```bash
cd /path/to/pi.Foreman
pi install "$(pwd)"
```

Add `-l` to either `pi install` command to make the installation project-scoped rather than available to all your projects. Pi loads project-scoped packages and settings only after you trust the project. Use `pi list` to see which source is installed, `pi update --extensions` to update a Git install, and restart pi after updating the package or its configuration. Avoid loading the same extension both as a package and by symlinking it into pi's extensions directory.

## Get started

Start an interactive `pi` session in a project. You can ask for a Foreman tool explicitly, or let pi decide when delegation makes sense:

```text
Use explore to find how requests are authenticated across this repository. Give me a file:line map.
```

```text
Use review to check my uncommitted changes for correctness. Focus on error handling.
```

```text
Use verify to run the project's build and test suite. Summarize any failures without dumping the full output.
```

During a call, the Foreman tool row shows what the child has reported so far. Press **Ctrl+O** to expand its recent activity; after completion, expand to read the full answer. A `read done` or `bash done` event means that **one child tool call** finished—the agent may still be working. When the model has not emitted an event, Foreman shows the elapsed wait rather than guessing what it is doing. Pi's generic “Working” indicator may remain visible.

Run `/foreman` in pi to see the active settings and this session's subagent spend. Foreman also supports:

| Command | Purpose |
|---|---|
| `/foreman stats` | See cross-session outcome, duration, model, and cost trends. |
| `/foreman tune -n` | Preview suggested timeout/turn-limit changes without applying them. |
| `/foreman tune` | Apply those suggestions. |

The agent, not the user, normally calls `explore`, `review`, and `verify` as tools. In particular, `review` reads a Git diff and reports findings; the main agent must make any fixes and can then run verification and review again. A `ship` verdict does **not** guarantee that every possible problem was found.

## Configure

Foreman works without configuration. To override defaults, create `.pi/foreman.json` in a trusted project, or `~/.pi/agent/foreman.json` for all projects. Project settings override global settings. Both files accept JSON with comments. Restart pi after editing them; `/foreman` shows the resolved values.

For example, to show the live activity timeline and suppress low-severity review findings:

```json
{
  "progress": "full",
  "review": { "minSeverity": "medium" }
}
```

### All settings

You can set any of these fields independently; omitted fields keep their defaults.

| Setting | Default | What it controls |
|---|---|---|
| `explore.model`, `review.model`, `verify.model` | Automatically chosen by tier | Model pattern for one tool, such as `"provider/model-id"`. An unresolved model falls back to the parent model with a notice. |
| `explore.maxTurns`, `review.maxTurns`, `verify.maxTurns` | `15`, `25`, `10` | Maximum turns for each child. |
| `explore.timeoutMs`, `review.timeoutMs`, `verify.timeoutMs` | `120000`, `300000`, `600000` | Wall-clock timeout for each child, in milliseconds. |
| `review.minSeverity` | `"low"` | `"low"`, `"medium"`, or `"high"`. Omit findings below this severity from a correctly formatted review. If all `fix-first` findings are filtered, the verdict becomes `ship`. |
| `progress` | `"line"` | `"line"` shows compact live status; **Ctrl+O** expands recent activity. `"full"` shows the timeline by default; `"off"` hides live tool-row updates. |
| `livePanel` | `false` | When `true`, show an overview above the editor **only while two or more** Foreman agents run at once. |
| `maxReturnChars` | `8000` | Byte limit for the child's answer returned to the main agent; full debug logs are not subject to this limit. |
| `logging` | `true` | Save completed child transcripts and cross-session telemetry. Set `false` to disable both. |
| `disabled` | `[]` | Tool names to deactivate, e.g. `["verify"]`. Use only Foreman's three tool names; other names may deactivate pi tools. |
| `contextPressure` | `{ "enabled": true, "warnAt": 60, "strongAt": 80 }` | At these context-use percentages, encourage the parent to delegate. Override the individual fields, or use `false` to disable these hints. |
| `tune` | `{ "enabled": false, "minRuns": 8, "timeoutRate": 0.2, "maxTurnsRate": 0.2, "maxTimeoutMs": 1200000, "maxMaxTurns": 60 }` | Control when `/foreman tune` recommends larger timeouts/turn caps and their upper limits. Set `enabled: true` to apply recommendations automatically at session start. `false` disables auto-application, not the manual command. |
| `tiers.fast`, `tiers.mid`, `tiers.strong` | Automatic model selection | Model patterns for the `explore`, `verify`, and `review` tiers. A per-tool `model` setting takes priority. |

The reviewer is instructed to skip findings below `review.minSeverity`, and Foreman also filters properly formatted findings before returning them. Malformed or truncated reviews are left intact rather than risk concealing a defect. The optional `focus` supplied to an individual review is a separate, best-effort lens (for example, `"security"`); it is not a severity threshold.

## Visibility, cost, and safety

- Calls have turn and time limits. Press pi's interrupt key (**Escape** in the standard interactive keybindings) to abort an active turn.
- The running tool row displays a bounded activity history, not a second pi window or the model's private reasoning. Once the call finishes, it collapses to the result; Ctrl+O reveals the answer and recent activity. Child usage and cost appear in the result footer and pi's session totals.
- With `logging: true`, completed runs write telemetry to `.pi/foreman/telemetry.jsonl` and child transcripts to `.pi/foreman/logs/`. These logs are **written after** a call, not streamed live. They can contain repository content; consider excluding `.pi/foreman/` from version control.
- `explore` and `review` have no write/edit tools and use a restricted shell. They are not a security sandbox: they can read files accessible to pi. `verify` runs build/test commands, which may change your working tree. Watch/dev/serve commands are refused, and concurrent verify runs are blocked.

## Troubleshooting and help

- **I see “Working” but little activity:** the child may be waiting for the model to emit its next event. Check elapsed time in the tool row; Ctrl+O shows the most recent events. The extra overview appears only for **parallel** agents when `livePanel` is enabled.
- **Old lines appear after completion:** `"progress": "full"` retains recent *tool* events while the agent runs; Ctrl+O also shows history after it finishes. If old live rows remain outside the finished, collapsed result, try pi's fullscreen terminal mode (`/settings` → `tuiMode`); regular mode uses terminal scrollback.
- **Review missed a new file:** review starts from `git diff` and `git diff --staged`, which do not include untracked files. Make the new files visible to Git's diff before relying on the verdict.
- **Settings seem ignored:** restart pi, accept the project's trust prompt, and check `/foreman`. `pi list` shows whether you installed Foreman from this local checkout or from GitHub; a Git install does not include your local uncommitted edits.
- **No telemetry or logs:** check that `logging` is enabled and look at the paths shown by `/foreman`. Child transcripts are written only when a run finishes.

For bugs or feature requests, [open an issue](https://github.com/cuasijoe/pi.Foreman/issues).
