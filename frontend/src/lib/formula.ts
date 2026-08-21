// Arithmetic over fundamental line items, for user-defined metrics.
//
// Hand-written tokeniser and shunting-yard rather than eval() or new Function():
// the expression comes from a text box and is saved to localStorage, so it is
// untrusted input that must never become executable code. This parser can only
// ever produce a number.

export type Vars = Record<string, number | null | undefined>

/**
 * The names a formula may use. Without one, any identifier is accepted as-is.
 *
 * A field is called "Share price" everywhere in the interface, so that is what
 * someone types. Only accepting `sharePrice` made the box a guessing game about
 * a spelling the interface never shows, so the lexicon maps every spelling of a
 * field — its key, its label, its sanitised label, and common trade shorthand —
 * onto one canonical key. Phrases may contain spaces, and the longest one wins.
 */
export interface Lexicon {
  /** Lowercased spelling -> canonical field key. */
  alias: Map<string, string>
  /** Canonical field key -> the label to show in an error. */
  label: Map<string, string>
}

export interface CompileResult {
  ok: boolean
  error?: string
  /** Identifiers the expression references, in first-seen order. */
  vars: string[]
}

type Tok =
  | { t: 'num'; v: number }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lp' }
  | { t: 'rp' }

const PREC: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3 }
const RIGHT = new Set(['^', 'u-'])

/** Every proper prefix of every phrase, so the tokeniser knows when to keep
 *  reading words instead of stopping at the first one. */
function prefixes(alias: Map<string, string>): Set<string> {
  const out = new Set<string>()
  for (const phrase of alias.keys()) {
    const w = phrase.split(' ')
    for (let n = 1; n < w.length; n++) out.add(w.slice(0, n).join(' '))
  }
  return out
}

const PREFIX_CACHE = new WeakMap<Map<string, string>, Set<string>>()
function prefixSet(alias: Map<string, string>): Set<string> {
  let s = PREFIX_CACHE.get(alias)
  if (!s) { s = prefixes(alias); PREFIX_CACHE.set(alias, s) }
  return s
}

/** Levenshtein, capped: only used to name a near miss in an error. */
function dist(a: string, b: string): number {
  const m = a.length, n = b.length
  if (Math.abs(m - n) > 3) return 9
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

/** The field a misspelling most likely meant, or null when nothing is close. */
function closest(word: string, lex: Lexicon): string | null {
  let best: string | null = null
  let bestD = 4
  for (const [phrase, key] of lex.alias) {
    const d = phrase.startsWith(word) || word.startsWith(phrase) ? 1 : dist(word, phrase)
    if (d < bestD) { bestD = d; best = lex.label.get(key) ?? key }
  }
  return best
}

function tokenize(src: string, lex?: Lexicon): Tok[] | string {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (/[0-9.]/.test(c)) {
      let j = i
      while (j < src.length && /[0-9._]/.test(src[j])) j++
      const raw = src.slice(i, j).replace(/_/g, '')
      const n = Number(raw)
      if (!Number.isFinite(n)) return `"${raw}" is not a number`
      // A trailing % scales the literal, so "20%" reads as 0.2.
      if (src[j] === '%') { out.push({ t: 'num', v: n / 100 }); i = j + 1; continue }
      out.push({ t: 'num', v: n }); i = j; continue
    }
    if (/[A-Za-z_]/.test(c)) {
      const word = (from: number) => {
        let j = from
        while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++
        return j
      }
      let j = word(i)
      if (!lex) { out.push({ t: 'id', v: src.slice(i, j) }); i = j; continue }
      // Keep swallowing words while the phrase so far could still grow into a
      // known one, then take the longest phrase that actually resolves.
      const pre = prefixSet(lex.alias)
      const ends: number[] = [j]
      let phrase = src.slice(i, j).toLowerCase()
      while (pre.has(phrase)) {
        let k = j
        while (k < src.length && src[k] === ' ') k++
        if (k === j || !/[A-Za-z_]/.test(src[k] ?? '')) break
        const e = word(k)
        phrase = `${phrase} ${src.slice(k, e).toLowerCase()}`
        ends.push(e); j = e
      }
      let taken = -1
      for (let n = ends.length - 1; n >= 0; n--) {
        const cand = src.slice(i, ends[n]).toLowerCase().replace(/\s+/g, ' ')
        const hit = lex.alias.get(cand)
        if (hit) { out.push({ t: 'id', v: hit }); taken = ends[n]; break }
      }
      if (taken < 0) { out.push({ t: 'id', v: src.slice(i, ends[0]) }); taken = ends[0] }
      i = taken; continue
    }
    if (c === '(') { out.push({ t: 'lp' }); i++; continue }
    if (c === ')') { out.push({ t: 'rp' }); i++; continue }
    if ('+-*/^'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue }
    return `unexpected character "${c}"`
  }
  return out
}

