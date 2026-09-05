import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { nanoid } from 'nanoid'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const uid = (prefix = '') => (prefix ? `${prefix}_${nanoid(10)}` : nanoid(12))

export function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v))
}

export function formatTime(ts: number) {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const pad = (n: number) => String(n).padStart(2, '0')
  if (sameDay) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`
  const yesterday = new Date(now.getTime() - 86400000)
  if (
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  )
    return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.getFullYear() === now.getFullYear())
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`
}

export function formatBytes(n: number) {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null
  const wrapped = (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  wrapped.flush = (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer)
    timer = null
    fn(...args)
  }
  return wrapped as T & { cancel: () => void; flush: (...args: Parameters<T>) => void }
}

/** 把 HTML 转成纯文本（用于搜索索引和 AI 上下文） */
export function htmlToText(html: string): string {
  if (!html) return ''
  const el = document.createElement('div')
  el.innerHTML = html
  el.querySelectorAll('br').forEach((n) => n.replaceWith('\n'))
  el.querySelectorAll('li').forEach((n) => n.prepend(document.createTextNode('• ')))
  const text = el.textContent || ''
  return text.replace(/ /g, ' ')
}

export function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 从富文本中提取 [[双向链接]] 目标标题 */
export function extractWikiLinks(text: string): string[] {
  const out = new Set<string>()
  const re = /\[\[([^\]\n]{1,120})\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const t = m[1].trim()
    if (t) out.add(t)
  }
  return [...out]
}

/** 从纯文本里提取 #标签 */
export function extractHashTags(text: string): string[] {
  const out = new Set<string>()
  const re = /(?:^|\s)#([^\s#，。、!?！？,.;:]{1,32})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.add(m[1])
  return [...out]
}

export function downloadFilename(title: string, ext: string) {
  const safe = (title || '未命名').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
  return `${safe}.${ext}`
}

export function isMac() {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
}

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      const idx = result.indexOf(',')
      resolve(idx >= 0 ? result.slice(idx + 1) : result)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function imageSize(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => resolve({ w: 480, h: 320 })
    img.src = src
  })
}

/** 给定背景色，返回可读的文字颜色；透明背景返回 undefined（继承主题色） */
export function readableTextColor(bg: string | undefined): string | undefined {
  if (!bg || bg === 'transparent' || bg === 'none') return undefined
  let r = 0
  let g = 0
  let b = 0
  const hex = bg.trim()
  if (hex.charAt(0) === '#') {
    const v = hex.length === 4
      ? hex
          .slice(1)
          .split('')
          .map((c) => c + c)
          .join('')
      : hex.slice(1)
    if (v.length < 6) return undefined
    r = parseInt(v.slice(0, 2), 16)
    g = parseInt(v.slice(2, 4), 16)
    b = parseInt(v.slice(4, 6), 16)
  } else {
    const m = /rgba?\(([^)]+)\)/.exec(hex)
    if (!m) return undefined
    const parts = m[1].split(',').map((x) => parseFloat(x))
    r = parts[0]
    g = parts[1]
    b = parts[2]
  }
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return luminance > 0.55 ? '#1f2430' : '#f5f6fa'
}

function parseColor(c: string): [number, number, number] | null {
  const hex = c.trim()
  if (hex.charAt(0) === '#') {
    const v =
      hex.length === 4
        ? hex
            .slice(1)
            .split('')
            .map((x) => x + x)
            .join('')
        : hex.slice(1)
    if (v.length < 6) return null
    return [
      parseInt(v.slice(0, 2), 16),
      parseInt(v.slice(2, 4), 16),
      parseInt(v.slice(4, 6), 16),
    ]
  }
  const m = /rgba?\(([^)]+)\)/.exec(hex)
  if (!m) return null
  const p = m[1].split(',').map((x) => parseFloat(x))
  return [p[0], p[1], p[2]]
}

/**
 * 深色画布上把接近黑色的墨迹提亮显示。
 * 只影响显示，不改动保存的原始颜色 —— 切回浅色主题仍是原来的黑。
 */
export function adaptInkColor(color: string, isDark: boolean): string {
  if (!isDark) return color
  const rgb = parseColor(color)
  if (!rgb) return color
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
  if (lum > 0.32) return color
  // 保留色相，提高明度
  const boost = (v: number) => Math.round(Math.min(255, v + (255 - v) * 0.82))
  return `rgb(${boost(rgb[0])}, ${boost(rgb[1])}, ${boost(rgb[2])})`
}

export const PALETTE = [
  '#1f2937',
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#22c55e',
  '#14b8a6',
  '#3b82f6',
  '#6366f1',
  '#a855f7',
  '#ec4899',
  '#78716c',
  '#ffffff',
]

export const HIGHLIGHT_PALETTE = [
  '#fde68a',
  '#bbf7d0',
  '#bfdbfe',
  '#fbcfe8',
  '#ddd6fe',
  '#fed7aa',
]

export const STICKY_COLORS = [
  '#FEF3C7',
  '#DCFCE7',
  '#DBEAFE',
  '#FCE7F3',
  '#EDE9FE',
  '#FFE4E6',
  '#F1F5F9',
]

export const NOTEBOOK_COLORS = [
  '#6C8CFF',
  '#F97066',
  '#F5A524',
  '#2DD4A7',
  '#A78BFA',
  '#F472B6',
  '#38BDF8',
  '#94A3B8',
]
