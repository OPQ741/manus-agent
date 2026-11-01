/**
 * 本地生成引擎（Local Composer）
 *
 * 它不是"模板替换"，而是一条编译管线：
 *   prompt → ① 意图分类 → ② 槽位抽取 → ③ 配方选择 → ④ 代码发射 → ⑤ 协议序列化
 *
 * 设计约束：
 *  - 纯函数、零副作用、零网络：同样的输入必须产出同样的字节（可做黄金测试）；
 *  - 输出走 NWF 协议，和云模型完全相同的一条链路（上层无感）；
 *  - 产物是"能用的应用"：有真实交互、真实持久化、响应式、可访问。
 */

import type { DesignPrefs, FileEntry, Plan } from '../../shared/types'
import { parseProtocol } from './protocol'

export type Archetype =
  | 'expense'
  | 'todo'
  | 'notes'
  | 'pomodoro'
  | 'kanban'
  | 'calculator'
  | 'landing'

export interface Tokens {
  accent: string
  accentSoft: string
  accentInk: string
  theme: 'light' | 'dark'
}

export interface Slots {
  archetype: Archetype
  name: string
  tagline: string
  currency: string
  fields: string[]
  tokens: Tokens
  locale: 'zh' | 'en'
}

interface ArchetypeSpec {
  id: Archetype
  label: string
  keywords: [string, number][]
  defaultName: string
  tagline: string
}

const ARCHETYPES: ArchetypeSpec[] = [
  {
    id: 'expense',
    label: '记账',
    keywords: [
      ['记账', 6], ['账本', 6], ['花销', 5], ['开支', 5], ['收支', 5], ['消费', 4], ['预算', 4],
      ['账单', 5], ['理财', 3], ['钱', 2], ['expense', 5], ['budget', 4], ['spending', 4],
    ],
    defaultName: '随手记账',
    tagline: '每一笔记下来，钱就清楚了',
  },
  {
    id: 'todo',
    label: '待办',
    keywords: [
      ['待办', 6], ['任务', 5], ['清单', 5], ['打卡', 5], ['计划', 3], ['提醒', 3], ['to-do', 5],
      ['todo', 5], ['task', 4], ['checklist', 5],
    ],
    defaultName: '今日待办',
    tagline: '把脑子里的东西，挪到清单上',
  },
  {
    id: 'notes',
    label: '笔记',
    keywords: [['笔记', 6], ['备忘', 5], ['灵感', 4], ['速记', 5], ['收藏', 3], ['note', 5], ['memo', 4]],
    defaultName: '灵感便签',
    tagline: '想到就写，别让它跑掉',
  },
  {
    id: 'pomodoro',
    label: '番茄钟',
    keywords: [['番茄', 7], ['专注', 5], ['计时', 5], ['倒计时', 5], ['pomodoro', 7], ['focus', 4], ['timer', 4]],
    defaultName: '番茄专注',
    tagline: '25 分钟，只做一件事',
  },
  {
    id: 'kanban',
    label: '看板',
    keywords: [['看板', 6], ['kanban', 6], ['board', 4], ['流程', 3], ['进度', 3], ['迭代', 3], ['拖拽', 3]],
    defaultName: '轻量看板',
    tagline: '待办、进行中、已完成',
  },
  {
    id: 'calculator',
    label: '计算器',
    keywords: [['计算器', 7], ['换算', 6], ['公式', 4], ['calculator', 7], ['calc', 4], ['汇率', 4]],
    defaultName: '极简计算器',
    tagline: '算得清楚，也看得清楚',
  },
  {
    id: 'landing',
    label: '落地页',
    keywords: [
      ['落地页', 7], ['官网', 6], ['主页', 4], ['介绍', 3], ['产品页', 6], ['宣传', 4], ['landing', 6],
      ['website', 4], ['首页', 3], ['portfolio', 5], ['简历', 4],
    ],
    defaultName: '产品落地页',
    tagline: '一句话说清你解决什么问题',
  },
]

const COLOR_WORDS: [string, string][] = [
  ['墨绿', '#12715B'], ['深绿', '#12715B'], ['绿', '#12715B'],
  ['紫', '#4B3BFF'], ['靛蓝', '#4B3BFF'], ['蓝紫', '#4B3BFF'],
  ['橙', '#C2703A'], ['琥珀', '#C2703A'], ['暖黄', '#C2703A'],
  ['红', '#C2405C'], ['玫红', '#C2405C'], ['粉', '#C2405C'],
  ['蓝', '#2563C9'], ['天蓝', '#2563C9'], ['青', '#0E7490'],
  ['黑', '#1F2124'], ['灰', '#4B5563'],
]

export function isDarkWord(prompt: string): boolean {
  return /深色|暗黑|夜间|暗色|dark\s*mode|黑夜/i.test(prompt)
}

/** ① 意图分类：加权词表 + 稳定 tie-break（同输入必同输出）。 */
export function classify(prompt: string): { archetype: Archetype; score: number; matched: string[] } {
  const text = prompt.toLowerCase()
  let best: { archetype: Archetype; score: number; matched: string[] } = {
    archetype: 'landing',
    score: 0,
    matched: [],
  }
  for (const spec of ARCHETYPES) {
    let score = 0
    const matched: string[] = []
    for (const [word, weight] of spec.keywords) {
      if (text.includes(word)) {
        score += weight
        matched.push(word)
      }
    }
    if (score > best.score || (score === best.score && score > 0 && spec.id < best.archetype)) {
      best = { archetype: spec.id, score, matched }
    }
  }
  if (best.score === 0) {
    // 没有任何命中：按长度区分"想要个页面"还是"想要个工具"
    const fallback: Archetype = prompt.trim().length > 24 ? 'landing' : 'notes'
    return { archetype: fallback, score: 0, matched: [] }
  }
  return best
}

