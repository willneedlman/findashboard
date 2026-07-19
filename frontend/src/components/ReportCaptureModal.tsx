import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Plus, Search } from 'lucide-react'
import { T } from '../lib/theme'
import ClipRenderer from './report/ClipRenderer'
import { useReportCreator, createProject, addClip, type ClipDraft } from '../lib/reportCreator'

// The capture modal: pick which displays from the tool to include (a visual
// selector, each a live mini preview), annotate any of them, and route the
// selection to a report project. Lazy-loaded by ReportCaptureHost on first
// capture so recharts stays out of the index chunk.

const DTYPE_COLOR: Record<string, string> = { table: '#60a5fa', chart: '#c9a84c', kpi: '#34d399', text: '#c084fc' }

const primaryBtn: React.CSSProperties = {
  background: T.gold, border: 'none', color: 'var(--theme-bg)',
  fontFamily: T.label, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
  textTransform: 'uppercase', padding: '9px 0', cursor: 'pointer', flex: 1,
}
const ghostBtn: React.CSSProperties = {
  background: 'transparent', border: `1px solid ${T.border}`, color: T.muted,
  fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
  textTransform: 'uppercase', padding: '9px 12px', cursor: 'pointer',
}
const inp: React.CSSProperties = {
  background: T.bg, border: `1px solid ${T.border}`, color: T.text, fontFamily: T.mono,
  fontSize: 11, padding: '7px 9px', width: '100%', outline: 'none', boxSizing: 'border-box',
}
const sectionLabel: React.CSSProperties = {
  display: 'block', fontFamily: T.label, fontSize: 8.5, fontWeight: 700,
  letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, marginBottom: 8,
}

