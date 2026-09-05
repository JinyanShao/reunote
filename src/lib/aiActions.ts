import * as api from './api'
import { buildAiUserContent, type AiChatAttachment } from './aiAttachments'
import { docToPlainText, useApp } from './store'
import type { AiMessage, AiProfile, CanvasDoc } from './types'

export interface QuickAction {
  key: string
  label: string
  group: '改写' | '翻译' | '分析' | '生成'
  needsSelection: boolean
  /** 结果适合直接替换原文（而不是新增内容） */
  replaces: boolean
  system: string
  user: (text: string) => string
}

const ZH = '请始终使用简体中文回答，除非用户明确要求其他语言。'
const RAW = '只输出结果正文本身，不要解释、不要加引号、不要加任何前后缀。保留原有的 Markdown 结构。'

export const TARGET_LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: '英语' },
  { code: 'zh-Hans', label: '简体中文' },
  { code: 'zh-Hant', label: '繁体中文' },
  { code: 'ja', label: '日语' },
  { code: 'ko', label: '韩语' },
  { code: 'fr', label: '法语' },
  { code: 'de', label: '德语' },
  { code: 'es', label: '西班牙语' },
  { code: 'ru', label: '俄语' },
  { code: 'pt', label: '葡萄牙语' },
  { code: 'ar', label: '阿拉伯语' },
  { code: 'th', label: '泰语' },
]

export function translateAction(langLabel: string): QuickAction {
  return {
    key: `translate-${langLabel}`,
    label: `译为${langLabel}`,
    group: '翻译',
    needsSelection: false,
    replaces: true,
    system: `你是专业译者，译文要自然地道，不要逐字硬译。${RAW}`,
    user: (t) => `把下面的内容翻译成${langLabel}：\n\n${t}`,
  }
}

