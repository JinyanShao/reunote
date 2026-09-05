import type { CanvasAgentSkillId } from './types'

interface CanvasAgentSkillDefinition {
  id: CanvasAgentSkillId
  label: string
  useWhen: string
  instructions: string
}

export const CANVAS_AGENT_SKILLS: readonly CanvasAgentSkillDefinition[] = [
  {
    id: 'balanced_grid',
    label: '均衡网格',
    useWhen: '对象较多，需要统一尺寸、间距并便于快速扫描',
    instructions:
      '先按内容类型选择需要统一尺寸的对象，再使用 arrange:grid；保留阅读顺序，间距通常为 24-40。',
  },
  {
    id: 'reading_columns',
    label: '阅读分栏',
    useWhen: '长内容需要按从上到下、从左到右的顺序排成两栏或三栏',
    instructions:
      '使用 arrange:columns，优先两栏；不要压缩正文到难以阅读，列间距通常为 36-56。',
  },
  {
    id: 'kanban_board',
    label: '看板分组',
    useWhen: '内容可按主题、状态或职责分组',
    instructions:
      '使用 group_layout:columns，为每组添加简短标题；同一对象只能进入一个分组。',
  },
  {
    id: 'timeline',
    label: '时间线',
    useWhen: '内容具有明确的先后、阶段或因果顺序',
    instructions:
      '先按语义顺序提供 ids，再使用 arrange:timeline；不要仅按对象当前坐标猜测时间顺序。',
  },
  {
    id: 'formula_companion',
    label: '公式原位排版',
    useWhen: '把正文、代码块、图片或 PDF 中的 LaTeX 转成可编辑公式',
    instructions:
      '按 Scan → Bind → Act → Observe → Critic → Repair 执行。先由本地扫描器枚举全部公式候选并绑定正文位置，模型只决定 latex 和来源对象，绝不能猜 x/y/width/height。可编辑正文或便签必须使用 embed_math 在原字符位置嵌入并回读验证；不得因匹配失败退化为右侧公式。图片、PDF、真正的代码和锁定正文才使用 create_math 创建独立伴随公式。同一来源的多条公式不得互相串联；Critic 必须清除可编辑正文旁重复的 Agent 公式。',
  },
] as const

const skillMap = new Map(CANVAS_AGENT_SKILLS.map((skill) => [skill.id, skill]))

export const CANVAS_AGENT_SKILL_IDS = CANVAS_AGENT_SKILLS.map((skill) => skill.id) as [
  CanvasAgentSkillId,
  ...CanvasAgentSkillId[],
]

export function isCanvasAgentSkillId(value: unknown): value is CanvasAgentSkillId {
  return typeof value === 'string' && skillMap.has(value as CanvasAgentSkillId)
}

export function canvasAgentSkillLabel(id: CanvasAgentSkillId) {
  return skillMap.get(id)?.label ?? id
}

export function canvasAgentSkillInstructions(id?: CanvasAgentSkillId) {
  if (!id) return '本阶段未指定排版 Skill，请优先使用确定性工具并保持现有阅读顺序。'
  const skill = skillMap.get(id)
  return skill ? `${skill.label}：${skill.instructions}` : ''
}

export function inferCanvasAgentSkill(text: string): CanvasAgentSkillId | undefined {
  const normalized = text.toLowerCase()
  if (/latex|公式|方程|数学/.test(normalized)) return 'formula_companion'
  if (/看板|分组|分类|kanban/.test(normalized)) return 'kanban_board'
  if (/时间线|时序|阶段|timeline/.test(normalized)) return 'timeline'
  if (/分栏|两栏|三栏|阅读顺序|columns?/.test(normalized)) return 'reading_columns'
  if (/网格|统一尺寸|整齐|排版|排板|布局|grid/.test(normalized)) return 'balanced_grid'
  return undefined
}

export const CANVAS_AGENT_SKILL_GUIDE = CANVAS_AGENT_SKILLS.map(
  (skill) => `- ${skill.id}（${skill.label}）：${skill.useWhen}。${skill.instructions}`
).join('\n')
