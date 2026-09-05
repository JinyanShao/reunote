export type Cmd =
  | { type: 'zoom'; factor: number }
  | { type: 'zoom-set'; zoom: number }
  | { type: 'zoom-fit' }
  | { type: 'zoom-reset' }
  | { type: 'insert-image' }
  | { type: 'insert-file' }
  | { type: 'insert-math'; latex?: string }
  | { type: 'insert-code' }
  | { type: 'insert-text' }
  | { type: 'insert-sticky' }
  | { type: 'insert-pdf' }
  | { type: 'insert-ai-text'; text: string }
  | { type: 'export-png' }
  | { type: 'export-md' }
  | { type: 'export-pdf' }
  | { type: 'import-md' }
  | { type: 'select-all' }
  | { type: 'focus-search' }
  | { type: 'find-next' }
  | { type: 'find-previous' }
  | { type: 'reveal-element'; id: string }
  | { type: 'reveal-elements'; ids: string[] }

const EVENT = 'jinyan-notes:cmd'

export function emit(cmd: Cmd) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: cmd }))
}

export function onCmd(handler: (cmd: Cmd) => void) {
  const fn = (e: Event) => handler((e as CustomEvent<Cmd>).detail)
  window.addEventListener(EVENT, fn)
  return () => window.removeEventListener(EVENT, fn)
}
