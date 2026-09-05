import TurndownService from 'turndown'
import { marked } from 'marked'
import * as api from './api'
import { useApp, newElementId, docToPlainText } from './store'
import type { CanvasDoc, CanvasElement } from './types'
import { boundsOf } from './geometry'
import { imageSize, readFileAsBase64 } from './utils'
import { strokeToPath } from './ink'
import { centeredWorldPosition } from './canvasPlacement'

// ───────────── Markdown ─────────────

function turndown() {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  })

  td.addRule('taskItem', {
    filter: (node) =>
      node.nodeName === 'LI' && (node as HTMLElement).getAttribute('data-type') === 'taskItem',
    replacement: (_content, node) => {
      const el = node as HTMLElement
      const checked = el.getAttribute('data-checked') === 'true'
      const body = (el.querySelector('div')?.textContent ?? el.textContent ?? '').trim()
      return `- [${checked ? 'x' : ' '}] ${body}\n`
    },
  })

  td.addRule('highlight', {
    filter: ['mark'],
    replacement: (content) => `==${content}==`,
  })

  td.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => {
      const rows = Array.from((node as HTMLTableElement).rows)
      if (rows.length === 0) return ''
      const lines: string[] = []
      rows.forEach((row, i) => {
        const cells = Array.from(row.cells).map((c) =>
          (c.textContent ?? '').trim().replace(/\|/g, '\\|')
        )
        lines.push(`| ${cells.join(' | ')} |`)
        if (i === 0) lines.push(`| ${cells.map(() => '---').join(' | ')} |`)
      })
      return `\n\n${lines.join('\n')}\n\n`
    },
  })

  return td
}

export function docToMarkdown(doc: CanvasDoc, title: string): string {
  const td = turndown()
  const parts: string[] = [`# ${title || '未命名页面'}\n`]
  const sorted = doc.elements.slice().sort((a, b) => a.y - b.y || a.x - b.x)

  for (const el of sorted) {
    switch (el.type) {
      case 'text':
        parts.push(td.turndown(el.html))
        break
      case 'sticky':
        parts.push(`> 📌 ${td.turndown(el.html).replace(/\n/g, '\n> ')}`)
        break
      case 'image':
        parts.push(`![${el.alt ?? '图片'}](${el.attachmentId ?? el.src})`)
        break
      case 'shape':
        if (el.label) parts.push(`**［${el.label}］**`)
        break
      case 'math':
        parts.push(`$$\n${el.latex}\n$$`)
        break
      case 'code':
        parts.push(`\`\`\`${el.language}\n${el.code}\n\`\`\``)
        break
      case 'file':
      case 'audio':
        parts.push(`📎 ${el.filename}`)
        break
      case 'pdf':
        parts.push(`📄 ${el.filename} 第 ${el.page} 页`)
        break
    }
  }

  if (doc.strokes.length > 0) {
    parts.push(`\n> 本页还包含 ${doc.strokes.length} 段手绘墨迹（Markdown 无法承载，已略过）。`)
  }

  return parts.filter((p) => p && p.trim()).join('\n\n')
}

/**
 * 离屏量测一段 HTML 在给定宽度下的真实高度。
 * 文本块容器是 overflow-hidden，高度给小了内容会被永久裁掉且无法滚动，
 * 所以导入时必须按实际内容定高，不能用固定值。
 */
export function measureHtmlHeight(html: string, width: number, padding: number): number {
  const probe = document.createElement('div')
  probe.className = 'rt'
  probe.style.cssText = [
    'position:absolute',
    'visibility:hidden',
    'pointer-events:none',
    'left:-99999px',
    'top:0',
    `width:${width - padding * 2}px`,
  ].join(';')
  probe.innerHTML = html
  document.body.appendChild(probe)
  const h = probe.scrollHeight
  document.body.removeChild(probe)
  return Math.ceil(h + padding * 2 + 8)
}

