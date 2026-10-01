import type { MediaSessionConfig } from 'openai/resources/live/live'

import { conversationConfig } from './conversation-config.ts'

export const sessionConfig = {
  model: 'gpt-live-1',
  delegation: {
    type: 'responses',
    responses: { ...conversationConfig },
  },
} satisfies MediaSessionConfig
