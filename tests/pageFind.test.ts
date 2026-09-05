import { describe, expect, it } from 'vitest'

import { findCanvasMatches, stepMatchIndex } from '@/lib/pageFind'

const searchableElements = [
  {
    label: 'rich text',
    element: { id: 'text-1', type: 'text', content: '<p>Project NeEdLe</p>' },
  },
  {
    label: 'sticky note text',
    element: { id: 'sticky-1', type: 'sticky', content: 'Project NeEdLe' },
  },
  {
    label: 'math LaTeX',
    element: { id: 'math-1', type: 'math', latex: String.raw`\operatorname{NeEdLe}(x)` },
  },
  {
    label: 'code',
    element: { id: 'code-1', type: 'code', code: 'const NeEdLe = true' },
  },
  {
    label: 'shape label',
    element: { id: 'shape-1', type: 'shape', label: 'Project NeEdLe' },
  },
  {
    label: 'file name',
    element: { id: 'file-1', type: 'file', name: 'project-NeEdLe.txt' },
  },
  {
    label: 'image alt text',
    element: { id: 'image-1', type: 'image', alt: 'Project NeEdLe diagram' },
  },
  {
    label: 'PDF file name',
    element: { id: 'pdf-1', type: 'pdf', name: 'project-NeEdLe.pdf' },
  },
] as const

describe('findCanvasMatches', () => {
  it.each(searchableElements)('finds $label case-insensitively', ({ element }) => {
    const doc = { elements: [element] }

    expect(findCanvasMatches(doc, 'needle')).toHaveLength(1)
  })

  it('returns no matches for an empty or whitespace-only query', () => {
    const doc = { elements: searchableElements.map(({ element }) => element) }

    expect(findCanvasMatches(doc, '')).toEqual([])
    expect(findCanvasMatches(doc, '   ')).toEqual([])
  })

  it('returns an empty result without throwing when nothing matches', () => {
    const doc = { elements: searchableElements.map(({ element }) => element) }

    expect(findCanvasMatches(doc, 'not-present-anywhere')).toEqual([])
  })
})

describe('stepMatchIndex', () => {
  it('steps forward and wraps from the last result to the first', () => {
    expect(stepMatchIndex(0, 3, 'next')).toBe(1)
    expect(stepMatchIndex(2, 3, 'next')).toBe(0)
  })

  it('steps backward and wraps from the first result to the last', () => {
    expect(stepMatchIndex(2, 3, 'previous')).toBe(1)
    expect(stepMatchIndex(0, 3, 'previous')).toBe(2)
  })

  it('selects a valid edge when there is no current result or the index is stale', () => {
    expect(stepMatchIndex(-1, 3, 'next')).toBe(0)
    expect(stepMatchIndex(-1, 3, 'previous')).toBe(2)
    expect(stepMatchIndex(8, 3, 'next')).toBe(0)
    expect(stepMatchIndex(8, 3, 'previous')).toBe(2)
  })

  it('uses -1 when there are no results', () => {
    expect(stepMatchIndex(4, 0, 'next')).toBe(-1)
    expect(stepMatchIndex(4, 0, 'previous')).toBe(-1)
  })
})