function pickAccent(prompt: string, design: DesignPrefs): string {
  for (const [word, color] of COLOR_WORDS) {
    if (new RegExp(`(?:主色|颜色|配色|主题色|用)\\s*(?:是|用|改成|换成)?\\s*[「"']?${word}`).test(prompt)) return color
  }
  return design.accent
}

function lighten(hex: string, ratio: number): string {
  const value = hex.replace('#', '')
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  const mix = (channel: number) => Math.round(channel + (255 - channel) * ratio)
  return '#' + [mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, '0')).join('')
}

function contrastInk(hex: string): string {
  const value = hex.replace('#', '')
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.62 ? '#14140F' : '#FFFFFF'
}

function extractName(prompt: string, spec: ArchetypeSpec): string {
  const quoted = /(?:叫|名为|名称是|名字叫)\s*[「"'“]([^」"'”]{1,16})[」"'”]/.exec(prompt)
  if (quoted?.[1]) return quoted[1]
  const bare = /(?:叫|名为)\s*([\u4e00-\u9fa5A-Za-z0-9]{2,12})(?:的|，|,|。|$)/.exec(prompt)
  if (bare?.[1]) return bare[1]
  return spec.defaultName
}

function defaultFields(archetype: Archetype): string[] {
  switch (archetype) {
    case 'expense':
      return ['金额', '分类', '备注']
    case 'todo':
      return ['事项', '截止时间']
    case 'notes':
      return ['标题', '正文']
    case 'kanban':
      return ['任务', '负责']
    default:
      return []
  }
}

/** ② 槽位抽取 */
export function extractSlots(prompt: string, design: DesignPrefs): Slots {
  const { archetype } = classify(prompt)
  const spec = ARCHETYPES.find((item) => item.id === archetype)!
  const accent = pickAccent(prompt, design)
  const theme: 'light' | 'dark' = isDarkWord(prompt) || design.theme === 'dark' ? 'dark' : 'light'
  const currencyMatch = /(美元|美金|USD|\$)|\b(日元|JPY)\b/i.exec(prompt)
  const currency = currencyMatch ? (/(美元|美金|USD|\$)/i.test(currencyMatch[0]) ? '$' : '¥') : '¥'

  const fieldsMatch = /(?:记录|包含|字段(?:有|是)?)\s*([^。.\n]{2,40})/.exec(prompt)
  const fields = fieldsMatch?.[1]
    ? fieldsMatch[1]
        .split(/[、,，和及\/]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s.length <= 8)
        .slice(0, 4)
    : defaultFields(archetype)

  return {
    archetype,
    name: extractName(prompt, spec),
    tagline: spec.tagline,
    currency,
    fields,
    locale: design.locale,
    tokens: {
      accent,
      accentSoft: lighten(accent, 0.86),
      accentInk: contrastInk(accent),
      theme,
    },
  }
}

export function planFor(slots: Slots): Plan {
  const spec = ARCHETYPES.find((item) => item.id === slots.archetype)!
  return {
    name: slots.name,
    summary: `${spec.label}应用 · ${spec.tagline}`,
    stack: 'HTML + CSS + 原生 JavaScript（零框架、零构建）',
    steps: [
      '确定信息结构与交互（表单 → 列表 → 汇总）',
      '生成响应式布局与设计令牌',
      '实现状态管理与本地持久化',
      '自检：入口文件、引用完整性、沙箱安全',
    ],
    files: [
      { path: 'index.html', purpose: '页面骨架与语义结构' },
      { path: 'styles.css', purpose: '设计令牌、布局与组件样式' },
      { path: 'app.js', purpose: '状态、渲染与 localStorage 持久化' },
      { path: 'README.md', purpose: '如何运行与二次开发说明' },
    ],
  }
}

/* ------------------------------------------------------------------ */
/* 代码发射                                                            */
/* ------------------------------------------------------------------ */

function baseCss(slots: Slots): string {
  const { tokens } = slots
  return `:root {
  --accent: ${tokens.accent};
  --accent-soft: ${tokens.accentSoft};
  --accent-ink: ${tokens.accentInk};
  --bg: #FBFAF8;
  --surface: #FFFFFF;
  --ink: #16161A;
  --muted: #6E6E78;
  --line: #E9E7E2;
  --danger: #C2405C;
  --radius: 14px;
  --shadow: 0 1px 2px rgba(20, 20, 15, .04), 0 8px 24px rgba(20, 20, 15, .06);
}
[data-theme="dark"] {
  --bg: #14141A;
  --surface: #1C1C24;
  --ink: #F2F1ED;
  --muted: #9C9CA8;
  --line: #2A2A35;
  --accent-soft: #232333;
  --shadow: 0 1px 2px rgba(0, 0, 0, .5), 0 12px 32px rgba(0, 0, 0, .4);
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 15px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  padding: 28px 18px 56px;
}
.shell { max-width: 760px; margin: 0 auto; }
.top { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 22px; }
.brand { display: flex; align-items: center; gap: 9px; font-size: 20px; font-weight: 650; letter-spacing: -.01em; }
.brand .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
.tagline { margin: 0; color: var(--muted); font-size: 13px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); }
.main { display: grid; gap: 16px; }
.foot { margin-top: 28px; text-align: center; color: var(--muted); font-size: 12px; }
.row { display: flex; gap: 10px; }
input, select, textarea, button { font: inherit; color: inherit; }
input, select, textarea {
  width: 100%; padding: 11px 13px; border: 1px solid var(--line); border-radius: 10px;
  background: var(--surface); outline: none; transition: border-color .15s ease, box-shadow .15s ease;
}
input:focus, select:focus, textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
button {
  cursor: pointer; border: 1px solid transparent; border-radius: 10px; padding: 11px 16px;
  background: var(--accent); color: var(--accent-ink); font-weight: 600;
  transition: transform .12s ease, filter .15s ease, background .15s ease;
}
button:hover { filter: brightness(1.05); }
button:active { transform: translateY(1px); }
button.ghost { background: transparent; color: var(--ink); border-color: var(--line); font-weight: 500; }
button.ghost:hover { border-color: var(--accent); color: var(--accent); }
button.danger { background: transparent; color: var(--danger); border-color: transparent; padding: 6px 8px; }
.muted { color: var(--muted); }
.mono { font-variant-numeric: tabular-nums; }
.chip {
  display: inline-flex; align-items: center; gap: 6px; padding: 6px 11px; border-radius: 999px;
  border: 1px solid var(--line); background: var(--surface); color: var(--muted); font-size: 13px; cursor: pointer;
}
.chip[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); font-weight: 600; }
.empty { padding: 34px 18px; text-align: center; color: var(--muted); font-size: 13px; }
.toast {
  position: fixed; left: 50%; bottom: 26px; transform: translate(-50%, 16px);
  background: #16161A; color: #fff; padding: 10px 16px; border-radius: 10px; font-size: 13px;
  opacity: 0; pointer-events: none; transition: opacity .2s ease, transform .2s ease; z-index: 20;
}
.toast.show { opacity: 1; transform: translate(-50%, 0); }
@media (max-width: 560px) {
  body { padding: 18px 12px 44px; }
  .row { flex-direction: column; }
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}`
}

