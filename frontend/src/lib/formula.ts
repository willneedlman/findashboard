// Arithmetic over fundamental line items, for user-defined metrics.
//
// Hand-written tokeniser and shunting-yard rather than eval() or new Function():
// the expression comes from a text box and is saved to localStorage, so it is
// untrusted input that must never become executable code. This parser can only
// ever produce a number.

export type Vars = Record<string, number | null | undefined>

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

function tokenize(src: string): Tok[] | string {
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
      let j = i
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++
      out.push({ t: 'id', v: src.slice(i, j) }); i = j; continue
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
  for (const tk of toks) {
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

const RPN_CACHE = new Map<string, Tok[] | string>()

function rpnFor(expr: string): Tok[] | string {
  const hit = RPN_CACHE.get(expr)
  if (hit) return hit
  const toks = tokenize(expr)
  const res = typeof toks === 'string' ? toks : toRpn(toks)
  RPN_CACHE.set(expr, res)
  return res
}

/** Validate an expression and report the identifiers it uses. */
export function compile(expr: string, known?: Set<string>): CompileResult {
  if (!expr.trim()) return { ok: false, error: 'empty formula', vars: [] }
  const rpn = rpnFor(expr)
  if (typeof rpn === 'string') return { ok: false, error: rpn, vars: [] }

  const vars: string[] = []
  let depth = 0
  for (const tk of rpn) {
    if (tk.t === 'num') { depth++; continue }
    if (tk.t === 'id') {
      if (!vars.includes(tk.v)) vars.push(tk.v)
      if (known && !known.has(tk.v)) return { ok: false, error: `unknown field "${tk.v}"`, vars }
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
export function evaluate(expr: string, vars: Vars): number | null {
  const rpn = rpnFor(expr)
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
export function series<T extends Vars>(expr: string, periods: T[]): (number | null)[] {
  return periods.map(p => evaluate(expr, p))
}
