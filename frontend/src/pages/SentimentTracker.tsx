import React, { useState, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { TrendingUp, History } from 'lucide-react'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'

const T = {
  bg:      'var(--theme-bg, #060e1c)',
  surface: 'var(--theme-surface, #0d1826)',
  border:  'var(--theme-border, rgba(255,255,255,0.06))',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  text:    'var(--theme-text, #d7e3fc)',
  mono:    'var(--theme-mono)',
  label:   'var(--theme-sans)',
  pos:     'var(--theme-positive, #86efac)',
  neg:     'var(--theme-negative, #fca5a5)',
  dim:     'var(--theme-text-dim, rgba(255,255,255,0.35))',
}

// ── Types ──────────────────────────────────────────────────────────────────────
interface Entity { name: string; asset_class: string }

interface ScoredItem {
  text:           string
  published_at:   number
  age_hours:      number
  url:            string
  sentiment:      'bullish' | 'bearish' | 'neutral'
  score:          number
  direction:      number
  macro_tier:     number
  confidence:     number
  recency_weight: number
  reasoning_tag:  string
  forward_looking_weight:  number
  forward_sentiment_score: number
  backward_sentiment_score: number
  entities:       Entity[]
}

interface Source {
  label:         string
  type:          string
  weight:        number
  avg_score:     number
  avg_direction: number
  avg_conf:      number
  avg_tier:      number
  avg_age_h:     number
  count:         number
  qualifies:     boolean
  asset_groups:  Record<string, string[]>
  items:         ScoredItem[]
}

interface Velocity {
  delta:       number
  velocity_hr: number
  elapsed_min: number
  points_used: number
}

interface Momentum {
  delta:      number
  label:      string
  recent_avg: number
  older_avg:  number
  n_recent:   number
  n_older:    number
}

interface Snapshot {
  composite_score:    number
  label:              string
  direction:          number
  session_conf:       number
  total_headlines:    number
  in_window_count:    number
  timeframe_hours:    number
  sources:            Source[]
  fetched_at:         number
  velocity?:          Velocity
  momentum?:          Momentum
  baseline_score?:    number
  baseline_std?:      number
  baseline_n?:        number
  baseline_delta?:    number
  total_collected?:   number
  total_scored?:      number
  sources_used?:      number
  bull_count:         number
  bear_count:         number
  neutral_count:      number
  bull_pct:           number
  bear_pct:           number
  high_impact_score?: number
  high_impact_count?: number
  market_context?:    MarketContext
  scoring_degraded?:  boolean
  groq_error?:        string | null
  forward_composite?:  number
  backward_composite?: number
  forward_count?:      number
  backward_count?:     number
}

interface MktEntry {
  current: number
  chg_1d:  number
  chg_5d:  number
  chg_1m:  number
  chg_ytd?: number
  regime?:  string
  avg_30d?: number
}

interface YieldCurve {
  spread_3m10y: number
  shape:        'inverted' | 'flat' | 'normal'
}

interface CutProb {
  meeting:       string
  ticker:        string
  implied_rate:  number
  bps_priced:    number
  prob_cut_25bp: number
}

interface FedPolicy {
  effective_rate?:       number
  effective_rate_proxy?: number
  note?:                 string
  cut_probabilities?:    CutProb[]
  cumulative_bps_eoy?:   number
  implied_cuts_eoy?:     number
}

interface MarketContext {
  sp500?:       MktEntry
  nasdaq?:      MktEntry
  vix?:         MktEntry
  yield_10y?:   MktEntry
  yield_3m?:    MktEntry
  yield_curve?: YieldCurve
  dxy?:         MktEntry
  gold?:        MktEntry
  oil?:         MktEntry
  natgas?:      MktEntry
  btc?:         MktEntry
  fed_policy?:  FedPolicy
}

interface HistoryPoint {
  composite_score: number
  label:           string
  direction:       number
  session_conf:    number
  fetched_at:      number
}

interface HistoryResp {
  points:   HistoryPoint[]
  velocity: Velocity | null
}

// ── Timeframe config ──────────────────────────────────────────────────────────
type Timeframe = '1h' | '4h' | '6h' | '24h' | '48h'

const TIMEFRAMES: { id: Timeframe; label: string; hours: number; desc: string }[] = [
  { id: '1h',  label: '1H',  hours: 1,  desc: 'Breaking — last 60 min' },
  { id: '4h',  label: '4H',  hours: 4,  desc: 'Session — last 4 hrs' },
  { id: '6h',  label: '6H',  hours: 6,  desc: 'Extended session' },
  { id: '24h', label: '1D',  hours: 24, desc: 'Full trading day' },
  { id: '48h', label: '2D',  hours: 48, desc: 'Two-day picture' },
]

// ── Helpers ────────────────────────────────────────────────────────────────────
function ageLabel(ageHours: number): string {
  if (ageHours < 0.017) return 'Just now'     // < 1 min
  if (ageHours < 1)     return `${Math.round(ageHours * 60)}m ago`
  if (ageHours < 24)    return `${ageHours.toFixed(0)}h ago`
  return `${Math.round(ageHours / 24)}d ago`
}

function sentimentColor(score: number): string {
  if (score >= 65) return 'var(--theme-positive-strong, #52c48a)'
  if (score >= 55) return 'var(--theme-positive, #86efac)'
  if (score >= 45) return T.muted
  if (score >= 35) return 'var(--theme-negative, #fca5a5)'
  return 'var(--theme-negative-strong, #e07878)'
}
function sentimentBg(score: number): string {
  if (score >= 65) return 'rgba(110,231,183,0.07)'
  if (score >= 55) return 'rgba(110,231,183,0.03)'
  if (score >= 45) return 'var(--theme-hover, rgba(255,255,255,0.02))'
  if (score >= 35) return 'rgba(252,165,165,0.03)'
  return 'rgba(252,165,165,0.07)'
}
function tierColor(t: number): string {
  return ['#5e768f','#60a5fa','#e8c04a','#e8935a','var(--theme-negative, #fca5a5)'][Math.max(0, t - 1)]
}
function confOpacity(c: number): number {
  return 0.45 + c * 0.55
}

const ASSET_CLASS_COLORS: Record<string, string> = {
  Equities:      '#60a5fa',
  'Fixed Income':'#e8c04a',
  FX:            '#34d399',
  Commodities:   '#e8935a',
  Crypto:        '#bd93f9',
  Macro:         '#d89fd0',
}

// ── Gauge ──────────────────────────────────────────────────────────────────────
function Gauge({ score, conf }: { score: number; conf: number }) {
  const R = 80, cx = 100, cy = 100
  const pct   = Math.max(0, Math.min(100, score)) / 100
  const angle = 180 - pct * 180
  const rad   = (angle * Math.PI) / 180
  const fx    = cx + R * Math.cos(rad)
  const fy    = cy - R * Math.sin(rad)
  const large = pct > 0.999 ? 1 : 0
  const color = sentimentColor(score)
  const trackOpacity = 0.3 + conf * 0.7
  return (
    <svg viewBox="8 8 184 112" style={{ width: '100%', display: 'block', opacity: trackOpacity }}>
      <path d={`M 20 100 A ${R} ${R} 0 0 1 180 100`}
        fill="none" stroke="var(--theme-border, rgba(255,255,255,0.08))" strokeWidth={14} strokeLinecap="round" />
      {score > 0 && (
        <path d={`M 20 100 A ${R} ${R} 0 ${large} 1 ${fx} ${fy}`}
          fill="none" stroke={color} strokeWidth={14} strokeLinecap="round" />
      )}
      <circle cx={fx} cy={fy} r={6} fill={color} />
      <text x={cx} y={cy + 6} textAnchor="middle" fill={color}
        fontFamily="var(--theme-mono)" fontSize={30} fontWeight={700}>
        {score.toFixed(0)}
      </text>
      <text x={18}  y={116} textAnchor="start" fill="var(--theme-text-dim, rgba(255,255,255,0.3))"
        fontFamily="var(--theme-mono)" fontSize={8}>FEAR</text>
      <text x={182} y={116} textAnchor="end"   fill="var(--theme-text-dim, rgba(255,255,255,0.3))"
        fontFamily="var(--theme-mono)" fontSize={8}>GREED</text>
    </svg>
  )
}

// ── Sparkline ──────────────────────────────────────────────────────────────────
function Sparkline({ points }: { points: HistoryPoint[] }) {
  if (points.length < 2) return null
  const W = 220, H = 48
  const scores = points.map(p => p.composite_score)
  const min    = Math.min(...scores, 30), max = Math.max(...scores, 70)
  const range  = max - min || 1
  const xs = points.map((_, i) => (i / (points.length - 1)) * W)
  const ys = scores.map(s => H - ((s - min) / range) * H)
  const path = xs.map((x, i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(' ')
  const color = sentimentColor(scores[scores.length - 1])
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H, display: 'block' }}>
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" opacity={0.7} />
      <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r={3} fill={color} />
    </svg>
  )
}

