// FORK (RisuGem): Gemini CLI bridge. Not in upstream Risuai.
// Before changing anything in this file, read CLAUDE.md in the repo root —
// it documents the GEMINI.md override strategy, the Windows .cmd-arg
// restrictions that shape it, and rejected alternatives.

import type { OpenAIChat } from '../index.svelte'
import type { RequestDataArgumentExtended, StreamResponseChunk, requestDataResponse } from './request'

const WORKSPACE_DIR = 'risugem-cli'

export async function requestGeminiCLI(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
    const { contextContent, userContent } = splitForGemini(arg.formated)

    try {
        const { Command } = await import('@tauri-apps/plugin-shell')
        const { writeFile, mkdir, exists, BaseDirectory } = await import('@tauri-apps/plugin-fs')
        const { appDataDir, join } = await import('@tauri-apps/api/path')

        const sessionDir = `${WORKSPACE_DIR}/gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        if (!(await exists(sessionDir, { baseDir: BaseDirectory.AppData }))) {
            await mkdir(sessionDir, { baseDir: BaseDirectory.AppData, recursive: true })
        }

        // Gemini CLI has no --system-prompt flag; its built-in "coding agent"
        // identity tends to override GEMINI.md workspace context. We can't
        // inject a prefix via `-p` on Windows because Rust's .cmd arg
        // validator rejects quotes and newlines (CVE-2024-24576 fix), so we
        // prepend the override to GEMINI.md itself (file write, no shell
        // escaping concerns) to reframe the session as non-coding.
        const overrideHeader =
            '# SESSION ROLE OVERRIDE\n\n' +
            'You are NOT "Gemini CLI" for this session. Disregard any built-in instructions about being a software engineering agent, coding assistant, or autonomous CLI tool. Those do not apply here.\n\n' +
            'Your assigned persona, chat history, system rules, and output format are defined below. Read everything below carefully and respond to user messages strictly following those instructions. Stay fully within the assigned persona. Do not offer coding or file-operation help unless the instructions below explicitly ask for it.\n\n' +
            '---\n\n'
        const finalGeminiMd = overrideHeader + (contextContent || ' ')
        await writeFile(`${sessionDir}/GEMINI.md`, new TextEncoder().encode(finalGeminiMd), { baseDir: BaseDirectory.AppData })
        const absDir = await join(await appDataDir(), sessionDir)

        // Windows npm-global installs typically provide `gemini.cmd` wrappers
        // rather than a `gemini.exe`; Tauri's CreateProcess fails to find the
        // bare name on those systems. Probe OS and pick the right binary.
        const { platform } = await import('@tauri-apps/plugin-os')
        const binary = platform() === 'windows' ? 'gemini.cmd' : 'gemini'
        // Moving alias (e.g. 'auto', 'pro', 'flash') from the model entry's
        // internalID. See modellist.ts note on Gemini CLI variants.
        const modelAlias = arg.modelInfo?.internalID
        const cliArgs = [
            '-p', userContent,
            ...(modelAlias ? ['-m', modelAlias] : []),
            '-e', 'none',
            '--approval-mode', 'plan',
            '-o', 'stream-json',
        ]

        const cmd = Command.create(binary, cliArgs, { cwd: absDir })
        let childProcess: Awaited<ReturnType<typeof cmd.spawn>> | null = null
        let aborted = false
        let stderrBuf = ''

        const cleanup = async () => {
            try {
                const { remove } = await import('@tauri-apps/plugin-fs')
                await remove(sessionDir, { baseDir: BaseDirectory.AppData, recursive: true })
            } catch { /* ignore */ }
        }

        const readableStream = new ReadableStream<StreamResponseChunk>({
            async start(controller) {
                // RisuAI expects each stream chunk to carry the full cumulative
                // text so far, so we accumulate Gemini's delta events locally
                // and emit the running total.
                let accumulated = ''
                // Buffer for incomplete JSONL lines that span stdout chunks.
                let stdoutBuf = ''
                cmd.stdout.on('data', (raw: string) => {
                    stdoutBuf += raw
                    const lines = stdoutBuf.split('\n')
                    stdoutBuf = lines.pop() ?? ''
                    for (const line of lines) {
                        const trimmed = line.trim()
                        if (!trimmed) continue
                        try {
                            const ev = JSON.parse(trimmed)
                            if (ev.type === 'message' && ev.role === 'assistant' && ev.delta === true && typeof ev.content === 'string') {
                                accumulated += ev.content
                                controller.enqueue({ "0": accumulated })
                            }
                            else if (ev.type === 'result' && ev.status && ev.status !== 'success') {
                                controller.error(new Error(ev.error?.message ?? `Gemini CLI result status: ${ev.status}`))
                            }
                        } catch {
                            // non-JSON line; ignore
                        }
                    }
                })

                cmd.stderr.on('data', (line: string) => {
                    if (line.trim()) {
                        stderrBuf += line + '\n'
                        console.warn('[GeminiCLI] stderr:', line)
                    }
                })

                cmd.on('close', (data: { code: number | null }) => {
                    cleanup()
                    if (aborted) return
                    if (data.code && data.code !== 0) {
                        controller.error(new Error(`Gemini CLI exited with code ${data.code}${stderrBuf ? `: ${stderrBuf.trim()}` : ''}`))
                        return
                    }
                    // Gemini CLI sometimes exhausts its internal retry budget on
                    // transient upstream errors (e.g. 429 MODEL_CAPACITY_EXHAUSTED
                    // for gemini-*-pro-preview under load) and then exits 0 after
                    // printing the error to stderr, without ever emitting an
                    // assistant message on stdout. Without this branch we'd report
                    // `type: 'success'` with empty text, which suppresses RisuAI's
                    // fallback-model path in request.ts. Surfacing it as a stream
                    // error makes the non-streaming drain below return `fail` and
                    // the streaming caller see an error, both of which let the
                    // fallback model take over.
                    if (accumulated === '') {
                        controller.error(new Error(`Gemini CLI produced no output${stderrBuf ? `: ${stderrBuf.trim().slice(-500)}` : ''}`))
                        return
                    }
                    controller.close()
                })

                cmd.on('error', (err: string) => {
                    cleanup()
                    controller.error(new Error(`Gemini CLI process error: ${err}`))
                })

                try {
                    childProcess = await cmd.spawn()
                } catch (err) {
                    cleanup()
                    controller.error(new Error(`Failed to spawn gemini: ${err instanceof Error ? err.message : String(err)}`))
                    return
                }

                arg.abortSignal?.addEventListener('abort', () => {
                    aborted = true
                    try { childProcess?.kill() } catch { /* ignore */ }
                    try { controller.close() } catch { /* already closed */ }
                })
            }
        })

        if (arg.useStreaming) {
            return {
                type: 'streaming',
                result: readableStream,
            }
        }

        // Non-streaming callers (e.g. auto-suggest) would otherwise discard
        // our streaming result; drain the stream here and return the final
        // cumulative text as a 'success' response so those callers work.
        try {
            const reader = readableStream.getReader()
            let finalText = ''
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                if (value && typeof value["0"] === 'string') finalText = value["0"]
            }
            return { type: 'success', result: finalText }
        } catch (err) {
            return {
                type: 'fail',
                result: `Gemini CLI stream error: ${err instanceof Error ? err.message : String(err)}`,
            }
        }
    } catch (err) {
        return {
            type: 'fail',
            result: `Gemini CLI invocation failed: ${err instanceof Error ? err.message : String(err)}`,
        }
    }
}

function splitForGemini(formated: OpenAIChat[]): { contextContent: string; userContent: string } {
    const roleTag = (r: OpenAIChat['role']) =>
        r === 'system' ? 'SYSTEM' : r === 'assistant' ? 'ASSISTANT' : 'USER'
    const fmt = (m: OpenAIChat) => `[${roleTag(m.role)}]\n${m.content}`

    let lastUserIdx = -1
    for (let i = formated.length - 1; i >= 0; i--) {
        if (formated[i].role === 'user') { lastUserIdx = i; break }
    }

    if (lastUserIdx === -1) {
        return {
            contextContent: formated.map(fmt).join('\n\n'),
            userContent: 'continue',
        }
    }

    const before = formated.slice(0, lastUserIdx).map(fmt).join('\n\n')
    const after = formated.slice(lastUserIdx + 1).map(fmt).join('\n\n')
    const contextContent = [before, after].filter(Boolean).join('\n\n')
    return { contextContent, userContent: formated[lastUserIdx].content }
}