function shellHtml(slots: Slots, body: string, extraClass = ''): string {
  const theme = slots.tokens.theme
  return `<!DOCTYPE html>
<html lang="${slots.locale === 'en' ? 'en' : 'zh-CN'}" data-theme="${theme}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="${slots.tagline}" />
  <title>${slots.name}</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <div class="shell ${extraClass}">
    <header class="top">
      <h1 class="brand"><span class="dot"></span>${slots.name}</h1>
      <p class="tagline">${slots.tagline}</p>
    </header>
    <main class="main">
${body}
    </main>
    <footer class="foot">数据保存在浏览器本地 · 由 Nucleus 生成</footer>
  </div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <script src="app.js"></script>
</body>
</html>`
}

const EXPENSE_HELPERS = `function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {}
  return [
    { id: 's1', amount: 38, category: '餐饮', note: '楼下的牛肉面', date: today(0) },
    { id: 's2', amount: 12, category: '交通', note: '地铁来回', date: today(-1) }
  ];
}
function persist(rows) {
  try { localStorage.setItem(KEY, JSON.stringify(rows)); } catch (e) {}
}
function today(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function money(n) { return CURRENCY + Number(n || 0).toFixed(2); }
function toast(text) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { el.classList.remove('show'); }, 1800);
}
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}`

interface RecipeOutput {
  body: string
  css: string
  js: string
}

