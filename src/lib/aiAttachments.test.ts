import { describe, expect, it } from 'vitest'
import { buildAiUserContent, type AiChatAttachment } from './aiAttachments'
import type { AiProfile } from './types'

function profile(apiStyle: 'openai' | 'anthropic', supportsVision = true): AiProfile {
  return {
    id: 'profile-1',
    name: '测试服务',
    baseUrl: 'http://localhost/v1',
    apiKey: '',
    model: 'vision-model',
    apiStyle,
    temperature: 0.2,
    maxTokens: 2048,
    timeoutSecs: 60,
    supportsVision,
  }
}

const image: AiChatAttachment = {
  id: 'image-1',
  name: 'diagram.png',
  mime: 'image/png',
  kind: 'image',
  size: 3,
  base64: 'YWJj',
}

const documentAttachment: AiChatAttachment = {
  id: 'document-1',
  name: 'notes.md',
  mime: 'text/markdown',
  kind: 'document',
  size: 12,
  text: '# 会议记录',
}

describe('AI chat attachment content', () => {
  it('builds OpenAI multimodal content with local document text', () => {
    const content = buildAiUserContent(profile('openai'), '总结附件', [image, documentAttachment])

    expect(content).toEqual([
      {
        type: 'text',
        text: '总结附件\n\n<attachment name="notes.md">\n# 会议记录\n</attachment>',
      },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,YWJj' },
      },
    ])
  })

  it('builds Anthropic base64 image content', () => {
    const content = buildAiUserContent(profile('anthropic'), '识别图片', [image]) as Array<{
      type: string
      source?: { media_type: string; data: string }
    }>

    expect(content[1]).toMatchObject({
      type: 'image',
      source: { media_type: 'image/png', data: 'YWJj' },
    })
  })

  it('rejects images when the selected profile has no vision support', () => {
    expect(() => buildAiUserContent(profile('openai', false), '看图', [image])).toThrow(
      '当前 AI 服务未启用图片理解'
    )
  })

  it('rejects an attachment batch larger than 40 MB', () => {
    expect(() =>
      buildAiUserContent(profile('openai'), '读取附件', [
        { ...image, id: 'large-1', size: 21 * 1024 * 1024 },
        { ...image, id: 'large-2', size: 20 * 1024 * 1024 },
      ])
    ).toThrow('附件总大小超过 40 MB')
  })
})
