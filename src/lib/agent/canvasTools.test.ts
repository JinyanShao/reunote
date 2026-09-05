// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { strokeBounds } from '../ink'
import type { CanvasDoc, CanvasElement, Stroke } from '../types'
import {
  canvasInventory,
  canvasTextSegments,
  createCanvasAgentDraft,
  executeCanvasTool,
} from './canvasTools'

function text(id: string, x: number, y: number, locked = false): CanvasElement {
  return {
    id,
    type: 'text',
    x,
    y,
    w: 120,
    h: 80,
    rotation: 0,
    z: 1,
    locked,
    html: `<p>${id}</p>`,
    bg: 'transparent',
    border: 'transparent',
    fontFamily: 'sans',
    fontScale: 1,
    padding: 8,
  }
}

function stroke(id: string, points: number[][]): Stroke {
  return { id, points, color: '#111111', size: 3, tool: 'pen', z: 1 }
}

function math(id: string, latex: string): CanvasElement {
  return {
    id,
    type: 'math',
    x: 100,
    y: 100,
    w: 320,
    h: 90,
    rotation: 0,
    z: 1,
    latex,
    color: '#111111',
    display: true,
  }
}

function image(id: string, x: number, y: number, w: number, h: number): CanvasElement {
  return {
    id,
    type: 'image',
    x,
    y,
    w,
    h,
    rotation: 0,
    z: 1,
    src: 'data:image/png;base64,AA==',
    alt: '包含公式的图片',
    radius: 0,
    shadow: false,
  }
}

function doc(elements: CanvasElement[], strokes: Stroke[] = []): CanvasDoc {
  return { version: 1, background: 'grid', elements, strokes }
}

