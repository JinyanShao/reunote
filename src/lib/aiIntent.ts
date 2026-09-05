export type AiIntent = 'chat' | 'agent'
export type AiAgentScope = 'page' | 'selection'

export interface AiIntentContext {
  hasAttachments?: boolean
  hasActiveAgentDraft?: boolean
  hasAgentHistory?: boolean
  hasSelection?: boolean
}

const CHAT_ONLY_OVERRIDE =
  /(?:只|仅)(?:需要)?(?:回答|说明|解释)|(?:不要|别|无需|不需要)(?:修改|改动|操作|写入|调整)(?:画布|页面|笔记|内容)?|\b(?:just\s+answer|answer\s+only|do\s+not|don't)\b.{0,32}\b(?:edit|modify|change|write|touch)\b/iu

const HOW_TO_QUESTION =
  /(?:(?:请问|我想知道|想知道|告诉我|请告诉我|请说明)?(?:什么是|什么叫|是什么意思|为什么|为何|如何|怎么|怎样|有哪些(?:方法|步骤|区别)|是否应该|应不应该|该不该)|应该.{0,24}吗)|\b(?:what\s+(?:is|are)|why|how\s+(?:do|does|can|could|should|would|to)|should\s+i|should\s+we|is\s+it\s+(?:better|possible|necessary|wise)|would\s+it\s+be)\b/iu

const EXPLANATION_REQUEST =
  /^(?:请)?(?:解释|说明|介绍|讲解|分析)(?:一下)?|^(?:please\s+)?(?:explain|describe|tell\s+me\s+about|analy[sz]e)\b/iu

const CANVAS_DESTINATION =
  /(?:画布|当前页|本页|页面上|页面中|页面里|AI\s*工作稿|工作稿|笔记中|笔记里|分区中|分区里)|\b(?:canvas|current\s+page|page|agent\s+draft|workspace|note)\b/iu

const SELECTED_TARGET =
  /(?:选中|所选|当前)(?:的)?(?:内容|文字|文本|元素|笔记|卡片|节点|图片|公式|对象)|\bselected\s+(?:content|text|elements?|notes?|cards?|nodes?|images?|formulas?|objects?)\b/iu

const EDITABLE_TARGET =
  /(?:这段内容|这些内容|这段文字|这些文字|这个元素|这些元素|卡片|节点|分支|文本块|公式|LaTeX|图片|图像|便签)|\b(?:this|these|the)\s+(?:content|text|elements?|notes?|cards?|nodes?|branches?|blocks?|images?|formulas?|objects?)\b/iu

const MUTATION =
  /(?:新增|添加|插入|创建|生成|绘制|画出|写入|写到|放到|放在|放进|摆放|移动|移到|挪到|排列|排版|排成|重排|布局|整理|优化|改成|改为|修改|改写|润色|校对|纠错|精简|扩写|替换|删除|移除|对齐|分组|连接|缩放|调整|转换|转成|变成|显示为|渲染为|嵌入|合并|拆分|更新)|\b(?:add|append|insert|create|generate|draw|write|put|place|position|move|arrange|lay\s*out|layout|rewrite|polish|proofread|replace|delete|remove|align|group|connect|resize|adjust|convert|turn|render|embed|merge|split|update|format|style|organize|optimise|optimize)\b/iu

const VISUAL_ARTIFACT =
  /(?:思维导图|脑图|流程图|示意图|关系图|概念图|结构图|架构图|时间线|鱼骨图)|\b(?:mind\s*map|flow\s*chart|diagram|concept\s*map|relationship\s*map|timeline|fishbone)\b/iu

const ARTIFACT_MUTATION =
  /(?:生成|创建|绘制|画出|制作|做成|整理成|总结成|归纳成|转换成|转成|变成|改成)|\b(?:create|generate|draw|convert|turn|transform|organize|make|summari[sz]e\s+into)\b/iu

const ANALYSIS_OUTPUT =
  /(?:总结|摘要|解释|说明|分析|回答|建议|提取|翻译|识别)|\b(?:summari[sz]e|summary|explain|analysis|answer|advice|extract|translate|recognize|identify)\b/iu

const EXPLICIT_PLACEMENT =
  /(?:写入|写到|插入|添加到|放到|放在|放进|摆放|嵌入|替换|改写|更新)|\b(?:write|insert|add|put|place|embed|replace|rewrite|update)\b/iu

const COMMITTED_EDIT =
  /(?:写入|写到|插入|添加到|放到|放在|放进|摆放|嵌入|替换|改写|更新|改成|改为|显示为|渲染为)|\b(?:write|insert|add|put|place|embed|replace|rewrite|update|render|change\s+into)\b/iu

const ATTACHMENT_REFERENCE =
  /(?:附件|上传的|这张图片|这个文件|图片里|图像里|PDF\s*里)|\b(?:attachment|attached|uploaded|this\s+(?:image|file)|the\s+(?:image|file|pdf))\b/iu

const LAYOUT_TASK =
  /(?:优化|整理|调整|重排|重新|统一).{0,8}(?:布局|排版|位置|尺寸)|(?:重新排版|重新布局|排一下版)|(?:布局|排版|位置|尺寸).{0,8}(?:优化|整理|调整|重排|重新|统一)|\b(?:organize|reorganize|optimise|optimize|adjust|fix|redo).{0,24}(?:layout|placement|position|size)\b/iu

const AGENT_FOLLOW_UP =
  /^(?:继续|接着|继续执行|重试|再来一次|重新执行|可以[，,]?就按|好的?[，,]?就按|按这个方案做|应用这个方案|采纳这个方案|再(?:往|向|把|调整|移动|放|排|改)|然后(?:把|再)|往(?:左|右|上|下)|向(?:左|右|上|下)|把它|把这些|就这样改)|^(?:continue|keep\s+going|retry|try\s+again|go\s+with\s+that|apply\s+(?:that|this)\s+plan|move\s+it|put\s+it|adjust\s+it)\b/iu

const PRONOUN_TARGET =
  /(?:把|将)(?:它|这个|这些|那段|那张)|\b(?:move|put|place|adjust|resize|replace|rewrite)\s+(?:it|this|these|that)\b/iu

const WHOLE_PAGE_TARGET =
  /(?:整页|全页|整个页面|当前页全部|本页全部|所有(?:内容|元素|公式|图片|节点))|\b(?:whole|entire)\s+(?:page|canvas)\b|\ball\s+(?:content|elements?|formulas?|images?|nodes?)\b/iu

const IMPLICIT_SELECTION_TARGET =
  /(?:这段|这些|这个|该|此|分支)|\b(?:this|these|selected|selection|it)\b/iu

function normalizeInput(input: string) {
  return input.trim().replace(/\s+/g, ' ')
}

/** Routes concrete mind-map creation requests to the deterministic mind-map workflow. */
export function isMindMapGenerationIntent(input: string) {
  const text = normalizeInput(input)
  if (!text || CHAT_ONLY_OVERRIDE.test(text) || HOW_TO_QUESTION.test(text)) return false
  const mentionsMindMap = /(?:思维导图|脑图)|\bmind\s*map\b/iu.test(text)
  return mentionsMindMap && ARTIFACT_MUTATION.test(text)
}

/**
 * Locally routes a free-form AI request without making another model call.
 * Questions stay in chat; concrete canvas mutations run through the Agent draft.
 */
export function classifyAiIntent(input: string, context: AiIntentContext = {}): AiIntent {
  const text = normalizeInput(input)
  const hasAttachments = context.hasAttachments === true
  const hasActiveAgentDraft = context.hasActiveAgentDraft === true
  const hasAgentHistory = context.hasAgentHistory === true
  const hasSelection = context.hasSelection === true

  // An attachment by itself is something to discuss, not permission to edit the canvas.
  if (!text) return 'chat'

  // Explicit non-editing language always wins, even if the sentence mentions the canvas.
  if (CHAT_ONLY_OVERRIDE.test(text)) return 'chat'

  // Instructional questions describe an operation but do not ask reunote to perform it.
  if (HOW_TO_QUESTION.test(text)) return 'chat'

  const targetsCanvas = CANVAS_DESTINATION.test(text)
  const targetsSelection = SELECTED_TARGET.test(text)
  const targetsElement = EDITABLE_TARGET.test(text)
  const mutates = MUTATION.test(text)

  if (VISUAL_ARTIFACT.test(text) && ARTIFACT_MUTATION.test(text)) return 'agent'
  if (
    ANALYSIS_OUTPUT.test(text) &&
    !((targetsCanvas || targetsSelection || targetsElement) && COMMITTED_EDIT.test(text))
  ) {
    return 'chat'
  }
  if (
    hasAttachments &&
    ATTACHMENT_REFERENCE.test(text) &&
    !targetsCanvas &&
    !targetsSelection &&
    !EXPLICIT_PLACEMENT.test(text)
  ) {
    return 'chat'
  }
  if (targetsCanvas && mutates) return 'agent'
  if (targetsSelection && mutates) return 'agent'
  if (targetsElement && mutates) return 'agent'
  if (ATTACHMENT_REFERENCE.test(text) && mutates) return 'agent'
  if (hasSelection && PRONOUN_TARGET.test(text) && mutates) return 'agent'
  if (LAYOUT_TASK.test(text)) return 'agent'
  if ((hasActiveAgentDraft || hasAgentHistory) && AGENT_FOLLOW_UP.test(text)) return 'agent'

  // Reading, explaining, or summarizing attachments remains conversational unless one
  // of the explicit canvas mutations above was present.
  if (hasAttachments) return 'chat'
  if (EXPLANATION_REQUEST.test(text)) return 'chat'

  return 'chat'
}

/** Chooses the narrowest safe Agent scope while preserving the user's manual fallback. */
export function inferAiAgentScope(
  input: string,
  selectionCount: number,
  fallback: AiAgentScope = 'page'
): AiAgentScope {
  if (selectionCount <= 0) return 'page'
  const text = normalizeInput(input)
  if (WHOLE_PAGE_TARGET.test(text)) return 'page'
  if (SELECTED_TARGET.test(text) || IMPLICIT_SELECTION_TARGET.test(text)) return 'selection'
  return fallback
}