/** Shunting-yard to RPN. Returns the queue, or an error string. */
function toRpn(toks: Tok[]): Tok[] | string {
  const out: Tok[] = []
  const ops: Tok[] = []
  let prev: Tok | null = null
  const valueish = (t: Tok | null) => !!t && (t.t === 'num' || t.t === 'id' || t.t === 'rp')
  const show = (t: Tok) => (t.t === 'id' ? t.v : t.t === 'num' ? String(t.v) : '(')
  for (const tk of toks) {
    // Two fields with nothing between them is the commonest way a dragged-in
    // formula goes wrong, and "incomplete expression" said nothing about it.
    if ((tk.t === 'num' || tk.t === 'id' || tk.t === 'lp') && valueish(prev)) {
      return `missing operator before "${show(tk)}"`
    }
    if (tk.t === 'num' || tk.t === 'id') { out.push(tk); prev = tk; continue }
    if (tk.t === 'lp') { ops.push(tk); prev = tk; continue }
    if (tk.t === 'rp') {
      while (ops.length && ops[ops.length - 1].t !== 'lp') out.push(ops.pop()!)
      if (!ops.length) return 'unbalanced parentheses'
      ops.pop()
      prev = tk; continue
    }
    // Minus is unary when nothing value-like precedes it.
    const unary = tk.v === '-' && (prev === null || prev.t === 'op' || prev.t === 'lp')
    const op = unary ? 'u-' : tk.v
    while (ops.length) {
      const top = ops[ops.length - 1]
      if (top.t !== 'op') break
      const tp = PREC[top.v] ?? 4      // u- binds tighter than * /
      const cp = PREC[op] ?? 4
      if (tp > cp || (tp === cp && !RIGHT.has(op))) out.push(ops.pop()!)
      else break
    }
    ops.push({ t: 'op', v: op })
    prev = tk
  }
  while (ops.length) {
    const top = ops.pop()!
    if (top.t === 'lp') return 'unbalanced parentheses'
    out.push(top)
  }
  return out
}

// Keyed on the lexicon object, because the same text compiles differently under
// a different set of names. Callers memoise their lexicon; a fresh one each
// render only costs a re-parse.
const LEX_CACHE = new WeakMap<Lexicon, Map<string, Tok[] | string>>()
const BARE_CACHE = new Map<string, Tok[] | string>()

function rpnFor(expr: string, lex?: Lexicon): Tok[] | string {
  let cache = BARE_CACHE
  if (lex) {
    const hit = LEX_CACHE.get(lex)
    if (hit) cache = hit
    else { cache = new Map(); LEX_CACHE.set(lex, cache) }
  }
  const hit = cache.get(expr)
  if (hit) return hit
  const toks = tokenize(expr, lex)
  const res = typeof toks === 'string' ? toks : toRpn(toks)
  cache.set(expr, res)
  return res
}

/** Validate an expression and report the identifiers it uses. */
export function compile(expr: string, lex?: Lexicon): CompileResult {
  if (!expr.trim()) return { ok: false, error: 'empty formula', vars: [] }
  const rpn = rpnFor(expr, lex)
  // Tokenising resolves a name to its key, so an error raised after that point
  // would otherwise quote a spelling the interface never shows.
  if (typeof rpn === 'string') {
    const msg = lex ? rpn.replace(/"([^"]+)"/g, (m, k) => (lex.label.has(k) ? `"${lex.label.get(k)}"` : m)) : rpn
    return { ok: false, error: msg, vars: [] }
  }

  const vars: string[] = []
  let depth = 0
  for (const tk of rpn) {
    if (tk.t === 'num') { depth++; continue }
    if (tk.t === 'id') {
      if (!vars.includes(tk.v)) vars.push(tk.v)
      if (lex && !lex.label.has(tk.v)) {
        const near = closest(tk.v.toLowerCase(), lex)
        return { ok: false, error: `"${tk.v}" is not a field${near ? `. Did you mean ${near}?` : ''}`, vars }
      }
      depth++; continue
    }
    if (tk.t !== 'op') return { ok: false, error: 'unbalanced parentheses', vars }
    depth -= tk.v === 'u-' ? 0 : 1
    if (depth < 1) return { ok: false, error: 'incomplete expression', vars }
  }
  if (depth !== 1) return { ok: false, error: 'incomplete expression', vars }
  return { ok: true, vars }
}

