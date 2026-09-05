import * as api from './api'
import { extractPdfTextBase64 } from './exchange'
import type { AiProfile } from './types'
import { uid } from './utils'

export interface AiChatAttachment {
  id: string
  name: string
  mime: string
  kind: 'image' | 'document'
  size: number
  base64?: string
  text?: string
  truncated?: boolean
}

const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024
const MAX_DOCUMENT_CHARS = 40_000
const MAX_TOTAL_DOCUMENT_CHARS = 70_000
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  jsx: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  py: 'text/x-python',
  rs: 'text/x-rust',
  go: 'text/x-go',
  java: 'text/x-java',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  log: 'text/plain',
  tex: 'application/x-tex',
}

const TEXT_EXTENSIONS = new Set(
  Object.entries(MIME_BY_EXT)
    .filter(
      ([, mime]) =>
        mime.startsWith('text/') || (!mime.startsWith('image/') && mime !== 'application/pdf')
    )
    .map(([ext]) => ext)
)

function extension(filename: string) {
  return filename.split('.').pop()?.toLowerCase() ?? ''
}

function filenameOf(path: string) {
  return path.split(/[\\/]/).pop() || '附件'
}

function byteLengthOfBase64(base64: string) {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

function truncateText(text: string) {
  if (text.length <= MAX_DOCUMENT_CHARS) return { text, truncated: false }
  return {
    text: `${text.slice(0, MAX_DOCUMENT_CHARS)}\n…（附件内容已截断）`,
    truncated: true,
  }
}

export async function loadAiChatAttachment(path: string): Promise<AiChatAttachment> {
  const name = filenameOf(path)
  const ext = extension(name)
  const mime = MIME_BY_EXT[ext]
  if (!mime) throw new Error(`暂不支持把 ${name} 发送给 AI`)

  if (mime.startsWith('image/')) {
    const base64 = await api.readFileBase64(path)
    const size = byteLengthOfBase64(base64)
    if (size > MAX_IMAGE_BYTES) throw new Error(`${name} 超过 12 MB，请先压缩图片`)
    return { id: uid('ai-att'), name, mime, kind: 'image', size, base64 }
  }

  if (mime === 'application/pdf') {
    const base64 = await api.readFileBase64(path)
    const size = byteLengthOfBase64(base64)
    if (size > MAX_DOCUMENT_BYTES) throw new Error(`${name} 超过 20 MB，请拆分后再上传`)
    const extracted = await extractPdfTextBase64(base64, MAX_DOCUMENT_CHARS)
    return {
      id: uid('ai-att'),
      name,
      mime,
      kind: 'document',
      size,
      text: extracted || '（这个 PDF 没有可提取的文字，可能是扫描件）',
      truncated: extracted.length >= MAX_DOCUMENT_CHARS,
    }
  }

  if (TEXT_EXTENSIONS.has(ext)) {
    const raw = await api.readFileText(path)
    const size = new TextEncoder().encode(raw).length
    if (size > MAX_DOCUMENT_BYTES) throw new Error(`${name} 超过 20 MB，请拆分后再上传`)
    const limited = truncateText(raw)
    return {
      id: uid('ai-att'),
      name,
      mime,
      kind: 'document',
      size,
      text: limited.text,
      truncated: limited.truncated,
    }
  }

  throw new Error(`暂不支持把 ${name} 发送给 AI`)
}

export function buildAiUserContent(
  profile: AiProfile,
  prompt: string,
  attachments: AiChatAttachment[]
): unknown {
  if (attachments.length > 6) throw new Error('每次最多上传 6 个附件')
  const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0)
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error('附件总大小超过 40 MB，请分批上传')
  }
  const images = attachments.filter((attachment) => attachment.kind === 'image')
  if (images.length > 0 && !profile.supportsVision) {
    throw new Error('当前 AI 服务未启用图片理解，请在 AI 设置中开启视觉能力')
  }

  let remaining = MAX_TOTAL_DOCUMENT_CHARS
  const documents = attachments
    .filter((attachment) => attachment.kind === 'document')
    .map((attachment) => {
      if (remaining <= 0) return ''
      const body = (attachment.text ?? '').slice(0, remaining)
      remaining -= body.length
      return `<attachment name=${JSON.stringify(attachment.name)}>\n${body}\n</attachment>`
    })
    .filter((block) => block.length > 0)
  const text = [prompt.trim() || '请阅读附件并概括重点。', ...documents].join('\n\n')
  if (images.length === 0) return text

  if (profile.apiStyle === 'anthropic') {
    return [
      { type: 'text', text },
      ...images.map((image) => ({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mime,
          data: image.base64,
        },
      })),
    ]
  }

  return [
    { type: 'text', text },
    ...images.map((image) => ({
      type: 'image_url',
      image_url: { url: `data:${image.mime};base64,${image.base64}` },
    })),
  ]
}
