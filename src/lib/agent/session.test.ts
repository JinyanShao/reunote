// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiChatAttachment } from '../aiAttachments'
import type { CanvasDoc, CanvasElement } from '../types'

vi.mock('../aiActions', () => ({ completeJson: vi.fn(), completeWithAttachments: vi.fn() }))

import { completeJson, completeWithAttachments } from '../aiActions'
import { runCanvasAgent } from './session'

const mockedCompleteJson = vi.mocked(completeJson)
const mockedCompleteWithAttachments = vi.mocked(completeWithAttachments)

function workflow(
  stages: Array<{
    title: string
    objective: string
    targetElementIds?: string[]
    skill?: string
  }> = [
    { title: '执行调整', objective: '完成用户要求', targetElementIds: [] },
  ]
) {
  return {
    title: '画布整理工作流',
    summary: '按阶段安全修改画布',
    stages,
  }
}

function element(id: string, x: number, y: number): CanvasElement {
  return {
    id,
    type: 'text',
    x,
    y,
    w: 100,
    h: 70,
    rotation: 0,
    z: 1,
    html: `<p>${id}</p>`,
    bg: 'transparent',
    border: 'transparent',
    fontFamily: 'sans',
    fontScale: 1,
    padding: 8,
  }
}

describe('canvas agent session', () => {
  beforeEach(() => {
    mockedCompleteJson.mockReset()
    mockedCompleteWithAttachments.mockReset()
  })

  it('runs a LangGraph tool loop and returns a non-mutating preview', async () => {
    const progress: string[] = []
    mockedCompleteJson
      .mockResolvedValueOnce(
        workflow([
          {
            title: '横向排列',
            objective: '把对象排成一行',
            targetElementIds: ['a', 'b'],
            skill: 'reading_columns',
          },
        ])
      )
      .mockResolvedValueOnce({
        kind: 'tool',
        reason: '把内容排成整齐的一行',
        tool: 'arrange',
        args: { mode: 'rows', gap: 30 },
      })
      .mockResolvedValueOnce({
        kind: 'finish',
        summary: '已横向整理画布内容',
      })

    const source: CanvasDoc = {
      version: 1,
      background: 'grid',
      elements: [element('a', 0, 0), element('b', 400, 200)],
      strokes: [],
    }
    const preview = await runCanvasAgent(
      {
        pageId: 'page-1',
        baseRev: 7,
        prompt: '横向整理这两个元素',
        scope: 'page',
        doc: source,
        selectedElementIds: [],
        selectedStrokeIds: [],
      },
      { onProgress: (item) => progress.push(`${item.phase}:${item.text}`) }
    )

    expect(mockedCompleteJson).toHaveBeenCalledTimes(3)
    expect(preview.steps).toHaveLength(1)
    expect(preview.workflow?.stages[0].skill).toBe('reading_columns')
    expect(preview.summary).toBe('已横向整理画布内容')
    expect(preview.changedElementIds).toContain('b')
    expect(preview.after.elements.find((item) => item.id === 'b')).toMatchObject({ x: 130, y: 0 })
    expect(source.elements.find((item) => item.id === 'b')).toMatchObject({ x: 400, y: 200 })
    expect(progress.some((item) => item.startsWith('thinking:'))).toBe(true)
    expect(progress.some((item) => item.startsWith('plan:计划第 1 步'))).toBe(true)
    expect(progress.some((item) => item.startsWith('tool:arrange'))).toBe(true)
    expect(progress.some((item) => item.startsWith('done:'))).toBe(true)
  })

  it('feeds a failed tool result back to the model for correction', async () => {
    mockedCompleteJson
      .mockResolvedValueOnce(workflow())
      .mockResolvedValueOnce({
        kind: 'tool',
        reason: '尝试对齐不存在的对象',
        tool: 'align',
        args: { ids: ['missing'], alignment: 'left' },
      })
      .mockResolvedValueOnce({
        kind: 'tool',
        reason: '改为排列全部有效对象',
        tool: 'arrange',
        args: { mode: 'columns', columns: 1 },
      })
      .mockResolvedValueOnce({ kind: 'finish', summary: '已纠正并完成排列' })

    const source: CanvasDoc = {
      version: 1,
      background: 'grid',
      elements: [element('a', 0, 0), element('b', 400, 200)],
      strokes: [],
    }
    const preview = await runCanvasAgent({
      pageId: 'page-2',
      baseRev: 2,
      prompt: '纵向排列',
      scope: 'page',
      doc: source,
      selectedElementIds: [],
      selectedStrokeIds: [],
    })

    expect(preview.steps).toHaveLength(2)
    expect(preview.steps[0].observation).toContain('工具调用失败')
    expect(preview.changedElementIds.length).toBeGreaterThan(0)
  })

  it('ingests attachments once and uses the summary throughout the Agent workflow', async () => {
    const attachment: AiChatAttachment = {
      id: 'document-1',
      name: 'meeting.md',
      mime: 'text/markdown',
      kind: 'document',
      size: 20,
      text: '# 会议\n- 结论 A',
    }
    mockedCompleteWithAttachments.mockResolvedValueOnce('会议结论：A；负责人：李明。')
    mockedCompleteJson
      .mockResolvedValueOnce(
        workflow([{ title: '创建摘要', objective: '创建会议摘要文本', targetElementIds: [] }])
      )
      .mockResolvedValueOnce({
        kind: 'tool',
        reason: '把附件重点写入画布',
        tool: 'create',
        args: { type: 'text', content: '会议结论：A；负责人：李明。' },
      })
      .mockResolvedValueOnce({ kind: 'finish', summary: '已整理附件' })
    const attachmentContexts: string[] = []

    const preview = await runCanvasAgent(
      {
        pageId: 'page-attachment',
        baseRev: 1,
        prompt: '整理这个附件',
        scope: 'page',
        doc: { version: 1, background: 'grid', elements: [], strokes: [] },
        selectedElementIds: [],
        selectedStrokeIds: [],
        attachments: [attachment],
      },
      { onAttachmentContext: (context) => attachmentContexts.push(context) }
    )

    expect(mockedCompleteWithAttachments).toHaveBeenCalledTimes(1)
    expect(mockedCompleteWithAttachments.mock.calls[0][2]).toEqual([attachment])
    expect(mockedCompleteJson).toHaveBeenCalledTimes(3)
    expect(mockedCompleteJson.mock.calls[0][1]).toContain('会议结论：A')
    expect(mockedCompleteJson.mock.calls[1][1]).toContain('会议结论：A')
    expect(attachmentContexts).toEqual(['会议结论：A；负责人：李明。'])
    expect(preview.after.elements).toHaveLength(1)
  })

  it('creates an undoable LaTeX block from existing text', async () => {
    mockedCompleteJson
      .mockResolvedValueOnce(workflow([{ title: '转换公式', objective: '创建 LaTeX 公式块', targetElementIds: ['source'] }]))
      .mockResolvedValueOnce({
        kind: 'tool',
        reason: '把正文中的勾股定理转换为独立公式块',
        tool: 'create_math',
        args: { latex: 'a^2+b^2=c^2', relativeTo: 'source', side: 'below' },
      })
      .mockResolvedValueOnce({ kind: 'finish', summary: '已创建勾股定理公式块' })

    const source: CanvasDoc = {
      version: 1,
      background: 'grid',
      elements: [element('source', 80, 90)],
      strokes: [],
    }
    const preview = await runCanvasAgent({
      pageId: 'page-math',
      baseRev: 3,
      prompt: '把正文里的公式转换成 LaTeX',
      scope: 'page',
      doc: source,
      selectedElementIds: [],
      selectedStrokeIds: [],
    })

    expect(preview.createdElementIds).toHaveLength(1)
    expect(preview.after.elements.find((item) => item.type === 'math')).toMatchObject({
      type: 'math',
      latex: 'a^2+b^2=c^2',
    })
    expect(preview.after.elements.find((item) => item.id === 'source')).toMatchObject({
      html: '<p>source</p>',
    })
  })

  it('anchors formula Skill output when the model omits relativeTo', async () => {
    mockedCompleteJson
      .mockResolvedValueOnce(
        workflow([
          {
            title: '转换公式',
            objective: '把来源正文转换为独立公式块',
            targetElementIds: ['source'],
            skill: 'formula_companion',
          },
        ])
      )
      .mockResolvedValueOnce({
        kind: 'tool',
        reason: '创建可编辑公式',
        tool: 'create_math',
        args: { latex: 'E=mc^2' },
      })
      .mockResolvedValueOnce({ kind: 'finish', summary: '已创建公式块' })

    const source: CanvasDoc = {
      version: 1,
      background: 'grid',
      elements: [element('source', 80, 90)],
      strokes: [],
    }
    const preview = await runCanvasAgent({
      pageId: 'page-skill-anchor',
      baseRev: 4,
      prompt: '把正文中的 LaTeX 代码显示成真实公式',
      scope: 'page',
      doc: source,
      selectedElementIds: [],
      selectedStrokeIds: [],
    })

    expect(preview.after.elements.find((item) => item.type === 'math')).toMatchObject({
      type: 'math',
      latex: 'E=mc^2',
      y: 196,
      agentMeta: {
        sourceId: 'source',
        skill: 'formula_companion',
      },
    })
    const formula = preview.after.elements.find((item) => item.type === 'math')!
    const anchor = preview.after.elements.find((item) => item.id === 'source')!
    expect(formula.x + formula.w / 2).toBe(anchor.x + anchor.w / 2)
    expect(preview.steps[preview.steps.length - 1]?.tool).toBe('layout_math')
  })

  it('ignores guessed formula geometry and anchors the formula to its matching paragraph', async () => {
    const article = element('article', 100, 100) as Extract<CanvasElement, { type: 'text' }>
    article.w = 420
    article.h = 300
    article.html = '<p>这是引言。</p><p>能量关系：E=mc^2</p><p>这是结论。</p>'
    const wrong = element('wrong-source', 900, 80) as Extract<CanvasElement, { type: 'text' }>
    wrong.html = '<p>与公式无关的内容</p>'
    mockedCompleteJson
      .mockResolvedValueOnce(
        workflow([
          {
            title: '转换正文公式',
            objective: '把正文第二段的公式排在对应位置',
            targetElementIds: ['article', 'wrong-source'],
            skill: 'formula_companion',
          },
        ])
      )
      .mockResolvedValueOnce({
        kind: 'tool',
        reason: '创建正文公式',
        tool: 'create_math',
        args: {
          latex: 'E=mc^2',
          relativeTo: 'wrong-source',
          sourceBlockIndex: 0,
          x: 9000,
          y: -8000,
          width: 1600,
          height: 1200,
        },
      })
      .mockResolvedValueOnce({ kind: 'finish', summary: '公式已创建' })
    const starts: string[][] = []
    const commits: string[][] = []

    const preview = await runCanvasAgent(
      {
        pageId: 'page-math-paragraph',
        baseRev: 1,
        prompt: '把正文中的 LaTeX 公式放到对应段落旁边',
        scope: 'page',
        doc: {
          version: 1,
          background: 'grid',
          elements: [article, wrong],
          strokes: [],
        },
        selectedElementIds: [],
        selectedStrokeIds: [],
      },
      {
        onStepStart: (step) => starts.push(step.activeElementIds),
        onStepCommitted: (step) => commits.push(step.changedElementIds.concat(step.createdElementIds)),
      }
    )

    const formula = preview.after.elements.find((item) => item.type === 'math')!
    expect(formula).toMatchObject({
      latex: 'E=mc^2',
      agentMeta: { sourceId: 'article', sourceBlockIndex: 1 },
    })
    expect(formula.x).toBeGreaterThan(article.x + article.w)
    expect(formula.x).not.toBe(9000)
    expect(formula.y).not.toBe(-8000)
    expect(formula.w).toBeLessThan(1600)
    expect(formula.h).toBeLessThan(1200)
    expect(preview.steps.map((step) => step.tool)).toEqual(['create_math', 'layout_math'])
    expect(starts).toHaveLength(2)
    expect(starts[1]).toContain('article')
    expect(commits).toHaveLength(2)
  })

  it('routes weak-model create_math calls into the matching rich-text paragraph', async () => {
    const article = element('article', 100, 100) as Extract<CanvasElement, { type: 'text' }>
    article.w = 420
    article.h = 300
    article.html = '<p>这是引言。</p><p>能量关系：$E=mc^2$</p><p>这是结论。</p>'
    const wrong = element('wrong-source', 900, 80) as Extract<CanvasElement, { type: 'text' }>
    wrong.html = '<p>与公式无关的内容</p>'
    mockedCompleteJson
      .mockResolvedValueOnce(
        workflow([
          {
            title: '嵌入正文公式',
            objective: '在原段落中显示真实公式',
            targetElementIds: ['article', 'wrong-source'],
            skill: 'formula_companion',
          },
        ])
      )
      .mockResolvedValueOnce({
        kind: 'tool',
        reason: '转换正文公式',
        tool: 'create_math',
        args: {
          latex: 'E=mc^2',
          relativeTo: 'wrong-source',
          sourceBlockIndex: 0,
          x: 9000,
          y: -8000,
        },
      })
      .mockResolvedValueOnce({ kind: 'finish', summary: '公式已嵌入' })

    const preview = await runCanvasAgent({
      pageId: 'page-embedded-math',
      baseRev: 1,
      prompt: '把正文中的 LaTeX 嵌入原段落并显示为真实公式',
      scope: 'page',
      doc: {
        version: 1,
        background: 'grid',
        elements: [article, wrong],
        strokes: [],
      },
      selectedElementIds: [],
      selectedStrokeIds: [],
    })

    const embedded = preview.after.elements.find(
      (item): item is Extract<CanvasElement, { type: 'text' }> =>
        item.id === 'article' && item.type === 'text'
    )!
    expect(embedded.html).toContain('<p>能量关系：\\(E=mc^2\\)</p>')
    expect(preview.after.elements.some((item) => item.type === 'math')).toBe(false)
    expect(preview.steps.map((step) => step.tool)).toEqual(['normalize_math', 'embed_math'])
    expect(preview.changedElementIds).toEqual(['article'])
    expect(preview.createdElementIds).toEqual([])
  })

  it('keeps deterministic formula progress when a provider returns no Agent JSON', async () => {
    const article = element('article', 100, 100) as Extract<CanvasElement, { type: 'text' }>
    article.html = '<p>能量关系：$E=mc^2$</p>'
    mockedCompleteJson
      .mockResolvedValueOnce(
        workflow([
          {
            title: '嵌入公式',
            objective: '在正文原位显示公式',
            targetElementIds: ['article'],
            skill: 'formula_companion',
          },
        ])
      )
      .mockRejectedValueOnce(new Error('模型连续两次未返回可用的 Agent 指令'))

    const preview = await runCanvasAgent({
      pageId: 'page-invalid-agent-json',
      baseRev: 1,
      prompt: '把正文中的 LaTeX 嵌入原段落并显示为真实公式',
      scope: 'page',
      doc: {
        version: 1,
        background: 'grid',
        elements: [article],
        strokes: [],
      },
      selectedElementIds: [],
      selectedStrokeIds: [],
    })

    expect(preview.after.elements[0]).toMatchObject({
      id: 'article',
      html: '<p>能量关系：\\(E=mc^2\\)</p>',
    })
    expect(preview.steps.map((step) => step.tool)).toEqual(['normalize_math'])
    expect(preview.summary).toContain('确定性 Critic')
  })

  it('repairs an existing formula deterministically even when the model immediately finishes', async () => {
    const sourceElement = element('source', 80, 90)
    sourceElement.w = 320
    sourceElement.h = 160
    const formula: CanvasElement = {
      id: 'formula',
      type: 'math',
      x: 100,
      y: 110,
      w: 420,
      h: 90,
      rotation: 0,
      z: 2,
      latex: 'a^2+b^2=c^2',
      color: 'var(--ink-text)',
      display: true,
      agentMeta: {
        planId: 'older-plan',
        role: 'created',
        sourceId: 'source',
        skill: 'formula_companion',
      },
    }
    mockedCompleteJson
      .mockResolvedValueOnce(
        workflow([
          {
            title: '校正公式位置',
            objective: '把公式放回来源附近',
            targetElementIds: ['source', 'formula'],
            skill: 'formula_companion',
          },
        ])
      )
      .mockResolvedValueOnce({ kind: 'finish', summary: '公式已经存在' })
    const committed = vi.fn()

    const preview = await runCanvasAgent(
      {
        pageId: 'page-existing-math',
        baseRev: 2,
        prompt: '重新排版现有 LaTeX 公式',
        scope: 'page',
        doc: {
          version: 1,
          background: 'grid',
          elements: [sourceElement, formula],
          strokes: [],
        },
        selectedElementIds: [],
        selectedStrokeIds: [],
      },
      { onStepCommitted: committed }
    )

    expect(mockedCompleteJson).toHaveBeenCalledTimes(2)
    expect(preview.steps.map((step) => step.tool)).toEqual(['layout_math'])
    expect(preview.changedElementIds).toContain('formula')
    expect(preview.after.elements.find((item) => item.id === 'formula')).toMatchObject({
      y: 286,
      agentMeta: { sourceId: 'source', skill: 'formula_companion' },
    })
    expect(preview.after.elements.find((item) => item.id === 'formula')?.w).toBeLessThan(420)
    expect(committed).toHaveBeenCalledTimes(1)
  })

  it('reflows an updated formula before building the final preview', async () => {
    const sourceElement = element('source', 20, 30)
    const formula: CanvasElement = {
      id: 'formula',
      type: 'math',
      x: 20,
      y: 136,
      w: 180,
      h: 84,
      rotation: 0,
      z: 2,
      latex: 'x=1',
      color: 'var(--ink-text)',
      display: true,
      agentMeta: {
        planId: 'older-plan',
        role: 'created',
        sourceId: 'source',
        skill: 'formula_companion',
      },
    }
    mockedCompleteJson
      .mockResolvedValueOnce(
        workflow([
          {
            title: '更新公式',
            objective: '更新并重新排版公式',
            targetElementIds: ['formula', 'source'],
            skill: 'formula_companion',
          },
        ])
      )
      .mockResolvedValueOnce({
        kind: 'tool',
        reason: '更新公式内容',
        tool: 'update_math',
        args: { id: 'formula', latex: '\\frac{a+b+c+d+e+f}{x+y+z}=42' },
      })
      .mockResolvedValueOnce({ kind: 'finish', summary: '公式已更新' })

    const preview = await runCanvasAgent({
      pageId: 'page-update-math',
      baseRev: 3,
      prompt: '更新这个 LaTeX 公式并放到正确位置',
      scope: 'page',
      doc: {
        version: 1,
        background: 'grid',
        elements: [sourceElement, formula],
        strokes: [],
      },
      selectedElementIds: [],
      selectedStrokeIds: [],
    })

    expect(preview.steps.map((step) => step.tool)).toEqual(['update_math', 'layout_math'])
    expect(preview.after.elements.find((item) => item.id === 'formula')).toMatchObject({
      latex: '\\frac{a+b+c+d+e+f}{x+y+z}=42',
      agentMeta: { sourceId: 'source' },
    })
    expect(preview.after.elements.find((item) => item.id === 'formula')?.w).toBeGreaterThan(180)
  })

  it('uses a locked text block as a read-only paragraph anchor', async () => {
    const article = element('locked-article', 60, 70) as Extract<CanvasElement, { type: 'text' }>
    article.w = 360
    article.h = 260
    article.html = '<p>第一段没有公式。</p><p>锁定段落中的公式：F=ma</p>'
    article.locked = true
    mockedCompleteJson
      .mockResolvedValueOnce(
        workflow([
          {
            title: '转换锁定正文公式',
            objective: '只读引用来源并创建公式',
            targetElementIds: ['locked-article'],
            skill: 'formula_companion',
          },
        ])
      )
      .mockResolvedValueOnce({
        kind: 'tool',
        reason: '创建锁定正文中的公式',
        tool: 'create_math',
        args: { latex: 'F=ma' },
      })
      .mockResolvedValueOnce({ kind: 'finish', summary: '公式已创建' })
    const before = JSON.stringify(article)

    const preview = await runCanvasAgent({
      pageId: 'page-locked-source',
      baseRev: 1,
      prompt: '把锁定正文中的 LaTeX 显示为真实公式',
      scope: 'page',
      doc: {
        version: 1,
        background: 'grid',
        elements: [article],
        strokes: [],
      },
      selectedElementIds: [],
      selectedStrokeIds: [],
    })

    expect(JSON.stringify(preview.after.elements.find((item) => item.id === article.id))).toBe(before)
    expect(preview.after.elements.find((item) => item.type === 'math')).toMatchObject({
      agentMeta: { sourceId: 'locked-article', sourceBlockIndex: 1 },
    })
  })

  it('embeds fallback formulas into their original text segments', async () => {
    const article = element('article', 80, 90) as Extract<CanvasElement, { type: 'text' }>
    article.w = 380
    article.h = 280
    article.html = '<p>勾股定理：a^2+b^2=c^2</p><p>质能关系：E=mc^2</p>'
    mockedCompleteJson
      .mockResolvedValueOnce(
        workflow([
          {
            title: '转录正文公式',
            objective: '创建两条可编辑公式',
            targetElementIds: ['article'],
            skill: 'formula_companion',
          },
        ])
      )
      .mockResolvedValueOnce({ kind: 'finish', summary: '暂未生成修改' })
      .mockResolvedValueOnce({
        formulas: [
          { latex: 'a^2+b^2=c^2', action: 'create', sourceId: 'article', uncertain: false },
          { latex: 'E=mc^2', action: 'create', sourceId: 'article', uncertain: false },
        ],
      })

    const preview = await runCanvasAgent({
      pageId: 'page-fallback-lane',
      baseRev: 1,
      prompt: '把正文中的两个 LaTeX 公式转换并排版',
      scope: 'page',
      doc: {
        version: 1,
        background: 'grid',
        elements: [article],
        strokes: [],
      },
      selectedElementIds: [],
      selectedStrokeIds: [],
    })

    const embedded = preview.after.elements.find(
      (item): item is Extract<CanvasElement, { type: 'text' }> =>
        item.id === 'article' && item.type === 'text'
    )!
    expect(preview.after.elements.filter((item) => item.type === 'math')).toHaveLength(0)
    expect(embedded.html).toContain('勾股定理：\\(a^2+b^2=c^2\\)')
    expect(embedded.html).toContain('质能关系：\\(E=mc^2\\)')
    expect(preview.steps.map((step) => step.tool)).toEqual(['embed_math', 'embed_math'])
  })

  it('migrates a legacy right-lane Agent formula back into its source paragraph', async () => {
    const article = element('article', 80, 90) as Extract<CanvasElement, { type: 'text' }>
    article.html = '<p>质能关系：$E=mc^2$</p>'
    const legacy: CanvasElement = {
      id: 'legacy-formula',
      type: 'math',
      x: 520,
      y: 120,
      w: 220,
      h: 84,
      rotation: 0,
      z: 2,
      latex: 'E=mc^2',
      color: '#111111',
      display: true,
      agentMeta: {
        planId: 'old-plan',
        role: 'created',
        sourceId: 'article',
        sourceBlockIndex: 0,
        skill: 'formula_companion',
      },
    }
    mockedCompleteJson
      .mockResolvedValueOnce(
        workflow([
          {
            title: '修复公式嵌入',
            objective: '把旧公式迁回正文',
            targetElementIds: ['article', 'legacy-formula'],
            skill: 'formula_companion',
          },
        ])
      )
      .mockResolvedValueOnce({ kind: 'finish', summary: '检查现有公式' })

    const preview = await runCanvasAgent({
      pageId: 'page-legacy-embed',
      baseRev: 1,
      prompt: '公式位置不对，请把它嵌入正文原位',
      scope: 'page',
      doc: {
        version: 1,
        background: 'grid',
        elements: [article, legacy],
        strokes: [],
      },
      selectedElementIds: [],
      selectedStrokeIds: [],
    })

    expect(preview.after.elements.some((item) => item.id === 'legacy-formula')).toBe(false)
    expect(preview.after.elements[0]).toMatchObject({
      id: 'article',
      html: '<p>质能关系：\\(E=mc^2\\)</p>',
    })
    expect(preview.deletedElementIds).toEqual(['legacy-formula'])
    expect(preview.steps.map((step) => step.tool)).toEqual(['normalize_math', 'embed_math'])
  })

  it('uses Scan/Bind and a semantic Critic to remove rewritten companion formulas', async () => {
    const article = element('article', 80, 90) as Extract<CanvasElement, { type: 'text' }>
    const sourceLatex = String.raw`\mathcal H^{(c)}_{\rm eff}=J\,\boldsymbol\tau_i\cdot\boldsymbol\tau_j+K\,\tau_i^z\tau_j^z+\Gamma\left(\tau_i^x\tau_j^y+\tau_i^y\tau_j^x\right)`
    article.html = `<p>正文<br>$$<br>${sourceLatex}<br>$$<br>结论</p>`
    const companionLatex = String.raw`\mathcal H_{ij}^{(z)}=J\,\boldsymbol{\tau}_i\!\cdot\!\boldsymbol{\tau}_j+K\,\tau_i^z\tau_j^z+\Gamma\left(\tau_i^x\tau_j^y+\tau_i^y\tau_j^x\right)`
    const companion: CanvasElement = {
      id: 'rewritten-formula',
      type: 'math',
      x: 520,
      y: 120,
      w: 520,
      h: 84,
      rotation: 0,
      z: 2,
      latex: companionLatex,
      color: '#111111',
      display: true,
      agentMeta: {
        planId: 'old-plan',
        role: 'created',
        sourceId: 'article',
        sourceBlockIndex: 0,
        skill: 'formula_companion',
      },
    }
    mockedCompleteJson
      .mockResolvedValueOnce(
        workflow([
          {
            title: '原位排版公式',
            objective: '扫描并修复全部正文公式',
            targetElementIds: ['article', 'rewritten-formula'],
            skill: 'formula_companion',
          },
        ])
      )
      .mockResolvedValueOnce({ kind: 'finish', summary: '检查公式位置' })

    const preview = await runCanvasAgent({
      pageId: 'page-semantic-migration',
      baseRev: 1,
      prompt: '帮我排 LaTeX，公式不要放在外面',
      scope: 'page',
      doc: {
        version: 1,
        background: 'grid',
        elements: [article, companion],
        strokes: [],
      },
      selectedElementIds: [],
      selectedStrokeIds: [],
    })

    const embedded = preview.after.elements.find(
      (item): item is Extract<CanvasElement, { type: 'text' }> =>
        item.id === 'article' && item.type === 'text'
    )!
    expect(embedded.html).toContain(`\\[${sourceLatex}\\]`)
    expect(preview.after.elements.some((item) => item.id === 'rewritten-formula')).toBe(false)
    expect(preview.deletedElementIds).toEqual(['rewritten-formula'])
    expect(preview.steps.map((step) => step.tool)).toEqual(['normalize_math', 'embed_math'])
    expect(mockedCompleteJson).not.toHaveBeenCalled()
  })

  it('allows a formula stage to process more than three formulas', async () => {
    mockedCompleteJson
      .mockResolvedValueOnce(
        workflow([
          {
            title: '转换多条公式',
            objective: '逐条创建四个公式块',
            targetElementIds: ['source'],
            skill: 'formula_companion',
          },
        ])
      )
      .mockResolvedValueOnce({
        kind: 'tool',
        reason: '创建第一条公式',
        tool: 'create_math',
        args: { latex: 'a=1', relativeTo: 'source' },
      })
      .mockResolvedValueOnce({
        kind: 'tool',
        reason: '创建第二条公式',
        tool: 'create_math',
        args: { latex: 'b=2', relativeTo: 'source' },
      })
      .mockResolvedValueOnce({
        kind: 'tool',
        reason: '创建第三条公式',
        tool: 'create_math',
        args: { latex: 'c=3', relativeTo: 'source' },
      })
      .mockResolvedValueOnce({
        kind: 'tool',
        reason: '创建第四条公式',
        tool: 'create_math',
        args: { latex: 'd=4', relativeTo: 'source' },
      })
      .mockResolvedValueOnce({ kind: 'finish', summary: '四条公式已创建' })

    const preview = await runCanvasAgent({
      pageId: 'page-many-formulas',
      baseRev: 1,
      prompt: '把这四条 LaTeX 都排好',
      scope: 'page',
      doc: {
        version: 1,
        background: 'grid',
        elements: [element('source', 80, 90)],
        strokes: [],
      },
      selectedElementIds: [],
      selectedStrokeIds: [],
    })

    expect(preview.after.elements.filter((item) => item.type === 'math')).toHaveLength(4)
    expect(preview.steps.map((step) => step.tool)).toEqual([
      'create_math',
      'create_math',
      'create_math',
      'create_math',
      'layout_math',
    ])
  })

  it('creates an uncertain editable draft when the main agent refuses zero-change math work', async () => {
    mockedCompleteJson
      .mockResolvedValueOnce(workflow([{ title: '转录公式', objective: '生成可编辑公式草稿', targetElementIds: ['source'] }]))
      .mockResolvedValueOnce({
        kind: 'finish',
        summary: '部分符号无法可靠辨识，暂未调整画布',
      })
      .mockResolvedValueOnce({
        formulas: [
          {
            latex: 'E=\\boxed{\\text{?}}mc^2',
            action: 'create',
            sourceId: 'source',
            uncertain: true,
          },
        ],
      })

    const source: CanvasDoc = {
      version: 1,
      background: 'grid',
      elements: [element('source', 80, 90)],
      strokes: [],
    }
    const preview = await runCanvasAgent({
      pageId: 'page-fallback',
      baseRev: 5,
      prompt: '把无法完全辨认的公式转换为 LaTeX 草稿',
      scope: 'page',
      doc: source,
      selectedElementIds: [],
      selectedStrokeIds: [],
    })

    expect(mockedCompleteJson).toHaveBeenCalledTimes(3)
    expect(preview.createdElementIds).toHaveLength(1)
    expect(preview.summary).toContain('问号占位符')
    expect(preview.after.elements.find((item) => item.type === 'math')).toMatchObject({
      latex: 'E=\\boxed{\\text{?}}mc^2',
      color: '#d97706',
    })
  })

  it('emits a structured workflow and realtime document delta after every successful tool', async () => {
    mockedCompleteJson
      .mockResolvedValueOnce(
        workflow([
          { title: '整理位置', objective: '横向排列对象', targetElementIds: ['a', 'b'] },
          { title: '统一样式', objective: '调整对象透明度', targetElementIds: ['a'] },
        ])
      )
      .mockResolvedValueOnce({
        kind: 'tool',
        reason: '先整理位置',
        tool: 'arrange',
        args: { ids: ['a', 'b'], mode: 'rows', gap: 20 },
      })
      .mockResolvedValueOnce({ kind: 'stage_done', summary: '位置已整理' })
      .mockResolvedValueOnce({
        kind: 'tool',
        reason: '再统一样式',
        tool: 'set_style',
        args: { ids: ['a'], opacity: 0.8 },
      })
      .mockResolvedValueOnce({ kind: 'finish', summary: '工作流已完成' })

    const source: CanvasDoc = {
      version: 1,
      background: 'grid',
      elements: [element('a', 0, 0), element('b', 400, 200)],
      strokes: [],
    }
    const workflows: string[] = []
    const starts: Array<{ stage: number; ids: string[] }> = []
    const committed: Array<{ stage: number; changed: string[]; bX: number }> = []
    const liveDocs: CanvasDoc[] = []
    const preview = await runCanvasAgent(
      {
        pageId: 'page-live',
        baseRev: 4,
        prompt: '先排列，再统一样式',
        scope: 'page',
        doc: source,
        selectedElementIds: [],
        selectedStrokeIds: [],
        history: [
          { role: 'user', content: '先按阅读顺序整理' },
          { role: 'assistant', content: '上一轮已完成初步分组' },
        ],
      },
      {
        onWorkflow: (item) => workflows.push(item.title),
        onStepStart: (item) =>
          starts.push({ stage: item.stage.index, ids: item.activeElementIds }),
        onStepCommitted: (item) =>
          committed.push({
            stage: item.stage.index,
            changed: item.changedElementIds,
            bX: item.doc.elements.find((entry) => entry.id === 'b')?.x ?? -1,
          }),
        onLiveDoc: (doc) => liveDocs.push(doc),
      }
    )

    expect(workflows).toEqual(['画布整理工作流'])
    expect(starts).toEqual([
      { stage: 0, ids: ['a', 'b'] },
      { stage: 1, ids: ['a'] },
    ])
    expect(committed).toEqual([
      { stage: 0, changed: ['b'], bX: 120 },
      { stage: 1, changed: ['a'], bX: 120 },
    ])
    expect(liveDocs).toHaveLength(2)
    expect(preview.steps.map((step) => step.stageIndex)).toEqual([0, 1])
    expect(preview.workflow?.stages).toHaveLength(2)
    expect(String(mockedCompleteJson.mock.calls[0]?.[1])).toContain('上一轮已完成初步分组')
    expect(String(mockedCompleteJson.mock.calls[1]?.[1])).toContain('先按阅读顺序整理')
    expect(source.elements.find((item) => item.id === 'b')).toMatchObject({ x: 400, y: 200 })
  })

  it('does not execute or publish a late draft when cancelled from step start', async () => {
    mockedCompleteJson
      .mockResolvedValueOnce(workflow())
      .mockResolvedValueOnce({
        kind: 'tool',
        reason: '准备排列',
        tool: 'arrange',
        args: { mode: 'rows' },
      })

    const source: CanvasDoc = {
      version: 1,
      background: 'grid',
      elements: [element('a', 0, 0), element('b', 400, 200)],
      strokes: [],
    }
    let cancelled = false
    const committed = vi.fn()
    const live = vi.fn()

    await expect(
      runCanvasAgent(
        {
          pageId: 'page-cancel',
          baseRev: 2,
          prompt: '排列对象',
          scope: 'page',
          doc: source,
          selectedElementIds: [],
          selectedStrokeIds: [],
        },
        {
          isCancelled: () => cancelled,
          onStepStart: () => {
            cancelled = true
          },
          onStepCommitted: committed,
          onLiveDoc: live,
        }
      )
    ).rejects.toThrow('Agent 操作已取消')

    expect(committed).not.toHaveBeenCalled()
    expect(live).not.toHaveBeenCalled()
    expect(source.elements.find((item) => item.id === 'b')).toMatchObject({ x: 400, y: 200 })
  })

  it('updates one text paragraph through the workflow without replacing sibling paragraphs', async () => {
    const article = element('article', 0, 0) as Extract<CanvasElement, { type: 'text' }>
    article.html = '<p>旧的第一段</p><p>第二段保留</p>'
    const source: CanvasDoc = {
      version: 1,
      background: 'grid',
      elements: [article],
      strokes: [],
    }
    mockedCompleteJson.mockResolvedValueOnce(workflow())

    let paragraphHash = ''
    mockedCompleteJson.mockImplementationOnce(async (_system, prompt) => {
      paragraphHash = String(prompt).match(/blockIndex=0 \| contentHash=([a-f0-9]+)/)?.[1] ?? ''
      return {
        kind: 'tool',
        reason: '逐段改写第一段',
        tool: 'update_text_segment',
        args: {
          elementId: 'article',
          blockIndex: 0,
          contentHash: paragraphHash,
          replacementHtml: '新的<strong>第一段</strong>',
        },
      }
    })
    mockedCompleteJson.mockResolvedValueOnce({ kind: 'finish', summary: '第一段已更新' })

    const preview = await runCanvasAgent({
      pageId: 'page-text',
      baseRev: 1,
      prompt: '改写第一段',
      scope: 'page',
      doc: source,
      selectedElementIds: [],
      selectedStrokeIds: [],
    })

    expect(paragraphHash).toHaveLength(16)
    expect(preview.after.elements[0]).toMatchObject({
      html: '<p>新的<strong>第一段</strong></p><p>第二段保留</p>',
    })
  })
})
