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

        await writeFile(`${sessionDir}/GEMINI.md`, new TextEncoder().encode(contextContent || ' '), { baseDir: BaseDirectory.AppData })
        const absDir = await join(await appDataDir(), sessionDir)

        const binary = 'gemini'
        const cliArgs = [
            '-p', userContent,
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
                cmd.stdout.on('data', (raw: string) => {
                    for (const line of raw.split('\n')) {
                        const trimmed = line.trim()
                        if (!trimmed) continue
                        try {
                            const ev = JSON.parse(trimmed)
                            if (ev.type === 'message' && ev.role === 'assistant' && ev.delta === true && typeof ev.content === 'string') {
                                controller.enqueue({ "0": ev.content })
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

        return {
            type: 'streaming',
            result: readableStream,
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