/**
 * Evaluate for one period. Returns null rather than throwing or coercing:
 * a missing line item in one year must leave a GAP in the series, never a zero
 * that reads as a real reported value.
 */
export function evaluate(expr: string, vars: Vars, lex?: Lexicon): number | null {
  const rpn = rpnFor(expr, lex)
  if (typeof rpn === 'string') return null
  const st: number[] = []
  for (const tk of rpn) {
    if (tk.t === 'num') { st.push(tk.v); continue }
    if (tk.t === 'id') {
      const v = vars[tk.v]
      if (v === null || v === undefined || !Number.isFinite(v)) return null
      st.push(v as number); continue
    }
    if (tk.t !== 'op') return null
    if (tk.v === 'u-') {
      const a = st.pop(); if (a === undefined) return null
      st.push(-a); continue
    }
    const b = st.pop(), a = st.pop()
    if (a === undefined || b === undefined) return null
    let r: number
    switch (tk.v) {
      case '+': r = a + b; break
      case '-': r = a - b; break
      case '*': r = a * b; break
      // Division by zero is a gap, not Infinity: an EV of zero means the year
      // has no market value, and plotting Infinity would blow up the axis.
      case '/': if (b === 0) return null; r = a / b; break
      case '^': r = Math.pow(a, b); break
      default: return null
    }
    if (!Number.isFinite(r)) return null
    st.push(r)
  }
  return st.length === 1 ? st[0] : null
}

/** Run a formula across every period, preserving gaps. */
export function series<T extends Vars>(expr: string, periods: T[], lex?: Lexicon): (number | null)[] {
  return periods.map(p => evaluate(expr, p, lex))
}

/** A lexicon from the dataset's own fields, plus any extra shorthand. */
export function lexicon(
  fields: { key: string; label: string }[],
  shorthand: Record<string, string> = {},
): Lexicon {
  const alias = new Map<string, string>()
  const label = new Map<string, string>()
  const put = (phrase: string, key: string) => {
    const p = phrase.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')
    if (p && !alias.has(p)) alias.set(p, key)
  }
  for (const f of fields) {
    label.set(f.key, f.label)
    alias.set(f.key.toLowerCase(), f.key)   // the key itself, verbatim
    put(f.key, f.key)
    put(f.label, f.key)
  }
  for (const [phrase, key] of Object.entries(shorthand)) if (label.has(key)) put(phrase, key)
  return { alias, label }
}

/**
 * The unit a formula's result carries, worked out from the units of its inputs.
 *
 * Without this every saved metric is a "ratio", so a formula that just adds two
 * dollar figures gets a ratio axis and ratio formatting. Dollars over dollars is
 * dimensionless, dollars over shares is dollars per share, and anything the
 * algebra cannot name comes back null so the caller can fall back rather than
 * assert a unit it does not have.
 */
export function resultUnit(
  expr: string,
  unitOf: (key: string) => string | undefined,
  lex?: Lexicon,
): string | null {
  const rpn = rpnFor(expr, lex)
  if (typeof rpn === 'string') return null
  const st: (string | null)[] = []
  const mul = (a: string | null, b: string | null): string | null => {
    if (a === null || b === null) return null
    if (a === 'x') return b
    if (b === 'x') return a
    // Per-share times a share count is the whole-company figure again.
    if ((a === '$/sh' && b === 'sh') || (a === 'sh' && b === '$/sh')) return '$'
    return null
  }
  const div = (a: string | null, b: string | null): string | null => {
    if (a === null || b === null) return null
    if (a === b) return 'x'
    if (b === 'x') return a
    if (a === '$' && b === 'sh') return '$/sh'
    if (a === '$' && b === '$/sh') return 'sh'
    if (a === '$/sh' && b === 'sh') return null
    return null
  }
  for (const tk of rpn) {
    if (tk.t === 'num') { st.push('x'); continue }
    if (tk.t === 'id') { st.push(unitOf(tk.v) ?? null); continue }
    if (tk.t !== 'op') return null
    if (tk.v === 'u-') continue          // negation cannot change a unit
    const b = st.pop(), a = st.pop()
    if (a === undefined || b === undefined) return null
    switch (tk.v) {
      // Adding unlike things is meaningless, so the result is unnamed rather
      // than silently taking one side's unit.
      case '+': case '-': st.push(a === b ? a : null); break
      case '*': st.push(mul(a, b)); break
      case '/': st.push(div(a, b)); break
      case '^': st.push(a === 'x' && b === 'x' ? 'x' : null); break
      default: return null
    }
  }
  return st.length === 1 ? st[0] : null
}

/** The spelling to write into the box for a field: its label, made typeable. */
export function token(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}
