import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { docToPlainText, useApp } from './lib/store'
import * as api from './lib/api'
import { emit, onCmd } from './lib/bus'
import {
  docToMarkdown,
  exportPng,
  exportRaster,
  insertFileData,
  insertFiles,
  insertImageData,
  insertPdfBase64,
  jpegToPdfBase64,
  markdownToElements,
} from './lib/exchange'
import { downloadFilename, readFileAsBase64 } from './lib/utils'
import { Sidebar } from './components/Sidebar'
import { PageList } from './components/PageList'
import { TopBar } from './components/TopBar'
import { CanvasStage } from './components/canvas/CanvasStage'
import { Toolbar } from './components/canvas/Toolbar'
import { SearchPalette } from './components/SearchPalette'
import { PageFindBar } from './components/PageFindBar'
import { SidePanel } from './components/SidePanel'
import { SettingsDialog } from './components/SettingsDialog'
import { AIPanel } from './components/ai/AIPanel'
import { ShortcutsDialog } from './components/ShortcutsDialog'
import { Spinner, TextPromptHost, ToastHost, useToast } from './components/ui'
import { suggestTitle } from './lib/aiActions'
import { parseLatexInput } from './lib/latex'
import { hasTauri } from './lib/mockBackend'
import { createCloseRequestController } from './lib/windowClose'
import {
  duplicatePageSafely,
  redoDocument,
  runExclusiveDocumentOperation,
  saveCurrentDocument,
  undoDocument,
} from './lib/documentCommands'

export default function App() {
  return (
    <ToastHost>
      <TextPromptHost>
        <Shell />
      </TextPromptHost>
    </ToastHost>
  )
}