function expenseRecipe(slots: Slots): RecipeOutput {
  const currency = slots.currency
  const body = `      <section class="card summary">
        <div>
          <p class="label">本月支出</p>
          <p class="amount mono" id="total">${currency}0.00</p>
        </div>
        <div class="summary-side">
          <p class="label">笔数</p>
          <p class="count mono" id="count">0</p>
        </div>
      </section>

      <section class="card form">
        <form id="form" novalidate>
          <div class="row">
            <label class="field">
              <span>金额</span>
              <input id="amount" name="amount" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00" required />
            </label>
            <label class="field">
              <span>分类</span>
              <select id="category" name="category">
                <option>餐饮</option><option>交通</option><option>购物</option><option>居住</option><option>娱乐</option><option>其他</option>
              </select>
            </label>
          </div>
          <label class="field">
            <span>备注</span>
            <input id="note" name="note" type="text" maxlength="40" placeholder="花在哪了？" />
          </label>
          <button type="submit">记一笔</button>
        </form>
      </section>

      <section class="card">
        <div class="list-head">
          <h2>近期记录</h2>
          <div class="chips" id="filters">
            <button class="chip" type="button" data-filter="all" aria-pressed="true">全部</button>
            <button class="chip" type="button" data-filter="餐饮" aria-pressed="false">餐饮</button>
            <button class="chip" type="button" data-filter="交通" aria-pressed="false">交通</button>
            <button class="chip" type="button" data-filter="购物" aria-pressed="false">购物</button>
          </div>
        </div>
        <ul class="list" id="list"></ul>
        <div class="empty" id="empty" hidden>还没有记录，先记第一笔吧。</div>
      </section>

      <section class="card bars" id="bars-wrap" hidden>
        <h2>分类占比</h2>
        <div id="bars"></div>
      </section>`

  const css = `.summary { display: flex; justify-content: space-between; align-items: flex-end; padding: 18px 20px; }
.label { margin: 0 0 4px; font-size: 12px; color: var(--muted); }
.amount { margin: 0; font-size: 30px; font-weight: 680; letter-spacing: -.02em; color: var(--accent); }
.count { margin: 0; font-size: 20px; font-weight: 600; }
.summary-side { text-align: right; }
.form { padding: 18px 20px; }
.field { display: grid; gap: 6px; font-size: 13px; color: var(--muted); flex: 1; }
.form form { display: grid; gap: 12px; }
.list-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 16px 20px 8px; flex-wrap: wrap; }
.list-head h2, .bars h2 { margin: 0; font-size: 14px; font-weight: 620; }
.chips { display: flex; gap: 8px; flex-wrap: wrap; }
.list { list-style: none; margin: 0; padding: 4px 8px 12px; }
.item { display: flex; align-items: center; gap: 12px; padding: 12px 12px; border-radius: 10px; }
.item + .item { border-top: 1px solid var(--line); border-radius: 0; }
.item-main { flex: 1; min-width: 0; }
.item-title { margin: 0; font-size: 14px; font-weight: 560; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-sub { margin: 2px 0 0; font-size: 12px; color: var(--muted); }
.item-amount { font-weight: 620; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); }
.bars { padding: 18px 20px; }
.bar-row { display: grid; grid-template-columns: 56px 1fr 68px; align-items: center; gap: 10px; font-size: 13px; margin-top: 10px; }
.bar { height: 8px; border-radius: 999px; background: var(--line); overflow: hidden; }
.bar > span { display: block; height: 100%; background: var(--accent); border-radius: 999px; transition: width .3s ease; }`

  const js = `const KEY = 'nucleus:expense:v1';
const CURRENCY = '${currency}';
${EXPENSE_HELPERS}

let rows = load();
let filter = 'all';
const form = document.getElementById('form');
const list = document.getElementById('list');
const empty = document.getElementById('empty');
const totalEl = document.getElementById('total');
const countEl = document.getElementById('count');

form.addEventListener('submit', function (event) {
  event.preventDefault();
  const amount = Number(document.getElementById('amount').value);
  if (!amount || amount <= 0) { toast('请输入有效金额'); return; }
  rows.unshift({
    id: uid(),
    amount: amount,
    category: document.getElementById('category').value,
    note: document.getElementById('note').value.trim(),
    date: today(0),
  });
  form.reset();
  persist(rows);
  render();
  toast('已记一笔');
});

document.getElementById('filters').addEventListener('click', function (event) {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  filter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(function (el) {
    el.setAttribute('aria-pressed', String(el.dataset.filter === filter));
  });
  render();
});

list.addEventListener('click', function (event) {
  const button = event.target.closest('[data-remove]');
  if (!button) return;
  rows = rows.filter(function (row) { return row.id !== button.dataset.remove; });
  persist(rows);
  render();
  toast('已删除');
});

function visible() {
  return filter === 'all' ? rows : rows.filter(function (row) { return row.category === filter; });
}

function render() {
  const items = visible();
  list.innerHTML = items.map(function (row) {
    return '<li class="item">' +
      '<div class="item-main"><p class="item-title">' + escapeHtml(row.note || row.category) + '</p>' +
      '<p class="item-sub">' + escapeHtml(row.date) + '</p></div>' +
      '<span class="badge">' + escapeHtml(row.category) + '</span>' +
      '<span class="item-amount mono">' + money(row.amount) + '</span>' +
      '<button class="danger" data-remove="' + escapeHtml(row.id) + '" aria-label="删除">✕</button>' +
      '</li>';
  }).join('');
  empty.hidden = items.length > 0;
  const total = rows.reduce(function (sum, row) { return sum + Number(row.amount || 0); }, 0);
  totalEl.textContent = money(total);
  countEl.textContent = String(rows.length);
  renderBars();
}

function renderBars() {
  const wrap = document.getElementById('bars-wrap');
  if (!rows.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const groups = {};
  rows.forEach(function (row) { groups[row.category] = (groups[row.category] || 0) + Number(row.amount || 0); });
  const entries = Object.keys(groups).map(function (key) { return [key, groups[key]]; })
    .sort(function (a, b) { return b[1] - a[1]; });
  const max = entries[0][1] || 1;
  document.getElementById('bars').innerHTML = entries.map(function (entry) {
    return '<div class="bar-row"><span>' + escapeHtml(entry[0]) + '</span>' +
      '<span class="bar"><span style="width:' + Math.round((entry[1] / max) * 100) + '%"></span></span>' +
      '<span class="mono muted">' + money(entry[1]) + '</span></div>';
  }).join('');
}

render();`

  return { body, css, js }
}