// ── Momentum card ──────────────────────────────────────────────────────────────
function MomentumCard({ m }: { m: Momentum }) {
  const up   = m.delta > 1
  const down = m.delta < -1
  const color = up ? T.pos : down ? T.neg : T.muted
  const icon  = up ? '↑' : down ? '↓' : '→'
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: '10px 12px' }}>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 8, fontFamily: T.mono }}>
        Momentum
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 24, color, lineHeight: 1 }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color, fontFamily: T.mono }}>{m.label}</div>
          <div style={{ fontSize: 8, color: T.muted, fontFamily: T.mono, marginTop: 2 }}>
            Recent avg {m.recent_avg.toFixed(0)} · Older avg {m.older_avg.toFixed(0)}
          </div>
          <div style={{ fontSize: 8, color: T.dim, fontFamily: T.mono }}>
            {m.n_recent} fresh vs {m.n_older} older articles
          </div>
        </div>
        <span style={{ fontSize: 15, fontWeight: 700, color, fontFamily: T.mono, flexShrink: 0 }}>
          {m.delta > 0 ? '+' : ''}{m.delta.toFixed(1)}
        </span>
      </div>
    </div>
  )
}

// ── Bull / Bear bar ────────────────────────────────────────────────────────────
function BullBearBar({ bull, bear, neutral }: { bull: number; bear: number; neutral: number }) {
  const total = bull + bear + neutral || 1
  const bPct = (bull / total) * 100
  const rPct = (bear / total) * 100
  const nPct = (neutral / total) * 100
  return (
    <div style={{ marginBottom: 14 }}>
      {/* Labels share the same proportional widths as the bar so they align exactly */}
      <div style={{ display: 'flex', marginBottom: 4, fontFamily: T.mono, fontSize: 9, overflow: 'hidden' }}>
        <span style={{ width: `${bPct}%`, flexShrink: 0, color: T.pos, textAlign: 'left', overflow: 'hidden', whiteSpace: 'nowrap' }}>
          {bPct >= 8 ? `↑ Bullish ${Math.round(bPct)}%` : ''}
        </span>
        <span style={{ width: `${nPct}%`, flexShrink: 0, color: T.muted, textAlign: 'center', overflow: 'hidden', whiteSpace: 'nowrap', fontSize: 8 }}>
          {nPct >= 6 ? `Neutral ${Math.round(nPct)}%` : ''}
        </span>
        <span style={{ width: `${rPct}%`, flexShrink: 0, color: T.neg, textAlign: 'right', overflow: 'hidden', whiteSpace: 'nowrap' }}>
          {rPct >= 8 ? `Bearish ${Math.round(rPct)}% ↓` : ''}
        </span>
      </div>
      <div style={{ display: 'flex', height: 5, borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${bPct}%`, background: T.pos, opacity: 0.65, flexShrink: 0 }} />
        <div style={{ width: `${nPct}%`, background: T.muted, opacity: 0.3, flexShrink: 0 }} />
        <div style={{ width: `${rPct}%`, background: T.neg, opacity: 0.65, flexShrink: 0 }} />
      </div>
      <div style={{ fontSize: 8, color: T.dim, fontFamily: T.mono, marginTop: 3 }}>
        {bull}B · {neutral}N · {bear}Br across all scored articles
      </div>
    </div>
  )
}

// ── Velocity badge ─────────────────────────────────────────────────────────────
function VelocityBadge({ v }: { v: Velocity }) {
  const up    = v.velocity_hr > 0
  const flat  = Math.abs(v.velocity_hr) < 0.5
  const color = flat ? T.muted : up ? T.pos : T.neg
  const arrow = flat ? '→' : up ? '↑' : '↓'
  const lbl   = flat ? 'Stable' : `${up ? '+' : ''}${v.velocity_hr.toFixed(1)}/hr`
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: 'var(--theme-hover, rgba(255,255,255,0.03))', border: `1px solid var(--theme-border-faint, rgba(255,255,255,0.05))` }}>
      <span style={{ fontSize: 14, color }}>{arrow}</span>
      <div>
        <div style={{ fontSize: 10, fontWeight: 700, color, fontFamily: T.mono }}>{lbl}</div>
        <div style={{ fontSize: 8, color: T.muted, fontFamily: T.mono }}>over {v.elapsed_min}m</div>
      </div>
    </div>
  )
}

// ── Timeframe selector ─────────────────────────────────────────────────────────
function TimeframeSelector({ active, onChange }: { active: Timeframe; onChange: (t: Timeframe) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {TIMEFRAMES.map(tf => {
        const isActive = tf.id === active
        return (
          <button
            key={tf.id}
            onClick={() => onChange(tf.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 10px',
              background: isActive ? `${T.gold}15` : 'transparent',
              border: `1px solid ${isActive ? T.gold + '60' : T.border}`,
              cursor: 'pointer', textAlign: 'left',
            }}
          >
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
              color: isActive ? T.gold : T.muted, fontFamily: T.mono, width: 24, flexShrink: 0,
            }}>
              {tf.label}
            </span>
            <span style={{ fontSize: 8, color: T.muted, fontFamily: T.label }}>{tf.desc}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── Asset class tag ────────────────────────────────────────────────────────────
function AssetTag({ name, assetClass }: { name: string; assetClass: string }) {
  const color = ASSET_CLASS_COLORS[assetClass] ?? T.muted
  return (
    <span style={{
      fontSize: 8, fontWeight: 700, fontFamily: T.mono, letterSpacing: '0.06em',
      padding: '1px 4px', border: `1px solid ${color}40`, color, background: `${color}10`,
      whiteSpace: 'nowrap',
    }}>
      {name}
    </span>
  )
}

// ── Score bar ──────────────────────────────────────────────────────────────────
function ScoreBar({ score, label, conf }: { score: number; label: string; conf: number }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, fontSize: 10, fontFamily: T.mono }}>
        <span style={{ color: T.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, marginRight: 8 }}>{label}</span>
        <span style={{ color: sentimentColor(score), flexShrink: 0 }}>{score.toFixed(0)}</span>
      </div>
      <div style={{ height: 3, background: 'var(--theme-hover, rgba(255,255,255,0.06))', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, score))}%`, background: sentimentColor(score), opacity: 0.4 + conf * 0.6, transition: 'width 0.6s ease' }} />
      </div>
    </div>
  )
}

