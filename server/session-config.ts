import type { MediaSessionConfig } from 'openai/resources/live/live'

export const sessionConfig = {
  model: 'gpt-live-1',
  delegation: {
    type: 'responses',
    responses: {
      model: 'gpt-6-luna',
      reasoning: { effort: 'none' },
      tools: [],
      tool_choice: 'none',
    },
  },
} satisfies MediaSessionConfig
