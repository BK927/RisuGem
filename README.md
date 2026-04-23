# RisuGem

A fork of [Risuai](https://github.com/kwaroran/RisuAI) that adds first-class support for running chats through local **Claude Code CLI** and **Gemini CLI** instead of HTTP API keys. If you already have a Claude subscription or Gemini CLI access, RisuGem lets RisuAI drive those tools directly — no extra API billing.

All core RisuAI features (character cards, group chats, lorebook, regex scripts, long-term memory, translators, themes, plugins, etc.) remain intact. See the [upstream README](https://github.com/kwaroran/RisuAI) and [wiki](https://github.com/kwaroran/Risuai/wiki) for those.

[![Svelte](https://img.shields.io/badge/svelte-5-red?logo=svelte)](https://svelte.dev/) [![Typescript](https://img.shields.io/badge/typescript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/) [![Tauri](https://img.shields.io/badge/tauri-2.5-%2324C8D8?logo=tauri)](https://tauri.app/)

---

## What this fork changes

- **New providers**: "Claude Code" and "Gemini CLI" show up in the model picker alongside the existing cloud providers.
- **Local CLI execution**: Requests spawn the local `claude` or `gemini` binary and stream results back into the chat UI.
- **Chat-only isolation**: Both bridges run with tools/edits disabled, a per-request ephemeral working directory, and no session persistence — RisuGem never lets the CLI touch your filesystem.
- **Cleanly additive**: Everything else is upstream Risuai. Fork-specific details live in [`CLAUDE.md`](CLAUDE.md).

## Why use RisuGem

- You have a **Claude subscription** and want to use it for RP / chat without also paying for the Anthropic API.
- You have **Gemini CLI** set up and want to use its quota for chat inside RisuAI.
- You want a desktop chat UI on top of the CLI tools instead of their bare terminal interface.

If none of the above apply, upstream [Risuai](https://github.com/kwaroran/RisuAI) is probably what you want.

---

## Installation

### Desktop (recommended)

Download the latest build from [GitHub Releases](https://github.com/BK927/RisuGem/releases).

### From source

```bash
git clone https://github.com/BK927/RisuGem.git
cd RisuGem
pnpm install
pnpm tauri dev        # desktop app in dev mode
# or
pnpm dev              # web-only preview
```

Prerequisites: Node.js 20.19+ or 22.12+, pnpm, and the Tauri build chain (Rust toolchain, platform-specific system deps — see [Tauri prerequisites](https://tauri.app/start/prerequisites/)).

### CLI provider prerequisites

To use the CLI providers, install the matching binary on your PATH:

| Provider | Install | Verify |
|---|---|---|
| **Claude Code** | [docs.anthropic.com/claude-code](https://docs.anthropic.com/en/docs/claude-code/overview) — run `claude` once to sign in with your Claude subscription | `claude --version` |
| **Gemini CLI** | [github.com/google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) — `npm install -g @google/gemini-cli`, then `gemini auth` | `gemini --version` |

RisuGem does **not** bundle either CLI. If the binary isn't on PATH, the provider will return a spawn error.

**Windows note:** Gemini CLI's npm install provides `gemini.cmd` (a batch wrapper), not a `.exe`. RisuGem detects this automatically. No manual configuration needed.

---

## Using the CLI providers

1. Open RisuGem → Settings → Model / API.
2. Select **Claude Code** or **Gemini CLI** as the provider.
3. (Optional) Pick a specific model from the dropdown — defaults are Sonnet and `auto-gemini-3` respectively.
4. Start chatting normally.

Streaming, auto-suggest, and the standard chat features all work. If responses come back off-character or the process fails to spawn, see the troubleshooting section at the bottom of [`CLAUDE.md`](CLAUDE.md).

---

## Known limitations

- **Claude Code refuses explicit NSFW content** regardless of character card. This is Anthropic's policy, not something the fork can override. Non-adult RP works fine.
- **Multi-line user messages via Gemini CLI on Windows** can fail to spawn if they contain `"`, `%`, or embedded newlines — a Rust `.cmd`-arg safety restriction. Short messages and typical RP prose are unaffected. Tracking for a fix via stdin piping once Tauri's plugin-shell adds stdin close.
- **Auto-memory leaks from `~/.claude/CLAUDE.md`** into Claude Code sessions — user-global memory always loads even with cwd isolation. If you use Claude Code for RP, keep your global memory free of coding-assistant directives that would bleed into character responses.

---

## Fork maintenance

This fork periodically merges from upstream Risuai. Contributors and future-me: read [`CLAUDE.md`](CLAUDE.md) before touching `src/ts/process/request/` or the Tauri capabilities. That file documents:

- Which files we added vs. modified.
- Which external CLI flags and output formats we depend on.
- Design decisions and rejected alternatives (so you don't re-investigate known dead-ends).
- The re-test checklist for after upstream merges or CLI tool updates.

---

## Credits

RisuGem is built entirely on top of [kwaroran/RisuAI](https://github.com/kwaroran/RisuAI). All feature credit, the UI, and the chat engine belong to the upstream authors. This fork only contributes the two CLI provider bridges and related plumbing.

Upstream Discord: [discord.gg/JzP8tB9ZK8](https://discord.gg/JzP8tB9ZK8)

License: same as upstream (see [LICENSE](LICENSE)).
