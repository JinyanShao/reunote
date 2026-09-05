import { describe, expect, it } from 'vitest'
import { buildMindMapDocument, normalizeMindMapPlan, type MindMapPlan } from './mindMap'

function idFactory() {
  let next = 0
  return () => `element-${++next}`
}

function overlaps(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

describe('mind-map normalization and layout', () => {
  it('removes a duplicate model root and repairs cycles', () => {
    const normalized = normalizeMindMapPlan({
      root: '量子计算',
      nodes: [
        { id: 'duplicate-root', label: '量子计算', parent: null },
        { id: 'hardware', label: '硬件路线', parent: 'duplicate-root' },
        { id: 'ion', label: '离子阱', parent: 'hardware' },
        { id: 'cycle-a', label: '纠错', parent: 'cycle-b' },
        { id: 'cycle-b', label: '容错', parent: 'cycle-a' },
      ],
    })

    expect(normalized.label).toBe('量子计算')
    expect(normalized.children.map((node) => node.label)).toEqual(
      expect.arrayContaining(['硬件路线', '纠错'])
    )
    expect(normalized.children.find((node) => node.label === '硬件路线')?.children[0]?.label).toBe(
      '离子阱'
    )
    expect(normalized.children.find((node) => node.label === '纠错')?.children[0]?.label).toBe(
      '容错'
    )
  })

  it('creates a balanced two-sided map with curves and no node collisions', () => {
    const plan: MindMapPlan = {
      root: '研究计划',
      nodes: [
        { id: 'a', label: '问题定义', parent: null },
        { id: 'a1', label: '研究边界', parent: 'a' },
        { id: 'a2', label: '核心假设', parent: 'a' },
        { id: 'b', label: '实验设计', parent: null },
        { id: 'b1', label: '样本选择', parent: 'b' },
        { id: 'b2', label: '指标体系', parent: 'b' },
        { id: 'c', label: '结果分析', parent: null },
        { id: 'c1', label: '统计检验', parent: 'c' },
        { id: 'd', label: '后续工作', parent: null },
        { id: 'd1', label: '迭代方向', parent: 'd' },
      ],
    }

    const result = buildMindMapDocument(plan, idFactory())
    const nodes = result.doc.elements.filter(
      (element) => element.type === 'shape' && element.visualStyle !== 'mind-connector'
    )
    const curves = result.doc.elements.filter(
      (element) => element.type === 'shape' && element.shape === 'curve'
    )
    const root = nodes.find(
      (element) => element.type === 'shape' && element.visualStyle === 'mind-root'
    )!

    expect(result.nodeCount).toBe(11)
    expect(curves).toHaveLength(result.nodeCount - 1)
    expect(nodes.some((node) => node.x + node.w < root.x)).toBe(true)
    expect(nodes.some((node) => node.x > root.x + root.w)).toBe(true)
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        expect(overlaps(nodes[i], nodes[j])).toBe(false)
      }
    }
  })
})
