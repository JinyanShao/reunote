// @vitest-environment jsdom

import { Editor } from '@tiptap/core'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildExtensions, RichText } from './RichText'

describe('RichText mathematics', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.innerHTML = ''
  })

  it('renders inline and display TeX at their stored text positions', async () => {
    await act(async () =>
      root.render(
        <RichText
          html={'<p>前文 \\(E=mc^2\\) 后文</p><p>\\[\\frac{a}{b}\\]</p>'}
          editable={false}
        />
      )
    )

    expect(container.querySelectorAll('.katex')).toHaveLength(2)
    expect(container.querySelector('.jinyan-notes-math-display .katex-display')).not.toBeNull()
    expect(container.textContent).toContain('前文')
    expect(container.textContent).toContain('后文')
  })

  it('round-trips editable TeX source without persisting generated KaTeX markup', () => {
    const html = '<p>前文 \\(E=mc^2\\) 后文</p>'
    const editor = new Editor({
      extensions: buildExtensions(''),
      content: html,
    })

    expect(editor.getHTML()).toBe(html)
    expect(editor.getHTML()).not.toContain('class="katex"')
    editor.destroy()
  })
})