export const QUICK_ACTIONS: QuickAction[] = [
  // ───── 改写 ─────
  {
    key: 'polish',
    label: '润色',
    group: '改写',
    needsSelection: true,
    replaces: true,
    system: `你是一位中文写作编辑。${ZH}${RAW}`,
    user: (t) => `润色下面这段文字，让它更通顺自然，保持原意和篇幅：\n\n${t}`,
  },
  {
    key: 'grammar',
    label: '纠错',
    group: '改写',
    needsSelection: true,
    replaces: true,
    system: `你是校对编辑。修正错别字、语法与标点问题，其余内容一律不动。${ZH}${RAW}`,
    user: (t) => `校对并改正下面的内容：\n\n${t}`,
  },
  {
    key: 'shorter',
    label: '精简',
    group: '改写',
    needsSelection: true,
    replaces: true,
    system: `你是中文编辑。${ZH}${RAW}`,
    user: (t) => `在不丢失关键信息的前提下，把下面的内容压缩到原来的一半左右：\n\n${t}`,
  },
  {
    key: 'expand',
    label: '扩写',
    group: '改写',
    needsSelection: true,
    replaces: true,
    system: `你是中文写作助手。补充细节、例子和过渡，但不要编造事实。${ZH}${RAW}`,
    user: (t) => `把下面的内容展开写得更充分：\n\n${t}`,
  },
  {
    key: 'formal',
    label: '更正式',
    group: '改写',
    needsSelection: true,
    replaces: true,
    system: `你是中文编辑。${ZH}${RAW}`,
    user: (t) => `把下面的内容改写得更正式、更书面：\n\n${t}`,
  },
  {
    key: 'casual',
    label: '更口语',
    group: '改写',
    needsSelection: true,
    replaces: true,
    system: `你是中文编辑。${ZH}${RAW}`,
    user: (t) => `把下面的内容改写得更轻松口语化，像和朋友聊天：\n\n${t}`,
  },
  {
    key: 'academic',
    label: '学术化',
    group: '改写',
    needsSelection: true,
    replaces: true,
    system: `你是学术写作编辑。用词严谨、逻辑清楚，避免口语。${ZH}${RAW}`,
    user: (t) => `把下面的内容改写成学术论文的语气：\n\n${t}`,
  },
  {
    key: 'bullets',
    label: '改成要点',
    group: '改写',
    needsSelection: true,
    replaces: true,
    system: `你是笔记整理助手。${ZH}只输出 Markdown 无序列表，不要额外说明。`,
    user: (t) => `把下面的内容整理成简洁的要点列表：\n\n${t}`,
  },
  {
    key: 'prose',
    label: '要点转段落',
    group: '改写',
    needsSelection: true,
    replaces: true,
    system: `你是中文写作助手。${ZH}${RAW}`,
    user: (t) => `把下面这些要点整合成通顺的段落：\n\n${t}`,
  },
  {
    key: 'continue',
    label: '续写',
    group: '改写',
    needsSelection: true,
    replaces: false,
    system: `你是写作助手。直接续写正文，不要重复已有内容。${ZH}${RAW}`,
    user: (t) => `顺着下面的内容继续写 2–4 句：\n\n${t}`,
  },

  // ───── 翻译 ─────
  translateAction('英语'),
  translateAction('简体中文'),
  translateAction('日语'),

  // ───── 分析 ─────
  {
    key: 'summarize',
    label: '总结',
    group: '分析',
    needsSelection: false,
    replaces: false,
    system: `你是笔记助手。${ZH}用简洁的要点总结，最多 6 条，使用 Markdown 无序列表。`,
    user: (t) => `总结下面的笔记内容：\n\n${t}`,
  },
  {
    key: 'explain',
    label: '解释',
    group: '分析',
    needsSelection: true,
    replaces: false,
    system: `你是耐心的老师。${ZH}用通俗的语言解释，必要时举一个例子。`,
    user: (t) => `解释下面这段内容的含义：\n\n${t}`,
  },
  {
    key: 'keywords',
    label: '提关键词',
    group: '分析',
    needsSelection: false,
    replaces: false,
    system: `你是信息抽取助手。${ZH}只输出 5–12 个关键词，用「、」分隔，不要编号。`,
    user: (t) => `提取下面内容的关键词：\n\n${t}`,
  },
  {
    key: 'todo',
    label: '提取待办',
    group: '分析',
    needsSelection: false,
    replaces: false,
    system: `你是任务整理助手。${ZH}只输出 Markdown 待办清单，形如 "- [ ] 事项"，不要额外说明。`,
    user: (t) => `从下面的内容中提取所有需要执行的待办事项：\n\n${t}`,
  },
  {
    key: 'critique',
    label: '找问题',
    group: '分析',
    needsSelection: false,
    replaces: false,
    system: `你是严格但建设性的评审者。${ZH}指出逻辑漏洞、事实存疑处和表达问题，并给出改法。用 Markdown 列表。`,
    user: (t) => `审阅下面的内容，指出其中的问题：\n\n${t}`,
  },
  {
    key: 'qa',
    label: '出题自测',
    group: '分析',
    needsSelection: false,
    replaces: false,
    system: `你是学习助手。${ZH}输出 5 个问答对，格式为 "**Q:** …" 与 "**A:** …"。`,
    user: (t) => `根据下面的笔记内容出 5 道自测题并给出答案：\n\n${t}`,
  },

  // ───── 生成 ─────
  {
    key: 'outline',
    label: '生成大纲',
    group: '生成',
    needsSelection: false,
    replaces: false,
    system: `你是结构化写作助手。${ZH}只输出 Markdown 多级标题大纲。`,
    user: (t) => `为下面的主题或内容生成一份结构清晰的大纲：\n\n${t}`,
  },
  {
    key: 'table',
    label: '整理成表格',
    group: '生成',
    needsSelection: false,
    replaces: false,
    system: `你是信息整理助手。${ZH}只输出一个 Markdown 表格，第一行为表头，不要额外说明。`,
    user: (t) => `把下面的内容整理成一张结构清晰的表格：\n\n${t}`,
  },
  {
    key: 'steps',
    label: '拆成步骤',
    group: '生成',
    needsSelection: false,
    replaces: false,
    system: `你是流程整理助手。${ZH}只输出 Markdown 有序列表，每步一句话。`,
    user: (t) => `把下面的内容拆解成可执行的步骤：\n\n${t}`,
  },
  {
    key: 'title',
    label: '起标题',
    group: '生成',
    needsSelection: false,
    replaces: false,
    system: `${ZH}只输出 5 个候选标题，每行一个，不要编号、不要解释。`,
    user: (t) => `为下面的内容起 5 个标题：\n\n${t}`,
  },
]

