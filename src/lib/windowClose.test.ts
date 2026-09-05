import { describe, expect, it, vi } from 'vitest'
import { createCloseRequestController } from './windowClose'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function setup(saveDocument: () => Promise<boolean>) {
  const destroyWindow = vi.fn(async () => undefined)
  const exitApplication = vi.fn(async () => undefined)
  const onBlocked = vi.fn()
  const onSaveFailure = vi.fn()
  const onError = vi.fn()
  const runExclusive = vi.fn(async (operation: () => Promise<boolean>) => ({
    started: true,
    value: await operation(),
  }))
  const controller = createCloseRequestController({
    runExclusive,
    saveDocument,
    destroyWindow,
    exitApplication,
    onBlocked,
    onSaveFailure,
    onError,
  })
  return {
    controller,
    destroyWindow,
    exitApplication,
    onBlocked,
    onSaveFailure,
    onError,
    runExclusive,
  }
}

describe('window close requests', () => {
  it('prevents the native close immediately and destroys the window after saving', async () => {
    const saving = deferred<boolean>()
    const saveDocument = vi.fn(() => saving.promise)
    const { controller, destroyWindow } = setup(saveDocument)
    const event = { preventDefault: vi.fn() }

    const closing = controller.handleCloseRequested(event)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(saveDocument).toHaveBeenCalledOnce()
    expect(destroyWindow).not.toHaveBeenCalled()

    saving.resolve(true)
    await closing

    expect(destroyWindow).toHaveBeenCalledOnce()
  })

  it('prevents repeated close requests while reusing the in-flight save', async () => {
    const saving = deferred<boolean>()
    const saveDocument = vi.fn(() => saving.promise)
    const { controller, destroyWindow, runExclusive } = setup(saveDocument)
    const firstEvent = { preventDefault: vi.fn() }
    const repeatedEvent = { preventDefault: vi.fn() }

    const closing = controller.handleCloseRequested(firstEvent)
    controller.handleCloseRequested(repeatedEvent)

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce()
    expect(repeatedEvent.preventDefault).toHaveBeenCalledOnce()
    expect(runExclusive).toHaveBeenCalledOnce()
    expect(saveDocument).toHaveBeenCalledOnce()

    saving.resolve(true)
    await closing

    expect(destroyWindow).toHaveBeenCalledOnce()
  })

  it('keeps the window open when saving fails', async () => {
    const saveDocument = vi.fn(async () => false)
    const { controller, destroyWindow, onSaveFailure } = setup(saveDocument)
    const event = { preventDefault: vi.fn() }

    await controller.handleCloseRequested(event)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(onSaveFailure).toHaveBeenCalledOnce()
    expect(destroyWindow).not.toHaveBeenCalled()
  })
})
