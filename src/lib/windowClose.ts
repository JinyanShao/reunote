export interface CloseRequestEventLike {
  preventDefault: () => void
}

interface ExclusiveCloseResult {
  started: boolean
  value?: boolean
}

interface CloseRequestControllerOptions {
  runExclusive: (operation: () => Promise<boolean>) => Promise<ExclusiveCloseResult>
  saveDocument: () => Promise<boolean>
  destroyWindow: () => Promise<void>
  exitApplication: () => Promise<void>
  onBlocked: () => void
  onSaveFailure: () => void
  onError: (error: unknown) => void
}

export function createCloseRequestController(options: CloseRequestControllerOptions) {
  let closing = false

  const persistAndClose = async (exitApplication: boolean) => {
    if (closing) return
    closing = true
    try {
      const result = await options.runExclusive(async () => {
        const saved = await options.saveDocument()
        if (!saved) return false
        if (exitApplication) await options.exitApplication()
        else await options.destroyWindow()
        return true
      })
      if (!result.started) {
        closing = false
        options.onBlocked()
        return
      }
      if (!result.value) {
        closing = false
        options.onSaveFailure()
      }
    } catch (error) {
      closing = false
      options.onError(error)
    }
  }

  return {
    handleCloseRequested(event: CloseRequestEventLike) {
      event.preventDefault()
      if (closing) return
      return persistAndClose(false)
    },
    requestAppExit() {
      return persistAndClose(true)
    },
  }
}