function todoRecipe(_slots: Slots): RecipeOutput {
  const body = `      <section class="card form">
        <form id="form" novalidate>
          <div class="row">
            <label class="field" style="flex:2">
              <span>要做什么</span>
              <input id="text" type="text" maxlength="60" placeholder="例如：写完笔试的说明文档" required />
            </label>
            <label class="field">
              <span>截止</span>
              <input id="due" type="date" />
            </label>
          </div>
          <button type="submit">加入清单</button>
        </form>
      </section>

      <section class="card">
        <div class="list-head">
          <h2>清单 <span class="muted" id="progress"></span></h2>
          <div class="chips" id="filters">
            <button class="chip" type="button" data-filter="all" aria-pressed="true">全部</button>
            <button class="chip" type="button" data-filter="open" aria-pressed="false">未完成</button>
            <button class="chip" type="button" data-filter="done" aria-pressed="false">已完成</button>
          </div>
        </div>
        <ul class="list" id="list"></ul>
        <div class="empty" id="empty" hidden>清单是空的，先加一条。</div>
      </section>`

  const css = `.form { padding: 18px 20px; }
.form form { display: grid; gap: 12px; }
.field { display: grid; gap: 6px; font-size: 13px; color: var(--muted); }
.list-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 16px 20px 8px; flex-wrap: wrap; }
.list-head h2 { margin: 0; font-size: 14px; font-weight: 620; }
.chips { display: flex; gap: 8px; }
.list { list-style: none; margin: 0; padding: 4px 8px 12px; }
.item { display: flex; align-items: center; gap: 12px; padding: 12px; border-radius: 10px; }
.item + .item { border-top: 1px solid var(--line); border-radius: 0; }
.item input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--accent); flex: 0 0 auto; }
.item-main { flex: 1; min-width: 0; }
.item-title { margin: 0; font-size: 14px; font-weight: 550; }
.item.done .item-title { text-decoration: line-through; color: var(--muted); }
.item-sub { margin: 2px 0 0; font-size: 12px; color: var(--muted); }
.danger { background: transparent; border: 0; color: var(--muted); cursor: pointer; padding: 4px 6px; }`

  const js = `const KEY = 'nucleus:todo:v1';
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) return parsed;
  } catch (e) {}
  return [
    { id: 'a1', text: '读一遍需求文档', done: true, due: '' },
    { id: 'a2', text: '写下第一个版本', done: false, due: '' }
  ];
}
function persist(rows) { try { localStorage.setItem(KEY, JSON.stringify(rows)); } catch (e) {} }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { el.classList.remove('show'); }, 1600);
}
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

let rows = load();
let filter = 'all';
const list = document.getElementById('list');
const empty = document.getElementById('empty');

document.getElementById('form').addEventListener('submit', function (event) {
  event.preventDefault();
  const input = document.getElementById('text');
  const text = input.value.trim();
  if (!text) { toast('先写点什么'); return; }
  rows.unshift({ id: uid(), text: text, done: false, due: document.getElementById('due').value });
  persist(rows);
  input.value = '';
  render();
});

document.getElementById('filters').addEventListener('click', function (event) {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  filter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(function (el) {
    el.setAttribute('aria-pressed', String(el.dataset.filter === filter));
  });
  render();
});

list.addEventListener('click', function (event) {
  const toggle = event.target.closest('[data-toggle]');
  if (toggle) {
    const id = toggle.dataset.toggle;
    rows = rows.map(function (row) { return row.id === id ? Object.assign({}, row, { done: !row.done }) : row; });
    persist(rows); render(); return;
  }
  const remove = event.target.closest('[data-remove]');
  if (remove) {
    rows = rows.filter(function (row) { return row.id !== remove.dataset.remove; });
    persist(rows); render();
  }
});

function render() {
  const items = rows.filter(function (row) {
    if (filter === 'open') return !row.done;
    if (filter === 'done') return row.done;
    return true;
  });
  list.innerHTML = items.map(function (row) {
    return '<li class="item' + (row.done ? ' done' : '') + '">' +
      '<input type="checkbox" data-toggle="' + escapeHtml(row.id) + '"' + (row.done ? ' checked' : '') + ' aria-label="完成" />' +
      '<div class="item-main"><p class="item-title">' + escapeHtml(row.text) + '</p>' +
      (row.due ? '<p class="item-sub">截止 ' + escapeHtml(row.due) + '</p>' : '') + '</div>' +
      '<button class="danger" data-remove="' + escapeHtml(row.id) + '" aria-label="删除">✕</button>' +
      '</li>';
  }).join('');
  empty.hidden = items.length > 0;
  const done = rows.filter(function (row) { return row.done; }).length;
  document.getElementById('progress').textContent = rows.length ? done + '/' + rows.length + ' 完成' : '';
}
render();`

  return { body, css, js }
}

function notesRecipe(_slots: Slots): RecipeOutput {
  const body = `      <section class="card form">
        <form id="form" novalidate>
          <label class="field">
            <span>标题</span>
            <input id="title" type="text" maxlength="40" placeholder="一句话标题" required />
          </label>
          <label class="field">
            <span>正文</span>
            <textarea id="body" rows="3" maxlength="600" placeholder="想到什么写什么…"></textarea>
          </label>
          <button type="submit">保存便签</button>
        </form>
      </section>

      <section class="grid" id="grid"></section>
      <div class="empty" id="empty" hidden>还没有便签。</div>`

  const css = `.form { padding: 18px 20px; }
.form form { display: grid; gap: 12px; }
.field { display: grid; gap: 6px; font-size: 13px; color: var(--muted); }
textarea { resize: vertical; min-height: 76px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; }
.note { padding: 16px; display: flex; flex-direction: column; gap: 8px; min-height: 120px; }
.note h3 { margin: 0; font-size: 14px; font-weight: 620; }
.note p { margin: 0; font-size: 13px; color: var(--muted); white-space: pre-wrap; word-break: break-word; }
.note footer { margin-top: auto; display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--muted); }
.danger { background: transparent; border: 0; color: var(--muted); cursor: pointer; }`

  const js = `const KEY = 'nucleus:notes:v1';
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) return parsed;
  } catch (e) {}
  return [{ id: 'n1', title: '欢迎使用', body: '这条便签保存在浏览器本地，刷新后还在。', at: Date.now() }];
}
function persist(rows) { try { localStorage.setItem(KEY, JSON.stringify(rows)); } catch (e) {} }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
let rows = load();
const grid = document.getElementById('grid');
const empty = document.getElementById('empty');

document.getElementById('form').addEventListener('submit', function (event) {
  event.preventDefault();
  const title = document.getElementById('title').value.trim();
  if (!title) return;
  rows.unshift({ id: uid(), title: title, body: document.getElementById('body').value.trim(), at: Date.now() });
  persist(rows);
  event.target.reset();
  render();
});

grid.addEventListener('click', function (event) {
  const button = event.target.closest('[data-remove]');
  if (!button) return;
  rows = rows.filter(function (row) { return row.id !== button.dataset.remove; });
  persist(rows); render();
});

function render() {
  grid.innerHTML = rows.map(function (row) {
    return '<article class="card note"><h3>' + escapeHtml(row.title) + '</h3>' +
      '<p>' + escapeHtml(row.body) + '</p>' +
      '<footer><span>' + new Date(row.at).toLocaleDateString() + '</span>' +
      '<button class="danger" data-remove="' + escapeHtml(row.id) + '">删除</button></footer></article>';
  }).join('');
  empty.hidden = rows.length > 0;
}
render();`

  return { body, css, js }
}

