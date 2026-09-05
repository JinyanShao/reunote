import { describe, expect, it } from 'vitest'
import { parseLatexInput } from './latex'

describe('parseLatexInput', () => {
  it.each([
    ['$$\\frac{a}{b}$$', '\\frac{a}{b}'],
    ['\\[e^{i\\pi}+1=0\\]', 'e^{i\\pi}+1=0'],
    ['```latex\n\\sum_{i=1}^n i\n```', '\\sum_{i=1}^n i'],
    ['x^2 + y^2 = z^2', 'x^2 + y^2 = z^2'],
  ])('recognizes %s', (input, expected) => {
    expect(parseLatexInput(input)).toBe(expected)
  })

  it.each(['普通会议记录', 'const x = y^2;', 'https://example.com/a_b'])('keeps normal text: %s', (input) => {
    expect(parseLatexInput(input)).toBeNull()
  })
})
