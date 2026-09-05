import type { AiMessage, AiStreamEvent, ChatTurn } from './types'

export interface AiConversationHistoryEntry {
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

export function sortAiConversationTimeline<T extends { createdAt: number }>(entries: T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.createdAt - b.entry.createdAt || a.index - b.index)
    .map(({ entry }) => entry)
}

export function mergeAiConversationHistory(
  entries: AiConversationHistoryEntry[],
  limit = 12
): AiMessage[] {
  return sortAiConversationTimeline(
    entries.filter((entry) => entry.content.trim().length > 0)
  )
    .slice(-Math.max(0, limit))
    .map((entry) => ({ role: entry.role, content: entry.content }))
}

export function applyAiStreamEvent(turn: ChatTurn, event: AiStreamEvent): ChatTurn {
  if (event.type === 'delta') {
    return { ...turn, text: turn.text + event.text, pending: true }
  }
  if (event.type === 'reasoning') {
    return {
      ...turn,
      reasoning: (turn.reasoning ?? '') + event.text,
      pending: true,
    }
  }
  if (event.type === 'error') {
    return { ...turn, pending: false, error: event.message }
  }
  return { ...turn, pending: false }
}

export function stopPendingAiTurns(turns: ChatTurn[]): ChatTurn[] {
  return turns.map((turn) =>
    turn.role === 'assistant' && turn.pending
      ? { ...turn, pending: false, stopped: true }
      : turn
  )
}