export const ACTION_GROUPS: QuickAction['group'][] = ['改写', '翻译', '分析', '生成']

/** 收集上下文文本：当前页 / 当前分区 / 当前笔记本 */
export async function buildContext(
  scope: 'page' | 'section' | 'notebook',
  maxChars = 12000
): Promise<string> {
  const s = useApp.getState()
  const chunks: string[] = []

  const pageText = docToPlainText(s.doc)
  chunks.push(`# ${s.title || '未命名页面'}\n${pageText}`)

  if (scope !== 'page') {
    const sectionIds =
      scope === 'section' ? (s.sectionId ? [s.sectionId] : []) : s.sections.map((x) => x.id)

    for (const sid of sectionIds) {
      const pages = await api.listPages(sid)
      for (const p of pages) {
        if (p.id === s.pageId) continue
        if (!p.preview) continue
        chunks.push(`# ${p.title || '未命名页面'}\n${p.preview}`)
        if (chunks.join('\n\n').length > maxChars) break
      }
      if (chunks.join('\n\n').length > maxChars) break
    }
  }

  const joined = chunks.join('\n\n---\n\n')
  return joined.length > maxChars ? joined.slice(0, maxChars) + '\n…（内容已截断）' : joined
}

export function activeProfile(): AiProfile | null {
  const s = useApp.getState()
  const { aiProfiles, activeProfileId } = s.settings
  if (aiProfiles.length === 0) return null
  return aiProfiles.find((p) => p.id === activeProfileId) ?? aiProfiles[0]
}

export class AiNotConfigured extends Error {
  constructor() {
    super('请先在「设置 → AI 服务」里填入接口地址、密钥和模型')
  }
}

export function requireProfile(): AiProfile {
  const p = activeProfile()
  if (!p) throw new AiNotConfigured()
  return p
}

/** 一次性补全，自动带上系统提示 */
export async function complete(system: string, user: string): Promise<string> {
  const profile = requireProfile()
  const out = await api.aiComplete(profile, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ])
  return out.trim()
}

export async function completeWithAttachments(
  system: string,
  user: string,
  attachments: AiChatAttachment[] = [],
  jsonMode = false
): Promise<string> {
  const profile = requireProfile()
  const content = attachments.length > 0 ? buildAiUserContent(profile, user, attachments) : user
  const out = await api.aiComplete(profile, [
    { role: 'system', content: system },
    { role: 'user', content },
  ], jsonMode)
  return out.trim()
}

/** 让模型输出 JSON；附件会按当前服务格式作为多模态内容发送。 */
export async function completeJson<T>(
  system: string,
  user: string,
  attachments: AiChatAttachment[] = []
): Promise<T> {
  const jsonSystem = `${system}\n\n严格只输出一个完整、有效的 JSON 对象或数组，不要输出 Markdown 代码块围栏，不要任何解释文字。`
  let jsonModeUnsupported = false
  const request = async (prompt: string) => {
    if (jsonModeUnsupported) return completeWithAttachments(jsonSystem, prompt, attachments)
    try {
      return await completeWithAttachments(jsonSystem, prompt, attachments, true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/response[_ -]?format|json[_ -]?mode|unsupported|不支持|未知字段/i.test(message)) {
        throw error
      }
      // Some OpenAI-compatible gateways reject response_format. Fall back once to the
      // prompt-only contract and keep the parser/repair path below as the safety net.
      jsonModeUnsupported = true
      return completeWithAttachments(jsonSystem, prompt, attachments)
    }
  }

  const raw = await request(user)
  try {
    return parseJson<T>(raw)
  } catch {
    const previous = raw.trim().slice(0, 6000) || '（上一次响应正文为空）'
    const repaired = await request(
      `${user}\n\n上一次响应无法解析。请重新完成同一任务，并只返回一个语法完整的 JSON。` +
        `不要解释，不要重复上一次的错误格式。\n\n<previous_response>\n${previous}\n</previous_response>`
    )
    try {
      return parseJson<T>(repaired)
    } catch {
      throw new Error(
        '模型连续两次未返回可用的 Agent 指令。已尝试 JSON 模式、推理字段提取和语法修复；请重试本轮任务。'
      )
    }
  }
}