function Shell() {
  const ready = useApp((s) => s.ready)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const settings = useApp((s) => s.settings)
  const pageId = useApp((s) => s.pageId)
  const documentLocked = useApp((s) => s.documentLocked)
  const store = useApp
  const toast = useToast()

  const [dropping, setDropping] = useState(false)
  const bootRef = useRef(false)

  // ───────── 启动 ─────────
  useEffect(() => {
    if (bootRef.current) return
    bootRef.current = true
    void store
      .getState()
      .bootstrap()
      .catch((e) => {
        console.error(e)
        toast(`初始化失败：${e instanceof Error ? e.message : String(e)}`, 'error')
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ───────── 主题 ─────────
  useEffect(() => {
    const apply = () => {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      const dark = settings.theme === 'dark' || (settings.theme === 'system' && prefersDark)
      document.documentElement.classList.toggle('dark', dark)
    }
    apply()
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [settings.theme])

  // ───────── 定时保存与原生关闭保护 ─────────
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (store.getState().dirty) void store.getState().save()
    }, 15000)
    return () => window.clearInterval(timer)
  }, [store])

  useEffect(() => {
    if (!hasTauri()) return
    let unlistenClose: (() => void) | undefined
    let unlistenExit: (() => void) | undefined
    let disposed = false
    const appWindow = getCurrentWindow()
    const closeController = createCloseRequestController({
      runExclusive: runExclusiveDocumentOperation,
      saveDocument: saveCurrentDocument,
      destroyWindow: () => appWindow.destroy(),
      exitApplication: api.completeAppExit,
      onBlocked: () => toast('另一项文档操作尚未完成，应用仍保持打开', 'error'),
      onSaveFailure: () => toast('保存失败，应用仍保持打开', 'error'),
      onError: (error) => toast(error instanceof Error ? error.message : String(error), 'error'),
    })

    const registerListeners = async () => {
      const closeDispose = await appWindow.onCloseRequested((event) => {
        void closeController.handleCloseRequested(event)
      })
      if (disposed) closeDispose()
      else unlistenClose = closeDispose

      const exitDispose = await listen('app-exit-requested', () => {
        void closeController.requestAppExit()
      })
      if (disposed) exitDispose()
      else unlistenExit = exitDispose

      if (!disposed && (await api.isExitRequestPending())) {
        void closeController.requestAppExit()
      }
    }
    void registerListeners().catch((error) => {
      if (!disposed) toast(`退出保护初始化失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    })
    return () => {
      disposed = true
      unlistenClose?.()
      unlistenExit?.()
    }
  }, [toast])

  // ───────── 自动标题：未命名页面写够内容后，用 AI 起一个标题（每页只试一次） ─────────
  const titledRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!pageId || !settings.autoTitle) return
    if (settings.aiProfiles.length === 0) return
    if (titledRef.current.has(pageId)) return

    const timer = window.setTimeout(async () => {
      const s = store.getState()
      if (s.pageId !== pageId) return
      if (s.title && s.title !== '未命名页面') return
      if (docToPlainText(s.doc).trim().length < 40) return
      titledRef.current.add(pageId)
      try {
        const t = await suggestTitle(s.doc)
        if (t && store.getState().pageId === pageId) {
          store.getState().setTitle(t)
          await store.getState().save(true)
        }
      } catch {
        /* 服务不可用时静默跳过 */
      }
    }, 10000)
    return () => window.clearTimeout(timer)
  }, [pageId, settings.autoTitle, settings.aiProfiles.length, store])

  // ───────── 导出 ─────────
  const handleExport = useCallback(
    async (kind: 'md' | 'png' | 'pdf' | 'backup') => {
      if (!(await saveCurrentDocument())) {
        toast('当前页面保存失败，已取消导出', 'error')
        return
      }
      const s = store.getState()

      try {
        if (kind === 'md') {
          const md = docToMarkdown(s.doc, s.title)
          const path = await saveDialog({
            title: '导出 Markdown',
            defaultPath: downloadFilename(s.title, 'md'),
            filters: [{ name: 'Markdown', extensions: ['md'] }],
          })
          if (!path) return
          await api.writeFileText(path, md)
          toast('已导出 Markdown', 'success')
          return
        }

        if (kind === 'png') {
          toast('正在生成图片…')
          const b64 = await exportPng(2)
          if (!b64) {
            toast('图片生成失败，可改用「打印 / 存为 PDF」', 'error')
            return
          }
          const path = await saveDialog({
            title: '导出图片',
            defaultPath: downloadFilename(s.title, 'png'),
            filters: [{ name: 'PNG 图片', extensions: ['png'] }],
          })
          if (!path) return
          await api.writeFileBase64(path, b64)
          toast('已导出图片', 'success')
          return
        }

        if (kind === 'pdf') {
          toast('正在生成 PDF…')
          const raster = await exportRaster(2, 'image/jpeg')
          if (!raster) {
            toast('PDF 生成失败', 'error')
            return
          }
          const pdf = jpegToPdfBase64(raster.base64, raster.w, raster.h)
          const path = await saveDialog({
            title: '导出 PDF',
            defaultPath: downloadFilename(s.title, 'pdf'),
            filters: [{ name: 'PDF', extensions: ['pdf'] }],
          })
          if (!path) return
          await api.writeFileBase64(path, pdf)
          toast('已导出 PDF', 'success')
          return
        }

        if (kind === 'backup') {
          const path = await saveDialog({
            title: '备份笔记库',
            defaultPath: `reunote备份-${new Date().toISOString().slice(0, 10)}.reunotebak`,
            filters: [{ name: 'reunote备份', extensions: ['reunotebak'] }],
          })
          if (!path) return
          await api.backupExport(path, true)
          toast('备份完成', 'success')
        }
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), 'error')
      }
    },
    [store, toast]
  )

  // ───────── 插入 ─────────
  const insertImage = useCallback(async () => {
    const picked = await openDialog({
      title: '插入图片',
      multiple: true,
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'] }],
    })
    if (!picked) return
    const paths = Array.isArray(picked) ? picked : [picked]
    for (const p of paths) {
      const b64 = await api.readFileBase64(p)
      await insertImageData(p.split('/').pop() ?? 'image.png', b64)
    }
  }, [])

  const insertFile = useCallback(async () => {
    const picked = await openDialog({ title: '插入文件', multiple: true })
    if (!picked) return
    const paths = Array.isArray(picked) ? picked : [picked]
    for (const p of paths) {
      const name = p.split('/').pop() ?? 'file'
      const b64 = await api.readFileBase64(p)
      if (name.toLowerCase().endsWith('.pdf')) {
        toast('正在解析 PDF…')
        const n = await insertPdfBase64(name, b64)
        toast(`已导入 ${n} 页，可直接用画笔批注`, 'success')
      } else if (/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name)) {
        await insertImageData(name, b64)
      } else {
        await insertFileData(name, b64, '')
      }
    }
  }, [toast])

  const importMarkdown = useCallback(async () => {
    const picked = await openDialog({
      title: '导入 Markdown',
      multiple: true,
      filters: [{ name: 'Markdown / 文本', extensions: ['md', 'markdown', 'txt'] }],
    })
    if (!picked) return
    const paths = Array.isArray(picked) ? picked : [picked]
    const s = store.getState()
    if (!s.sectionId) {
      toast('请先选择一个分区', 'error')
      return
    }
    for (const p of paths) {
      const text = await api.readFileText(p)
      const name = (p.split('/').pop() ?? '导入').replace(/\.(md|markdown|txt)$/i, '')
      const firstHeading = /^#\s+(.+)$/m.exec(text)
      const title = firstHeading ? firstHeading[1].trim() : name
      const id = await s.newPage(title)
      if (!id) continue
      store.getState().updateDoc((d) => {
        d.elements = markdownToElements(text)
      })
      await store.getState().save(true)
    }
    toast(`已导入 ${paths.length} 个文件`, 'success')
  }, [store, toast])

  const restoreBackup = useCallback(async () => {
    const picked = await openDialog({
      title: '选择备份文件',
      multiple: false,
      filters: [{ name: '笔记备份', extensions: ['reunotebak', 'jinyanbak', 'json'] }],
    })
    if (!picked || Array.isArray(picked)) return
    if (!window.confirm('从备份恢复会覆盖同 ID 的内容，确定继续？')) return
    try {
      const result = await runExclusiveDocumentOperation(async () => {
        if (!(await saveCurrentDocument())) return null
        const count = await api.backupImport(picked)
        await store.getState().bootstrap()
        return count
      })
      if (!result.started) {
        toast('另一项文档操作尚未完成，已取消恢复', 'error')
      } else if (result.value === null) {
        toast('当前页面保存失败，已取消恢复', 'error')
      } else {
        toast(`已恢复 ${result.value} 条记录`, 'success')
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    }
  }, [store, toast])

  // ───────── 菜单与快捷键 ─────────
  useEffect(() => {
    if (!hasTauri()) return
    const unlisten = listen<string>('menu-action', async (e) => {
      const id = e.payload
      const s = store.getState()
      if (s.documentLocked) return
      switch (id) {
        case 'settings':
          s.setUI({ settingsOpen: true })
          break
        case 'new-page':
          await s.newPage()
          break
        case 'new-section':
          await s.newSection()
          break
        case 'new-notebook':
          await s.newNotebook()
          break
        case 'save-page': {
          const saved = await saveCurrentDocument()
          toast(saved ? '已保存' : '保存失败，请稍后重试', saved ? 'success' : 'error')
          break
        }
        case 'duplicate-page': {
          if (!s.pageId) break
          try {
            const duplicateId = await duplicatePageSafely(s.pageId)
            toast(
              duplicateId ? '已创建并打开页面副本' : '无法创建副本',
              duplicateId ? 'success' : 'error'
            )
          } catch (error) {
            toast(error instanceof Error ? error.message : String(error), 'error')
          }
          break
        }
        case 'document-undo':
          undoDocument()
          break
        case 'document-redo':
          redoDocument()
          break
        case 'search':
          s.setUI({ searchOpen: true })
          break
        case 'find-in-page':
          s.setUI({ findOpen: true })
          break
        case 'find-next':
          s.setUI({ findOpen: true })
          emit({ type: 'find-next' })
          break
        case 'find-previous':
          s.setUI({ findOpen: true })
          emit({ type: 'find-previous' })
          break
        case 'toggle-sidebar':
          s.setUI({ sidebarOpen: !s.sidebarOpen })
          break
        case 'toggle-ai':
          s.setUI({ aiOpen: !s.aiOpen })
          break
        case 'toggle-theme':
          s.patchSettings({
            theme: document.documentElement.classList.contains('dark') ? 'light' : 'dark',
          })
          break
        case 'zoom-in':
          emit({ type: 'zoom', factor: 1.2 })
          break
        case 'zoom-out':
          emit({ type: 'zoom', factor: 1 / 1.2 })
          break
        case 'zoom-reset':
          emit({ type: 'zoom-reset' })
          break
        case 'zoom-fit':
          emit({ type: 'zoom-fit' })
          break
        case 'export-md':
          await handleExport('md')
          break
        case 'export-png':
          await handleExport('png')
          break
        case 'export-pdf':
          await handleExport('pdf')
          break
        case 'backup-export':
          await handleExport('backup')
          break
        case 'import-md':
          await importMarkdown()
          break
        case 'import-pdf':
          await insertFile()
          break
        case 'shortcuts':
          s.setUI({ shortcutsOpen: true })
          break
        case 'open-data-dir':
          await api.openDataDir()
          break
        case 'backup-import':
          await restoreBackup()
          break
        default:
          break
      }
    })
    return () => {
      void unlisten.then((f) => f())
    }
  }, [store, toast, handleExport, importMarkdown, insertFile, restoreBackup])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.defaultPrevented) return
      const s = store.getState()
      if (s.documentLocked) return
      const k = e.key.toLowerCase()
      if (k === 'k') {
        e.preventDefault()
        s.setUI({ searchOpen: !s.searchOpen })
      } else if (k === 'f') {
        e.preventDefault()
        s.setUI({ findOpen: true })
      } else if (k === 'g') {
        e.preventDefault()
        s.setUI({ findOpen: true })
        emit({ type: e.shiftKey ? 'find-previous' : 'find-next' })
      } else if (k === 'j') {
        e.preventDefault()
        s.setUI({ aiOpen: !s.aiOpen })
      } else if (k === '\\') {
        e.preventDefault()
        s.setUI({ sidebarOpen: !s.sidebarOpen })
      } else if (k === 'z' && !e.shiftKey) {
        e.preventDefault()
        undoDocument()
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault()
        redoDocument()
      } else if (k === 's') {
        e.preventDefault()
        void saveCurrentDocument().then((saved) => {
          if (!saved) toast('保存失败，请稍后重试', 'error')
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [store, toast])

  // ───────── 拖放与粘贴 ─────────
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault()
      if (e.dataTransfer?.types.includes('Files')) setDropping(true)
    }
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDropping(false)
    }
    const onDrop = async (e: DragEvent) => {
      e.preventDefault()
      setDropping(false)
      if (store.getState().documentLocked) return
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length === 0) return
      if (!store.getState().pageId) {
        toast('请先打开一个页面', 'error')
        return
      }
      try {
        await insertFiles(files)
        toast(`已插入 ${files.length} 个文件`, 'success')
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error')
      }
    }
    const onPaste = async (e: ClipboardEvent) => {
      if (store.getState().documentLocked) return
      const active = document.activeElement as HTMLElement | null
      if (active?.isContentEditable || active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA')
        return
      const items = Array.from(e.clipboardData?.items ?? [])
      const imageItem = items.find((i) => i.type.startsWith('image/'))
      if (imageItem) {
        const file = imageItem.getAsFile()
        if (file && store.getState().pageId) {
          e.preventDefault()
          const b64 = await readFileAsBase64(file)
          await insertImageData(`粘贴图片.${file.type.split('/')[1] || 'png'}`, b64)
          toast('已粘贴图片', 'success')
        }
        return
      }
      const text = e.clipboardData?.getData('text/plain')
      if (text && text.trim() && store.getState().pageId) {
        e.preventDefault()
        const latex = parseLatexInput(text)
        if (latex) {
          emit({ type: 'insert-math', latex })
          toast('已识别为 LaTeX 公式', 'success')
          return
        }
        emit({ type: 'insert-ai-text', text: `<p>${escapeText(text)}</p>` })
      }
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('paste', onPaste)
    }
  }, [store, toast])

  useEffect(
    () =>
      onCmd((cmd) => {
        if (cmd.type === 'insert-image') void insertImage()
        if (cmd.type === 'insert-file') void insertFile()
        if (cmd.type === 'import-md') void importMarkdown()
      }),
    [insertImage, insertFile, importMarkdown]
  )

  if (!ready) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[var(--ink-bg)]">
        <div className="flex flex-col items-center gap-3 text-[var(--ink-muted)]">
          <Spinner size={20} />
          <span className="text-[13px]">正在打开你的笔记库…</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--ink-bg)] text-[var(--ink-text)]">
      {sidebarOpen && (
        <>
          <Sidebar />
          <PageList />
        </>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onExport={handleExport} />
        <div className="relative min-h-0 flex-1">
          {pageId ? (
            <>
              <CanvasStage />
              <PageFindBar />
              <Toolbar
                onInsertImage={() => void insertImage()}
                onInsertFile={() => void insertFile()}
              />
            </>
          ) : (
            <EmptyState />
          )}
        </div>
      </div>

      <SidePanel />
      <AIPanel />

      <SearchPalette />
      <SettingsDialog />
      <ShortcutsDialog />

      {documentLocked && (
        <div className="fixed inset-0 z-[9999] cursor-wait" aria-hidden="true" />
      )}

      {dropping && (
        <div className="pointer-events-none fixed inset-0 z-[9996] flex items-center justify-center bg-[var(--ink-accent)]/10 backdrop-blur-[1px]">
          <div className="rounded-2xl border-2 border-dashed border-[var(--ink-accent)] bg-[var(--ink-panel)] px-8 py-6 text-[14px] font-medium shadow-float">
            松手即可插入到画布
          </div>
        </div>
      )}
    </div>
  )
}

function EmptyState() {
  const store = useApp
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[var(--ink-canvas)]">
      <div className="text-[15px] font-medium">这个分区还没有页面</div>
      <button
        onClick={() => void store.getState().newPage()}
        className="rounded-lg bg-[var(--ink-accent)] px-4 py-2 text-[13px] text-white hover:brightness-110"
      >
        新建一页
      </button>
    </div>
  )
}

function escapeText(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
}
