# RisuGem — Fork Notes

<!--
  Last verified against: b04e4689 (2026-04-24)
  This file goes stale silently — nothing auto-updates it. Bump the marker
  above whenever you re-verify the claims below against the current code
  and the installed CLI versions. See the "Upstream merge policy" and
  "When something breaks" sections at the bottom for when to re-verify.
-->

This repository is a fork of [kwaroran/RisuAI](https://github.com/kwaroran/RisuAI) (remote `upstream`). The fork adds first-class support for local **Claude Code CLI** and **Gemini CLI** as LLM providers, so users with those CLI subscriptions can drive RisuAI chats through the CLI tools instead of direct API keys.

Everything in this file is about what diverges from upstream or depends on external CLI binaries. Normal RisuAI development should follow the upstream project conventions (see `AGENTS.md`).

---

## Fork map

Use `git diff --stat upstream/main..HEAD` to regenerate the authoritative list at any time. As of the last update:

**Added (pure additions — upstream merges never touch these):**
- `src/ts/process/request/claudeCode.ts` — Claude Code CLI bridge (`requestClaudeCode`)
- `src/ts/process/request/geminiCli.ts` — Gemini CLI bridge (`requestGeminiCLI`)
- `CLAUDE.md` (this file)

**Modified upstream files (merge conflicts possible):**
- `src/ts/process/request/request.ts` — two dispatcher cases (`LLMFormat.ClaudeCodeCLI`, `LLMFormat.GeminiCLI`) in the `requestChatDataMain` switch
- `src/ts/model/types.ts` — two new `LLMFormat` enum values
- `src/ts/model/modellist.ts` — provider entries for both CLI tools (shown as "recommended")
- `src-tauri/capabilities/migrated.json` — shell permission entries so Tauri can spawn `claude`, `claude.exe`, `gemini`, and `gemini.cmd`
- `src-tauri/tauri.conf.json` — updater endpoint retargeted at `BK927/RisuGem` releases
- `src/lang/zh-Hant.ts` — reset to match `en.ts` base so language-injection doesn't break on our added keys
- `.gitignore` — one-line addition

---

## External CLI dependencies

These are what our bridges assume about the external tools. If the tool upstreams change flag names or output formats, re-verify here first.

### Claude Code CLI (`claude`)

| Assumption | Where (by symbol) | Verify with |
|---|---|---|
| Flag `--system-prompt-file <path>` replaces the default Claude Code system prompt entirely | `claudeCode.ts` → `cliArgs` in `requestClaudeCode` | `claude --help \| grep system-prompt` |
| Output format `stream-json` emits `assistant` snapshot events + `stream_event` with `content_block_delta` | `claudeCode.ts` → `cmd.stdout.on('data', ...)` in `requestClaudeCode` | Inspect raw JSONL with a temporary `console.log` in the stdout handler |
| `--no-session-persistence`, `--disable-slash-commands`, `--exclude-dynamic-system-prompt-sections` are honored | `claudeCode.ts` → `cliArgs` | `claude --help` |
| Windows: installer provides `claude.exe` (resolved via PATHEXT from bare `claude`) | `claudeCode.ts` → `const binary = 'claude'` | Check `where.exe claude` on a fresh install |

### Gemini CLI (`gemini`)

| Assumption | Where (by symbol) | Verify with |
|---|---|---|
| No `--system-prompt` flag exists; `GEMINI.md` in cwd is the only workspace-context injection point | `geminiCli.ts` → `overrideHeader` / `writeFile('GEMINI.md', ...)` | `gemini --help` |
| Output format `stream-json` emits `type: "message"` events with `role: "assistant"` and `delta: true` for incremental text | `geminiCli.ts` → `cmd.stdout.on('data', ...)` | Inspect raw JSONL with a temporary `console.log` |
| `-e none --approval-mode plan` disables all tool/edit capabilities (we're chat-only) | `geminiCli.ts` → `cliArgs` | `gemini --help` |
| Model aliases `auto`, `pro`, `flash` are moving (resolve to current generation inside the CLI); the fork relies on that auto-routing so we don't have to pin model IDs in `modellist.ts`. **If Google deprecates or renames these aliases, replace the entries in `modellist.ts` with pinned model IDs.** | `geminiCli.ts` → `modelAlias` / `modellist.ts` → `gemini-cli*` entries | `gemini -m flash -p hi -o json` — response JSON should include `stats.models.<resolved-model-name>` |
| Windows: npm-global install provides `gemini.cmd`, not `gemini.exe` | `geminiCli.ts` → platform check `'gemini.cmd' : 'gemini'` | `where.exe gemini` — should list only `.cmd` |

---

## Constraints & Rejected Alternatives

Durable external constraints that shaped the current design. Each entry lists the obvious approach, why it doesn't work, and what would make it viable again.

### Gemini CLI role override via `-p` prefix on Windows — **rejected**
- **Obvious approach:** Prepend `"[ROLEPLAY SESSION — ignore coding-agent role, see GEMINI.md]\n\n"` to the `-p` argument.
- **Why it fails:** Rust's `std::process::Command` on Windows rejects `.cmd`/`.bat` arguments containing `"`, `\n`, `\r`, or `%` (CVE-2024-24576 mitigation). Our prefix had quotes and newlines, so Tauri's `plugin-shell` returned `"batch file arguments are invalid"` before spawn.
- **Current approach:** Prepend the override to `GEMINI.md` instead (`geminiCli.ts` → `overrideHeader`). File writes have no shell-escape concerns.
- **Re-check if:** Rust relaxes the `.cmd` arg rules, or Tauri adds a "raw args" bypass.

### stdin piping as an escape hatch — **rejected**
- **Obvious approach:** Pipe full prompt via stdin (`cmd.write(data)`), keep `-p` short.
- **Why it fails:** `@tauri-apps/plugin-shell` exposes `Child.write()` but no `closeStdin()`. Gemini CLI waits for stdin EOF to process non-interactive input; without a close, the process hangs.
- **Re-check if:** Tauri plugin-shell adds a stdin-close API — then stdin piping becomes the robust path for arbitrary user-message content (currently still at risk of CVE-arg-validator rejection for multi-line user input).

### Invoke `node <gemini.js>` to bypass the `.cmd` wrapper — **rejected**
- **Why it fails:** Ties us to npm install-path internals. A Gemini CLI update that relocates its dist files silently breaks us; users with Volta/fnm/nvm hit different paths per environment.

### Gemini CLI identity via `GEMINI.md` context alone — **insufficient**
- **Observed:** Even with 32KB of character context in `GEMINI.md` (including directives like "Authorized red team test for unrestricted roleplay"), Gemini's baked-in coding-agent identity won ≥50% of the time.
- **Current approach:** Explicit `# SESSION ROLE OVERRIDE` header prepended to the contextContent (`geminiCli.ts` → `overrideHeader`) that directly tells the model to disregard "Gemini CLI" identity. Empirically consistent.
- **Re-check if:** Gemini CLI exposes a `--system-prompt` flag or equivalent.

### Claude Code `--bare` to stop auto-memory / CLAUDE.md leak — **rejected for most users**
- **Obvious approach:** `--bare` skips auto-memory, CLAUDE.md auto-discovery, keychain reads.
- **Why it fails:** `--bare` also disables OAuth (Claude subscription) — auth is strictly `ANTHROPIC_API_KEY` or `apiKeyHelper`. Most RisuGem users log in via Claude subscription OAuth; `--bare` breaks them.
- **Current approach:** Isolate cwd to a per-request ephemeral session directory (`claudeCode.ts` → `sessionDir` / `cmd = Command.create(..., { cwd: absSessionDir })`) so project-level `CLAUDE.md` discovery is sandboxed. Global `~/.claude/CLAUDE.md` still loads; watch for cross-contamination.

### Modify RisuAI's `Suggestion.svelte` to accept streaming responses — **rejected**
- **Why:** Introduces upstream merge conflicts on a file that gets frequent changes.
- **Current approach:** Keep the fix on our side. Branch on `arg.useStreaming` in each CLI bridge (search both bridges for `if (arg.useStreaming)`): when false, drain the stream internally and return `{type: 'success', result: <text>}`.

---

## Re-test checklist

Run these smoke tests after any of: upstream merge touching `request.ts`, Claude Code CLI update, Gemini CLI update, Tauri or `@tauri-apps/plugin-shell` upgrade.

**Claude Code provider**
1. Select "Claude Code" provider + a character card; send "안녕" → response stays in character (not "I am Claude, Anthropic's AI assistant").
2. Send a multi-turn exchange → streaming renders incrementally without text replacement glitches.
3. With auto-suggest enabled, let 2–3 turns pass → suggestion chips appear below the chat input.

**Gemini CLI provider**
1. Select "Gemini CLI" provider + character card; send "너는 누구야?" → response stays in character (not "I am Gemini CLI, a software engineering agent").
2. Send 3–5 messages in a row → in-character consistency (no random breaks into coding-agent voice — the "random" symptom that the role-override header fixes).
3. Auto-suggest: same as above.

**Both**
- Abort mid-stream (stop generation button) → no orphan child process (check Task Manager / `ps aux`).
- Session dir cleanup: after several messages, `%APPDATA%/com.risugem.app/risugem-cli/` should not grow unbounded (bridges `rm -rf` their session dir on close).

---

## Upstream merge policy

1. Fetch and diff: `git fetch upstream && git log upstream/main..HEAD --oneline` to see our commits, `git log HEAD..upstream/main --oneline` to see theirs.
2. Our added files (`claudeCode.ts`, `geminiCli.ts`, `CLAUDE.md`) are never touched by upstream. Ignore them in conflict resolution.
3. Conflicts will concentrate in: `request.ts` (dispatcher switch), `types.ts` (LLMFormat enum), `modellist.ts` (provider list), `capabilities/migrated.json`, `tauri.conf.json`. For each: keep upstream structural changes, re-apply our two-line additions.
4. Re-verify this file's claims against reality:
   - `git diff --stat upstream/main..HEAD` — compare against the "Fork map" section; add or remove entries as needed.
   - `claude --help` and `gemini --help` — spot-check the flags in the "External CLI dependencies" tables still exist and mean what we claim.
   - Bump the `Last verified` marker at the top of this file.
5. Run the full re-test checklist above before cutting a release.
6. `zh-Hant.ts` is intentionally a minimal stub in our fork. If upstream makes substantive i18n changes there, consider whether to re-sync or keep the stub — don't merge blindly.

---

## Rejected integrations

Providers we investigated and decided not to add, so future-us doesn't repeat the research.

### ChatGPT Codex — rejected 2026-04-24

**What we considered.** Two paths: (a) spawn the `codex` CLI as a subprocess (same pattern as Claude Code / Gemini CLI bridges), or (b) call the OpenAI `/v1/responses` endpoint directly using the OAuth access token stored in `~/.codex/auth.json`.

**Why rejected.**

1. **CLI subprocess path (a).** Codex is designed as a coding agent, and the agent loop can't be fully suppressed. Even with `base_instructions` overridden via a custom `CODEX_HOME/config.toml`, short prompts respond cleanly but longer/structured character context still triggers intermediate `command_execution` items and preamble agent_messages. Result: worse UX than Claude Code / Gemini CLI — noticeable latency (5–30s), higher token cost, no real token streaming (responses arrive as whole `agent_message` items), and pinned model IDs (`gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.2`) with no Gemini-style moving aliases so new generations need manual modellist updates.

2. **Direct endpoint path (b).** Darker ToS grey zone than the current CLI bridges. OpenAI's official position separates ChatGPT subscription from API access; `/v1/responses` is an API endpoint. Calling it with a ChatGPT-subscription OAuth token requires impersonating the official Codex CLI's `client_id` (`app_EMoamEEZ73f0CkXaXp7hrann`) and sending Codex-specific system-prompt signatures that OpenAI validates server-side — both fall under the ToS reverse-engineering clause. Third-party plugins doing this (OpenCode, OpenClaw) ship with "personal use only" disclaimers, and no OpenAI staff has publicly sanctioned the pattern. Anthropic's 2025–2026 enforcement wave against unofficial Claude.ai clients shows providers do act on this category.

**Re-check if.**
- Codex CLI gains a genuine chat-only mode that skips agent loops (would unblock path (a)).
- OpenAI publishes an official third-party OAuth client registration for subscription-backed Codex access (would unblock path (b)).
- Until then, the practical answer for OpenAI-model users is to enter an `OPENAI_API_KEY` into RisuAI's existing OpenAI provider — that path is unambiguous and needs no fork work.

**Investigation artifacts.** `codex debug models` for the current catalog, `codex debug prompt-input` for the default system prompt wrapper, OpenAI ToS + community threads linked in git history (commit that added this section).

---

## Decision log (ADRs)

Project-level decisions whose reasoning would be expensive to reconstruct from code alone. These explain the *shape of the project* (why fork, how to sync). Code-level "we tried X, X doesn't work because Y, so we do Z" entries live in the **Constraints & Rejected Alternatives** section above; provider-level "we don't add CLI Z" entries live in **Rejected integrations**.

When adding a new ADR, date-stamp it, describe the *alternatives actually considered*, and include a **Re-check if** list so future-you knows when the decision should be revisited. Don't write ADRs for non-decisions (default states, obvious choices) — if the re-discovery cost is under an hour, a code comment is enough.

---

### ADR-001 — Maintain as a hard fork of upstream RisuAI
**Date:** 2026-04-24 · **Status:** Accepted

**Context.** RisuGem adds Claude Code CLI and Gemini CLI as RisuAI LLM providers. Implementing these requires (a) two new source files in `src/ts/process/request/`, (b) small additive edits in 6 upstream files (fork map above), and (c) Tauri `shell` capabilities for subprocess spawning. Upstream RisuAI is actively developed (on the order of several commits per week). The distribution model is a desktop binary built by our own release pipeline.

**Decision.** Maintain RisuGem as a long-lived hard fork of `kwaroran/RisuAI`, periodically synced from `upstream/main`. Accept a small, well-bounded merge-conflict surface as the cost.

**Consequences.**
- Full control over UX (native provider entries in the model picker, Windows `.cmd` detection, error messages).
- Must periodically merge from upstream (largely automated — see ADR-002).
- Fork-specific knowledge must be captured out-of-band (this file) because it's invisible from code alone.
- CI/release infrastructure duplicates upstream's.

**Alternatives considered.**
- **Patch set (git format-patch / quilt).** The conflict-resolution work is identical — same lines still clash whether the mechanism is `git merge` or `git am --3way`. Adds tooling overhead with zero real saving. Worse UX for users (no pre-built binaries unless we still run a release pipeline).
- **Submit CLI bridges upstream as a PR.** RisuAI upstream is unlikely to accept provider code that uses a ChatGPT/Claude subscription the way our bridges do (ToS grey zone), and the Windows `.cmd`/platform-branch code adds complexity upstream may not want. A narrower PR exposing just a "custom provider extension point" might be tractable later, but that's a long-tail improvement rather than a replacement for the fork.
- **Ship as a RisuAI plugin.** Blocked by Tauri's capability model: spawning `claude` / `gemini` as subprocesses requires shell permissions declared in `src-tauri/capabilities/migrated.json`, which cannot be added at runtime by a plugin. Plugin-only integration is impossible without first convincing upstream to ship broad shell capability (which they shouldn't).
- **Sidecar HTTP server + stock RisuAI.** A separate local server exposing OpenAI-compatible endpoints that internally spawn the CLIs. Zero RisuAI modifications, zero merge burden. Rejected for UX: users would need to install and run a second process, configure a localhost endpoint, and the model picker would show a generic "Custom OpenAI" entry instead of native "Claude Code" / "Gemini CLI" labels. Worth building *in addition to* the fork only if a non-RisuAI-client use case emerges.

**Re-check if.**
- Upstream RisuAI adds a provider extension point that exposes the `LLMFormat` switch as a plugin hook *and* allows plugins to request additional shell capabilities. Both are needed; either alone isn't enough.
- A non-RisuAI client use case arises for the CLI bridges (then the sidecar becomes a parallel option, not a replacement).

---

### ADR-002 — Semi-automated upstream sync via tiered GitHub Actions workflow
**Date:** 2026-04-24 · **Status:** Accepted
**Implementation:** `.github/workflows/upstream-sync.yml`

**Context.** Given ADR-001, we need a low-friction way to track upstream. Upstream pushes multiple commits per week. Manual sync without automation risks drift (work accumulates, conflicts compound). Fully-manual review of every merge risks alert fatigue — after the 3rd routine PR in a week, review becomes ceremonial.

A 30-commit sample of upstream history (measured 2026-04-24) showed 26/30 (87%) of commits don't touch any file in our "Modified upstream files" list. Those commits are genuinely mechanical from our perspective: git merge is either already clean or trivially so.

**Decision.** Tiered workflow that scales review effort to actual risk:

| Condition on cleanly-merged upstream diff | Action |
|---|---|
| Doesn't touch any sensitive file AND `pnpm check` passes | **Auto-merge to `main`**, no PR |
| Touches a sensitive file OR `pnpm check` fails | Open **PR labeled `upstream-sync`** for human review |
| `git merge` raised a real conflict | Open **issue labeled `upstream-sync`** for manual resolve |

Sensitive file list = the 6 files in "Modified upstream files" (Fork map above), encoded as `env.SENSITIVE_FILES` in the workflow. A `dedupe` step ensures no new PR/issue is created while an existing one with the same label is open, so unresolved items don't pile up across daily runs.

The re-test checklist (Claude Code + Gemini CLI smoke tests) is run by a human *once per release*, not per merge — main is allowed to advance silently between releases.

**Consequences.**
- ~87% of upstream commits (estimated) merge silently; roughly 1–2 PRs per week for human review.
- Release cuts (from `main` to `production`) remain the human-verified gate. A bad auto-merge can reach `main` but not end users until the human reviews the release candidate.
- `CLAUDE.md` "Last verified" marker must be bumped by humans — it isn't reliable evidence that auto-merged states were manually reviewed.
- Version-bump commits (`chore: update version to X.Y.Z`) touch `tauri.conf.json` and therefore **always** go to the PR path, even though they're semantically trivial for us. Acceptable cost.

**Alternatives considered.**
- **Every-merge PR (no tier).** Rejected. Daily review creates alert fatigue; within 1–2 weeks, reviews become "click merge on anything called 'sync'". Worse than the tiered design because the rare sensitive case gets the same attention as routine ones.
- **Full auto-merge regardless of files changed.** Rejected. A clean `git merge` doesn't guarantee semantic safety. If upstream changes the signature of `OpenAIChat` or the streaming contract in `request.ts`, the type-check may pass but our bridges break at runtime. Sensitive-file detection is a cheap proxy for "might this break our code in a way the compiler won't see".
- **Manual sync only.** Rejected. Work accumulates; compounded conflicts are worse than incremental ones; and a fork that's one month behind upstream is harder to contribute fixes back to.
- **Automation via a scheduled shell script + local cron.** Rejected. Requires a machine to always be on and authenticated, state lives on one laptop, visibility is zero. GitHub Actions is the obvious right tool for a repo-scoped scheduled job.

**Re-check if.**
- The sensitive file list grows significantly (update `SENSITIVE_FILES` in the workflow + the Fork map + this ADR together — they must stay in sync).
- Upstream starts batching commits into fewer, larger releases — the per-day cadence assumption weakens.
- RisuAI gains a plugin architecture that lets us un-fork (ADR-001 re-check triggers this one too).
- Review volume exceeds ~3 PRs/week in practice — revisit whether version-bump commits should be auto-merged despite touching `tauri.conf.json`.

---

## When something breaks after a CLI tool update

1. Add a temporary `console.log('[ClaudeCode raw]', trimmed)` (or `[GeminiCLI raw]`) inside the stdout handler in the respective bridge file. Note: use `console.log`, not `console.debug` — browser DevTools filter `debug` by default.
2. Reproduce in the app with F12 Console open.
3. Compare the emitted JSONL event shape against the "External CLI dependencies" table above.
4. If the shape changed, update the parser; if a flag was removed, update the CLI args and this file.
5. Remove the debug log before committing.
