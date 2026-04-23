import type { OpenAIChat } from '../index.svelte'
import type { RequestDataArgumentExtended, StreamResponseChunk, requestDataResponse } from './request'

export async function requestGeminiCLI(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
    const prompt = serializeChat(arg.formated)

    try {
        const { Command } = await import('@tauri-apps/plugin-shell')

        const binary = 'gemini'
        const cliArgs = [
            '-p', prompt,
            '-e', 'none',
            '--approval-mode', 'plan',
            '-o', 'stream-json',
        ]

        const cmd = Command.create(binary, cliArgs)
        let childProcess: Awaited<ReturnType<typeof cmd.spawn>> | null = null
        let aborted = false
        let stderrBuf = ''

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
                    if (aborted) return
                    if (data.code && data.code !== 0) {
                        controller.error(new Error(`Gemini CLI exited with code ${data.code}${stderrBuf ? `: ${stderrBuf.trim()}` : ''}`))
                        return
                    }
                    controller.close()
                })

                cmd.on('error', (err: string) => {
                    controller.error(new Error(`Gemini CLI process error: ${err}`))
                })

                try {
                    childProcess = await cmd.spawn()
                } catch (err) {
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

function serializeChat(formated: OpenAIChat[]): string {
    return formated.map(m => {
        const tag = m.role === 'system' ? 'SYSTEM'
            : m.role === 'assistant' ? 'ASSISTANT'
            : 'USER'
        return `[${tag}]\n${m.content}`
    }).join('\n\n')
}
