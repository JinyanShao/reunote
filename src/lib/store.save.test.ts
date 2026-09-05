import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasDoc } from './types'

vi.mock('./api', () => ({
  savePage: vi.fn(),
}))

import * as api from './api'
import { useApp } from './store'

const emptyDoc: CanvasDoc = { version: 1, background: 'grid', elements: [], strokes: [] }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('forced store saves', () => {
  let initialState: ReturnType<typeof useApp.getState>

  beforeEach(() => {
    initialState = useApp.getState()
    vi.mocked(api.savePage).mockReset()
    useApp.setState({
      pageId: 'page-1',
      title: '第一版',
      doc: emptyDoc,
      viewport: { x: 0, y: 0, zoom: 1 },
      pages: [],
      dirty: true,
      saving: false,
      rev: 1,
    })
  })

  afterEach(() => {
    useApp.setState(initialState, true)
  })

  it('does not resolve until edits made during the first write are also persisted', async () => {
    const first = deferred<number>()
    const second = deferred<number>()
    vi.mocked(api.savePage)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    let settled = false
    const saving = useApp
      .getState()
      .save(true)
      .then((result) => {
        settled = true
        return result
      })
    await Promise.resolve()

    expect(api.savePage).toHaveBeenCalledTimes(1)
    useApp.setState({ title: '第二版', dirty: true, rev: 2 })
    first.resolve(100)
    await first.promise
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(api.savePage).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.savePage).mock.calls[1][0].title).toBe('第二版')

    second.resolve(200)
    await expect(saving).resolves.toBe(true)
    expect(useApp.getState().dirty).toBe(false)
    expect(useApp.getState().lastSaved).toBe(200)
  })
})