function pomodoroRecipe(_slots: Slots): RecipeOutput {
  const body = `      <section class="card timer">
        <div class="ring" id="ring" style="--p:0">
          <div class="ring-inner">
            <p class="phase" id="phase">专注</p>
            <p class="clock mono" id="clock">25:00</p>
          </div>
        </div>
        <div class="controls">
          <button id="start">开始</button>
          <button class="ghost" id="reset">重置</button>
        </div>
        <p class="hint muted" id="hint">完成一轮就休息 5 分钟</p>
      </section>

      <section class="card log">
        <h2>今日记录</h2>
        <p class="mono muted" id="count">0 个番茄</p>
        <ul class="dots" id="dots"></ul>
      </section>`

  const css = `.timer { padding: 26px 20px; display: grid; justify-items: center; gap: 18px; }
.ring {
  --p: 0; width: 220px; height: 220px; border-radius: 50%;
  background: conic-gradient(var(--accent) calc(var(--p) * 1%), var(--line) 0);
  display: grid; place-items: center; transition: background .3s linear;
}
.ring-inner { width: 186px; height: 186px; border-radius: 50%; background: var(--surface); display: grid; place-items: center; gap: 2px; }
.phase { margin: 0; font-size: 12px; letter-spacing: .16em; text-transform: uppercase; color: var(--muted); }
.clock { margin: 0; font-size: 40px; font-weight: 660; letter-spacing: -.02em; }
.controls { display: flex; gap: 10px; }
.hint { margin: 0; font-size: 12px; }
.log { padding: 18px 20px; }
.log h2 { margin: 0 0 4px; font-size: 14px; font-weight: 620; }
.dots { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; padding: 10px 0 0; margin: 0; }
.dots li { width: 12px; height: 12px; border-radius: 50%; background: var(--accent); }`

  const js = `const DURATION = 25 * 60;
const KEY = 'nucleus:pomodoro:v1';
let left = DURATION;
let running = false;
let tick = null;
let done = 0;
try { done = Number(localStorage.getItem(KEY) || 0) || 0; } catch (e) {}

const clock = document.getElementById('clock');
const ring = document.getElementById('ring');
const phase = document.getElementById('phase');
const startBtn = document.getElementById('start');

function paint() {
  const m = Math.floor(left / 60);
  const s = left % 60;
  clock.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  ring.style.setProperty('--p', String(Math.round(((DURATION - left) / DURATION) * 100)));
  document.title = (running ? clock.textContent + ' · ' : '') + '番茄专注';
}

function stop() {
  running = false;
  clearInterval(tick);
  startBtn.textContent = '继续';
  phase.textContent = '已暂停';
}

function complete() {
  stop();
  left = DURATION;
  done += 1;
  try { localStorage.setItem(KEY, String(done)); } catch (e) {}
  paint();
  startBtn.textContent = '再来一轮';
  phase.textContent = '完成';
  renderLog();
}

startBtn.addEventListener('click', function () {
  if (running) { stop(); return; }
  running = true;
  phase.textContent = '专注';
  startBtn.textContent = '暂停';
  tick = setInterval(function () {
    left -= 1;
    if (left <= 0) { complete(); return; }
    paint();
  }, 1000);
});

document.getElementById('reset').addEventListener('click', function () {
  stop();
  left = DURATION;
  startBtn.textContent = '开始';
  phase.textContent = '专注';
  paint();
});

function renderLog() {
  document.getElementById('count').textContent = done + ' 个番茄';
  const dots = [];
  for (let i = 0; i < Math.min(done, 40); i++) dots.push('<li></li>');
  document.getElementById('dots').innerHTML = dots.join('');
}

paint();
renderLog();`

  return { body, css, js }
}

function kanbanRecipe(_slots: Slots): RecipeOutput {
  const body = `      <section class="card form">
        <form id="form" novalidate>
          <div class="row">
            <label class="field" style="flex:2">
              <span>任务</span>
              <input id="text" type="text" maxlength="60" placeholder="要做什么？" required />
            </label>
            <label class="field">
              <span>负责人</span>
              <input id="owner" type="text" maxlength="12" placeholder="我" />
            </label>
            <button type="submit">添加</button>
          </div>
        </form>
      </section>

      <section class="board" id="board"></section>`

  const css = `.form { padding: 16px 18px; }
.form form { display: grid; gap: 12px; }
.form .row { align-items: flex-end; }
.field { display: grid; gap: 6px; font-size: 13px; color: var(--muted); }
.board { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.col { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; min-height: 180px; }
.col h2 { margin: 0 0 10px; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); display: flex; justify-content: space-between; }
.card-item { background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; }
.card-item p { margin: 0; font-size: 13px; }
.card-item footer { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; gap: 6px; }
.tiny { font-size: 11px; color: var(--muted); border: 1px solid var(--line); background: transparent; border-radius: 6px; padding: 2px 6px; cursor: pointer; color: var(--muted); }
@media (max-width: 640px) { .board { grid-template-columns: 1fr; } }`

  const js = `const COLUMNS = [
  { id: 'todo', label: '待办' },
  { id: 'doing', label: '进行中' },
  { id: 'done', label: '已完成' }
];
const KEY = 'nucleus:kanban:v1';
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) return parsed;
  } catch (e) {}
  return [
    { id: 'k1', text: '收集需求', owner: '我', col: 'done' },
    { id: 'k2', text: '画出首页草稿', owner: '我', col: 'doing' },
    { id: 'k3', text: '接入数据持久化', owner: '', col: 'todo' }
  ];
}
function persist(rows) { try { localStorage.setItem(KEY, JSON.stringify(rows)); } catch (e) {} }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
let rows = load();
const board = document.getElementById('board');

document.getElementById('form').addEventListener('submit', function (event) {
  event.preventDefault();
  const text = document.getElementById('text').value.trim();
  if (!text) return;
  rows.unshift({ id: uid(), text: text, owner: document.getElementById('owner').value.trim(), col: 'todo' });
  persist(rows);
  document.getElementById('text').value = '';
  render();
});

board.addEventListener('click', function (event) {
  const move = event.target.closest('[data-move]');
  if (move) {
    rows = rows.map(function (row) {
      return row.id === move.dataset.id ? Object.assign({}, row, { col: move.dataset.move }) : row;
    });
    persist(rows); render(); return;
  }
  const remove = event.target.closest('[data-remove]');
  if (remove) {
    rows = rows.filter(function (row) { return row.id !== remove.dataset.remove; });
    persist(rows); render();
  }
});

function render() {
  board.innerHTML = COLUMNS.map(function (column) {
    const items = rows.filter(function (row) { return row.col === column.id; });
    const next = COLUMNS[(COLUMNS.indexOf(column) + 1) % COLUMNS.length];
    return '<section class="col"><h2>' + column.label + '<span>' + items.length + '</span></h2>' +
      items.map(function (row) {
        return '<article class="card-item"><p>' + escapeHtml(row.text) + '</p>' +
          '<footer><span class="tiny">' + escapeHtml(row.owner || '未指派') + '</span>' +
          '<span><button class="tiny" data-move="' + next.id + '" data-id="' + escapeHtml(row.id) + '">→ ' + next.label + '</button>' +
          '<button class="tiny" data-remove="' + escapeHtml(row.id) + '">✕</button></span></footer></article>';
      }).join('') + '</section>';
  }).join('');
}
render();`

  return { body, css, js }
}

