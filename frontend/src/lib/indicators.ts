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

// Wilder's RSI: simple-average seed, then recursive smoothing.
export function rsiArr(v: number[], n = 14): (number | null)[] {
  const out: (number | null)[] = new Array(v.length).fill(null)
  if (v.length <= n) return out
  let g = 0, l = 0
  for (let i = 1; i <= n; i++) { const d = v[i] - v[i - 1]; if (d >= 0) g += d; else l -= d }
  let avgG = g / n, avgL = l / n
  out[n] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL)
  for (let i = n + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1]
    avgG = (avgG * (n - 1) + Math.max(d, 0)) / n
    avgL = (avgL * (n - 1) + Math.max(-d, 0)) / n
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL)
  }
  return out
}

// Rolling realized volatility (annualized %, log returns). The IV tracker uses
// the same 30d HV as its history proxy, so this matches its scale.
export function hvArr(closes: number[], n = 30): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null)
  const rets = closes.map((c, i) => (i === 0 || closes[i - 1] <= 0 ? null : Math.log(c / closes[i - 1])))
  for (let i = n; i < closes.length; i++) {
    const win = rets.slice(i - n + 1, i + 1).filter((r): r is number => r != null)
    if (win.length < n * 0.8) continue
    const m = win.reduce((a, b) => a + b, 0) / win.length
    const sd = Math.sqrt(win.reduce((a, b) => a + (b - m) ** 2, 0) / (win.length - 1))
    out[i] = sd * Math.sqrt(252) * 100
  }
  return out
}

export function macdArr(v: number[], fast = 12, slow = 26, sig = 9) {
  const f = emaArr(v, fast), s = emaArr(v, slow)
  const line: (number | null)[] = v.map((_, i) => (f[i] != null && s[i] != null ? (f[i] as number) - (s[i] as number) : null))
  const signal: (number | null)[] = new Array(v.length).fill(null)
  const first = line.findIndex(x => x != null)
  if (first >= 0 && v.length - first >= sig) {
    const k = 2 / (sig + 1)
    let prev = 0
    for (let i = first; i < first + sig; i++) prev += line[i] as number
    prev /= sig
    signal[first + sig - 1] = prev
    for (let i = first + sig; i < v.length; i++) { prev = (line[i] as number) * k + prev * (1 - k); signal[i] = prev }
  }
  const hist: (number | null)[] = v.map((_, i) => (line[i] != null && signal[i] != null ? (line[i] as number) - (signal[i] as number) : null))
  return { line, signal, hist }
}
