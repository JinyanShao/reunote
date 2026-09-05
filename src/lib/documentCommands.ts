import { getActiveEditor, getActiveEditorHistory } from './activeEditor'
import * as api from './api'
import { useCanvasAgent } from './agent/store'
import { useApp } from './store'

function mutationsLocked() {
  const agent = useCanvasAgent.getState()
  return agent.running || agent.finalizing || useApp.getState().documentLocked
}

export async function runExclusiveDocumentOperation<T>(operation: () => Promise<T>) {
  if (mutationsLocked()) return { started: false as const, value: undefined }
  const editor = getActiveEditor()
  if (editor && !editor.isDestroyed) editor.commands.blur()
  const active = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement)
  active?.blur?.()
  // Commit any composition/update triggered by blur before blocking document mutations.
  useApp.setState({ documentLocked: true })
  try {
    return { started: true as const, value: await operation() }
  } finally {
    useApp.setState({ documentLocked: false })
  }
}

function activeInput() {
  if (typeof document === 'undefined') return null
  const active = document.activeElement as HTMLElement | null
  return active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA' ? active : null
}

export function canUndoDocument() {
  if (mutationsLocked()) return false
  const editorHistory = getActiveEditorHistory()
  if (editorHistory.active) return editorHistory.canUndo
  if (activeInput()) return document.queryCommandEnabled?.('undo') ?? false
  return useApp.getState().past.length > 0
}

export function canRedoDocument() {
  if (mutationsLocked()) return false
  const editorHistory = getActiveEditorHistory()
  if (editorHistory.active) return editorHistory.canRedo
  if (activeInput()) return document.queryCommandEnabled?.('redo') ?? false
  return useApp.getState().future.length > 0
}

export function undoDocument() {
  if (mutationsLocked()) return false
  const editor = getActiveEditor()
  if (editor && !editor.isDestroyed) return editor.commands.undo()
  if (activeInput()) return document.execCommand?.('undo') ?? false
  const store = useApp.getState()
  if (store.past.length === 0) return false
  store.undo()
  return true
}

export function redoDocument() {
  if (mutationsLocked()) return false
  const editor = getActiveEditor()
  if (editor && !editor.isDestroyed) return editor.commands.redo()
  if (activeInput()) return document.execCommand?.('redo') ?? false
  const store = useApp.getState()
  if (store.future.length === 0) return false
  store.redo()
  return true
}

export async function saveCurrentDocument() {
  const store = useApp.getState()
  if (!store.pageId) return true
  return store.save(true)
}

export async function duplicatePageSafely(pageId?: string | null) {
  const result = await runExclusiveDocumentOperation(async () => {
    const before = useApp.getState()
    const targetId = pageId ?? before.pageId
    if (!targetId) return null
    if (targetId === before.pageId && !(await before.save(true))) return null

    const duplicateId = await api.duplicatePage(targetId)
    const current = useApp.getState()
    if (current.sectionId) {
      useApp.setState({ pages: await api.listPages(current.sectionId) })
    }
    await useApp.getState().openPage(duplicateId)
    return duplicateId
  })
  return result.started ? result.value : null
}