describe('canvas agent tools', () => {
  it('only arranges elements inside the selected scope', () => {
    const source = doc([text('a', 100, 100), text('b', 500, 300), text('outside', 900, 900)])
    const draft = createCanvasAgentDraft(source, 'selection', ['a', 'b'], [], 'plan-1')
    const result = executeCanvasTool(draft, 'arrange', {
      mode: 'rows',
      gap: 20,
    })
    const a = result.draft.doc.elements.find((element) => element.id === 'a')!
    const b = result.draft.doc.elements.find((element) => element.id === 'b')!
    const outside = result.draft.doc.elements.find((element) => element.id === 'outside')!

    expect(a.x).toBe(100)
    expect(a.y).toBe(100)
    expect(b.x).toBe(240)
    expect(b.y).toBe(100)
    expect({ x: outside.x, y: outside.y }).toEqual({ x: 900, y: 900 })
    expect(result.targetElementIds).toEqual(['a', 'b'])
    expect(result.changedElementIds).toEqual(['b'])
    expect(result.createdElementIds).toEqual([])
  })

  it('rejects locked and out-of-scope elements', () => {
    const source = doc([text('locked', 0, 0, true), text('outside', 300, 0)])
    const pageDraft = createCanvasAgentDraft(source, 'page', [], [], 'plan-2')
    expect(() =>
      executeCanvasTool(pageDraft, 'arrange', { ids: ['locked'], mode: 'grid' })
    ).toThrow('已锁定')

    const selectedDraft = createCanvasAgentDraft(source, 'selection', ['locked'], [], 'plan-3')
    expect(() =>
      executeCanvasTool(selectedDraft, 'align', { ids: ['outside'], alignment: 'left' })
    ).toThrow('不在允许的作用范围内')
  })

  it('moves selected handwriting as a single virtual canvas object', () => {
    const source = doc(
      [text('anchor', 100, 100)],
      [stroke('s1', [[0, 0, 0.5], [20, 20, 0.5]]), stroke('s2', [[30, 10, 0.5], [50, 30, 0.5]])]
    )
    const draft = createCanvasAgentDraft(source, 'page', [], [], 'plan-4')
    const result = executeCanvasTool(draft, 'place_relative', {
      ids: ['ink:page'],
      anchorId: 'anchor',
      side: 'below',
      gap: 40,
    })
    const visibleTop = Math.min(...result.draft.doc.strokes.map((item) => strokeBounds(item).y))
    expect(visibleTop).toBe(220)
    expect(result.draft.doc.strokes[0].points[1][0] - result.draft.doc.strokes[0].points[0][0]).toBe(20)
  })

  it('creates tracked headings for semantic groups without changing body content', () => {
    const source = doc([text('a', 100, 100), text('b', 500, 300)])
    const draft = createCanvasAgentDraft(source, 'page', [], [], 'plan-5')
    const result = executeCanvasTool(draft, 'group_layout', {
      groups: [
        { title: '计划', ids: ['a'] },
        { title: '执行', ids: ['b'] },
      ],
      direction: 'columns',
      addHeadings: true,
    })
    const created = result.draft.doc.elements.filter((element) => element.agentMeta?.planId === 'plan-5')
    expect(created).toHaveLength(2)
    expect(result.draft.createdElementIds).toEqual(created.map((element) => element.id))
    expect(result.draft.doc.elements.find((element) => element.id === 'a')).toMatchObject({
      html: '<p>a</p>',
    })
  })

  it('normalizes every rich-text formula in one deterministic source pass', () => {
    const article = text('article', 100, 100) as Extract<CanvasElement, { type: 'text' }>
    article.html = '<p>行内 $a+b$<br>$$<br>\\frac{a}{b}=c<br>$$</p>'
    const draft = createCanvasAgentDraft(doc([article]), 'page', [], [], 'plan-normalize-math')

    const result = executeCanvasTool(draft, 'normalize_math', { elementId: 'article' })
    const normalized = result.draft.doc.elements[0] as Extract<CanvasElement, { type: 'text' }>

    expect(normalized.html).toContain('\\(a+b\\)')
    expect(normalized.html).toContain('\\[\\frac{a}{b}=c\\]')
    expect(result.observation).toContain('已扫描 2 个公式候选')
    expect(result.changedElementIds).toEqual(['article'])
  })

  it('changes only the requested page background', () => {
    const draft = createCanvasAgentDraft(doc([]), 'page', [], [], 'plan-6')
    const result = executeCanvasTool(draft, 'set_background', { background: 'dots' })
    expect(result.draft.doc.background).toBe('dots')
    expect(draft.doc.background).toBe('grid')
  })

  it('creates a tracked LaTeX block without rewriting its source text', () => {
    const source = doc([text('source', 100, 100)])
    const draft = createCanvasAgentDraft(source, 'page', [], [], 'plan-math')
    const result = executeCanvasTool(draft, 'create_math', {
      latex: '\\frac{a}{b}=c',
      relativeTo: 'source',
      side: 'below',
    })
    const created = result.draft.doc.elements.find((element) => element.type === 'math')

    expect(result.draft.doc.elements.find((element) => element.id === 'source')).toMatchObject({
      html: '<p>source</p>',
    })
    expect(created).toMatchObject({
      type: 'math',
      latex: '\\frac{a}{b}=c',
      y: 216,
      agentMeta: { planId: 'plan-math', role: 'created' },
    })
    expect(created!.x + created!.w / 2).toBe(100 + 120 / 2)
    expect(result.draft.createdElementIds).toEqual([created?.id])
  })

  it('keeps a formula in its preferred lane when the nearest slot is occupied', () => {
    const source = doc([text('source', 100, 100), text('blocker', 100, 216)])
    const draft = createCanvasAgentDraft(source, 'page', [], [], 'plan-clear-formula')
    const result = executeCanvasTool(draft, 'create_math', {
      latex: 'E=mc^2',
      relativeTo: 'source',
      side: 'below',
    })
    const created = result.draft.doc.elements.find((element) => element.type === 'math')

    expect(created).toMatchObject({ x: 70, y: 336, w: 180, h: 84 })
    expect(created?.agentMeta).toMatchObject({
      sourceId: 'source',
      skill: 'formula_companion',
    })
    expect(result.observation).toContain('来源下方')
  })

  it('vertically centers a formula in the right lane of an image source', () => {
    const sourceImage = image('source-image', 100, 100, 300, 240)
    const draft = createCanvasAgentDraft(doc([sourceImage]), 'page', [], [], 'plan-image-formula')
    const result = executeCanvasTool(draft, 'create_math', {
      latex: 'E=mc^2',
      relativeTo: 'source-image',
    })
    const formula = result.draft.doc.elements.find((element) => element.type === 'math')!

    expect(formula.x).toBe(sourceImage.x + sourceImage.w + 36)
    expect(formula.y + formula.h / 2).toBe(sourceImage.y + sourceImage.h / 2)
    expect(result.observation).toContain('来源右侧')
  })

  it('keeps same-source formulas in one lane and preserves their document order', () => {
    const draft = createCanvasAgentDraft(doc([text('source', 100, 100)]), 'page', [], [], 'plan-lane')
    const firstResult = executeCanvasTool(draft, 'create_math', {
      latex: 'x=1',
      relativeTo: 'source',
      side: 'below',
    })
    const firstId = firstResult.createdElementIds[0]
    const secondResult = executeCanvasTool(firstResult.draft, 'create_math', {
      latex: 'y=x+1',
      relativeTo: 'source',
      side: 'below',
    })
    const secondId = secondResult.createdElementIds.find((id) => id !== firstId)!
    const first = secondResult.draft.doc.elements.find((element) => element.id === firstId)!
    const second = secondResult.draft.doc.elements.find((element) => element.id === secondId)!

    expect(first.x).toBe(second.x)
    expect(first.y).toBe(216)
    expect(second.y).toBe(first.y + first.h + 18)
    expect(second.y).toBeGreaterThan(first.y)
  })

  it('stores paragraph anchors and orders same-source formulas by sourceBlockIndex', () => {
    const article = text('article', 100, 100) as Extract<CanvasElement, { type: 'text' }>
    article.w = 300
    article.h = 360
    article.html = '<p>第一段：a=1</p><p>第二段正文</p><p>第三段：c=3</p>'
    const draft = createCanvasAgentDraft(doc([article]), 'page', [], [], 'plan-paragraphs')
    const thirdResult = executeCanvasTool(draft, 'create_math', {
      latex: 'c=3',
      relativeTo: 'article',
      sourceBlockIndex: 2,
    })
    const thirdId = thirdResult.createdElementIds[0]
    const firstResult = executeCanvasTool(thirdResult.draft, 'create_math', {
      latex: 'a=1',
      relativeTo: 'article',
      sourceBlockIndex: 0,
    })
    const firstId = firstResult.createdElementIds.find((id) => id !== thirdId)!
    const first = firstResult.draft.doc.elements.find((element) => element.id === firstId)!
    const third = firstResult.draft.doc.elements.find((element) => element.id === thirdId)!

    expect(first.agentMeta).toMatchObject({ sourceId: 'article', sourceBlockIndex: 0 })
    expect(third.agentMeta).toMatchObject({ sourceId: 'article', sourceBlockIndex: 2 })
    expect(first.x).toBe(third.x)
    expect(first.y).toBeLessThan(third.y)
  })

  it('embeds text formulas at their original occurrences instead of creating canvas blocks', () => {
    const article = text('article', 100, 100) as Extract<CanvasElement, { type: 'text' }>
    article.w = 420
    article.h = 260
    article.html =
      '<p><strong>参数：</strong>$t\\in[0.05,0.30]$，并令 $U\\in[3.6,5]$。</p>' +
      '<p>$$\\Delta=3.89$$</p>'
    const draft = createCanvasAgentDraft(doc([article]), 'page', [], [], 'plan-embedded')
    const first = executeCanvasTool(draft, 'create_math', {
      latex: 't\\in[0.05,0.30]',
      relativeTo: 'article',
      sourceBlockIndex: 0,
      placement: 'embedded',
    })
    const second = executeCanvasTool(first.draft, 'embed_math', {
      elementId: 'article',
      blockIndex: 1,
      latex: '\\Delta=3.89',
      display: true,
    })
    const updated = second.draft.doc.elements.find(
      (element): element is Extract<CanvasElement, { type: 'text' }> =>
        element.id === 'article' && element.type === 'text'
    )!

    expect(second.draft.doc.elements.filter((element) => element.type === 'math')).toHaveLength(0)
    expect(updated.html).toContain('\\(t\\in[0.05,0.30]\\)')
    expect(updated.html).toContain('\\[\\Delta=3.89\\]')
    expect(updated.html).toContain('<strong>参数：</strong>')
    expect(updated.h).toBeGreaterThan(article.h)
    expect(first.createdElementIds).toEqual([])
    expect(first.changedElementIds).toEqual(['article'])
  })

  it('only removes an old Agent companion after embedding the matching source formula', () => {
    const article = text('article', 100, 100) as Extract<CanvasElement, { type: 'text' }>
    article.html = '<p>质能关系：$E=mc^2$</p>'
    const companion = math('agent-formula', 'E=mc^2') as Extract<CanvasElement, { type: 'math' }>
    companion.agentMeta = {
      planId: 'old-plan',
      role: 'created',
      sourceId: 'article',
      sourceBlockIndex: 0,
      skill: 'formula_companion',
    }
    const manual = math('manual-formula', 'E=mc^2')
    const draft = createCanvasAgentDraft(
      doc([article, companion, manual]),
      'page',
      [],
      [],
      'plan-migrate'
    )
    const result = executeCanvasTool(draft, 'embed_math', {
      elementId: 'article',
      blockIndex: 0,
      latex: 'E=mc^2',
      formulaId: 'agent-formula',
    })

    expect(result.draft.doc.elements.some((element) => element.id === 'agent-formula')).toBe(false)
    expect(result.draft.doc.elements.some((element) => element.id === 'manual-formula')).toBe(true)
    expect(result.deletedElementIds).toEqual(['agent-formula'])
    expect(result.draft.deletedElementIds).toEqual(['agent-formula'])
    expect((result.draft.doc.elements[0] as Extract<CanvasElement, { type: 'text' }>).html).toBe(
      '<p>质能关系：\\(E=mc^2\\)</p>'
    )
  })

  it('repairs a legacy 420px formula with deterministic size and centered placement', () => {
    const source = text('source', 100, 100)
    const legacy = math('formula', 'E=mc^2')
    legacy.x = 900
    legacy.y = 700
    legacy.w = 420
    const draft = createCanvasAgentDraft(doc([source, legacy]), 'page', [], [], 'plan-repair')
    const result = executeCanvasTool(draft, 'layout_math', {
      ids: ['formula'],
      anchors: { formula: 'source' },
    })
    const repaired = result.draft.doc.elements.find((element) => element.id === 'formula')!

    expect(repaired).toMatchObject({ x: 70, y: 216, w: 180, h: 84 })
    expect(repaired.agentMeta).toMatchObject({
      role: 'positioned',
      sourceId: 'source',
      skill: 'formula_companion',
    })
    expect(repaired.x + repaired.w / 2).toBe(source.x + source.w / 2)
  })

  it('uses a locked source as a read-only formula anchor', () => {
    const lockedSource = text('locked-source', 240, 180, true)
    const originalSource = structuredClone(lockedSource)
    const formula = math('formula', 'x^2+y^2=z^2')
    const draft = createCanvasAgentDraft(
      doc([lockedSource, formula]),
      'page',
      [],
      [],
      'plan-locked-anchor'
    )
    const result = executeCanvasTool(draft, 'layout_math', {
      ids: ['formula'],
      anchors: { formula: 'locked-source' },
    })
    const anchored = result.draft.doc.elements.find((element) => element.id === 'formula')!

    expect(result.draft.doc.elements.find((element) => element.id === 'locked-source')).toEqual(
      originalSource
    )
    expect(anchored.agentMeta).toMatchObject({ sourceId: 'locked-source' })
    expect(anchored.x + anchored.w / 2).toBe(lockedSource.x + lockedSource.w / 2)
  })

  it('avoids the visible bounds of rotated objects', () => {
    const source = text('source', 100, 100)
    const rotated = text('rotated', 280, 100)
    rotated.w = 30
    rotated.h = 300
    rotated.rotation = 90
    const draft = createCanvasAgentDraft(doc([source, rotated]), 'page', [], [], 'plan-rotated')
    const result = executeCanvasTool(draft, 'create_math', {
      latex: 'E=mc^2',
      relativeTo: 'source',
      side: 'below',
    })
    const formula = result.draft.doc.elements.find((element) => element.type === 'math')!

    expect(formula.y).toBeGreaterThan(source.y + source.h + 36)
    expect(formula.x + formula.w / 2).toBe(source.x + source.w / 2)
  })

  it('keeps formulas out of handwriting bounds', () => {
    const source = text('source', 100, 100)
    const handwriting = stroke('handwriting', [
      [40, 230, 0.5],
      [280, 260, 0.5],
    ])
    const draft = createCanvasAgentDraft(
      doc([source], [handwriting]),
      'page',
      [],
      [],
      'plan-handwriting'
    )
    const result = executeCanvasTool(draft, 'create_math', {
      latex: 'E=mc^2',
      relativeTo: 'source',
      side: 'below',
    })
    const formula = result.draft.doc.elements.find((element) => element.type === 'math')!

    expect(formula.y).toBeGreaterThan(260)
    expect(formula.x + formula.w / 2).toBe(source.x + source.w / 2)
  })

  it('updates only an existing math block', () => {
    const draft = createCanvasAgentDraft(doc([math('formula', 'x^2')]), 'page', [], [], 'plan-7')
    const result = executeCanvasTool(draft, 'update_math', {
      id: 'formula',
      latex: 'x^2+y^2=z^2',
    })

    expect(result.draft.doc.elements[0]).toMatchObject({ latex: 'x^2+y^2=z^2' })
    expect(draft.doc.elements[0]).toMatchObject({ latex: 'x^2' })
  })

  it('lists stable paragraph references and safely updates exactly one paragraph', () => {
    const source = text('article', 100, 100) as Extract<CanvasElement, { type: 'text' }>
    source.html = '<p>第一段 <strong>重点</strong></p><p>第二段保持不变</p>'
    const draft = createCanvasAgentDraft(doc([source]), 'page', [], [], 'plan-text')
    const segments = canvasTextSegments(draft)

    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({
      elementId: 'article',
      blockIndex: 0,
      tag: 'p',
      text: '第一段 重点',
    })
    expect(canvasInventory(draft)).toContain(`contentHash=${segments[0].contentHash}`)

    const result = executeCanvasTool(draft, 'update_text_segment', {
      elementId: 'article',
      blockIndex: 0,
      contentHash: segments[0].contentHash,
      replacementHtml: '<p>更新后的 <strong onclick="bad()">重点</strong><script>bad()</script></p>',
    })
    const updated = result.draft.doc.elements[0] as Extract<CanvasElement, { type: 'text' }>

    expect(updated.html).toBe('<p>更新后的 <strong>重点</strong></p><p>第二段保持不变</p>')
    expect(result.targetElementIds).toEqual(['article'])
    expect(result.changedElementIds).toEqual(['article'])
    expect(draft.doc.elements[0]).toMatchObject({ html: source.html })
  })

  it('rejects a stale paragraph hash without changing the draft', () => {
    const source = text('article', 100, 100) as Extract<CanvasElement, { type: 'text' }>
    source.html = '<p>原始内容</p><p>其他内容</p>'
    const draft = createCanvasAgentDraft(doc([source]), 'page', [], [], 'plan-stale')

    expect(() =>
      executeCanvasTool(draft, 'update_text_segment', {
        elementId: 'article',
        blockIndex: 0,
        contentHash: '0000000000000000',
        replacementHtml: '不应写入',
      })
    ).toThrow('内容已变化')
    expect(draft.doc.elements[0]).toMatchObject({ html: source.html })
  })
})
