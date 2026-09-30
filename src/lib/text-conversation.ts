import { create } from 'zustand'
import type { ChatMessage, TextChatTransport } from './text-chat-client.ts'
import { sendTextChat, TextChatError } from './text-chat-client.ts'
import { createPacedText, schedulePacing, type PacingScheduler } from './paced-text.ts'

export type TextMode = 'voice' | 'text'
export type TurnStatus = 'waiting' | 'streaming' | 'complete' | 'failed'

export interface ConversationTurn {
  id: string
  userText: string
  assistantText: string
  status: TurnStatus
  error: string | null
  presentationAccelerated?: boolean
}

export interface TextConversationStore {
  mode: TextMode
  turns: ConversationTurn[]
  activeTurnId: string | null
  sendText(text: string): string | null
  retryTurn(id: string): boolean
  enterText(): void
  enterVoice(): void
  cancelActive(): void
}

const canceledMessage = 'Reply canceled.'
const failedMessage = 'Could not complete the reply. Please try again.'

export function createTextConversationStore(
  transport: TextChatTransport = sendTextChat,
  createId: () => string = () => crypto.randomUUID(),
  schedule: PacingScheduler = schedulePacing,
  now: () => number = () => performance.now(),
) {
  let generation = 0
  let controller: AbortController | null = null
  let presentation: ReturnType<typeof createPacedText> | null = null

  return create<TextConversationStore>((set, get) => {
    const isCurrent = (attempt: number, id: string) =>
      generation === attempt && get().activeTurnId === id

    const contextFor = (turns: ConversationTurn[], userText: string): ChatMessage[] => [
      ...turns.flatMap((turn): ChatMessage[] => turn.status === 'complete'
        ? [
            { role: 'user', content: turn.userText },
            { role: 'assistant', content: turn.assistantText },
          ]
        : []),
      { role: 'user', content: userText },
    ]

    const start = (id: string, messages: ChatMessage[]) => {
      const attempt = ++generation
      const abortController = new AbortController()
      controller = abortController
      let terminalError: string | null = null
      const pacing = createPacedText((text, presentationAccelerated) => {
        if (!isCurrent(attempt, id)) return
        set((state) => ({
          turns: state.turns.map((turn) => turn.id === id
            ? { ...turn, assistantText: turn.assistantText + text, status: 'streaming', presentationAccelerated }
            : turn),
        }))
      }, () => {
        if (!isCurrent(attempt, id)) return
        generation++
        controller = null
        presentation = null
        set((state) => ({
          activeTurnId: null,
          turns: state.turns.map((turn) => turn.id === id
            ? { ...turn, status: terminalError ? 'failed' : 'complete', error: terminalError }
            : turn),
        }))
      }, schedule, now)
      presentation = pacing
      const onDelta = (text: string) => {
        if (isCurrent(attempt, id)) pacing.push(text)
      }
      const run = async () => {
        try {
          await transport(messages, abortController.signal, onDelta)
          if (!isCurrent(attempt, id)) return
          controller = null
          pacing.finish()
        } catch (error) {
          if (!isCurrent(attempt, id)) return
          controller = null
          terminalError = error instanceof TextChatError ? error.message : failedMessage
          pacing.finish()
        }
      }
      void run()
    }

    return {
      mode: 'text',
      turns: [],
      activeTurnId: null,
      sendText(text) {
        const userText = text
        const state = get()
        if (state.mode !== 'text' || state.activeTurnId || !userText.trim()) return null
        const id = createId()
        const messages = contextFor(state.turns, userText)
        set({
          activeTurnId: id,
          turns: [...state.turns, { id, userText, assistantText: '', status: 'waiting', error: null }],
        })
        start(id, messages)
        return id
      },
      retryTurn(id) {
        const state = get()
        const latest = state.turns.at(-1)
        if (state.mode !== 'text' || state.activeTurnId || latest?.id !== id || latest.status !== 'failed') {
          return false
        }
        const messages = contextFor(state.turns, latest.userText)
        set({
          activeTurnId: id,
          turns: state.turns.map((turn) => turn.id === id
            ? { ...turn, assistantText: '', status: 'waiting', error: null }
            : turn),
        })
        start(id, messages)
        return true
      },
      enterText() {
        set({ mode: 'text' })
      },
      enterVoice() {
        get().cancelActive()
        set({ mode: 'voice' })
      },
      cancelActive() {
        const id = get().activeTurnId
        if (!id) return
        generation++
        presentation?.cancel()
        presentation = null
        const activeController = controller
        controller = null
        set((state) => ({
          activeTurnId: null,
          turns: state.turns.map((turn) => turn.id === id
            ? { ...turn, status: 'failed', error: canceledMessage }
            : turn),
        }))
        activeController?.abort()
      },
    }
  })
}

export const useTextConversation = createTextConversationStore()
