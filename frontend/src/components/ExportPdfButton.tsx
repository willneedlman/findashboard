import { useState } from 'react'
import { usePdfExport } from '../hooks/usePdfExport'

const T = {
  surface: 'var(--theme-surface, #0d1826)',
  border:  'var(--theme-border, var(--theme-border, rgba(255,255,255,0.08)))',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  mono:    'var(--theme-mono)',
}

interface Props {
  targetId: string
  filename:  string
}

export default function ExportPdfButton({ targetId, filename }: Props) {
  const { exportPdf }   = usePdfExport()
  const [busy, setBusy] = useState(false)

  const handle = async () => {
    setBusy(true)
    try {
      await exportPdf(targetId, filename)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      onClick={handle}
      disabled={busy}
      style={{
        background:  T.surface,
        border:      `1px solid ${T.gold}40`,
        color:       busy ? T.muted : T.gold,
        fontFamily:  T.mono,
        fontSize:    10,
        fontWeight:  700,
        letterSpacing: '0.08em',
        padding:     '4px 10px',
        cursor:      busy ? 'not-allowed' : 'pointer',
        outline:     'none',
        opacity:     busy ? 0.6 : 1,
        transition:  'opacity 0.15s',
      }}
    >
      {busy ? 'EXPORTING…' : '↓ PDF'}
    </button>
  )
}
