import { describe, expect, it } from 'vitest'
import { classifyAiIntent, inferAiAgentScope, isMindMapGenerationIntent } from './aiIntent'

describe('AI input intent routing', () => {
  it('detects concrete mind-map creation without swallowing questions', () => {
    expect(isMindMapGenerationIntent('把这页内容整理成思维导图')).toBe(true)
    expect(isMindMapGenerationIntent('Create a mind map from this page')).toBe(true)
    expect(isMindMapGenerationIntent('如何生成思维导图？')).toBe(false)
    expect(isMindMapGenerationIntent('为什么生成的思维导图会覆盖原文？')).toBe(false)
  })

  it.each([
    '帮我生成一个思维导图',
    '在左侧添加一个分支',
    '把这些内容排成两栏',
    '识别图片公式并写到画布',
    '将选中的笔记移动到右边',
    '在左侧帮我生成一个思维导图的分支',
    'move the selected notes to the right',
    'Create a flowchart from these notes',
    'Place this image on the canvas',
    '把 LaTeX 代码公式改为真实公式显示',
    '润色这段内容并保留原意',
    '优化一下现在的布局',
    '把这页内容总结成思维导图',
    '把所有内容做成一张流程图',
    '把选中的内容总结后替换原文',
    '识别这张图片里的公式并改成真实公式',
    '帮我重新排版一下',
  ])('routes a canvas mutation to Agent: %s', (input) => {
    expect(classifyAiIntent(input)).toBe('agent')
  })

  it.each([
    '什么是思维导图',
    '如何生成思维导图',
    '请问如何在画布中生成思维导图？',
    '我想知道怎么把内容排成两栏',
    '怎么把选中的笔记移动到右边？',
    '解释这个公式',
    '总结这段内容',
    '帮我生成当前页面的摘要',
    '思维导图有哪些类型？',
    'What is a mind map?',
    'How do I create a mind map?',
    'How can I move the selected notes to the right?',
    'Explain this formula',
    'Summarize these notes',
    'Generate a summary of the current page',
    '只回答我，不要修改画布：这个公式是什么意思？',
    '总结当前页的主要内容',
    '生成思维导图是什么意思？',
    'Should I move the image left?',
  ])('keeps an informational request in chat: %s', (input) => {
    expect(classifyAiIntent(input)).toBe('chat')
  })

  it('keeps attachment-only input in chat', () => {
    expect(classifyAiIntent('', { hasAttachments: true })).toBe('chat')
  })

  it.each([
    '总结这些附件',
    '读取附件并告诉我重点',
    '识别图片里的公式并转换成 LaTeX',
    'Summarize the attached document',
  ])('keeps attachment analysis in chat: %s', (input) => {
    expect(classifyAiIntent(input, { hasAttachments: true })).toBe('chat')
  })

  it.each([
    '把附件里的公式转换成 LaTeX 并写入画布',
    '把这张图片放到当前页左侧',
    'Convert the attachment into a mind map',
    'Put the attached image on the canvas',
  ])('routes an explicit attachment-to-canvas operation to Agent: %s', (input) => {
    expect(classifyAiIntent(input, { hasAttachments: true })).toBe('agent')
  })

  it('uses attachments and a current selection as concrete mutation targets', () => {
    expect(classifyAiIntent('把附件放在左边', { hasAttachments: true })).toBe('agent')
    expect(classifyAiIntent('把它移到左边', { hasSelection: true })).toBe('agent')
    expect(classifyAiIntent('把它移到左边')).toBe('chat')
  })

  it.each(['继续', '再往左一点', 'move it to the right'])('routes an Agent follow-up: %s', (input) => {
    expect(classifyAiIntent(input, { hasActiveAgentDraft: true })).toBe('agent')
    expect(classifyAiIntent(input)).toBe('chat')
  })

  it('continues an existing Agent conversation after a draft was finalized', () => {
    expect(classifyAiIntent('可以，就按这个方案做', { hasAgentHistory: true })).toBe('agent')
  })

  it('infers selection scope only when a selection exists', () => {
    expect(inferAiAgentScope('把选中的节点移到左边', 2)).toBe('selection')
    expect(inferAiAgentScope('在这个节点上添加分支', 1)).toBe('selection')
    expect(inferAiAgentScope('把选中的节点移到左边', 0, 'selection')).toBe('page')
  })

  it('lets an explicit whole-page target override selection scope', () => {
    expect(inferAiAgentScope('整理整个页面', 3, 'selection')).toBe('page')
    expect(inferAiAgentScope('统一所有公式的位置', 3, 'selection')).toBe('page')
  })
})
