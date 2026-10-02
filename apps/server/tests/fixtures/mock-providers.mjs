// Loaded only by the compiled-process tests. Every outbound request stays synthetic.
let conversation = 0
const event = value => `data: ${JSON.stringify(value)}\n\n`
const encoder = new TextEncoder()
globalThis.fetch = async (input, init = {}) => {
  const url = input.toString()
  if (url === 'https://api.openai.com/v1/responses') {
    const request = JSON.parse(init.body)
    if (new Headers(init.headers).get('authorization') !== 'Bearer synthetic-openai-key') throw new Error('Unexpected synthetic configuration.')
    process.send?.({ type: 'inference', input: request.input })
    const paused = request.input.at(-1)?.content === 'Paused'
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(event({ type: 'response.output_text.delta', delta: 'Shared reply' })))
        const abort = () => {
          clearTimeout(timer)
          process.send?.({ type: 'aborted' })
          controller.error(new Error('Synthetic request aborted.'))
        }
        const timer = paused ? undefined : setTimeout(() => {
          init.signal?.removeEventListener('abort', abort)
          controller.enqueue(encoder.encode(event({ type: 'response.completed', response: { status: 'completed' } })))
          controller.close()
        }, 150)
        init.signal?.addEventListener('abort', abort, { once: true })
      },
    }), { headers: { 'content-type': 'text/event-stream' } })
  }
  if (url === 'https://api.elevenlabs.io/v1/speech-to-text') {
    if (new Headers(init.headers).get('xi-api-key') !== 'synthetic-elevenlabs-key') throw new Error('Unexpected synthetic configuration.')
    process.send?.({ type: 'audio', bytes: [...new Uint8Array(await init.body.get('file').arrayBuffer())] })
    return Response.json({ text: 'Synthetic words' })
  }
  if (url === 'https://api.elevenlabs.io/v1/speech-engine/seng_test') return Response.json({
    speech_engine_id: 'seng_test', speech_engine: { ws_url: 'wss://public.example/speech-engine/upstream' },
    tts: { model_id: 'eleven_v4_turbo', voice_id: 'voice_test' },
    conversation: { client_events: ['audio', 'user_transcript', 'agent_response'] },
  })
  if (url.startsWith('https://api.elevenlabs.io/v1/convai/conversation/token?')) return Response.json({
    token: 'short-lived-token', conversation_id: `conv_process_${++conversation}`,
  })
  throw new Error('Unexpected outbound request in local process verification.')
}
