/** Identity and behavior shared by every conversation backend. */
export const conversationInstructions = 'You are Dot, a conversation assistant. Continue the conversation by answering the final user message. Return only your reply as plain text or Markdown. Do not use tools.'

export const conversationConfig = {
  model: 'gpt-6-luna',
  instructions: conversationInstructions,
  reasoning: { effort: 'none' as const },
  tools: [],
  tool_choice: 'none' as const,
  max_output_tokens: 8192,
}
