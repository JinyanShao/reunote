import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from './api'
import { completeJson, parseJson } from './aiActions'
import type { AiChatAttachment } from './aiAttachments'
import { useApp } from './store'
import type { AiProfile } from './types'

const profile: AiProfile = {
  id: 'profile-terra',
  name: 'GPT-5.6 Terra',
  baseUrl: 'http://localhost/v1',
  apiKey: '',
  model: 'gpt-5.6-terra',
  apiStyle: 'openai',
  temperature: 0.2,
  maxTokens: 4096,
  timeoutSecs: 180,
  supportsVision: true,
}

afterEach(() => vi.restoreAllMocks())

describe('structured AI completion', () => {
  it('extracts the first complete JSON value from mixed model output', () => {
    const parsed = parseJson<{ kind: string }>(
      '先分析 {这不是 JSON}。\n```json\n{"kind":"finish","summary":"完成"}\n```\n后续说明。'
    )

    expect(parsed).toMatchObject({ kind: 'finish' })
  })

  it('repairs common JSON punctuation mistakes from compatible models', () => {
    expect(
      parseJson<{ kind: string; summary: string }>(
        '结果：{kind: “finish”, summary: “完成”,}'
      )
    ).toEqual({ kind: 'finish', summary: '完成' })
  })

  it('automatically retries once after malformed JSON', async () => {
    useApp.setState({
      settings: {
        ...useApp.getState().settings,
        aiProfiles: [profile],
        activeProfileId: profile.id,
      },
    })
    const complete = vi
      .spyOn(api, 'aiComplete')
      .mockResolvedValueOnce('我将执行这个任务，但这里没有 JSON。')
      .mockResolvedValueOnce('{"kind":"finish","summary":"已完成"}')

    await expect(
      completeJson<{ kind: string }>('返回 Agent 指令', '整理画布')
    ).resolves.toMatchObject({ kind: 'finish' })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls[0][2]).toBe(true)
    expect(complete.mock.calls[1][2]).toBe(true)
    expect(complete.mock.calls[1][1][1].content).toContain('<previous_response>')
  })

  it('falls back when an OpenAI-compatible service rejects response_format', async () => {
    useApp.setState({
      settings: {
        ...useApp.getState().settings,
        aiProfiles: [profile],
        activeProfileId: profile.id,
      },
    })
    const complete = vi
      .spyOn(api, 'aiComplete')
      .mockRejectedValueOnce(new Error('HTTP 400: response_format is unsupported'))
      .mockResolvedValueOnce('{"kind":"finish","summary":"已完成"}')

    await expect(completeJson<{ kind: string }>('返回 Agent 指令', '整理画布')).resolves.toEqual({
      kind: 'finish',
      summary: '已完成',
    })
    expect(complete.mock.calls.map((call) => call[2])).toEqual([true, false])
  })

  it('sends image attachments as multimodal content during structured completion', async () => {
    useApp.setState({
      settings: {
        ...useApp.getState().settings,
        aiProfiles: [profile],
        activeProfileId: profile.id,
      },
    })
    const image: AiChatAttachment = {
      id: 'image-1',
      name: 'formula.png',
      mime: 'image/png',
      kind: 'image',
      size: 3,
      base64: 'YWJj',
    }
    const complete = vi.spyOn(api, 'aiComplete').mockResolvedValueOnce('{"ok":true}')

    await completeJson('读取附件', '识别公式', [image])

    const userContent = complete.mock.calls[0][1][1].content as Array<{ type: string }>
    expect(userContent.map((part) => part.type)).toEqual(['text', 'image_url'])
    expect(complete.mock.calls[0][2]).toBe(true)
  })
})
