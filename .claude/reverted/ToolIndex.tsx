import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Search, X } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import { JOBS, ASSETS, TOOLS, type Asset, type Job, type Tool } from '../lib/tools'
import { T } from '../lib/theme'
import { MONO, SANS } from './cockpitKit'

// The browse surface. Cmd-K is the fast path for anyone who knows the name, so
// this one exists for the other case: finding a tool you did not know was here.
// Every tool appears under each job it does rather than under a single parent,
// which is the whole point. Thirty of the sixty do more than one.

export default function ToolIndex() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const [q, setQ] = useState('')

  const jobs = new Set((params.get('job') || '').split(',').filter(Boolean) as Job[])
  const assets = new Set((params.get('asset') || '').split(',').filter(Boolean) as Asset[])

  // Filters live in the URL so a narrowed view can be linked, and so the old
  // hub URLs can redirect to their nearest equivalent with a job preselected.
  const toggle = (key: 'job' | 'asset', value: string) => {
    const next = new Set((params.get(key) || '').split(',').filter(Boolean))
    if (next.has(value)) next.delete(value)
    else next.add(value)
    const merged = new URLSearchParams(params)
    if (next.size) merged.set(key, [...next].join(','))
    else merged.delete(key)
    setParams(merged, { replace: true })
  }

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return TOOLS.filter(t => {
      if (assets.size && !t.assets.some(a => assets.has(a))) return false
      if (!needle) return true
      return `${t.title} ${t.chip} ${t.desc} ${t.route}`.toLowerCase().includes(needle)
    })
  }, [q, params.get('asset')])

  const groups = useMemo(() => JOBS
    .filter(j => !jobs.size || jobs.has(j.id))
    .map(j => ({ ...j, tools: matches.filter(t => t.jobs.includes(j.id)) }))
    .filter(g => g.tools.length > 0),
  [matches, params.get('job')])

  const shown = new Set(groups.flatMap(g => g.tools.map(t => t.route))).size
  const filtered = jobs.size > 0 || assets.size > 0 || q.trim().length > 0

  return (
    <PageWrapper
      title="All tools"
      meta={
        <span style={{ fontFamily: MONO, fontSize: 10.5, lineHeight: 1.6, color: T.muted }}>
          {TOOLS.length} tools. Filter by what you are trying to do, or by market.
          A tool that does two jobs is listed under both.
        </span>
      }
    >
      <div className="tix-frame">
        <div className="tix-search">
          <Search size={14} style={{ color: T.muted, flexShrink: 0 }} />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search tools"
            aria-label="Search tools"
            style={{
              flex: 1, minWidth: 0, height: 30, border: 0, outline: 'none',
              background: 'transparent', color: T.text, fontFamily: MONO, fontSize: 13,
            }}
          />
          {filtered && (
            <button
              onClick={() => { setQ(''); setParams(new URLSearchParams(), { replace: true }) }}
              className="tix-clear"
            >
              <X size={11} /> Clear
            </button>
          )}
        </div>

        <div className="tix-filters">
          <div className="tix-row">
            <span className="tix-rowlabel">Doing</span>
            {JOBS.map(j => (
              <button key={j.id} onClick={() => toggle('job', j.id)}
                aria-pressed={jobs.has(j.id)}
                className={`tix-chip${jobs.has(j.id) ? ' on' : ''}`}>{j.label}</button>
            ))}
          </div>
          <div className="tix-row">
            <span className="tix-rowlabel">Market</span>
            {ASSETS.map(a => (
              <button key={a.id} onClick={() => toggle('asset', a.id)}
                aria-pressed={assets.has(a.id)}
                className={`tix-chip${assets.has(a.id) ? ' on' : ''}`}>{a.label}</button>
            ))}
          </div>
        </div>

        {filtered && (
          <div className="tix-count">
            {shown} of {TOOLS.length} tools
            {groups.length !== JOBS.length && ` across ${groups.length} of ${JOBS.length} groups`}
          </div>
        )}

        {groups.length === 0 ? (
          <div style={{ padding: '34px 22px', fontFamily: MONO, fontSize: 12, color: T.muted }}>
            Nothing matches that. Clear a filter, or search a different word.
          </div>
        ) : groups.map(g => (
          <section key={g.id} className="tix-group">
            <header className="tix-grouphead">
              <h2>{g.label}</h2>
              <span className="tix-blurb">{g.blurb}</span>
              <span className="tix-n">{g.tools.length}</span>
            </header>
            <div className="tix-grid">
              {g.tools.map(t => (
                <ToolRow key={`${g.id}-${t.route}`} tool={t} home={g.id}
                  go={() => navigate(t.route)} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </PageWrapper>
  )
}

function ToolRow({ tool, home, go }: { tool: Tool; home: Job; go: () => void }) {
  const Icon = tool.icon
  // The other jobs it does. Naming them here is what makes the multi-membership
  // legible rather than merely true: you can see the tool has another use.
  const elsewhere = tool.jobs.filter(j => j !== home)
  return (
    <button onClick={go} className="tix-tool">
      <Icon size={15} className="tix-icon" />
      <span className="tix-title">{tool.title}</span>
      {elsewhere.length > 0 && (
        <span className="tix-also">
          {elsewhere.map(j => (
            <i key={j}>{JOBS.find(x => x.id === j)?.label}</i>
          ))}
        </span>
      )}
      <span className="tix-desc">{tool.desc}</span>
    </button>
  )
}
