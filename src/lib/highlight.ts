/**
 * 自研轻量语法高亮。
 *
 * 关键点：先切词再转义，绝不对已经拼好的 HTML 再用正则 —— 那是最经典的
 * XSS 与串色来源。这里每个 token 的文本都会独立 escape。
 */

export type Lang = 'html' | 'css' | 'js' | 'json' | 'md' | 'text'

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

interface Rule {
  pattern: RegExp
  cls: string
}

const JS_KEYWORDS =
  'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|await|async|try|catch|finally|throw|typeof|instanceof|delete|void|yield|of|in|null|undefined|true|false|this'

const JS_RULES: Rule[] = [
  { pattern: /\/\*[\s\S]*?\*\//, cls: 'tok-com' },
  { pattern: /\/\/[^\n]*/, cls: 'tok-com' },
  { pattern: /`(?:[^`\\]|\\.)*`/, cls: 'tok-str' },
  { pattern: /"(?:[^"\\\n]|\\.)*"/, cls: 'tok-str' },
  { pattern: /'(?:[^'\\\n]|\\.)*'/, cls: 'tok-str' },
  { pattern: new RegExp(`\\b(?:${JS_KEYWORDS})\\b`), cls: 'tok-key' },
  { pattern: /\b\d+(?:\.\d+)?\b/, cls: 'tok-num' },
]

const CSS_RULES: Rule[] = [
  { pattern: /\/\*[\s\S]*?\*\//, cls: 'tok-com' },
  { pattern: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/, cls: 'tok-str' },
  { pattern: /@[\w-]+/, cls: 'tok-key' },
  { pattern: /[.#]?[\w-]+(?=[^{}()]*\{)/, cls: 'tok-tag' },
  { pattern: /--?[\w-]+(?=\s*:)/, cls: 'tok-attr' },
  { pattern: /#(?:[0-9a-fA-F]{3,8})\b/, cls: 'tok-num' },
  { pattern: /\b\d+(?:\.\d+)?(?:px|rem|em|vh|vw|s|ms|%)?\b/, cls: 'tok-num' },
]

const HTML_RULES: Rule[] = [
  { pattern: /<!--[\s\S]*?-->/, cls: 'tok-com' },
  { pattern: /<\/?[\w-]+/, cls: 'tok-tag' },
  { pattern: /[\w-]+(?==)/, cls: 'tok-attr' },
  { pattern: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/, cls: 'tok-str' },
]

function rulesFor(lang: Lang): Rule[] {
  if (lang === 'js') return JS_RULES
  if (lang === 'css') return CSS_RULES
  if (lang === 'html') return HTML_RULES
  if (lang === 'json') return [JS_RULES[3]!, JS_RULES[4]!, JS_RULES[5]!, JS_RULES[6]!]
  return []
}

function buildMatcher(rules: Rule[]): RegExp {
  return new RegExp(rules.map((rule) => `(${rule.pattern.source})`).join('|'), 'g')
}

/** 返回可安全注入的 HTML 片段。 */
export function highlight(code: string, lang: Lang): string {
  const rules = rulesFor(lang)
  if (rules.length === 0) return escapeHtml(code)

  const matcher = buildMatcher(rules)
  let out = ''
  let last = 0
  let match: RegExpExecArray | null

  while ((match = matcher.exec(code)) !== null) {
    if (match.index > last) out += escapeHtml(code.slice(last, match.index))
    // 找出是第几个捕获组命中
    let cls = ''
    for (let i = 1; i < match.length; i++) {
      if (match[i] !== undefined) {
        cls = rules[i - 1]?.cls ?? ''
        break
      }
    }
    const text = escapeHtml(match[0])
    out += cls ? `<span class="${cls}">${text}</span>` : text
    last = match.index + match[0].length
    if (match[0].length === 0) matcher.lastIndex += 1
  }
  out += escapeHtml(code.slice(last))
  return out
}

export function langOf(path: string): Lang {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'css') return 'css'
  if (ext === 'js' || ext === 'mjs' || ext === 'ts') return 'js'
  if (ext === 'json') return 'json'
  if (ext === 'md') return 'md'
  return 'text'
}