export function markdownToElements(md: string): CanvasElement[] {
  const html = marked.parse(md, { async: false }) as string
  const w = 720
  const padding = 12
  let h = 400
  try {
    h = Math.max(120, measureHtmlHeight(html, w, padding))
  } catch {
    /* 量测失败时退回一个够用的高度，宁可留白也不裁切 */
    h = Math.max(400, Math.ceil(md.length * 0.9))
  }
  const el: CanvasElement = {
    id: newElementId(),
    type: 'text',
    x: 80,
    y: 70,
    w,
    h,
    rotation: 0,
    z: 1,
    html,
    bg: 'transparent',
    border: 'transparent',
    fontFamily: 'sans',
    fontScale: 1,
    padding,
  }
  return [el]
}

// ───────────── 图片 / 文件插入 ─────────────

function defaultCanvasPosition(width: number, height: number, cascade = 0) {
  const state = useApp.getState()
  const host = document.querySelector<HTMLElement>('[data-canvas-stage]')
  return centeredWorldPosition(
    state.viewport,
    {
      width: host?.clientWidth ?? window.innerWidth,
      height: host?.clientHeight ?? window.innerHeight,
    },
    { width, height },
    cascade
  )
}

export async function insertImageData(
  filename: string,
  base64: string,
  at?: { x: number; y: number },
  cascade = 0
) {
  const s = useApp.getState()
  if (!s.pageId) return
  const att = await api.saveAttachment(s.pageId, filename, base64)
  const size = await imageSize(att.url)
  const max = 560
  const scale = Math.min(1, max / Math.max(size.w, size.h))
  const width = Math.round(size.w * scale)
  const height = Math.round(size.h * scale)
  const position = at ?? defaultCanvasPosition(width, height, cascade)
  const el: CanvasElement = {
    id: newElementId(),
    type: 'image',
    x: Math.round(position.x),
    y: Math.round(position.y),
    w: width,
    h: height,
    rotation: 0,
    z: 0,
    src: att.url,
    attachmentId: att.id,
    alt: filename,
    radius: 8,
    shadow: false,
  }
  s.addElement(el)
  return el
}

export async function insertFileData(
  filename: string,
  base64: string,
  mime: string,
  at?: { x: number; y: number },
  cascade = 0
) {
  const s = useApp.getState()
  if (!s.pageId) return
  const att = await api.saveAttachment(s.pageId, filename, base64)

  if (mime.startsWith('audio')) {
    const position = at ?? defaultCanvasPosition(320, 68, cascade)
    const el: CanvasElement = {
      id: newElementId(),
      type: 'audio',
      x: Math.round(position.x),
      y: Math.round(position.y),
      w: 320,
      h: 68,
      rotation: 0,
      z: 0,
      attachmentId: att.id,
      src: att.url,
      filename,
    }
    s.addElement(el)
    return el
  }

  const position = at ?? defaultCanvasPosition(280, 62, cascade)
  const el: CanvasElement = {
    id: newElementId(),
    type: 'file',
    x: Math.round(position.x),
    y: Math.round(position.y),
    w: 280,
    h: 62,
    rotation: 0,
    z: 0,
    attachmentId: att.id,
    filename,
    mime: att.mime,
    size: att.size,
  }
  s.addElement(el)
  return el
}

export async function insertFiles(files: File[], at?: { x: number; y: number }) {
  let offset = 0
  for (const f of files) {
    const b64 = await readFileAsBase64(f)
    const pos = at ? { x: at.x + offset, y: at.y + offset } : undefined
    if (f.type.startsWith('image/')) await insertImageData(f.name, b64, pos, at ? 0 : offset)
    else if (f.type === 'application/pdf') await insertPdfBase64(f.name, b64, pos)
    else await insertFileData(f.name, b64, f.type || 'application/octet-stream', pos, at ? 0 : offset)
    offset += 28
  }
}

// ───────────── PDF ─────────────

let pdfWorker: Worker | null = null

/**
 * pdf.js 的 worker 文件是 ESM 模块，而 pdf.js 默认用**经典 Worker** 去加载
 * （即只设 workerSrc 的话），浏览器会直接抛
 * `Uncaught SyntaxError: Unexpected token 'export'`，
 * 随后 page.render() 永远挂起 —— PDF 导入整体不可用。
 * 正确做法是自己以 { type: 'module' } 建 worker 再交给 workerPort；
 * `new URL(..., import.meta.url)` 这种写法 Vite 在打包时也能正确处理。
 */
