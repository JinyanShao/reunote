# reunote

> 中文说明：[README.zh-CN.md](README.zh-CN.md)

A local-first infinite-canvas notebook for macOS. **No account, no login, no cloud
sync** — every note, attachment and setting stays in a SQLite file on your own Mac.

It borrows the free canvas from OneNote, block-based rich text from Notion,
backlinks from Obsidian and pressure ink from GoodNotes, and puts them in one
application that never asks you to sign in.

- **Stack** — React 18 + TypeScript + Vite + Tailwind + TipTap in a Tauri 2
  (Rust) shell, SQLite via rusqlite
- **Size** — ~80 TypeScript modules and ~4,300 lines of Rust; 211 frontend tests
  and 26 Rust tests run on every push
- **Status** — v1.0.0, universal binary (Apple Silicon + Intel), macOS 13+

---

## Install

1. Open `output/reunote-v1.0.0-macOS-universal.dmg`
2. Drag **reunote** into Applications
3. **The first launch only:** right-click the app → **Open**, then confirm
   **Open** in the dialog

Step 3 is required. The build is ad-hoc signed — there is no paid Apple Developer
certificate behind it — so Gatekeeper blocks a plain double-click the first time.
After one right-click launch, double-clicking works as usual.

If macOS claims the app is damaged, clear the quarantine attribute once:

```bash
xattr -cr "/Applications/reunote.app"
```

---

## What it does

### Infinite canvas

- Place anything anywhere; scroll to pan, `⌘`+scroll (or trackpad pinch) to zoom
- Element types: rich-text blocks, sticky notes, images, shapes, LaTeX formulas,
  code blocks, file attachments, audio, PDF pages
- Rubber-band selection, snapping with alignment guides, z-order, lock, rotate
- 120 steps of undo / redo
- Page backgrounds: grid, dots, ruled, narrow-ruled, blank

### Rich text

- Headings, bold / italic / underline / strikethrough, text colour, six
  highlights, super- and subscript
- Bullet, numbered and **task** lists, quotes, rules, syntax-highlighted code
  blocks, tables, links, images
