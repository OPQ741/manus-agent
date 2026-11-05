/**
 * 内置图标库：模型只写名字，路径由我们补。
 *
 * 为什么不用图标字体 / 外链 sprite：
 *  - 预览是 `srcdoc` + 无同源权限的沙箱，CDN 样式表要么被 CSP 拦、要么离线就没了；
 *  - 让模型自己画 path 的结果是"看着像星星的六边形"——它记不准控制点，而图标恰恰是
 *    最容易被一眼看穿的地方；
 *  - 同一份 `<path>` 被内联 20 次会白白吃掉一两 KB，而项目总预算只有 400 KB。
 *
 * 所以走"名字 → 内置几何"：模型输出 `<svg data-icon="plus">`，组装时换成下面的路径。
 * 几何统一 24×24、`stroke="currentColor"` 走描边，颜色自动跟随文字色，深色模式不用改。
 *
 * 约定：这里的字符串只放**子元素**（path/circle/rect/line/polyline），
 * 外层 `<svg>` 由 expandIcons 统一生成，属性（viewBox / stroke / fill）才不会被各写一套。
 */

/** 名字 → 24×24 网格上的子元素。别名在 ALIASES 里折叠。 */
const PATHS: Record<string, string> = {
  plus: '<path d="M5 12h14M12 5v14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  trash: '<path d="M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  edit: '<path d="M4 20h4L18 10a2.83 2.83 0 0 0-4-4L4 16v4Z"/>',
  save: '<path d="M5 3h11l3 3v15H5V3Z"/><path d="M8 3v6h7M8 14h8v7H8z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  download: '<path d="M12 3v12M7 11l5 5 5-5M4 20h16"/>',
  upload: '<path d="M12 16V4M7 8l5-5 5 5M4 20h16"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.6 6.8-4.2M8.6 13.4l6.8 4.2"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
  'arrow-left': '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
  'arrow-up': '<path d="M12 19V5M6 11l6-6 6 6"/>',
  'arrow-down': '<path d="M12 5v14M6 13l6 6 6-6"/>',
  'chevron-left': '<path d="m15 5-7 7 7 7"/>',
  'chevron-right': '<path d="m9 5 7 7-7 7"/>',
  'chevron-down': '<path d="m5 9 7 7 7-7"/>',
  'chevron-up': '<path d="m5 15 7-7 7 7"/>',
  home: '<path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1v-8Z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5.5a3.5 3.5 0 0 1 0 7M17.5 14.6a5 5 0 0 1 3.5 4.7"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M4 21v-5M4 12V3M12 21v-9M12 8V3M20 21v-7M20 10V3"/><path d="M1.5 16h5M9.5 8h5M17.5 14h5"/>',
  bell: '<path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6Z"/><path d="M10.5 20a2 2 0 0 0 3 0"/>',
  heart: '<path d="M12 20s-7-4.6-7-9.5A4 4 0 0 1 12 7a4 4 0 0 1 7 3.5C19 15.4 12 20 12 20Z"/>',
  star: '<path d="m12 4 2.5 5.2 5.5.8-4 3.9 1 5.6-5-2.7-5 2.7 1-5.6-4-3.9 5.5-.8L12 4Z"/>',
  bookmark: '<path d="M6 4h12v17l-6-4-6 4V4Z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.5l3.5 2"/>',
  chart: '<path d="M4 4v16h16"/><path d="M8 17v-5M13 17V8M18 17v-3"/>',
  trending: '<path d="M3 17 10 10l4 4 7-7"/><path d="M15 7h6v6"/>',
  pie: '<path d="M21 12A9 9 0 1 1 12 3v9h9Z"/>',
  tag: '<path d="M3 12V4h8l9 9-8 8-9-9Z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  phone: '<path d="M7 3h3l2 5-2.5 1.5a12 12 0 0 0 5 5L16 12l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2Z"/>',
  'map-pin': '<path d="M12 21s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/>',
  'credit-card': '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  eye: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="m4 4 16 16"/><path d="M9.9 5.2A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.3 4.1M6.3 7.9A17 17 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 4.3-1"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/>',
  play: '<path d="m8 5 11 7-11 7V5Z"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 8h.01"/>',
  alert: '<path d="M12 3 22 20H2L12 3Z"/><path d="M12 9v5M12 17h.01"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
  file: '<path d="M6 3h8l4 4v14H6V3Z"/><path d="M14 3v5h4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.5 12h12L22 7H6"/>',
  package: '<path d="M12 3 3 8v8l9 5 9-5V8l-9-5Z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  message: '<path d="M4 5h16v11H9l-5 4V5Z"/><path d="M8 10h8"/>',
  send: '<path d="m3 11 18-8-8 18-2.5-7.5L3 11Z"/>',
  link: '<path d="M10 7H7a5 5 0 0 0 0 10h3M14 7h3a5 5 0 0 1 0 10h-3M8.5 12h7"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z"/>',
}

