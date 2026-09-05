import { describe, expect, it } from 'vitest'
import { inferCanvasAgentSkill } from './layoutSkills'

describe('canvas Agent skill routing', () => {
  it.each([
    ['把 LaTeX 代码转成真实公式', 'formula_companion'],
    ['按主题分组为看板', 'kanban_board'],
    ['整理成项目时间线', 'timeline'],
    ['排成两栏阅读布局', 'reading_columns'],
    ['统一尺寸并网格排版', 'balanced_grid'],
  ] as const)('routes %s to %s', (prompt, expected) => {
    expect(inferCanvasAgentSkill(prompt)).toBe(expected)
  })
})
