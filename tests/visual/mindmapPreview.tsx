import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import { PageList } from '../../src/components/PageList'
import { CanvasStage } from '../../src/components/canvas/CanvasStage'
import { TextPromptHost, ToastHost } from '../../src/components/ui'
import { boundsOf } from '../../src/lib/geometry'
import { buildMindMapDocument } from '../../src/lib/mindMap'
import { useApp } from '../../src/lib/store'
import type { PageMeta } from '../../src/lib/types'

if (new URLSearchParams(window.location.search).get('theme') === 'dark') {
  document.documentElement.classList.add('dark')
}

let id = 0
const result = buildMindMapDocument(
  {
    root: '量子轨道交换起源',
    nodes: [
      { id: 'review', label: '审稿核心问题', parent: null },
      { id: 'review-1', label: '缺少轨道耦合', parent: 'review' },
      { id: 'review-2', label: '有效张量合法性', parent: 'review' },
      { id: 'micro', label: '微观推导链', parent: null },
      { id: 'micro-1', label: '多轨道模型', parent: 'micro' },
      { id: 'micro-2', label: '自旋轨道交换', parent: 'micro' },
      { id: 'micro-3', label: '双重态投影', parent: 'micro' },
      { id: 'channel', label: '交换通道', parent: null },
      { id: 'channel-1', label: '轨道算符定义', parent: 'channel' },
      { id: 'channel-2', label: '三类交换通道', parent: 'channel' },
      { id: 'response', label: '结论与回应', parent: null },
      { id: 'response-1', label: '补全轨道耦合', parent: 'response' },
      { id: 'response-2', label: '量级比值稳健', parent: 'response' },
      { id: 'response-3', label: '符号依赖耦合', parent: 'response' },
    ],
  },
  () => `visual-${++id}`
)

const now = Date.now()
const pages: PageMeta[] = [
  {
    id: 'source-page',
    sectionId: 'section-1',
    notebookId: 'notebook-1',
    parentId: null,
    title: '量子轨道交换起源',
    preview: '原始研究笔记保持不变',
    sortOrder: 1000,
    favorite: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    tags: ['量子'],
  },
  {
    id: 'mindmap-page',
    sectionId: 'section-1',
    notebookId: 'notebook-1',
    parentId: 'source-page',
    title: '量子轨道交换起源 · 思维导图',
    preview: '独立生成的可编辑思维导图',
    sortOrder: 2000,
    favorite: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    tags: [],
  },
  {
    id: 'other-page',
    sectionId: 'section-1',
    notebookId: 'notebook-1',
    parentId: null,
    title: '计算记录',
    preview: '其他页面',
    sortOrder: 3000,
    favorite: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    tags: [],
  },
]

const bounds = boundsOf(result.doc.elements)!
const canvasWidth = Math.max(900, window.innerWidth - 248)
const canvasHeight = Math.max(620, window.innerHeight)
const zoom = Math.min(1, (canvasWidth - 130) / bounds.w, (canvasHeight - 130) / bounds.h)

useApp.setState({
  ready: true,
  notebookId: 'notebook-1',
  sectionId: 'section-1',
  pageId: 'mindmap-page',
  sections: [
    {
      id: 'section-1',
      notebookId: 'notebook-1',
      name: '研究笔记',
      color: '#14866d',
      sortOrder: 1000,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  pages,
  title: pages[1].title,
  doc: result.doc,
  viewport: {
    x: (canvasWidth - bounds.w * zoom) / 2 - bounds.x * zoom,
    y: (canvasHeight - bounds.h * zoom) / 2 - bounds.y * zoom,
    zoom,
  },
  selection: [],
  strokeSelection: [],
  dirty: false,
  past: [],
  future: [],
})

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastHost>
      <TextPromptHost>
        <div className="flex h-full w-full overflow-hidden bg-[var(--ink-bg)] text-[var(--ink-text)]">
          <PageList />
          <main className="h-full min-w-0 flex-1">
            <CanvasStage />
          </main>
        </div>
      </TextPromptHost>
    </ToastHost>
  </React.StrictMode>
)
