import * as api from './api'
import { activeProfile, multiVisionMessages, visionMessages } from './aiActions'
import { strokeToPath } from './ink'
import type { Stroke } from './types'

const OCR_PROMPT =
  '识别这张图片里的所有文字，按原有的段落和换行输出。' +
  '如果是手写内容，请尽量还原原意。' +
  '只输出识别到的文字本身，不要加任何解释、标题或前后缀。若图中没有文字，回答“未识别到文字”。'

export class OcrError extends Error {}

/** 把一组笔迹光栅化成 PNG data URL，用于喂给多模态模型 */
export function strokesToDataUrl(strokes: Stroke[], padding = 24, scale = 2): string | null {
  if (strokes.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const st of strokes) {
    for (const p of st.points) {
      minX = Math.min(minX, p[0] - st.size)
      minY = Math.min(minY, p[1] - st.size)
      maxX = Math.max(maxX, p[0] + st.size)
      maxY = Math.max(maxY, p[1] + st.size)
    }
  }
  if (!isFinite(minX)) return null

  const w = Math.ceil(maxX - minX) + padding * 2
  const h = Math.ceil(maxY - minY) + padding * 2
  if (w <= 0 || h <= 0 || w > 8000 || h > 8000) return null

  const canvas = document.createElement('canvas')
  canvas.width = w * scale
  canvas.height = h * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  // 白底黑字最利于模型识别，因此统一按浅色渲染
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.scale(scale, scale)
  ctx.translate(padding - minX, padding - minY)

  for (const st of strokes) {
    const d = strokeToPath(st)
    if (!d) continue
    try {
      ctx.fillStyle = st.tool === 'highlighter' ? 'rgba(250,204,21,.45)' : '#111827'
      ctx.fill(new Path2D(d))
    } catch {
      /* 单条笔迹失败不影响其他 */
    }
  }
  return canvas.toDataURL('image/png')
}

/** 从附件 id 拿到 data URL */
export async function attachmentDataUrl(assetIdOrSrc: string): Promise<string | null> {
  if (assetIdOrSrc.indexOf('data:') === 0) return assetIdOrSrc
  const id = assetIdOrSrc.split('/').pop()
  if (!id) return null
  try {
    const b64 = await api.readAttachment(id)
    if (!b64) return null
    const ext = id.split('.').pop()?.toLowerCase() ?? 'png'
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
    return `data:${mime};base64,${b64}`
  } catch {
    return null
  }
}

/** 调用多模态模型识别图片中的文字 */
export async function recognizeText(dataUrl: string): Promise<string> {
  const profile = activeProfile()
  if (!profile) throw new OcrError('请先在设置里添加 AI 服务')
  if (!profile.supportsVision)
    throw new OcrError(
      `当前服务「${profile.name}」未勾选“支持读图”。请在设置里换一个多模态模型并勾选该选项。`
    )
  const text = await api.aiComplete(profile, visionMessages(OCR_PROMPT, dataUrl, profile.apiStyle))
  const clean = text.trim()
  if (!clean) throw new OcrError('模型没有返回识别结果')
  return clean
}

/** 识别多张画布图片中的公式，结果会作为 Agent 的只读视觉上下文。 */
export async function recognizeMathImages(
  images: { label: string; dataUrl: string }[]
): Promise<string> {
  const profile = activeProfile()
  if (!profile) throw new OcrError('请先在设置里添加 AI 服务')
  if (!profile.supportsVision) {
    throw new OcrError(`当前服务「${profile.name}」未启用图片理解，无法识别图片中的公式`)
  }
  if (images.length === 0) return ''
  const prompt =
    '识别以下画布图片中的数学公式。按画布对象 ID 分组，输出每条公式的 LaTeX 源码和必要的简短上下文。' +
    'LaTeX 不要包含 Markdown 代码围栏；看不清的符号要明确标注，不要猜测。若没有公式，请明确写“未识别到公式”。'
  const out = await api.aiComplete(
    profile,
    multiVisionMessages(prompt, images, profile.apiStyle)
  )
  const clean = out.trim()
  if (!clean) throw new OcrError('模型没有返回公式识别结果')
  return clean
}