function getPdfWorker(): Worker {
  if (!pdfWorker) {
    pdfWorker = new Worker(
      new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url),
      { type: 'module' }
    )
  }
  return pdfWorker
}

export async function extractPdfTextBase64(base64: string, maxChars = 40_000) {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerPort = getPdfWorker()
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

  const pdf = await pdfjs.getDocument({ data: bytes }).promise
  const chunks: string[] = []
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text) chunks.push(`[第 ${pageNumber} 页]\n${text}`)
    if (chunks.join('\n\n').length >= maxChars) break
  }
  const joined = chunks.join('\n\n')
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n…（PDF 内容已截断）` : joined
}

export async function insertPdfBase64(
  filename: string,
  base64: string,
  at?: { x: number; y: number },
  maxPages = 40
) {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerPort = getPdfWorker()

  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

  const pdf = await pdfjs.getDocument({ data: bytes }).promise
  const total = Math.min(pdf.numPages, maxPages)
  const s = useApp.getState()
  if (!s.pageId) return
  // 渲染是逐页 await 的，用户中途切页会让附件挂到错误的页面上；
  // 记下起始页 id，每轮校验，变了就中止。
  const ownerPageId = s.pageId

  let y = at?.y ?? null
  let x = at?.x ?? null
  const created: CanvasElement[] = []

  for (let i = 1; i <= total; i++) {
    if (useApp.getState().pageId !== ownerPageId) {
      throw new Error(`已切换页面，PDF 导入在第 ${i} 页中止`)
    }
    const page = await pdf.getPage(i)
    const viewport = page.getViewport({ scale: 2 })
    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    const ctx = canvas.getContext('2d')
    if (!ctx) continue
    await page.render({ canvasContext: ctx, viewport }).promise
    const dataUrl = canvas.toDataURL('image/png')
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    const att = await api.saveAttachment(ownerPageId, `${filename}-p${i}.png`, b64)

    const w = 780
    const h = Math.round((viewport.height / viewport.width) * w)
    if (x === null || y === null) {
      const position = defaultCanvasPosition(w, h)
      x = position.x
      y = position.y
    }
    created.push({
      id: newElementId(),
      type: 'pdf',
      x,
      y,
      w,
      h,
      rotation: 0,
      z: 0,
      src: att.url,
      attachmentId: att.id,
      page: i,
      total,
      filename,
    })
    y += h + 28
  }

  // 一次性写入，避免每页都产生一条撤销记录
  useApp.getState().updateDoc((d) => {
    let z = 0
    for (const e of d.elements) z = Math.max(z, e.z)
    created.forEach((e, idx) => d.elements.push({ ...e, z: z + idx + 1 }))
  })
  useApp.getState().setSelection([])
  return total
}

// ───────────── PNG 导出 ─────────────

/** 把 inkasset:// 图片换成 data URL，否则 SVG 光栅化会拒绝加载 */
async function inlineImages(root: HTMLElement) {
  const imgs = Array.from(root.querySelectorAll('img'))
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute('src') ?? ''
      if (src.indexOf('data:') === 0) return
      const name = src.split('/').pop()
      if (!name) return
      try {
        const b64 = await api.readAttachment(name)
        const ext = name.split('.').pop()?.toLowerCase() ?? 'png'
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
        img.setAttribute('src', `data:${mime};base64,${b64}`)
      } catch {
        img.removeAttribute('src')
      }
    })
  )
}

function collectCss(): string {
  const chunks: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) chunks.push(rule.cssText)
    } catch {
      /* 跨域样式表，跳过 */
    }
  }
  return chunks.join('\n')
}

export async function exportPng(scale = 2) {
  const r = await exportRaster(scale, 'image/png')
  return r ? r.base64 : null
}

export async function exportRaster(
  scale = 2,
  mime: 'image/png' | 'image/jpeg' = 'image/png'
): Promise<{ base64: string; w: number; h: number } | null> {
  const s = useApp.getState()
  const doc = s.doc
  const world = document.querySelector<HTMLElement>('[data-world="1"]')
  if (!world) return null

  const eb = boundsOf(doc.elements)
  let minX = eb?.x ?? 0
  let minY = eb?.y ?? 0
  let maxX = eb ? eb.x + eb.w : 800
  let maxY = eb ? eb.y + eb.h : 600
  for (const st of doc.strokes) {
    for (const p of st.points) {
      minX = Math.min(minX, p[0] - st.size)
      minY = Math.min(minY, p[1] - st.size)
      maxX = Math.max(maxX, p[0] + st.size)
      maxY = Math.max(maxY, p[1] + st.size)
    }
  }
  const pad = 40
  minX -= pad
  minY -= pad
  maxX += pad
  maxY += pad
  const w = Math.max(80, Math.ceil(maxX - minX))
  const h = Math.max(80, Math.ceil(maxY - minY))

  const cloneNode = world.cloneNode(true) as HTMLElement
  cloneNode.style.transform = `translate(${-minX}px, ${-minY}px)`
  cloneNode.style.transformOrigin = '0 0'
  cloneNode.style.width = `${w}px`
  cloneNode.style.height = `${h}px`
  cloneNode.querySelectorAll('[data-overlay="1"]').forEach((n) => n.remove())
  await inlineImages(cloneNode)

  const isDark = document.documentElement.classList.contains('dark')
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--ink-canvas').trim()

  // foreignObject 里的内容按 XML 解析：
  // - outerHTML 输出的 <img>、<br>、<input> 不自闭合，直接让整个 SVG 解析失败，
  //   必须用 XMLSerializer（会输出 <img …/>）。
  // - CSS 文本里可能有 & 和 <，包进 CDATA。
  const serializer = new XMLSerializer()
  const xhtml = serializer.serializeToString(cloneNode)
  const css = collectCss().replace(/]]>/g, ']]]]><![CDATA[>')

  const html = `<div xmlns="http://www.w3.org/1999/xhtml" class="${isDark ? 'dark' : ''}" style="width:${w}px;height:${h}px;position:relative;overflow:hidden;background:${bg || '#fff'}">
  <style><![CDATA[${css}]]></style>
  ${xhtml}
