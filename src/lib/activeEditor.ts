import type { Editor } from '@tiptap/react'

let current: Editor | null = null
const listeners = new Set<() => void>()

export interface ActiveEditorHistory {
  active: boolean
  canUndo: boolean
  canRedo: boolean
}

const EMPTY_HISTORY: ActiveEditorHistory = { active: false, canUndo: false, canRedo: false }
let historySnapshot = EMPTY_HISTORY

function readHistory(editor: Editor | null): ActiveEditorHistory {
  if (!editor || editor.isDestroyed) return EMPTY_HISTORY
  return {
    active: true,
    canUndo: editor.can().undo(),
    canRedo: editor.can().redo(),
  }
}

function notifyHistoryChanged() {
  const next = readHistory(current)
  if (
    next.active === historySnapshot.active &&
    next.canUndo === historySnapshot.canUndo &&
    next.canRedo === historySnapshot.canRedo
  ) {
    return
  }
  historySnapshot = next
  listeners.forEach((listener) => listener())
}

function detachHistoryListener(editor: Editor | null) {
  editor?.off('transaction', notifyHistoryChanged)
}

function attachHistoryListener(editor: Editor | null) {
  editor?.on('transaction', notifyHistoryChanged)
}

interface Remembered {
  /** 选区所属的编辑器实例——绝不能把坐标写进别的编辑器 */
  editor: Editor
  from: number
  to: number
  text: string
}

let remembered: Remembered | null = null

export function setActiveEditor(editor: Editor | null) {
  if (current === editor) {
    notifyHistoryChanged()
    return
  }
  detachHistoryListener(current)
  current = editor
  attachHistoryListener(current)
  notifyHistoryChanged()
}

export function clearActiveEditor(editor: Editor) {
  if (current === editor) setActiveEditor(null)
}

export function getActiveEditor() {
  if (current?.isDestroyed) setActiveEditor(null)
  return current
}

export function subscribeActiveEditorHistory(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getActiveEditorHistory() {
  return historySnapshot
}

/** 记住最近一次有效的文字选区，避免点击面板按钮后选区丢失 */
export function rememberSelection() {
  const ed = current
  if (!ed || ed.isDestroyed) return
  const { from, to, empty } = ed.state.selection
  if (empty) return
  const text = ed.state.doc.textBetween(from, to, '\n', '\n').trim()
  if (!text) return
  remembered = { editor: ed, from, to, text }
}

export function takeSelectionText(): string {
  const live = window.getSelection()?.toString().trim() ?? ''
  if (live) return live
  return remembered?.text ?? ''
}

/**
 * 把 AI 结果写回原选区；成功返回 true。
 * 只在「记忆时的那个编辑器」上执行，且校验坐标仍在文档范围内，
 * 防止在 A 块选字、B 块获得焦点后把 B 块的内容毁掉。
 */
export function replaceSelection(html: string): boolean {
  const r = remembered
  if (!r) return false
  const ed = r.editor
  if (ed.isDestroyed) {
    remembered = null
    return false
  }
  const docSize = ed.state.doc.content.size
  if (r.from > docSize || r.to > docSize || r.from >= r.to) {
    remembered = null
    return false
  }
  // 内容若在记忆后被改过，坐标已不可信，宁可失败也不误删
  const nowText = ed.state.doc.textBetween(r.from, r.to, '\n', '\n').trim()
  if (nowText !== r.text) {
    remembered = null
    return false
  }
  try {
    ed.chain()
      .focus()
      .setTextSelection({ from: r.from, to: r.to })
      .deleteSelection()
      .insertContent(html)
      .run()
    remembered = null
    return true
  } catch {
    remembered = null
    return false
  }
}

export function hasRememberedSelection() {
  return !!remembered && !remembered.editor.isDestroyed
}
