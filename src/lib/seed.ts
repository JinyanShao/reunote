import * as api from './api'
import { EMPTY_DOC, type CanvasDoc, type CanvasElement, type Stroke } from './types'
import { uid } from './utils'

function text(
  x: number,
  y: number,
  w: number,
  h: number,
  html: string,
  extra: Partial<CanvasElement> = {}
): CanvasElement {
  return {
    id: uid('el'),
    type: 'text',
    x,
    y,
    w,
    h,
    rotation: 0,
    z: 0,
    html,
    bg: 'transparent',
    border: 'transparent',
    fontFamily: 'sans',
    fontScale: 1,
    padding: 10,
    ...extra,
  } as CanvasElement
}

function sticky(x: number, y: number, html: string, color: string): CanvasElement {
  return {
    id: uid('el'),
    type: 'sticky',
    x,
    y,
    w: 210,
    h: 170,
    rotation: 0,
    z: 0,
    html,
    color,
  } as CanvasElement
}

function stroke(points: number[][], color: string, size: number, tool: 'pen' | 'highlighter'): Stroke {
  return { id: uid('st'), points, color, size, tool, z: 0 }
}

function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number, steps = 40) {
  const pts: number[][] = []
  for (let i = 0; i <= steps; i++) {
    const t = from + ((to - from) * i) / steps
    const p = Math.sin((Math.PI * i) / steps) * 0.6 + 0.4
    pts.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry, p])
  }
  return pts
}

function welcomeDoc(): CanvasDoc {
  const elements: CanvasElement[] = [
    text(
      80,
      60,
      560,
      120,
      '<h1>欢迎使用 reunote 👋</h1><p>这是一块<strong>无限画布</strong>：在任意位置双击就能写字，拖动可以移动，右下角可以缩放。</p>',
      { fontScale: 1 }
    ),
    text(
      80,
      210,
      420,
      250,
      '<h2>三秒上手</h2><ul><li>双击空白处 → 新建文本块</li><li>按 <code>V</code> 选择 / <code>H</code> 抓手 / <code>P</code> 画笔</li><li>按住 <code>空格</code> 拖动画布</li><li><code>⌘ + 滚轮</code> 缩放画布</li><li><code>⌘K</code> 全局搜索，<code>⌘J</code> 唤起 AI</li></ul>',
      { bg: '#ffffff', border: '#e4e7ee' }
    ),
    text(
      540,
      210,
      430,
      250,
      '<h2>待办清单</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked><span></span></label><div><p>安装 reunote</p></div></li><li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>在设置里填入自己的 AI 服务地址</p></div></li><li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>把旧笔记用 Markdown 导入进来</p></div></li></ul>',
      { bg: '#ffffff', border: '#e4e7ee' }
    ),
    sticky(
      1010,
      60,
      '<p><strong>便签</strong></p><p>随手记一句，颜色可以换。</p>',
      '#FEF3C7'
    ),
    sticky(1010, 250, '<p>支持 <code>#标签</code> 与 <code>[[双向链接]]</code>。</p>', '#DBEAFE'),
    {
      id: uid('el'),
      type: 'shape',
      x: 96,
      y: 510,
      w: 300,
      h: 150,
      rotation: 0,
      z: 0,
      shape: 'rect',
      stroke: '#6366f1',
      fill: '#eef2ff',
      strokeWidth: 2,
      dashed: false,
      label: '图形 + 文字标签',
    } as CanvasElement,
    {
      id: uid('el'),
      type: 'math',
      x: 440,
      y: 520,
      w: 300,
      h: 90,
      rotation: 0,
      z: 0,
      latex: 'e^{i\\pi} + 1 = 0',
      color: 'var(--ink-text)',
      display: true,
    } as CanvasElement,
    text(
      440,
      625,
      520,
      90,
      '<p>↑ 这是一个 <strong>LaTeX 公式块</strong>，双击即可编辑。下面那条是手绘墨迹。</p>'
    ),
  ]

  const strokes: Stroke[] = [
    stroke(arc(300, 760, 210, 44, Math.PI, 2 * Math.PI), '#f97316', 4, 'pen'),
    stroke(
      [
        [96, 700, 0.6],
        [180, 698, 0.9],
        [280, 702, 1],
        [380, 699, 0.8],
        [470, 701, 0.5],
      ],
      '#facc15',
      24,
      'highlighter'
    ),
  ]

  elements.forEach((e, i) => (e.z = i + 1))
  strokes.forEach((s, i) => (s.z = i + 1))

  return { ...EMPTY_DOC, background: 'grid', elements, strokes }
}

function quickStartDoc(): CanvasDoc {
  const elements: CanvasElement[] = [
    text(
      80,
      60,
      640,
      500,
      `<h1>能力速查</h1>
<h2>画布</h2>
<ul>
<li>元素：文本块、便签、图片、图形、公式、代码块、文件附件、PDF 页</li>
<li>多选框选、对齐吸附参考线、层级前后、锁定</li>
<li>撤销 <code>⌘Z</code> / 重做 <code>⇧⌘Z</code>，历史 120 步</li>
</ul>
<h2>手绘</h2>
<ul>
<li>压感画笔、荧光笔、橡皮（整笔擦除）、套索选择</li>
<li>笔迹以矢量存储，任意缩放都清晰</li>
</ul>
<h2>组织</h2>
<ul>
<li>笔记本 → 分区 → 页面 三级结构，支持子页面</li>
<li><code>#标签</code> 自动收集，<code>[[链接]]</code> 自动生成反向链接</li>
<li><code>⌘K</code> 全库搜索（中文友好），收藏、回收站、版本历史</li>
</ul>
<h2>AI</h2>
<ul>
<li>设置里填入任意 OpenAI 兼容服务的 <strong>地址 / 密钥 / 模型</strong></li>
<li>选中文字 → 润色、续写、翻译、总结、改写、解释、提取待办</li>
<li>侧边栏对话可携带当前页面 / 分区 / 笔记本作为上下文</li>
<li>密钥只存在本机数据库，不会外传给除你填写的服务之外的任何一方</li>
</ul>`,
      { bg: '#ffffff', border: '#e4e7ee' }
    ),
  ]
  elements.forEach((e, i) => (e.z = i + 1))
  return { ...EMPTY_DOC, background: 'dots', elements, strokes: [] }
}

export async function buildWelcome() {
  const nb = await api.createNotebook('我的笔记本', '#6C8CFF', 'book')
  const intro = await api.createSection(nb.id, '开始使用', '#6C8CFF')
  await api.createPage(intro.id, '欢迎使用 reunote', JSON.stringify(welcomeDoc()))
  await api.createPage(intro.id, '能力速查', JSON.stringify(quickStartDoc()))

  const daily = await api.createSection(nb.id, '日常记录', '#2DD4A7')
  await api.createPage(daily.id, '今天', JSON.stringify(EMPTY_DOC))

  const ideas = await api.createSection(nb.id, '灵感收集', '#A78BFA')
  await api.createPage(ideas.id, '想法池', JSON.stringify(EMPTY_DOC))
}
