import type { OpenAIChat } from '../index.svelte'
import type { RequestDataArgumentExtended, StreamResponseChunk, requestDataResponse } from './request'

export async function requestClaudeCode(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
    const { system, conversation } = splitAndSerialize(arg.formated)

    try {
        const { Command } = await import('@tauri-apps/plugin-shell')

        const binary = 'claude'
        const model = arg.modelInfo?.internalID ?? 'sonnet'
        const cliArgs = [
            '-p', conversation,
            '--system-prompt', system || ' ',
            '--tools', '',
            '--disable-slash-commands',
            '--no-session-persistence',
            '--exclude-dynamic-system-prompt-sections',
            '--include-partial-messages',
            '--output-format', 'stream-json',
            '--verbose',
            '--model', model,
        ]

        const cmd = Command.create(binary, cliArgs)
        let childProcess: Awaited<ReturnType<typeof cmd.spawn>> | null = null
        let aborted = false
        let lastAccumulated = ''
        let stderrBuf = ''

        const readableStream = new ReadableStream<StreamResponseChunk>({
            async start(controller) {
                cmd.stdout.on('data', (raw: string) => {
                    for (const line of raw.split('\n')) {
                        const trimmed = line.trim()
                        if (!trimmed) continue
                        try {
                            const ev = JSON.parse(trimmed)
                            if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
                                const text = (ev.message.content as Array<{ type?: string; text?: string }>)
                                    .filter(c => c?.type === 'text' && typeof c.text === 'string')
                                    .map(c => c.text!)
                                    .join('')
                                if (text.length > lastAccumulated.length && text.startsWith(lastAccumulated)) {
                                    const delta = text.slice(lastAccumulated.length)
                                    controller.enqueue({ "0": delta })
                                    lastAccumulated = text
                                } else if (text && text !== lastAccumulated) {
                                    controller.enqueue({ "0": text })
                                    lastAccumulated = text
                                }
                            }
                            else if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta' && typeof ev.event.delta.text === 'string') {
                                controller.enqueue({ "0": ev.event.delta.text })
                                lastAccumulated += ev.event.delta.text
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
                    if (aborted) return
                    if (data.code && data.code !== 0) {
                        controller.error(new Error(`Claude Code exited with code ${data.code}${stderrBuf ? `: ${stderrBuf.trim()}` : ''}`))
                        return
                    }
                    controller.close()
                })

                cmd.on('error', (err: string) => {
                    controller.error(new Error(`Claude Code process error: ${err}`))
                })

                try {
                    childProcess = await cmd.spawn()
                } catch (err) {
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

        return {
            type: 'streaming',
            result: readableStream,
        }
    } catch (err) {
        return {
            type: 'fail',
            result: `Claude Code invocation failed: ${err instanceof Error ? err.message : String(err)}`,
        }
    }
}

function splitAndSerialize(formated: OpenAIChat[]): { system: string; conversation: string } {
    const systemParts: string[] = []
    const rest: OpenAIChat[] = []

    for (const m of formated) {
        if (m.role === 'system') {
            systemParts.push(m.content)
        } else {
            rest.push(m)
        }
    }

    const system = systemParts.join('\n\n')
    const conversation = rest.map(m => {
        const tag = m.role === 'assistant' ? 'ASSISTANT' : 'USER'
        return `[${tag}]\n${m.content}`
    }).join('\n\n')

    return { system, conversation }
}
