// FORK (RisuGem): Claude Code CLI bridge. Not in upstream Risuai.
// Before changing anything in this file, read CLAUDE.md in the repo root —
// it documents the external flag assumptions, rejected alternatives, and
// what to re-verify when the Claude Code CLI updates.

import type { OpenAIChat } from '../index.svelte'
import type { RequestDataArgumentExtended, StreamResponseChunk, requestDataResponse } from './request'

const WORKSPACE_DIR = 'risugem-cli'

export async function requestClaudeCode(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
    const { systemContent, userContent } = splitForFile(arg.formated)

    try {
        const { Command } = await import('@tauri-apps/plugin-shell')
        const { writeFile, mkdir, exists, BaseDirectory } = await import('@tauri-apps/plugin-fs')
        const { appDataDir, join } = await import('@tauri-apps/api/path')

        if (!(await exists(WORKSPACE_DIR, { baseDir: BaseDirectory.AppData }))) {
            await mkdir(WORKSPACE_DIR, { baseDir: BaseDirectory.AppData, recursive: true })
        }

        const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const sessionDir = `${WORKSPACE_DIR}/claude-${sessionId}`
        if (!(await exists(sessionDir, { baseDir: BaseDirectory.AppData }))) {
            await mkdir(sessionDir, { baseDir: BaseDirectory.AppData, recursive: true })
        }
        const relPath = `${sessionDir}/sysprompt.txt`
        await writeFile(relPath, new TextEncoder().encode(systemContent || ' '), { baseDir: BaseDirectory.AppData })
        const absPath = await join(await appDataDir(), sessionDir, 'sysprompt.txt')
        const absSessionDir = await join(await appDataDir(), sessionDir)

        // Claude's installer provides `claude.exe` on Windows, which Tauri
        // resolves from the bare `claude` name via PATHEXT. No special case
        // needed here.
        const binary = 'claude'
        const model = arg.modelInfo?.internalID ?? 'sonnet'
        const cliArgs = [
            '-p', userContent,
            '--system-prompt-file', absPath,
            '--tools', '',
            '--disable-slash-commands',
            '--no-session-persistence',
            '--exclude-dynamic-system-prompt-sections',
            '--include-partial-messages',
            '--output-format', 'stream-json',
            '--verbose',
            '--model', model,
        ]

        // cwd isolation: prevents Claude Code auto-memory keyed on our dev
        // project path from leaking in, and avoids CLAUDE.md discovery from
        // parent directories.
        const cmd = Command.create(binary, cliArgs, { cwd: absSessionDir })
        let childProcess: Awaited<ReturnType<typeof cmd.spawn>> | null = null
        let aborted = false
        let lastAccumulated = ''
        let stderrBuf = ''

        const cleanup = async () => {
            try {
                const { remove } = await import('@tauri-apps/plugin-fs')
                await remove(sessionDir, { baseDir: BaseDirectory.AppData, recursive: true })
            } catch { /* ignore */ }
        }

        const readableStream = new ReadableStream<StreamResponseChunk>({
            async start(controller) {
                // Buffer for incomplete JSONL lines that span stdout chunks.
                let stdoutBuf = ''
                cmd.stdout.on('data', (raw: string) => {
                    stdoutBuf += raw
                    const lines = stdoutBuf.split('\n')
                    stdoutBuf = lines.pop() ?? ''  // keep last partial line
                    for (const line of lines) {
                        const trimmed = line.trim()
                        if (!trimmed) continue
                        try {
                            const ev = JSON.parse(trimmed)
                            // Assistant events carry cumulative message snapshots. Only
                            // advance if the snapshot extends what we've accumulated.
                            if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
                                const text = (ev.message.content as Array<{ type?: string; text?: string }>)
                                    .filter(c => c?.type === 'text' && typeof c.text === 'string')
                                    .map(c => c.text!)
                                    .join('')
                                if (text.length >= lastAccumulated.length && text.startsWith(lastAccumulated)) {
                                    lastAccumulated = text
                                    controller.enqueue({ "0": lastAccumulated })
                                }
                                // else: earlier/diverging snapshot — ignore
                            }
                            // stream_event carries incremental text deltas.
                            else if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta' && typeof ev.event.delta.text === 'string') {
                                lastAccumulated += ev.event.delta.text
                                controller.enqueue({ "0": lastAccumulated })
                            }
                            else if (ev.type === 'result' && ev.is_error) {
                                controller.error(new Error(typeof ev.result === 'string' ? ev.result : 'Claude Code error'))
                            }
                        } catch {
                            // non-JSON line; ignore
                        }
                    }
                })

                cmd.stderr.on('data', (line: string) => {
                    if (line.trim()) {
                        stderrBuf += line + '\n'
                        console.warn('[ClaudeCode] stderr:', line)
                    }
                })

                cmd.on('close', (data: { code: number | null }) => {
                    cleanup()
                    if (aborted) return
                    if (data.code && data.code !== 0) {
                        controller.error(new Error(`Claude Code exited with code ${data.code}${stderrBuf ? `: ${stderrBuf.trim()}` : ''}`))
                        return
                    }
                    // Parallels geminiCli.ts: Claude Code can also exit 0 after
                    // an internal failure (e.g. auth expiry, network drop) without
                    // emitting a final assistant snapshot. Reporting that as a
                    // stream error lets RisuAI's fallback-model path engage.
                    if (lastAccumulated === '') {
                        controller.error(new Error(`Claude Code produced no output${stderrBuf ? `: ${stderrBuf.trim().slice(-500)}` : ''}`))
                        return
                    }
                    controller.close()
                })

                cmd.on('error', (err: string) => {
                    cleanup()
                    controller.error(new Error(`Claude Code process error: ${err}`))
                })

                try {
                    childProcess = await cmd.spawn()
                } catch (err) {
                    cleanup()
                    controller.error(new Error(`Failed to spawn claude: ${err instanceof Error ? err.message : String(err)}`))
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
                result: `Claude Code stream error: ${err instanceof Error ? err.message : String(err)}`,
            }
        }
    } catch (err) {
        return {
            type: 'fail',
            result: `Claude Code invocation failed: ${err instanceof Error ? err.message : String(err)}`,
        }
    }
}

function splitForFile(formated: OpenAIChat[]): { systemContent: string; userContent: string } {
    const roleTag = (r: OpenAIChat['role']) =>
        r === 'system' ? 'SYSTEM' : r === 'assistant' ? 'ASSISTANT' : 'USER'
    const fmt = (m: OpenAIChat) => `[${roleTag(m.role)}]\n${m.content}`

    let lastUserIdx = -1
    for (let i = formated.length - 1; i >= 0; i--) {
        if (formated[i].role === 'user') { lastUserIdx = i; break }
    }

    if (lastUserIdx === -1) {
        return {
            systemContent: formated.map(fmt).join('\n\n'),
            userContent: 'continue',
        }
    }

    const before = formated.slice(0, lastUserIdx).map(fmt).join('\n\n')
    const after = formated.slice(lastUserIdx + 1).map(fmt).join('\n\n')
    const systemContent = [before, after].filter(Boolean).join('\n\n')
    return { systemContent, userContent: formated[lastUserIdx].content }
}
