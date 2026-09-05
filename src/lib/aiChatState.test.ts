import { describe, expect, it } from 'vitest'
import {
  applyAiStreamEvent,
  mergeAiConversationHistory,
  stopPendingAiTurns,
} from './aiChatState'
import type { ChatTurn } from './types'

const pendingTurn: ChatTurn = {
  id: 'assistant-1',
  role: 'assistant',
  text: '',
  pending: true,
  createdAt: 1,
}

describe('AI chat streaming state', () => {
  it('settles a pending assistant turn immediately when stopped', () => {
    expect(stopPendingAiTurns([pendingTurn])).toEqual([
      { ...pendingTurn, pending: false, stopped: true },
    ])
  })

  it('applies streaming deltas while a request is active', () => {
    expect(applyAiStreamEvent(pendingTurn, { type: 'delta', text: '结果' })).toMatchObject({
      text: '结果',
      pending: true,
    })
    expect(applyAiStreamEvent(pendingTurn, { type: 'done', finish: 'stop' })).toMatchObject({
      pending: false,
    })
  })
})

describe('AI conversation history', () => {
  it('merges chat and Agent entries in timestamp order and trims the oldest', () => {
    expect(
      mergeAiConversationHistory(
        [
          { role: 'assistant', content: 'Agent 完成排版', createdAt: 30 },
          { role: 'user', content: '先讨论方案', createdAt: 10 },
          { role: 'assistant', content: '建议两栏', createdAt: 20 },
          { role: 'user', content: '为什么这样排？', createdAt: 40 },
        ],
        3
      )
    ).toEqual([
      { role: 'assistant', content: '建议两栏' },
      { role: 'assistant', content: 'Agent 完成排版' },
      { role: 'user', content: '为什么这样排？' },
    ])
  })
})