function PieceCard({ piece, index, selected, note, onToggle, onNote }: {
  piece: ClipDraft; index: number; selected: boolean; note: string
  onToggle: () => void; onNote: (v: string) => void
}) {
  const color = DTYPE_COLOR[piece.dataType] ?? T.muted
  return (
    <div style={{ border: `1px solid ${selected ? T.gold : T.border}`, background: selected ? T.goldTint(6) : T.bg }}>
      <button onClick={onToggle} aria-pressed={selected}
        style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', padding: '9px 11px' }}>
        <span style={{ width: 15, height: 15, flexShrink: 0, border: `1px solid ${selected ? T.gold : T.muted}`, background: selected ? T.gold : 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          {selected && <Check size={11} color="var(--theme-bg)" />}
        </span>
        <span style={{ fontFamily: T.label, fontSize: 7.5, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color, border: `1px solid ${color}`, padding: '2px 5px', flexShrink: 0 }}>{piece.dataType}</span>
        <span style={{ minWidth: 0, flex: 1, fontFamily: T.label, fontSize: 11.5, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{piece.payload.title || `${piece.sourceTab} ${piece.dataType}`}</span>
      </button>
      <div aria-hidden style={{ maxHeight: 120, overflow: 'hidden', padding: '0 11px 10px', pointerEvents: 'none', opacity: selected ? 1 : 0.5, position: 'relative' }}>
        <ClipRenderer payload={piece.payload} mode="dark" compact />
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 26, background: `linear-gradient(transparent, ${selected ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 6%, var(--theme-bg, #101c2e))' : 'var(--theme-bg, #101c2e)'})` }} />
      </div>
      {selected && (
        <div style={{ padding: '0 11px 11px' }}>
          <input value={note} onChange={e => onNote(e.target.value)} placeholder="Note or instruction for this piece (optional)"
            style={{ ...inp, fontFamily: T.label, fontSize: 10.5 }} data-piece-note={index} />
        </div>
      )}
    </div>
  )
}

export default function ReportCaptureModal({ pieces, onClose }: { pieces: ClipDraft[]; onClose: () => void }) {
  const navigate = useNavigate()
  const projects = useReportCreator()
  const [selected, setSelected] = useState<boolean[]>(() => pieces.map(() => true))
  const [notes, setNotes] = useState<string[]>(() => pieces.map(() => ''))
  const [creating, setCreating] = useState(projects.length === 0)
  const [newName, setNewName] = useState('')
  const [selectedId, setSelectedId] = useState(projects[0]?.id ?? '')
  const [query, setQuery] = useState('')
  const [savedProjectId, setSavedProjectId] = useState<string | null>(null)

  const chosen = selected.filter(Boolean).length
  const filtered = useMemo(
    () => projects.filter(p => p.name.toLowerCase().includes(query.trim().toLowerCase())),
    [projects, query],
  )
  const canSave = chosen > 0 && (creating ? newName.trim().length > 0 : !!selectedId)

  const save = () => {
    if (!canSave) return
    let projectId = selectedId
    if (creating) projectId = createProject(newName).id
    pieces.forEach((piece, i) => { if (selected[i]) addClip(projectId, piece, notes[i]) })
    setSavedProjectId(projectId)
  }

  return (
    <div onClick={onClose} role="dialog" aria-modal="true" aria-label="Send to Report Creator"
      style={{ position: 'fixed', inset: 0, zIndex: 1001, background: 'rgba(0,0,0,0.62)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: 'min(580px, 95vw)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', background: T.surface, border: `1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 34%, transparent)`, boxShadow: '0 24px 70px rgba(0,0,0,0.55)', overflow: 'hidden' }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '13px 16px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <span style={{ fontFamily: T.label, fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.gold }}>Send to Report Creator</span>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.muted, fontSize: 16, lineHeight: 1 }}>×</button>
        </div>

        {savedProjectId ? (
          <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center', textAlign: 'center' }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: T.pos, fontFamily: T.label, fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              <Check size={16} /> {chosen} clip{chosen === 1 ? '' : 's'} saved
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted, lineHeight: 1.5 }}>
              Added to your report. Keep clipping from other tools, then generate the AI report when you are ready.
            </div>
            <div style={{ display: 'flex', gap: 8, width: '100%' }}>
              <button onClick={onClose} style={ghostBtn}>Keep browsing</button>
              <button onClick={() => { onClose(); navigate('/report-creator') }} style={primaryBtn}>Open Report Creator</button>
            </div>
          </div>
        ) : (
          <div style={{ padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                <span style={sectionLabel}>Choose what to include</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontFamily: T.mono, fontSize: 8.5, color: T.muted }}>{pieces[0]?.sourceTab} · {chosen}/{pieces.length} selected</span>
                  {pieces.length > 1 && (
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      <button type="button" onClick={() => setSelected(pieces.map(() => true))}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: T.mono, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.gold }}>
                        All
                      </button>
                      <button type="button" onClick={() => setSelected(pieces.map(() => false))}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: T.mono, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.muted }}>
                        None
                      </button>
                    </span>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {pieces.map((piece, i) => (
                  <PieceCard key={`${piece.payload.title ?? piece.dataType}-${i}`} piece={piece} index={i} selected={selected[i]} note={notes[i]}
                    onToggle={() => setSelected(s => s.map((v, j) => (j === i ? !v : v)))}
                    onNote={v => setNotes(n => n.map((x, j) => (j === i ? v : x)))} />
                ))}
              </div>
            </div>

            <div>
              <span style={sectionLabel}>Add to project</span>
              {creating ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <input autoFocus value={newName} onChange={e => setNewName(e.target.value)} placeholder="New project name, e.g. Q2 risk review" style={inp}
                    onKeyDown={e => { if (e.key === 'Enter') save() }} />
                  {projects.length > 0 && (
                    <button onClick={() => setCreating(false)} style={{ ...ghostBtn, alignSelf: 'flex-start', padding: '5px 10px' }}>← Choose existing</button>
                  )}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ position: 'relative' }}>
                    <Search size={12} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: T.muted }} />
                    <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search projects" style={{ ...inp, paddingLeft: 28 }} />
                  </div>
                  <div style={{ maxHeight: 140, overflowY: 'auto', border: `1px solid ${T.border}` }}>
                    {filtered.length === 0 ? (
                      <div style={{ padding: '10px 12px', fontFamily: T.mono, fontSize: 10, color: T.muted }}>No matching projects.</div>
                    ) : filtered.map(p => {
                      const on = p.id === selectedId
                      return (
                        <button key={p.id} onClick={() => setSelectedId(p.id)}
                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', textAlign: 'left', background: on ? T.goldTint(12) : 'transparent', border: 'none', borderBottom: `1px solid ${T.borderFaint}`, padding: '8px 12px', cursor: 'pointer' }}>
                          <span style={{ fontFamily: T.label, fontSize: 11, color: on ? T.gold : T.text }}>{p.name}</span>
                          <span style={{ fontFamily: T.mono, fontSize: 8.5, color: T.muted }}>{p.clips.length} clip{p.clips.length === 1 ? '' : 's'}</span>
                        </button>
                      )
                    })}
                  </div>
                  <button onClick={() => { setCreating(true); setNewName(query) }} style={{ ...ghostBtn, alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px' }}>
                    <Plus size={12} /> Create new project
                  </button>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={onClose} style={ghostBtn}>Cancel</button>
              <button onClick={save} disabled={!canSave} style={{ ...primaryBtn, opacity: canSave ? 1 : 0.5, cursor: canSave ? 'pointer' : 'default' }}>
                {creating ? `Create & add ${chosen}` : `Add ${chosen} clip${chosen === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