</div>`

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><foreignObject width="100%" height="100%">${html}</foreignObject></svg>`

  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = w * scale
      canvas.height = h * scale
      const ctx = canvas.getContext('2d')
      if (!ctx) return resolve(null)
      ctx.fillStyle = bg || '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.scale(scale, scale)
      ctx.drawImage(img, 0, 0)
      try {
        const out = canvas.toDataURL(mime, mime === 'image/jpeg' ? 0.92 : undefined)
        resolve({ base64: out.slice(out.indexOf(',') + 1), w: canvas.width, h: canvas.height })
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

/** 把一张 JPEG 包成单页 PDF（/DCTDecode 可直接内嵌 JPEG 字节） */
export function jpegToPdfBase64(jpegBase64: string, pxW: number, pxH: number): string {
  const jpeg = atob(jpegBase64)
  // 以 144 dpi 折算成 PDF 点（1 pt = 1/72 inch）
  const ptW = Math.round((pxW / 144) * 72)
  const ptH = Math.round((pxH / 144) * 72)

  const objects: string[] = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objects[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ptW} ${ptH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`
  objects[4] =
    `<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceRGB ` +
    `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n${jpeg}\nendstream`
  const content = `q\n${ptW} 0 0 ${ptH} 0 0 cm\n/Im0 Do\nQ\n`
  objects[5] = `<< /Length ${content.length} >>\nstream\n${content}endstream`

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let i = 1; i <= 5; i++) {
    offsets[i] = pdf.length
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefPos = pdf.length
  pdf += `xref\n0 6\n0000000000 65535 f \n`
  for (let i = 1; i <= 5; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`

  // 逐字节转 base64，避免 UTF-8 破坏二进制
  let out = ''
  for (let i = 0; i < pdf.length; i++) out += String.fromCharCode(pdf.charCodeAt(i) & 0xff)
  return btoa(out)
}

/** 备用的纯矢量导出：只画墨迹与图形，保证一定能出图 */
export function exportInkSvg(): string {
  const doc = useApp.getState().doc
  const paths = doc.strokes
    .map(
      (st) =>
        `<path d="${strokeToPath(st)}" fill="${st.color}" opacity="${st.tool === 'highlighter' ? 0.42 : 1}"/>`
    )
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg">${paths}</svg>`
}

export function plainTextOfCurrentPage() {
  return docToPlainText(useApp.getState().doc)
}
