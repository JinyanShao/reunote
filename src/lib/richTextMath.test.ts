// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  embedLatexInRichTextHtml,
  equivalentRichTextLatex,
  normalizeAllRichTextMathHtml,
  renderRichTextMathHtml,
  richTextContainsLatex,
  scanRichTextMath,
  scanRichTextMathHtml,
} from './richTextMath'

describe('rich text mathematics', () => {
  it('recognizes inline and display delimiters but skips escaped dollars', () => {
    const matches = scanRichTextMath(
      String.raw`price \$5, $a+b$, $$E=mc^2$$, \(x^2\), \[\frac{a}{b}\]`
    )

    expect(matches.map((match) => [match.latex, match.display])).toEqual([
      ['a+b', false],
      ['E=mc^2', true],
      ['x^2', false],
      ['\\frac{a}{b}', true],
    ])
  })

  it('embeds repeated formulas one occurrence at a time without losing markup', () => {
    const html = '<p><strong>关系：</strong>$x^2+y^2=z^2$，再次使用 $x^2+y^2=z^2$。</p>'
    const first = embedLatexInRichTextHtml(html, 'x^2+y^2=z^2', { blockIndex: 0 })
    const second = embedLatexInRichTextHtml(first.html, 'x^2+y^2=z^2', { blockIndex: 0 })

    expect(first.status).toBe('embedded')
    expect(first.html).toContain('<strong>关系：</strong>\\(x^2+y^2=z^2\\)')
    expect(first.html).toContain('$x^2+y^2=z^2$')
    expect(second.html.match(/\\\(x\^2\+y\^2=z\^2\\\)/g)).toHaveLength(2)
    expect(second.html).not.toContain('$x^2+y^2=z^2$')
  })

  it('keeps prose formulas inline and standalone formulas in display flow', () => {
    const prose = embedLatexInRichTextHtml('<p>能量关系 E=mc^2 很重要。</p>', 'E=mc^2', {
      blockIndex: 0,
      display: true,
    })
    const standalone = embedLatexInRichTextHtml('<p>E=mc^2</p>', 'E=mc^2', {
      blockIndex: 0,
      display: true,
    })

    expect(prose.html).toBe('<p>能量关系 \\(E=mc^2\\) 很重要。</p>')
    expect(prose.display).toBe(false)
    expect(standalone.html).toBe('<p>\\[E=mc^2\\]</p>')
    expect(standalone.display).toBe(true)
  })

  it('renders formulas with KaTeX in place while leaving code untouched', () => {
    const rendered = renderRichTextMathHtml(
      '<p>行内 $a+b$。</p><p>$$E=mc^2$$</p><pre><code>$not_math$</code></pre>'
    )
    const doc = new DOMParser().parseFromString(rendered, 'text/html')

    expect(doc.querySelectorAll('.katex')).toHaveLength(2)
    expect(doc.querySelector('.jinyan-notes-math-display .katex-display')).not.toBeNull()
    expect(doc.querySelector('pre')?.textContent).toBe('$not_math$')
    expect(richTextContainsLatex('<p>\\(a+b\\)</p>', 'a+b')).toBe(true)
  })

  it('scans, normalizes, and renders inline and multiline formulas across br nodes', () => {
    const html =
      '<p>行内 <span>$a</span><em>+b$</em>。<br>第一式：<br>$$<br>\\frac{a}{b}=c<br>$$<br>' +
      '第二式：<br>\\[<br>x^2+y^2=z^2<br>\\]</p>' +
      '<pre><code>$$<br>not_math<br>$$</code></pre>'

    expect(
      scanRichTextMathHtml(html).map((match) => [match.latex, match.display, match.blockIndex])
    ).toEqual([
      ['a+b', false, 0],
      ['\\frac{a}{b}=c', true, 0],
      ['x^2+y^2=z^2', true, 0],
    ])
    expect(richTextContainsLatex(html, '\\frac{a}{b}=c')).toBe(true)

    const first = normalizeAllRichTextMathHtml(html)
    expect(first).toMatchObject({ total: 3, normalized: 2 })
    expect(first.html).toContain('\\(a+b\\)')
    expect(first.html).toContain('\\[\\frac{a}{b}=c\\]')
    expect(first.html).toContain('\\[<br>x^2+y^2=z^2<br>\\]')
    expect(first.html).toContain('<pre><code>$$<br>not_math<br>$$</code></pre>')

    const second = normalizeAllRichTextMathHtml(first.html)
    expect(second).toEqual({ html: first.html, total: 3, normalized: 0 })

    const rendered = new DOMParser().parseFromString(
      renderRichTextMathHtml(first.html),
      'text/html'
    )
    expect(rendered.querySelectorAll('.katex')).toHaveLength(3)
    expect(rendered.querySelectorAll('.jinyan-notes-math-display')).toHaveLength(2)
  })

  it('embeds a display formula spanning br-separated text nodes', () => {
    const result = embedLatexInRichTextHtml(
      '<p>前文<br>$$<br>\\sum_{i=1}^n i<br>$$<br>后文</p>',
      '\\sum_{i=1}^n i',
      { blockIndex: 0, display: true }
    )

    expect(result).toMatchObject({ status: 'embedded', display: true, blockIndex: 0 })
    expect(result.html).toContain('\\[\\sum_{i=1}^n i\\]')
    expect(result.html).not.toContain('$$')
  })

  it('matches conservative TeX spelling variants for legacy companion migration', () => {
    const sourceHamiltonian = String.raw`\mathcal H^{(c)}_{\rm eff}=J\,\boldsymbol\tau_i\cdot\boldsymbol\tau_j+K\,\tau_i^z\tau_j^z+\Gamma\left(\tau_i^x\tau_j^y+\tau_i^y\tau_j^x\right)`
    const companionHamiltonian = String.raw`\mathcal H_{ij}^{(z)}=J\,\boldsymbol{\tau}_i\!\cdot\!\boldsymbol{\tau}_j+K\,\tau_i^z\tau_j^z+\Gamma\left(\tau_i^x\tau_j^y+\tau_i^y\tau_j^x\right)`
    const sourceProjector = String.raw`n_\gamma=|\gamma\rangle\langle\gamma|,\qquad q_{\gamma\gamma'}=-|\gamma\rangle\langle\gamma'|\quad(\gamma\neq\gamma')`
    const companionProjector = String.raw`n_{\gamma}=\lvert\gamma\rangle\langle\gamma\rvert,\qquad q_{\gamma\gamma'}=-\lvert\gamma\rangle\langle\gamma'\rvert\quad\left(\gamma\ne\gamma'\right)`

    expect(equivalentRichTextLatex(sourceHamiltonian, companionHamiltonian)).toBe(true)
    expect(equivalentRichTextLatex(sourceProjector, companionProjector)).toBe(true)
    expect(equivalentRichTextLatex('K=0', 'J=0')).toBe(false)

    const html = `<p>$$<br>${sourceHamiltonian}<br>$$</p>`
    expect(richTextContainsLatex(html, companionHamiltonian)).toBe(true)
  })
})