- `/` opens the block command menu; selecting text raises a floating toolbar
- Markdown input shortcuts (`# `, `- `, `> `, ` ``` ` and friends)

### Ink

- Pressure pen (graphics tablet and Apple Pencil forwarding; mouse and trackpad
  get simulated pressure)
- Highlighter in multiply / screen blend, correct in both light and dark themes
- Eraser (whole stroke) and lasso selection for ink
- Strokes are stored as **vectors**, so they stay sharp at any zoom
- In dark mode, near-black ink is lightened for display only — the stored colour
  is untouched
- Shape tools: rectangle, ellipse, diamond, arrow, line, with fill, dashes and
  text labels

### Organising and finding

- Notebook → section → page, with nested sub-pages
- `#tags` are collected automatically; `[[Page title]]` builds a backlinks panel
- `⌘K` searches the whole library, and it is friendly to Chinese: no tokeniser,
  any substring matches
- Favourites, recently opened, and a trash that soft-deletes (restore or purge)
- Up to 50 version snapshots per page, roll back at any time

### Import and export

- Export to Markdown, PNG or PDF
- Import Markdown / text files, images, or any file as an attachment
- **PDF annotation** — an imported PDF is rendered page by page onto the canvas,
  so you can draw straight onto it
- Drag files into the window or paste an image with `⌘V`
- Whole-library backup to a `.jinyanbak` archive (attachments included) and
  one-click restore, backwards compatible with older backups

### AI (optional, bring your own key)

Fill in **endpoint / API key / model** under Settings → AI service.

- Works with any **OpenAI-compatible** service: OpenAI, DeepSeek, Qwen, Kimi,
  Zhipu GLM, SiliconFlow, OpenRouter, Ollama (local), LM Studio (local) — with
  one-click presets
- Also speaks the **Anthropic Messages** protocol
- Several services can be configured and switched; model lists, connectivity
  tests, temperature, max tokens and timeout are all exposed

**Text actions** — run on a selection, and the result can replace the original
in place:

| Group | Actions |
| --- | --- |
| Rewrite | polish, fix errors, shorten, expand, more formal, more casual, academic, to bullets, bullets to prose, continue |
| Translate | English, Simplified / Traditional Chinese, Japanese, Korean, French, German, Spanish, Russian, Portuguese, Arabic, Thai |
| Analyse | summarise, explain, keywords, extract to-dos, find problems, generate quiz questions |
| Generate | outline, table, step-by-step breakdown, title |

The floating toolbar in a text block has a ✨ button for the same rewrites and
translations without leaving the block.

**Canvas-level AI** — results land on the canvas and are undoable:

- **Tidy up** — fully local, reflows scattered elements into neat columns
- **Smart layout** — the model groups elements by topic into labelled columns
- **Mind map** — builds a node tree from the page and draws it with connectors
- **Sticky wall** — splits the content into coloured sticky notes
- **Write it up** — turns loose notes into a finished piece on a new page
- **Translate page** — renders the whole page into a target language on a new page

**Also**

- Side-panel chat with streaming output and optional chain-of-thought display;
  context scope can be the page, the section or the notebook
- **Handwriting / image OCR** — lasso ink, or select an image or PDF page, and
  "Recognise text" converts it with your configured multimodal model (tick
  "this model can read images" in settings)
- New pages can title themselves from their content (switchable)

> **On privacy:** the API key is written to the local SQLite database only.
> Requests go from the app's Rust layer straight to the endpoint you entered,
> through no third party. With no AI configured, the app makes no network
> requests at all.

---

## Shortcuts

| Action | Keys |
| --- | --- |
| Select / hand / text / sticky | `V` / `H` / `T` / `N` |
| Pen / highlighter / eraser / lasso | `P` / `M` / `E` / `L` |
| Rectangle / ellipse / arrow | `R` / `O` / `A` |
| Pan | hold `space` and drag, or two-finger swipe |
| Zoom | `⌘` + scroll / pinch, `⌘=` `⌘-` `⌘0` `⌘9` |
| Undo / redo | `⌘Z` / `⇧⌘Z` |
| Select all / duplicate / delete | `⌘A` / `⌘D` / `⌫` |
| Nudge | arrow keys (`⇧` for 10px) |
| Search / AI / sidebar | `⌘K` / `⌘J` / `⌘\` |
| New page / new section | `⌘N` / `⇧⌘N` |
| Save / export Markdown | `⌘S` / `⇧⌘E` |

Help → Keyboard shortcuts has the full list.

---

## Where the data lives

```
~/Library/Application Support/com.jinyanshao.reunote/
├── reunote.db         notes, structure, tags, versions, settings (SQLite)
└── attachments/       images, rendered PDF pages, file attachments
```

Settings → Data and backup shows the statistics and takes a backup; Help → Open
data folder jumps straight there.

---

## Building it yourself

Double-click **`Build reunote.command`**. The script:

1. checks for the Xcode command line tools and Node 20+
2. installs the Rust toolchain inside the project at `.build-tools/`, leaving the
   system alone
3. installs frontend dependencies and generates the icons
4. builds the `aarch64` + `x86_64` universal binary and packages a DMG into
   `output/`

By hand:

```bash
npm install
npx tauri build --target universal-apple-darwin
```

## Development

```bash
npm install
npm run dev          # Vite dev server on 127.0.0.1:5273
npm run app:dev      # the Tauri shell against that server
npm test             # vitest, 211 tests
npm run typecheck    # tsc --noEmit
```

The Rust side lives in `src-tauri/`:

```bash
cd src-tauri && cargo test
```

CI (`.github/workflows/ci.yml`) runs the typecheck, the frontend tests and a
production build on every push and pull request, and the Rust tests on macOS.

## Architecture

```
src/
├── components/        React views — canvas, editor, sidebar, dialogs
│   ├── canvas/        stage, element views, toolbars, agent preview overlay
│   ├── editor/        TipTap rich text and the slash menu
│   └── ai/            the AI side panel
├── lib/               state and logic, no JSX
│   ├── store.ts       zustand store: notebooks, pages, elements, undo
│   ├── agent/         AI session, canvas tools, layout skills
│   ├── ink.ts         perfect-freehand strokes → SVG paths
│   ├── pageFind.ts    substring search that works on Chinese
│   └── api.ts         the typed bridge to the Rust commands
└── main.tsx

src-tauri/src/
├── commands.rs        every Tauri command the frontend can call
├── db.rs              SQLite schema and migrations
├── ai.rs              AI forwarding, SSE streaming over a Tauri channel
├── files.rs           attachment storage
└── models.rs          the shared data types
```

- **Ink** — perfect-freehand produces variable-width outlines, stored as vector
  paths rather than bitmaps
- **Formulas** — KaTeX  **PDF** — pdf.js  **Markdown** — marked / turndown
- **Storage** — SQLite (rusqlite, bundled), so the library is one portable file
- **AI forwarding** — reqwest with SSE streamed back to the frontend over a
  Tauri channel, which keeps keys and endpoints out of the WebView

## Licence

MIT