export function parseJson<T>(raw: string): T {
  const text = raw.trim()
  const candidates = [text, ...repairedJsonCandidates(text)]
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1].trim())
  }
  candidates.push(...balancedJsonCandidates(text))

  for (const candidate of new Set(candidates.filter(Boolean))) {
    try {
      return JSON.parse(candidate) as T
    } catch {
      // 继续尝试响应中的下一个完整 JSON 片段。
    }
  }
  throw new Error('模型响应中没有找到语法完整的 JSON')
}

function repairedJsonCandidates(text: string) {
  const candidates: string[] = []
  for (const candidate of balancedJsonCandidates(text)) {
    const repaired = candidate
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)/g, '$1"$2"$3')
    if (repaired !== candidate) candidates.push(repaired)
  }
  return candidates
}

function balancedJsonCandidates(text: string) {
  const candidates: string[] = []
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{' && text[start] !== '[') continue
    const stack: string[] = []
    let inString = false
    let escaped = false
    for (let index = start; index < text.length; index++) {
      const char = text[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') {
        inString = true
        continue
      }
      if (char === '{' || char === '[') stack.push(char)
      else if (char === '}' || char === ']') {
        const expected = char === '}' ? '{' : '['
        if (stack.pop() !== expected) break
        if (stack.length === 0) {
          candidates.push(text.slice(start, index + 1))
          break
        }
      }
    }
  }
  return candidates
}

export function chatMessages(system: string, user: string, history: AiMessage[] = []): AiMessage[] {
  return ([{ role: 'system', content: system }] as AiMessage[]).concat(history, [
    { role: 'user', content: user },
  ])
}

/** 让模型给页面起标题 */
export async function suggestTitle(doc: CanvasDoc): Promise<string | null> {
  const profile = activeProfile()
  if (!profile) return null
  const text = docToPlainText(doc).slice(0, 2500)
  if (text.trim().length < 12) return null
  const out = await api.aiComplete(profile, [
    {
      role: 'system',
      content: '你为笔记生成标题。只输出标题本身，不超过 16 个字，不要标点结尾，不要引号。',
    },
    { role: 'user', content: `为这篇笔记起一个标题：\n\n${text}` },
  ])
  const clean = out.trim().replace(/^["'「《]|["'」》]$/g, '')
  return clean.slice(0, 30) || null
}

function visionImagePart(
  imageDataUrl: string,
  apiStyle: AiProfile['apiStyle']
): Record<string, unknown> {
  if (apiStyle === 'anthropic') {
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(imageDataUrl)
    if (!match) throw new Error('图片数据格式不正确')
    return {
      type: 'image',
      source: { type: 'base64', media_type: match[1], data: match[2] },
    }
  }
  return { type: 'image_url', image_url: { url: imageDataUrl } }
}

/** 多模态：识别单张图片 */
export function visionMessages(
  prompt: string,
  imageDataUrl: string,
  apiStyle: AiProfile['apiStyle'] = 'openai'
): AiMessage[] {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        visionImagePart(imageDataUrl, apiStyle),
      ],
    },
  ]
}

/** 多模态：一次识别多个带画布对象标签的图片。 */
export function multiVisionMessages(
  prompt: string,
  images: { label: string; dataUrl: string }[],
  apiStyle: AiProfile['apiStyle'] = 'openai'
): AiMessage[] {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        ...images.flatMap((image) => [
          { type: 'text', text: `画布对象 ${image.label}：` },
          visionImagePart(image.dataUrl, apiStyle),
        ]),
      ],
    },
  ]
}