/** 模型爱写的同义词：折叠到 PATHS 的键，避免"明明有却报未识别"。 */
const ALIASES: Record<string, string> = {
  close: 'x',
  remove: 'trash',
  delete: 'trash',
  pencil: 'edit',
  compose: 'edit',
  update: 'refresh',
  reload: 'refresh',
  sync: 'refresh',
  gear: 'settings',
  cog: 'settings',
  sliders: 'settings',
  notification: 'bell',
  favorite: 'heart',
  like: 'heart',
  date: 'calendar',
  time: 'clock',
  timer: 'clock',
  stats: 'chart',
  'bar-chart': 'chart',
  'line-chart': 'trending',
  'pie-chart': 'pie',
  label: 'tag',
  email: 'mail',
  envelope: 'mail',
  call: 'phone',
  location: 'map-pin',
  place: 'map-pin',
  pin: 'map-pin',
  card: 'credit-card',
  payment: 'credit-card',
  security: 'lock',
  password: 'lock',
  hide: 'eye-off',
  visible: 'eye',
  play_circle: 'play',
  photo: 'image',
  picture: 'image',
  document: 'file',
  doc: 'file',
  dir: 'folder',
  directory: 'folder',
  items: 'list',
  dashboard: 'grid',
  shopping: 'cart',
  shop: 'cart',
  box: 'package',
  chat: 'message',
  comment: 'message',
  'chat-bubble': 'message',
  paperclip: 'link',
  world: 'globe',
  language: 'globe',
  website: 'globe',
}

/** 名字归一：大小写、空格、下划线都算同一个。 */
export function iconName(raw: string): string {
  const name = raw.trim().toLowerCase().replace(/[\s_]+/g, '-')
  const alias = ALIASES[name] ?? ALIASES[name.replace(/-/g, '')]
  return (alias ?? name).replace(/^lucide-/, '')
}

export function hasIcon(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PATHS, iconName(name))
}

/** 提示词与未知图标提示都用它：让模型看到"能用哪些名字"，而不是猜。 */
export const ICON_NAMES: string[] = Object.keys(PATHS)

export interface ExpandedIcons {
  html: string
  /** 成功套用内置几何的图标名（去重前） */
  used: string[]
  /** 库里没有的名字：保留原标签、不阻断 */
  unknown: string[]
  /** 模型自己写了 path 的图标：尊重它的表达，不覆盖 */
  drawn: number
}

/**
 * 把 `<svg data-icon="plus">` 换成内置几何。
 *
 * 只替换**空**图标：如果模型自己写了子元素，说明它想画点别的（比如品牌 logo），
 * 这时覆盖只会把它的意图抹掉。这类计入 `drawn`，在自检里照样有数。
 *
 * 同时接受 `<i data-icon="x">` / `<span data-icon="x">` —— 模型习惯写 `<i class="icon">`，
 * 不允许比允许更容易出错。
 */
