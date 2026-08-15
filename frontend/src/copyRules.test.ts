import { describe, it, expect } from 'vitest'

// DESIGN.md bans em dashes and semicolons in shipped copy. It is the one rule on
// the UI consistency board a machine can hold, so it is held here rather than in
// a review checklist: the other 42 findings all needed a human to judge.
//
// Scope is JSX *text* — what a reader sees between tags. Expressions, props,
// comments and code are none of the copy's business, and a semicolon is load
// bearing in all three.

// Vite's glob rather than node:fs — the app has no @types/node and does not
// need one for a source-text check.
const SOURCES = import.meta.glob('./**/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

// Copy does not only live between tags. It also rides in props and in data
// tables: title=, placeholder=, hint=, and `desc:` rows in *.ts files. Every
// violation the audit found lived in exactly that blind spot, because the JSX
// text scan above cannot see it. So there is a second scan, over string
// literals bound to a name that carries something a reader will see.
const ALL_SOURCES = import.meta.glob('./**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

const COPY_KEYS = [
  'title', 'label', 'placeholder', 'hint', 'desc', 'description', 'text',
  'sub', 'note', 'tooltip', 'caption', 'message', 'summary', 'name',
  'aria-label', 'ariaLabel', 'chip', 'blurb', 'detail', 'reason', 'rule',
  'legend', 'heading', 'subtitle', 'cta', 'empty', 'error', 'helper',
  'tagline', 'masthead', 'action', 'prompt', 'body', 'footnote', 'meta',
]
const COPY_LITERAL = new RegExp(
  String.raw`\b(?:${COPY_KEYS.join('|')})\s*[:=]\s*(['"])((?:\\.|(?!\1).)*)\1`,
  'g',
)

/** Every copy-carrying string literal, with the file and line it sits on. */
function copyLiterals(): { where: string; value: string }[] {
  const out: { where: string; value: string }[] = []
  for (const [path, source] of Object.entries(ALL_SOURCES)) {
    if (path.includes('.test.')) continue
    const lines = stripComments(source)
    lines.forEach((line, i) => {
      for (const m of line.matchAll(COPY_LITERAL)) {
        out.push({ where: `${path}:${i + 1}`, value: m[2] })
      }
    })
  }
  return out
}

function scanCopy(bad: (value: string) => boolean): string[] {
  return copyLiterals()
    .filter(({ value }) => value.trim() !== '—' && bad(value))
    .map(({ where, value }) => `${where}: ${value.slice(0, 100)}`)
}

/** Blank out every comment, keeping the line count so hits stay locatable. */
function stripComments(source: string): string[] {
  const out: string[] = []
  let inBlock = false
  for (const raw of source.split('\n')) {
    let line = raw, kept = ''
    while (line) {
      if (inBlock) {
        const end = line.indexOf('*/')
        if (end === -1) { line = ''; break }
        line = line.slice(end + 2)
        inBlock = false
        continue
      }
      const block = line.indexOf('/*')
      const slash = line.search(/(^|[^:])\/\//)
      if (block !== -1 && (slash === -1 || block < slash)) {
        kept += line.slice(0, block)
        line = line.slice(block + 2)
        inBlock = true
        continue
      }
      if (slash !== -1) { kept += line.slice(0, slash === 0 ? 0 : slash + 1); line = ''; break }
      kept += line
      line = ''
    }
    out.push(kept)
  }
  return out
}

/** Drop every balanced `{...}` group. Must run before the tag scan: `style={{…}}`
 *  and `{v ?? '-'}` are expressions, and a nested-brace regex cannot see them. */
function stripExpressions(line: string): string {
  let out = '', depth = 0
  for (const ch of line) {
    if (ch === '{') depth++
    else if (ch === '}') { if (depth > 0) depth-- }
    else if (depth === 0) out += ch
  }
  return out
}

/** The visible text runs on one line. Empty for a line that is pure code. */
export function textRuns(line: string): string[] {
  const code = stripExpressions(line)
  // A whole line of prose wrapped inside an element. Anything carrying code
  // punctuation is code: a type literal and a chained call both use `;`, and
  // `a.b || '-'` is a fallback, not a sentence.
  if (!/[<>()[\]=:`|&]/.test(code) && !/\w\.\w/.test(code) && /^['"a-zA-Z]/.test(code.trim())) return [code]
  // Only lines carrying a real tag can carry JSX text. Without this a type
  // literal — `a: Record<string, X>; b: Y` — reads as text between two tags.
  if (!/<\/|\/>/.test(code)) return []
  return [...code.matchAll(/>([^<>]*)</g)].map(m => m[1])
}

function scan(check: (runs: string[]) => boolean): string[] {
  const hits: string[] = []
  for (const [path, source] of Object.entries(SOURCES)) {
    if (path.endsWith('.test.tsx')) continue
    stripComments(source).forEach((line, i) => {
      if (check(textRuns(line))) hits.push(`${path}:${i + 1}: ${line.trim().slice(0, 120)}`)
    })
  }
  return hits
}

describe('shipped copy', () => {
  it('reads every page', () => expect(Object.keys(SOURCES).length).toBeGreaterThan(150))

  // A run that is nothing but a dash is the "no value" glyph in a table cell or
  // a legend key for a dashed line, not prose. The ban is on the em dash as
  // punctuation inside a sentence.
  it('has no em dashes in prose', () => {
    expect(scan(runs => runs.filter(r => r.trim() !== '—').join(' ').includes('—'))).toEqual([])
  })

  it('has no semicolons in prose', () => {
    // HTML entities (&nbsp;, &lt;) end in a semicolon and are not prose.
    expect(scan(runs => runs.join(' ').replace(/&[a-z]+;|&#\d+;/gi, ' ').includes(';'))).toEqual([])
  })
})

// The same rules over props and *.ts data tables. This is where the audit found
// every violation, because the scan above can only see between tags.
describe('copy in props and data', () => {
  it('finds copy literals to check', () => {
    expect(copyLiterals().length).toBeGreaterThan(500)
  })

  it('has no em dashes', () => {
    expect(scanCopy(v => v.includes('—'))).toEqual([])
  })

  it('has no semicolons', () => {
    expect(scanCopy(v => v.replace(/&[a-z]+;|&#\d+;/gi, ' ').includes(';'))).toEqual([])
  })

  // Arrows are house style and stay. This is the typographic punctuation that
  // has an ASCII spelling: an ellipsis is three dots, a range takes a hyphen,
  // and quotes are straight.
  it('uses ASCII punctuation', () => {
    expect(scanCopy(v => /[…–−‘’“”]/.test(v))).toEqual([])
  })

  it('has no decorative unicode', () => {
    expect(scanCopy(v => /[■-◿☀-➿⬀-⯿Ⓐ-⓪①-⓿]/u.test(v))).toEqual([])
  })
})