function calculatorRecipe(_slots: Slots): RecipeOutput {
  const body = `      <section class="card calc">
        <output class="screen mono" id="screen" aria-live="polite">0</output>
        <p class="expr muted mono" id="expr">&nbsp;</p>
        <div class="keys" id="keys">
          <button class="key ghost" data-key="C">C</button>
          <button class="key ghost" data-key="back">⌫</button>
          <button class="key ghost" data-key="%">%</button>
          <button class="key ghost" data-key="/">÷</button>
          <button class="key" data-key="7">7</button>
          <button class="key" data-key="8">8</button>
          <button class="key" data-key="9">9</button>
          <button class="key ghost" data-key="*">×</button>
          <button class="key" data-key="4">4</button>
          <button class="key" data-key="5">5</button>
          <button class="key" data-key="6">6</button>
          <button class="key ghost" data-key="-">−</button>
          <button class="key" data-key="1">1</button>
          <button class="key" data-key="2">2</button>
          <button class="key" data-key="3">3</button>
          <button class="key ghost" data-key="+">+</button>
          <button class="key" data-key="0">0</button>
          <button class="key" data-key=".">.</button>
          <button class="key wide" data-key="=">=</button>
        </div>
        <p class="hint muted">支持键盘输入 · 历史保留最近 5 条</p>
        <ul class="history" id="history"></ul>
      </section>`

  const css = `.calc { padding: 18px; display: grid; gap: 10px; max-width: 380px; margin: 0 auto; }
.screen { text-align: right; font-size: 38px; font-weight: 620; letter-spacing: -.02em; padding: 10px 6px 0; overflow-x: auto; }
.expr { margin: 0; text-align: right; font-size: 12px; padding: 0 6px 8px; min-height: 18px; }
.keys { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.key { padding: 16px 0; font-size: 17px; font-weight: 560; border-radius: 12px; }
.key.ghost { background: var(--bg); border-color: var(--line); color: var(--ink); }
.key.wide { grid-column: span 2; }
.hint { margin: 4px 0 0; font-size: 11px; text-align: center; }
.history { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
.history li { text-align: right; }`

  const js = `let current = '0';
let previous = null;
let operator = null;
let history = [];
const screen = document.getElementById('screen');
const expr = document.getElementById('expr');

function paint() {
  screen.textContent = current;
  expr.textContent = previous !== null && operator ? previous + ' ' + operator : '\\u00a0';
}

function compute(a, b, op) {
  const x = Number(a);
  const y = Number(b);
  if (op === '+') return x + y;
  if (op === '-') return x - y;
  if (op === '*') return x * y;
  if (op === '/') return y === 0 ? NaN : x / y;
  return y;
}

function press(key) {
  if (/^[0-9]$/.test(key)) {
    current = current === '0' ? key : current + key;
  } else if (key === '.') {
    if (!current.includes('.')) current += '.';
  } else if (key === 'C') {
    current = '0'; previous = null; operator = null;
  } else if (key === 'back') {
    current = current.length > 1 ? current.slice(0, -1) : '0';
  } else if (key === '%') {
    current = String(Number(current) / 100);
  } else if (key === '=') {
    if (previous !== null && operator) {
      const result = compute(previous, current, operator);
      history.unshift(previous + ' ' + operator + ' ' + current + ' = ' + (isNaN(result) ? '错误' : String(+result.toFixed(8))));
      history = history.slice(0, 5);
      current = isNaN(result) ? '错误' : String(+result.toFixed(8));
      previous = null; operator = null;
      renderHistory();
    }
  } else {
    if (previous !== null && operator && current !== '0') {
      const result = compute(previous, current, operator);
      current = isNaN(result) ? '错误' : String(+result.toFixed(8));
    }
    previous = current;
    operator = key;
    current = '0';
  }
  paint();
}

document.getElementById('keys').addEventListener('click', function (event) {
  const button = event.target.closest('[data-key]');
  if (button) press(button.dataset.key);
});

addEventListener('keydown', function (event) {
  const map = { Enter: '=', '=': '=', Escape: 'C', Backspace: 'back', '/': '/', '*': '*', '-': '-', '+': '+', '%': '%', '.': '.' };
  if (/^[0-9]$/.test(event.key)) press(event.key);
  else if (map[event.key]) { event.preventDefault(); press(map[event.key]); }
});

function renderHistory() {
  document.getElementById('history').innerHTML = history.map(function (item) {
    return '<li>' + item + '</li>';
  }).join('');
}

paint();`

  return { body, css, js }
}