// ── Source panel ───────────────────────────────────────────────────────────────
function SourcePanel({ src, timeframeHours }: { src: Source; timeframeHours: number }) {
  const [expanded, setExpanded] = useState(false)

  // Sort items newest first
  const sortedItems = useMemo(
    () => [...src.items].sort((a, b) => a.age_hours - b.age_hours),
    [src.items]
  )

  return (
    <div style={{ marginBottom: 8, border: `1px solid ${src.qualifies ? T.border : 'var(--theme-hover, rgba(255,255,255,0.03))'}`, background: T.surface, opacity: src.qualifies ? 1 : 0.55 }}>
      <div onClick={() => setExpanded(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', cursor: 'pointer' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: T.text, fontFamily: T.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {src.label}
            </span>
            {!src.qualifies && (
              <span style={{ fontSize: 7, fontWeight: 700, color: T.muted, letterSpacing: '0.1em', fontFamily: T.mono, background: 'var(--theme-border-faint, rgba(255,255,255,0.05))', padding: '1px 4px' }}>
                LOW SIGNAL
              </span>
            )}
          </div>
          <div style={{ fontSize: 10, color: T.muted, marginTop: 2, fontFamily: T.mono }}>
            {src.count} articles in {timeframeHours}h window · T{src.avg_tier.toFixed(0)} · avg {src.avg_age_h.toFixed(0)}h old
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: sentimentColor(src.avg_score), fontFamily: T.mono }}>
            {src.avg_score.toFixed(0)}
          </div>
          <div style={{ fontSize: 8, color: src.avg_direction > 0.1 ? T.pos : src.avg_direction < -0.1 ? T.neg : T.muted, fontFamily: T.mono }}>
            {src.avg_direction > 0 ? '+' : ''}{src.avg_direction.toFixed(2)}
          </div>
        </div>
        <span style={{ color: T.muted, fontSize: 10 }}>{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div style={{ padding: '0 12px 12px', borderTop: `1px solid ${T.border}` }}>
          {/* Asset groups */}
          {Object.keys(src.asset_groups).length > 0 && (
            <div style={{ padding: '8px 0', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {Object.entries(src.asset_groups).map(([ac, names]) =>
                names.slice(0, 4).map(name => <AssetTag key={`${ac}-${name}`} name={name} assetClass={ac} />)
              )}
            </div>
          )}

          {sortedItems.map((item, i) => (
            <div key={i} style={{
              padding: '7px 8px', marginTop: 6, background: sentimentBg(item.score),
              border: `1px solid var(--theme-hover, rgba(255,255,255,0.04))`,
              opacity: confOpacity(item.confidence),
            }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 4 }}>
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: sentimentColor(item.score), flexShrink: 0, marginTop: 2 }}>
                  {item.sentiment}
                </span>
                <span style={{ fontSize: 11, color: T.text, fontFamily: T.mono, lineHeight: '15px', flex: 1 }}>
                  {item.url
                    ? <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>{item.text}</a>
                    : item.text}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {/* Age badge */}
                <span style={{ fontSize: 9, padding: '1px 5px', fontFamily: T.mono, fontWeight: 700,
                  color: item.age_hours < 1 ? T.pos : item.age_hours < 6 ? T.gold : T.muted,
                  background: item.age_hours < 1 ? 'rgba(134,239,172,0.09)' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${item.age_hours < 1 ? 'rgba(134,239,172,0.22)' : T.border}`,
                }}>
                  {ageLabel(item.age_hours)}
                </span>
                <span style={{ fontSize: 9, padding: '1px 5px', fontFamily: T.mono, fontWeight: 700, letterSpacing: '0.06em', background: `${tierColor(item.macro_tier)}15`, color: tierColor(item.macro_tier), border: `1px solid ${tierColor(item.macro_tier)}40` }}>
                  T{item.macro_tier}
                </span>
                <span style={{ fontSize: 9, padding: '1px 5px', fontFamily: T.mono, color: T.muted, background: 'var(--theme-hover, rgba(255,255,255,0.03))', border: `1px solid ${T.border}` }}>
                  [{item.reasoning_tag}]
                </span>
                <span style={{ fontSize: 9, color: T.muted, fontFamily: T.mono }}>
                  conf {(item.confidence * 100).toFixed(0)}%
                </span>
                {(() => {
                  const fwd = item.forward_looking_weight >= 0.5
                  const Icon = fwd ? TrendingUp : History
                  const c = fwd ? T.gold : 'var(--theme-tertiary, #60a5fa)'
                  return (
                    <span title={`${fwd ? 'Forward' : 'Backward'}-looking · Forward subscore ${item.forward_sentiment_score.toFixed(0)} · Backward subscore ${item.backward_sentiment_score.toFixed(0)}`}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9, padding: '1px 5px', fontFamily: T.mono, fontWeight: 700, letterSpacing: '0.06em', cursor: 'help',
                        color: c, background: 'rgba(255,255,255,0.03)', border: `1px solid color-mix(in srgb, ${c} 40%, transparent)` }}>
                      <Icon size={10} strokeWidth={2.5} />
                      {fwd ? 'FWD' : 'BWD'} {Math.round(item.forward_looking_weight * 100)}%
                    </span>
                  )
                })()}
                {item.entities.slice(0, 3).map(e => <AssetTag key={e.name} name={e.name} assetClass={e.asset_class} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Market context card ────────────────────────────────────────────────────────
function MarketContextCard({ ctx }: { ctx: MarketContext }) {
  const [open, setOpen] = useState(true)

  const chgColor = (v: number) => v > 0.05 ? T.pos : v < -0.05 ? T.neg : T.muted

  const vixColor = ctx.vix ? (
    ctx.vix.regime === 'low'      ? 'var(--theme-positive, #86efac)' :
    ctx.vix.regime === 'normal'   ? T.muted   :
    ctx.vix.regime === 'elevated' ? '#e8c04a' : 'var(--theme-negative-strong, #e07878)'
  ) : T.muted

  const curveColor = ctx.yield_curve ? (
    ctx.yield_curve.shape === 'normal'   ? 'var(--theme-positive, #86efac)' :
    ctx.yield_curve.shape === 'flat'     ? '#e8c04a' : 'var(--theme-negative-strong, #e07878)'
  ) : T.muted

  const SectionLabel = ({ label }: { label: string }) => (
    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted, fontFamily: T.mono, marginTop: 11, marginBottom: 5 }}>
      {label}
    </div>
  )

  const Row = ({ label, val, children }: { label: string; val?: React.ReactNode; children?: React.ReactNode }) => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 9, fontFamily: T.mono, minHeight: 18 }}>
      <span style={{ color: T.muted, width: 66, flexShrink: 0, fontSize: 9 }}>{label}</span>
      {val != null && <span style={{ color: T.text, fontWeight: 700, fontSize: 11, minWidth: 50 }}>{val}</span>}
      <div style={{ display: 'flex', gap: 5, alignItems: 'baseline', flexWrap: 'wrap', color: T.muted, fontSize: 9 }}>{children}</div>
    </div>
  )

  const Chg = ({ v, suffix = '', inv = false }: { v: number; suffix?: string; inv?: boolean }) => {
    const sign = inv ? -v : v
    return <span style={{ color: chgColor(sign) }}>{v >= 0 ? '+' : ''}{v.toFixed(2)}{suffix}</span>
  }

  const Chip = ({ label, color }: { label: string; color: string }) => (
    <span style={{ fontSize: 9, padding: '1px 5px', fontWeight: 700, letterSpacing: '0.06em', background: `${color}12`, color, border: `1px solid ${color}30` }}>
      {label.toUpperCase()}
    </span>
  )

  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}` }}>
      <div onClick={() => setOpen(v => !v)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', cursor: 'pointer' }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, fontFamily: T.mono }}>
          Market Context
        </div>
        <span style={{ fontSize: 9, color: T.muted }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div style={{ padding: '0 12px 10px', borderTop: `1px solid ${T.border}` }}>

          {/* ── Equities ── */}
          {(ctx.sp500 || ctx.nasdaq || ctx.vix) && (
            <>
              <SectionLabel label="Equities" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {ctx.sp500 && (
                  <Row label="S&P 500" val={ctx.sp500.current.toLocaleString(undefined, { maximumFractionDigits: 0 })}>
                    <Chg v={ctx.sp500.chg_1d} suffix="D" />
                    <Chg v={ctx.sp500.chg_5d} suffix="W" />
                    {ctx.sp500.chg_ytd != null && <Chg v={ctx.sp500.chg_ytd} suffix="Y" />}
                  </Row>
                )}
                {ctx.nasdaq && (
                  <Row label="Nasdaq" val={ctx.nasdaq.current.toLocaleString(undefined, { maximumFractionDigits: 0 })}>
                    <Chg v={ctx.nasdaq.chg_1d} suffix="D" />
                    <Chg v={ctx.nasdaq.chg_5d} suffix="W" />
                  </Row>
                )}
                {ctx.vix && (
                  <Row label="VIX" val={<span style={{ color: vixColor }}>{ctx.vix.current.toFixed(1)}</span>}>
                    <Chip label={ctx.vix.regime ?? ''} color={vixColor} />
                    <span style={{ color: T.dim, fontSize: 9 }}>30D avg {ctx.vix.avg_30d?.toFixed(1)}</span>
                  </Row>
                )}
              </div>
            </>
          )}

          {/* ── Rates ── */}
          {(ctx.yield_10y || ctx.yield_3m || ctx.yield_curve) && (
            <>
              <SectionLabel label="Rates" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {ctx.yield_10y && (
                  <Row label="10Y Yield" val={`${ctx.yield_10y.current.toFixed(2)}%`}>
                    <span style={{ color: chgColor(-ctx.yield_10y.chg_5d) }}>
                      {ctx.yield_10y.chg_5d >= 0 ? '+' : ''}{(ctx.yield_10y.chg_5d * 100).toFixed(0)}bpW
                    </span>
                    <span style={{ color: chgColor(-ctx.yield_10y.chg_1m) }}>
                      {ctx.yield_10y.chg_1m >= 0 ? '+' : ''}{(ctx.yield_10y.chg_1m * 100).toFixed(0)}bpM
                    </span>
                  </Row>
                )}
                {ctx.yield_3m && (
                  <Row label="3M Bill" val={`${ctx.yield_3m.current.toFixed(2)}%`} />
                )}
                {ctx.yield_curve && (
                  <Row label="Spread" val={<span style={{ color: curveColor }}>{ctx.yield_curve.spread_3m10y >= 0 ? '+' : ''}{ctx.yield_curve.spread_3m10y.toFixed(2)}%</span>}>
                    <Chip label={ctx.yield_curve.shape} color={curveColor} />
                  </Row>
                )}
              </div>
            </>
          )}

          {/* ── Dollar ── */}
          {ctx.dxy && (
            <>
              <SectionLabel label="Dollar" />
              <Row label="DXY" val={ctx.dxy.current.toFixed(1)}>
                <Chg v={ctx.dxy.chg_1d} suffix="D" />
                <Chg v={ctx.dxy.chg_5d} suffix="W" />
              </Row>
            </>
          )}

          {/* ── Fed Policy ── */}
          {ctx.fed_policy && (
            <>
              <SectionLabel label="Fed Policy" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {(ctx.fed_policy.effective_rate != null || ctx.fed_policy.effective_rate_proxy != null) && (
                  <Row label="FFR" val={`${(ctx.fed_policy.effective_rate ?? ctx.fed_policy.effective_rate_proxy)?.toFixed(2)}%`}>
                    {ctx.fed_policy.note && <span style={{ color: T.dim, fontSize: 7 }}>3M proxy</span>}
                  </Row>
                )}
                {ctx.fed_policy.cut_probabilities?.map(cp => {
                  const pct = cp.prob_cut_25bp
                  const color = pct > 60 ? T.pos : pct > 30 ? '#e8c04a' : T.muted
                  const mtgLabel = new Date(cp.meeting).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                  return (
                    <div key={cp.meeting} style={{ marginBottom: 4 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontFamily: T.mono, marginBottom: 2 }}>
                        <span style={{ fontSize: 9, color: T.muted }}>{mtgLabel} FOMC</span>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                          <span style={{ fontSize: 10, color: T.text, fontWeight: 700 }}>→ {cp.implied_rate.toFixed(2)}%</span>
                          <span style={{ fontSize: 9, color, fontWeight: 600 }}>{pct.toFixed(0)}%↓</span>
                        </div>
                      </div>
                      <div style={{ height: 2, background: 'rgba(255,255,255,0.05)', borderRadius: 1, overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: color, opacity: 0.4 }} />
                      </div>
                    </div>
                  )
                })}
                {ctx.fed_policy.implied_cuts_eoy != null && (
                  <div style={{ fontSize: 9, fontFamily: T.mono, padding: '3px 6px', background: 'rgba(255,255,255,0.02)', border: `1px solid ${T.border}` }}>
                    <span style={{ color: T.muted }}>EOY: </span>
                    <span style={{ color: T.text, fontWeight: 600 }}>
                      {ctx.fed_policy.implied_cuts_eoy > 0 ? '−' : '+'}
                      {Math.abs(ctx.fed_policy.implied_cuts_eoy).toFixed(1)} cuts
                    </span>
                    {ctx.fed_policy.cumulative_bps_eoy != null && (
                      <span style={{ color: T.dim }}> ({ctx.fed_policy.cumulative_bps_eoy > 0 ? '−' : '+'}{Math.abs(ctx.fed_policy.cumulative_bps_eoy).toFixed(0)}bp)</span>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── Commodities ── */}
          {(ctx.gold || ctx.oil || ctx.natgas) && (
            <>
              <SectionLabel label="Commodities" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {ctx.gold && (
                  <Row label="Gold" val={`$${ctx.gold.current.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}>
                    <Chg v={ctx.gold.chg_1d} suffix="D" />
                    <Chg v={ctx.gold.chg_5d} suffix="W" />
                    <Chg v={ctx.gold.chg_1m} suffix="M" />
                  </Row>
                )}
                {ctx.oil && (
                  <Row label="WTI Oil" val={`$${ctx.oil.current.toFixed(1)}`}>
                    <Chg v={ctx.oil.chg_1d} suffix="D" />
                    <Chg v={ctx.oil.chg_5d} suffix="W" />
                    <Chg v={ctx.oil.chg_1m} suffix="M" />
                  </Row>
                )}
                {ctx.natgas && (
                  <Row label="Nat Gas" val={`$${ctx.natgas.current.toFixed(2)}`}>
                    <Chg v={ctx.natgas.chg_1d} suffix="D" />
                    <Chg v={ctx.natgas.chg_5d} suffix="W" />
                  </Row>
                )}
              </div>
            </>
          )}

          {/* ── Crypto ── */}
          {ctx.btc && (
            <>
              <SectionLabel label="Crypto" />
              <Row label="Bitcoin" val={`$${ctx.btc.current.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}>
                <Chg v={ctx.btc.chg_1d} suffix="D" />
                <Chg v={ctx.btc.chg_5d} suffix="W" />
                <Chg v={ctx.btc.chg_1m} suffix="M" />
              </Row>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────
export default function SentimentTracker() {
  const [timeframe, setTimeframe] = useState<Timeframe>('24h')
  const [lens, setLens] = useState<'all' | 'forward' | 'backward'>('all')
  const qc = useQueryClient()
  const tf  = TIMEFRAMES.find(t => t.id === timeframe)!

  const { data, isLoading, error, isFetching } = useQuery<Snapshot>({
    queryKey:        ['sentiment-snapshot', timeframe],
    queryFn:         () => axios.get(`/api/sentiment/snapshot?timeframe_hours=${tf.hours}`).then(r => r.data),
    staleTime:       3 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  })

  const { data: histResp } = useQuery<HistoryResp>({
    queryKey:        ['sentiment-history'],
    queryFn:         () => axios.get('/api/sentiment/history').then(r => r.data),
    staleTime:       5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
  })

  const history  = histResp?.points ?? []
  const velocity = data?.velocity ?? histResp?.velocity

  // Show last N hours of history in sparkline, matching the timeframe
  const sparklineHistory = useMemo(() => {
    const cutoff = Date.now() / 1000 - tf.hours * 3600
    const filtered = history.filter(p => p.fetched_at >= cutoff)
    return filtered.length >= 2 ? filtered : history.slice(-20)
  }, [history, tf.hours])

  const baselineAvg = useMemo(() => {
    if (data?.baseline_score != null) return data.baseline_score
    if (history.length < 3) return null
    return history.reduce((s, p) => s + p.composite_score, 0) / history.length
  }, [data, history])

  const baselineDelta = data != null && baselineAvg !== null
    ? data.baseline_delta ?? (data.composite_score - baselineAvg)
    : null
  const baselineN = data?.baseline_n ?? history.length

  const sourceTypeCounts = useMemo(() => {
    if (!data) return null
    const counts: Record<string, number> = {}
    for (const src of data.sources) {
      counts[src.type] = (counts[src.type] ?? 0) + 1
    }
    return counts
  }, [data])

  const assetClassScores = useMemo(() => {
    if (!data) return []
    const acc: Record<string, { scoreSum: number; confSum: number; count: number }> = {}
    for (const src of data.sources) {
      for (const item of src.items) {
        for (const entity of item.entities ?? []) {
          const ac = entity.asset_class
          if (!acc[ac]) acc[ac] = { scoreSum: 0, confSum: 0, count: 0 }
          acc[ac].scoreSum += item.score * item.confidence * item.recency_weight
          acc[ac].confSum  += item.confidence * item.recency_weight
          acc[ac].count    += 1
        }
      }
    }
    return Object.entries(acc)
      .filter(([, v]) => v.count > 0)
      .map(([ac, v]) => ({
        ac,
        score: v.confSum > 0 ? Math.round(v.scoreSum / v.confSum) : 50,
        count: v.count,
      }))
      .sort((a, b) => b.count - a.count)
  }, [data])

  const handleRefresh = () => {
    qc.invalidateQueries({ queryKey: ['sentiment-snapshot', timeframe] })
    qc.invalidateQueries({ queryKey: ['sentiment-history'] })
    axios.get(`/api/sentiment/snapshot?refresh=true&timeframe_hours=${tf.hours}`)
      .then(fresh => qc.setQueryData(['sentiment-snapshot', timeframe], fresh.data))
  }

  const lastUpdated = data?.fetched_at
    ? new Date(data.fetched_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null

  const conf      = data?.session_conf ?? 1
  const lowSignal = conf < 0.5
  const sources   = data?.sources ?? []

  // Forward- vs backward-looking subscores shown beneath the overall sentiment.
  const fwdComposite = data?.forward_composite ?? data?.composite_score ?? 50
  const bwdComposite = data?.backward_composite ?? data?.composite_score ?? 50
  const displaySources = lens === 'all'
    ? sources
    : sources
        .map(s => ({ ...s, items: s.items.filter(it => lens === 'forward' ? it.forward_looking_weight >= 0.5 : it.forward_looking_weight < 0.5) }))
        .filter(s => s.items.length > 0)
  const shownCount = lens === 'all'
    ? (data?.in_window_count ?? 0)
    : displaySources.reduce((n, s) => n + s.items.length, 0)

  const sidebar = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Gauge */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: '14px 14px 10px' }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 10, textAlign: 'center', fontFamily: T.mono }}>
          Market Sentiment
        </div>
        {data ? (
          <>
            <Gauge score={data.composite_score} conf={conf} />
            <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', color: sentimentColor(data.composite_score), marginTop: 6, fontFamily: T.mono, textAlign: 'center' }}>
              {data.label}
            </div>
            {/* Forward / backward subscores beneath the overall sentiment */}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              {([['Forward', fwdComposite, data.forward_count ?? 0, T.gold], ['Backward', bwdComposite, data.backward_count ?? 0, 'var(--theme-tertiary, #60a5fa)']] as const).map(([lbl, val, n, accent]) => (
                <div key={lbl} style={{ flex: 1, background: 'var(--theme-bg, #101c2e)', border: `1px solid ${T.border}`, padding: '6px 8px' }}>
                  <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: accent, fontFamily: T.mono }}>{lbl}-Looking</div>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 2 }}>
                    <span style={{ fontSize: 17, fontWeight: 700, color: sentimentColor(val), fontFamily: T.mono }}>{val.toFixed(0)}</span>
                    <span style={{ fontSize: 8, color: T.muted, fontFamily: T.mono }}>{n} {n === 1 ? 'article' : 'articles'}</span>
                  </div>
                  <div style={{ height: 3, background: T.border, marginTop: 4 }}>
                    <div style={{ width: `${Math.max(0, Math.min(100, val))}%`, height: '100%', background: sentimentColor(val) }} />
                  </div>
                </div>
              ))}
            </div>
            {data.scoring_degraded && (() => {
              const err = data.groq_error ?? ''
              const rateLimitMatch = err.match(/retry in ([^.'"]+)/i)
              const tpdMatch = err.match(/Limit (\d+).*?Used (\d+)/i)
              const isRateLimit = err.includes('429') || err.toLowerCase().includes('rate_limit')
              const isNoArticles = err === 'no articles collected'
              const isNoKey = err === 'GROQ_API_KEY not configured'
              let headline = 'SCORING UNAVAILABLE'
              let detail = 'Groq API error. Every article defaulted to neutral (50). The numbers below do not reflect actual sentiment.'
              if (isRateLimit) {
                headline = 'DAILY TOKEN LIMIT REACHED'
                const retryIn = rateLimitMatch ? rateLimitMatch[1].trim() : null
                const used = tpdMatch ? `${parseInt(tpdMatch[2]).toLocaleString()} / ${parseInt(tpdMatch[1]).toLocaleString()} tokens used today` : null
                detail = [
                  used,
                  retryIn ? `Retry in ${retryIn}.` : null,
                  'Scores defaulted to neutral — upgrade Groq plan or wait for the daily limit to reset.',
                ].filter(Boolean).join(' ')
              } else if (isNoArticles) {
                headline = 'NO ARTICLES COLLECTED'
                detail = 'RSS/Reddit/Finnhub returned no articles in this time window. Scores are placeholder neutrals.'
              } else if (isNoKey) {
                headline = 'GROQ API KEY NOT SET'
                detail = 'Set GROQ_API_KEY in backend/.env to enable sentiment scoring.'
              }
              return (
                <div style={{ marginTop: 6, fontSize: 9, fontWeight: 700, letterSpacing: '0.07em', color: '#fca5a5', fontFamily: T.mono, background: 'rgba(252,165,165,0.05)', padding: '5px 8px', border: '1px solid rgba(252,165,165,0.2)', lineHeight: '14px' }}>
                  {headline}
                  <div style={{ fontSize: 8, fontWeight: 400, marginTop: 2, color: 'rgba(252,165,165,0.7)', letterSpacing: '0.04em', lineHeight: '13px' }}>
                    {detail}
                  </div>
                </div>
              )
            })()}
            {lowSignal && (
              <div style={{ marginTop: 6, textAlign: 'center', fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', color: '#e8c04a', fontFamily: T.mono, background: 'rgba(232,192,74,0.05)', padding: '3px 0', border: '1px solid rgba(232,192,74,0.15)' }}>
                LOW SIGNAL — {data.in_window_count} articles in {tf.label} window
              </div>
            )}
            <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', fontSize: 9, color: T.muted, fontFamily: T.mono }}>
              <span>DIR {data.direction > 0 ? '+' : ''}{data.direction.toFixed(2)}</span>
              <span>{data.in_window_count} in {tf.label}</span>
            </div>
            {data.high_impact_score != null && (
              <div style={{ marginTop: 6, padding: '5px 8px', background: 'rgba(232,147,90,0.06)', border: '1px solid rgba(232,147,90,0.18)', fontFamily: T.mono }}>
                <div style={{ fontSize: 9, color: 'var(--theme-warn)', fontWeight: 700, letterSpacing: '0.08em' }}>HIGH-IMPACT SIGNAL (T4/T5)</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
                  <span style={{ fontSize: 9, color: sentimentColor(data.high_impact_score) }}>
                    Score {data.high_impact_score.toFixed(0)}
                  </span>
                  <span style={{ fontSize: 8, color: T.muted }}>{data.high_impact_count} articles</span>
                </div>
              </div>
            )}
            {baselineDelta !== null && (
              <div style={{ marginTop: 6, padding: '4px 8px', background: 'var(--theme-hover, rgba(255,255,255,0.03))', border: '1px solid var(--theme-border-faint, rgba(255,255,255,0.05))', textAlign: 'center', fontSize: 9, fontFamily: T.mono }}>
                <span style={{ color: T.muted }}>vs {baselineN}pt baseline </span>
                <span style={{ color: baselineDelta > 3 ? T.pos : baselineDelta < -3 ? T.neg : T.muted, fontWeight: 700 }}>
                  {baselineDelta > 0 ? '+' : ''}{baselineDelta.toFixed(1)}
                </span>
                {data.baseline_std != null && (
                  <span style={{ color: T.dim }}> ±{data.baseline_std.toFixed(1)}σ</span>
                )}
              </div>
            )}
            {sourceTypeCounts && (
              <div style={{ marginTop: 5, display: 'flex', gap: 4, justifyContent: 'center', flexWrap: 'wrap' }}>
                {Object.entries(sourceTypeCounts).map(([type, n]) => (
                  <span key={type} style={{
                    fontSize: 8, fontFamily: T.mono, fontWeight: 700, letterSpacing: '0.08em',
                    padding: '2px 5px', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
                    color: type === 'reddit' ? '#e8805a' : type === 'finnhub' ? '#60a5fa' : T.muted,
                    background: type === 'reddit' ? 'rgba(232,128,90,0.06)' : type === 'finnhub' ? 'rgba(96,165,250,0.05)' : 'transparent',
                  }}>
                    {type.toUpperCase()} {n}
                  </span>
                ))}
              </div>
            )}
          </>
        ) : isLoading ? (
          <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.muted, fontSize: 11 }}>Loading…</div>
        ) : null}
        {lastUpdated && (
          <div style={{ fontSize: 9, color: T.muted, marginTop: 6, fontFamily: T.mono, textAlign: 'center' }}>Updated {lastUpdated}</div>
        )}
      </div>

      {/* Market context */}
      {data?.market_context && Object.keys(data.market_context).length > 0 && (
        <MarketContextCard ctx={data.market_context} />
      )}

      {/* Momentum */}
      {data?.momentum && <MomentumCard m={data.momentum} />}

      {/* Velocity */}
      {velocity && (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: 10 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 6, fontFamily: T.mono }}>Score Velocity</div>
          <VelocityBadge v={velocity} />
        </div>
      )}

      {/* Asset-class breakdown */}
      {assetClassScores.length > 0 && (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: '10px 12px' }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 8, fontFamily: T.mono }}>
            By Asset Class
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {assetClassScores.map(({ ac, score, count }) => {
              const color     = ASSET_CLASS_COLORS[ac] ?? T.muted
              const sentiment = score >= 60 ? 'bullish' : score <= 40 ? 'bearish' : 'neutral'
              const sentColor = score >= 60 ? T.pos     : score <= 40 ? T.neg     : T.muted
              return (
                <div key={ac}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                    <span style={{ fontSize: 10, fontWeight: 600, color, fontFamily: T.mono, letterSpacing: '0.04em' }}>{ac}</span>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ fontSize: 9, color: sentColor, fontFamily: T.mono }}>{sentiment}</span>
                      <span style={{ fontSize: 10, fontWeight: 700, color, fontFamily: T.mono }}>{score}</span>
                    </div>
                  </div>
                  <div style={{ height: 3, background: T.border, borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ width: `${score}%`, height: '100%', borderRadius: 2, background: color, opacity: 0.75, transition: 'width 0.5s ease' }} />
                  </div>
                  <div style={{ fontSize: 8, color: T.muted, marginTop: 2, fontFamily: T.mono }}>{count} mention{count !== 1 ? 's' : ''}</div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Timeframe selector */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: 10 }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 8, fontFamily: T.mono }}>Timeframe</div>
        <TimeframeSelector active={timeframe} onChange={setTimeframe} />
      </div>

      {/* Trend sparkline */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: 12 }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 6, fontFamily: T.mono }}>
          Trend — {tf.label}
        </div>
        {sparklineHistory.length >= 2
          ? <Sparkline points={sparklineHistory} />
          : <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, textAlign: 'center', padding: '12px 0' }}>Accumulates across refreshes</div>
        }
      </div>

      {/* Source score bars */}
      {sources.length > 0 && (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: 12 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 10, fontFamily: T.mono }}>
            By Source
          </div>
          {sources.map(s => (
            <ScoreBar key={s.label} score={s.avg_score} label={s.label} conf={s.avg_conf} />
          ))}
        </div>
      )}

      {/* Refresh */}
      <button
        onClick={handleRefresh}
        disabled={isFetching}
        style={{
          padding: '7px 12px', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
          textTransform: 'uppercase', background: 'transparent', border: `1px solid ${T.gold}`,
          color: T.gold, cursor: isFetching ? 'wait' : 'pointer',
          fontFamily: T.mono, opacity: isFetching ? 0.5 : 1,
        }}
      >
        {isFetching ? 'Fetching…' : '↺ Refresh'}
      </button>
    </div>
  )

  const content = (
    <div>
      {error && (
        <div style={{ padding: 12, background: 'color-mix(in srgb, var(--theme-negative) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-negative) 30%, transparent)', color: 'var(--theme-negative, #fca5a5)', fontSize: 11, fontFamily: T.mono, marginBottom: 12 }}>
          Failed to load sentiment data. Backend may be starting up.
        </div>
      )}
      {isLoading && !data && (
        <div style={{ textAlign: 'center', padding: 48, color: T.muted, fontSize: 12, fontFamily: T.mono }}>
          Fetching and scoring financial news…<br />
          <span style={{ fontSize: 10, opacity: 0.6 }}>First load ~10–15 seconds</span>
        </div>
      )}

      {data && (
        <>
          {/* Headline horizon filter */}
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: '10px 14px', marginBottom: 14, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, fontFamily: T.mono }}>Filter Headlines By Horizon</span>
            <div style={{ display: 'flex', border: `1px solid ${T.border}` }}>
              {([['all', 'All Articles'], ['forward', 'Forward-Looking'], ['backward', 'Backward-Looking']] as const).map(([k, lbl], i) => (
                <button key={k} onClick={() => setLens(k)} style={{
                  background: lens === k ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 16%, transparent)' : 'transparent',
                  border: 'none', borderLeft: i ? `1px solid ${T.border}` : 'none', cursor: 'pointer',
                  color: lens === k ? T.gold : T.muted, fontFamily: T.mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '6px 11px', whiteSpace: 'nowrap',
                }}>{lbl}</button>
              ))}
            </div>
          </div>

          {/* Bull / Bear distribution */}
          <BullBearBar bull={data.bull_count} bear={data.bear_count} neutral={data.neutral_count} />

          {/* Asset class legend */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
            {Object.entries(ASSET_CLASS_COLORS).map(([ac, color]) => (
              <span key={ac} style={{ fontSize: 8, fontWeight: 700, fontFamily: T.mono, letterSpacing: '0.06em', padding: '2px 6px', border: `1px solid ${color}40`, color, background: `${color}10` }}>
                {ac}
              </span>
            ))}
            <span style={{ fontSize: 8, fontFamily: T.mono, color: T.muted, padding: '2px 6px', border: `1px solid ${T.border}` }}>T1–T5 = macro tier</span>
          </div>

          {sources.length > 0 && (
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 8, fontFamily: T.mono }}>
                News Headlines — last {tf.label} · {shownCount} {lens === 'forward' ? 'forward-looking' : lens === 'backward' ? 'backward-looking' : 'articles'} in window
              </div>
              {displaySources.length === 0 ? (
                <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, padding: '16px 0', textAlign: 'center' }}>
                  No {lens}-looking articles in this window.
                </div>
              ) : displaySources.map(src => (
                <SourcePanel key={src.label} src={src} timeframeHours={tf.hours} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )

  return (
    <PageWrapper title="Sentiment Tracker">
      <SidebarLayout sidebar={sidebar} sidebarWidth={260}>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 12 }}>
          Lexicon-scored Financial News ·{' '}
          <span style={{ color: T.gold }}>{tf.label} window</span>
          {' · '}time-decay weighted · momentum tracked
        </div>
        {content}
      </SidebarLayout>
    </PageWrapper>
  )
}
