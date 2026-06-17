// Client-side chart overlays, shared by the paper-trade dashboard widget and the
// Paper Trading page chart. All return arrays aligned 1:1 with the input candles.
export interface Candle { time: number | string; open: number; high: number; low: number; close: number; volume: number }

export function smaArr(v: number[], n: number): (number | null)[] {
  const out: (number | null)[] = []; let sum = 0
  for (let i = 0; i < v.length; i++) { sum += v[i]; if (i >= n) sum -= v[i - n]; out.push(i >= n - 1 ? sum / n : null) }
  return out
}

export function emaArr(v: number[], n: number): (number | null)[] {
  const out: (number | null)[] = []; const k = 2 / (n + 1); let prev: number | null = null
  for (let i = 0; i < v.length; i++) {
    if (i < n - 1) { out.push(null); continue }
    prev = prev == null ? v.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n : v[i] * k + prev * (1 - k)
    out.push(prev)
  }
  return out
}

export function bollinger(v: number[], n = 20, k = 2) {
  const mid = smaArr(v, n); const upper: (number | null)[] = []; const lower: (number | null)[] = []
  for (let i = 0; i < v.length; i++) {
    if (mid[i] == null) { upper.push(null); lower.push(null); continue }
    const win = v.slice(i - n + 1, i + 1); const m = mid[i] as number
    const sd = Math.sqrt(win.reduce((a, b) => a + (b - m) ** 2, 0) / n)
    upper.push(m + k * sd); lower.push(m - k * sd)
  }
  return { upper, mid, lower }
}

export function vwapArr(c: Candle[]): (number | null)[] {
  let pv = 0, vv = 0
  return c.map(x => { const tp = (x.high + x.low + x.close) / 3; pv += tp * x.volume; vv += x.volume; return vv > 0 ? pv / vv : null })
}