function landingRecipe(slots: Slots): RecipeOutput {
  const body = `      <section class="card hero">
        <span class="pill">全新上线</span>
        <h2>${slots.tagline}</h2>
        <p class="lead">把最关键的三个价值点讲清楚：它解决什么问题、给谁用、凭什么比现在的方案好。</p>
        <form class="waitlist" id="form">
          <input id="email" type="email" placeholder="留下邮箱，第一时间通知你" required />
          <button type="submit">加入等待名单</button>
        </form>
        <p class="fine muted" id="fine">已有 <span class="mono" id="total">0</span> 人加入 · 不发垃圾邮件</p>
      </section>

      <section class="features">
        <article class="card feature"><h3>快</h3><p>从想法到可用页面，不需要搭环境。</p></article>
        <article class="card feature"><h3>省</h3><p>不用写构建配置，产物是可以直接托管的三件套。</p></article>
        <article class="card feature"><h3>清楚</h3><p>每个模块都知道自己为什么存在，不做无意义的装饰。</p></article>
      </section>

      <section class="card cta">
        <h2>准备好了吗？</h2>
        <p class="muted">上面那个表单是真的能用的 —— 数据存在你的浏览器里。</p>
      </section>`

  const css = `.hero { padding: 40px 28px; text-align: center; display: grid; gap: 14px; justify-items: center; }
.pill { font-size: 12px; padding: 4px 10px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.hero h2 { margin: 0; font-size: 30px; line-height: 1.25; letter-spacing: -.02em; max-width: 20ch; }
.lead { margin: 0; max-width: 46ch; color: var(--muted); }
.waitlist { display: flex; gap: 10px; width: 100%; max-width: 420px; margin-top: 6px; }
.waitlist input { flex: 1; }
.fine { margin: 0; font-size: 12px; }
.features { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; }
.feature { padding: 20px; }
.feature h3 { margin: 0 0 6px; font-size: 15px; color: var(--accent); }
.feature p { margin: 0; font-size: 13px; color: var(--muted); }
.cta { padding: 26px 24px; }
.cta h2 { margin: 0 0 6px; font-size: 18px; }
.cta p { margin: 0; font-size: 13px; }
@media (max-width: 560px) { .hero h2 { font-size: 24px; } .waitlist { flex-direction: column; } }`

  const js = `const KEY = 'nucleus:landing:v1';
function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { return []; }
}
function persist(rows) { try { localStorage.setItem(KEY, JSON.stringify(rows)); } catch (e) {} }
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { el.classList.remove('show'); }, 1800);
}
let rows = read();

document.getElementById('form').addEventListener('submit', function (event) {
  event.preventDefault();
  const input = document.getElementById('email');
  const value = input.value.trim();
  if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(value)) { toast('邮箱格式不太对'); return; }
  if (rows.indexOf(value) >= 0) { toast('这个邮箱已经在名单里了'); return; }
  rows.push(value);
  persist(rows);
  input.value = '';
  document.getElementById('total').textContent = String(rows.length);
  toast('已加入，感谢！');
});

document.getElementById('total').textContent = String(rows.length);`

  return { body, css, js }
}

function recipeFor(archetype: Archetype, slots: Slots): RecipeOutput {
  switch (archetype) {
    case 'expense':
      return expenseRecipe(slots)
    case 'todo':
      return todoRecipe(slots)
    case 'notes':
      return notesRecipe(slots)
    case 'pomodoro':
      return pomodoroRecipe(slots)
    case 'kanban':
      return kanbanRecipe(slots)
    case 'calculator':
      return calculatorRecipe(slots)
    case 'landing':
      return landingRecipe(slots)
  }
}

function readmeFor(slots: Slots): string {
  return `# ${slots.name}

${slots.tagline}

## 运行

直接双击 \`index.html\`，或在本目录起任意静态服务器：

\`\`\`bash
npx serve .
\`\`\`

## 结构

| 文件 | 作用 |
| --- | --- |
| \`index.html\` | 页面结构 |
| \`styles.css\` | 设计令牌与组件样式 |
| \`app.js\` | 状态管理与本地持久化 |

## 说明

- 零依赖、零构建，可以直接部署到任何静态托管。
- 数据保存在浏览器 \`localStorage\`，键名以 \`nucleus:\` 开头。
- 由 Nucleus Studio 生成。
`
}

/** ④⑤ 编译为 NWF 协议文本 */
export function compose(prompt: string, design: DesignPrefs, previous: FileEntry[] = []): { text: string; slots: Slots } {
  const slots = extractSlots(prompt, design)
  const recipe = recipeFor(slots.archetype, slots)
  const plan = planFor(slots)

  const files: { path: string; content: string }[] = [
    { path: 'index.html', content: shellHtml(slots, recipe.body) },
    { path: 'styles.css', content: baseCss(slots) + '\n\n' + recipe.css },
    { path: 'app.js', content: recipe.js },
    { path: 'README.md', content: readmeFor(slots) },
  ]

  const prevMap = new Map(previous.map((file) => [file.path, file.content]))
  const changed = files.filter((file) => prevMap.get(file.path) !== file.content)

  // 迭代场景：只回写真正变化的文件，让 changed[] 与流式体验都保持轻量
  const targets = previous.length > 0 ? changed : files

  const parts: string[] = []
  parts.push(`<note>${slots.name} · ${plan.summary}</note>`)
  parts.push(`<plan>${JSON.stringify(plan)}</plan>`)
  if (targets.length === 0) {
    parts.push('<note>没有检测到需要变更的文件，已保持原样。</note>')
  }
  for (const file of targets) {
    parts.push(`<file path="${file.path}">\n${file.content}\n</file>`)
  }
  return { text: parts.join('\n'), slots }
}

/** 供测试与调试：只拿文件集（复用同一套解析器，等于顺带验证协议） */
export function composeFiles(prompt: string, design: DesignPrefs): FileEntry[] {
  const { text } = compose(prompt, design)
  const files: FileEntry[] = []
  for (const event of parseProtocol(text)) {
    if (event.type === 'file_end') {
      files.push({ path: event.path, content: event.content, updatedAt: 0 })
    }
  }
  return files
}
