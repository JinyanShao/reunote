// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TextPromptHost, useTextPrompt } from './ui'

function Harness() {
  const promptText = useTextPrompt()
  const [result, setResult] = useState('pending')
  return (
    <>
      <button
        onClick={async () => {
          const value = await promptText({
            title: '重命名笔记本',
            label: '笔记本名称',
            value: '旧名称',
          })
          setResult(value ?? 'cancelled')
        }}
      >
        打开
      </button>
      <output>{result}</output>
    </>
  )
}

describe('TextPromptHost', () => {
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

  it('shows an app dialog and resolves the submitted value', async () => {
    await act(async () => {
      root.render(
        <TextPromptHost>
          <Harness />
        </TextPromptHost>
      )
    })

    await act(async () => {
      container.querySelector('button')!.click()
    })

    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    const input = document.querySelector<HTMLInputElement>('input[aria-label="笔记本名称"]')!
    expect(input.value).toBe('旧名称')

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, '新名称')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      document
        .querySelector<HTMLFormElement>('#jinyan-notes-text-prompt')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(container.querySelector('output')?.textContent).toBe('新名称')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