export function expandIcons(html: string): ExpandedIcons {
  const used: string[] = []
  const unknown: string[] = []
  let drawn = 0

  const OPEN = /<(svg|i|span)\b([^>]*?)>/gi
  const out = html.replace(OPEN, (tag: string, tagName: string, attrs: string, offset: number, whole: string) => {
    const hit = /\bdata-icon\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs)
    if (!hit) return tag
    // 已经展开过：整份文档被二次组装时不重复插路径
    if (/\bdata-icon-applied\b/i.test(attrs)) return tag

    const raw = hit[2] ?? hit[3] ?? hit[4] ?? ''
    const name = iconName(raw)
    const body = PATHS[name]
    if (!body) {
      unknown.push(raw.trim() || '(空)')
      return tag
    }

    // 自闭合（<svg ... />）没有内联内容；否则看开标签到闭标签之间有没有东西
    const selfClosed = /\/\s*$/.test(tag.slice(0, -1))
    if (!selfClosed) {
      const closeAt = whole.toLowerCase().indexOf(`</${tagName.toLowerCase()}>`, offset + tag.length)
      const inner = closeAt === -1 ? '' : whole.slice(offset + tag.length, closeAt)
      if (inner.trim()) {
        drawn += 1
        return tag
      }
    }

    used.push(name)
    return renderSvg(tagName.toLowerCase(), attrs, body)
  })

  return { html: out, used, unknown, drawn }
}

/**
 * 生成外层 `<svg>`，保留模型写的 class / style / width / height。
 *
 * 没有宽高时给 `1em`：图标跟着文字大小走，这是图标最不容易出错的默认值
 * （固定 24px 放进 14px 的按钮里一定会溢出）。
 */
function renderSvg(tagName: string, attrs: string, body: string): string {
  const kept = attrs
    .replace(/\bdata-icon\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i, '')
    .replace(/\s+/g, ' ')
    .trim()

  const has = (pattern: RegExp) => pattern.test(kept)
  const extra: string[] = ['data-icon-applied=""']
  if (!has(/\bviewBox\s*=/i)) extra.push('viewBox="0 0 24 24"')
  if (!has(/\bwidth\s*=/i)) extra.push('width="1em"')
  if (!has(/\bheight\s*=/i)) extra.push('height="1em"')
  if (!has(/\bfill\s*=/i)) extra.push('fill="none"')
  if (!has(/\bstroke\s*=/i)) extra.push('stroke="currentColor"')
  if (!has(/\bstroke-width\s*=/i)) extra.push('stroke-width="2"')
  if (!has(/\bstroke-linecap\s*=/i)) extra.push('stroke-linecap="round"')
  if (!has(/\bstroke-linejoin\s*=/i)) extra.push('stroke-linejoin="round"')
  if (!has(/\baria-(label|hidden)\b/i)) extra.push('aria-hidden="true"')

  /**
   * 样式只能有一个属性，所以先攒起来再一次性写。
   *  - 图标不吃事件：按钮里套图标时，点到的应该是按钮；
   *  - `<i>`/`<span>` 转成 svg 后默认按基线对齐，往下挪一点才和文字对齐。
   */
  const styles: string[] = []
  if (!has(/\bpointer-events\s*:/i)) styles.push('pointer-events:none')
  if (tagName !== 'svg' && !has(/\bvertical-align\s*:/i)) styles.push('vertical-align:-0.125em')
  if (styles.length) {
    const declared = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/i.exec(kept)
    const own = declared?.[2] ?? declared?.[3] ?? ''
    const merged = [...styles, ...(own ? [own.trim().replace(/;$/, '')] : [])].join(';')
    if (declared) {
      return `<svg ${kept.replace(declared[0], `style="${merged}"`)} ${extra.join(' ')}>${body}</svg>`
    }
    extra.push(`style="${merged}"`)
  }

  return `<svg ${kept} ${extra.join(' ')}>${body}</svg>`
}
