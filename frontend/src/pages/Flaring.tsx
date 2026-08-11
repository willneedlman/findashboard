import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import PageWrapper from '../components/PageWrapper'
import ObservationBoardPanel from '../components/ObservationBoardPanel'
import { fetchEnergyBoard, fetchFlaringBoard, fetchFlaringSites, fetchObservatorySources } from '../hooks/useApi'
import { T } from '../lib/theme'
import { MONO, SANS, mix, Panel } from './cockpitKit'

interface Site { id: string; label: string; unit: string; bbox: number[] }
interface SitesResp { available: boolean; reason: string | null; sites: Site[] }
interface Source {
  id: string; label: string; available: boolean; requiresKey: boolean
  envVar?: string; signup?: string; note: string
}
interface SourcesResp { sources: Source[] }

const WINDOWS = [30, 60, 90, 120] as const
const ENERGY_BOARDS = [
  { id: 'us_natgas', label: 'US natural gas' },
  { id: 'us_crude', label: 'US crude supply' },
] as const

export default function Flaring() {
  const [site, setSite] = useState('permian')
  const [days, setDays] = useState<number>(60)
  const [energy, setEnergy] = useState<string>('us_natgas')

  const { data: sites, isLoading } = useQuery<SitesResp>({
    queryKey: ['flaring-sites'],
    queryFn: fetchFlaringSites,
    staleTime: 6 * 3_600_000,
    refetchOnWindowFocus: false,
  })

  const { data: sources } = useQuery<SourcesResp>({
    queryKey: ['observatory-sources'],
    queryFn: fetchObservatorySources,
    staleTime: 6 * 3_600_000,
    refetchOnWindowFocus: false,
  })

  const eiaWired = sources?.sources.find(s => s.id === 'eia')?.available ?? false
  const missing = (sources?.sources ?? []).filter(s => s.requiresKey && !s.available)

  return (
    <PageWrapper title="Flaring Watch">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{
          margin: 0, maxWidth: 900, fontFamily: SANS, fontSize: 12.5, lineHeight: 1.65, color: T.muted,
        }}>
          Gas flares burn hot enough to register as thermal anomalies in VIIRS. Summing
          radiant power inside a fixed polygon tracks field activity without anyone
          reporting it. Read it as burned gas, not output: a flare is gas that was not
          captured, so a rising signal can mean more drilling or less capacity to take
          it away, and the two look the same from orbit.
        </p>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {(sites?.sites ?? []).map(s => {
            const on = s.id === site
            return (
              <button
                key={s.id}
                onClick={() => setSite(s.id)}
                style={{
                  fontFamily: MONO, fontSize: 10, padding: '4px 9px', cursor: 'pointer',
                  background: on ? mix(T.gold, 14) : 'transparent',
                  color: on ? T.gold : T.muted,
                  border: `1px solid ${on ? T.gold : T.border}`,
                }}
              >{s.label.replace(/ — .*$/, '')}</button>
            )
          })}

          <div style={{ width: 1, alignSelf: 'stretch', background: T.border, margin: '0 6px' }} />

          {WINDOWS.map(w => {
            const on = w === days
            return (
              <button
                key={w}
                onClick={() => setDays(w)}
                style={{
                  fontFamily: MONO, fontSize: 10, padding: '4px 9px', cursor: 'pointer',
                  background: on ? mix(T.gold, 14) : 'transparent',
                  color: on ? T.gold : T.muted,
                  border: `1px solid ${on ? T.gold : T.border}`,
                }}
              >{w}d</button>
            )
          })}
        </div>

        {!isLoading && missing.length > 0 && (
          <Panel label="Feeds Not Wired" style={{ padding: '30px 12px 14px' }}>
            <p style={{ margin: '0 0 10px', fontFamily: MONO, fontSize: 10, lineHeight: 1.7, color: T.muted }}>
              Nothing is shown for these rather than an empty chart. A blank series and a
              field that stopped flaring are the same picture, and only one of them is true.
            </p>
            {missing.map(s => (
              <div key={s.id} style={{
                display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline',
                padding: '6px 0', borderTop: `1px solid ${T.border}`,
              }}>
                <span style={{ fontFamily: MONO, fontSize: 10.5, color: T.text }}>{s.label}</span>
                <code style={{ fontFamily: MONO, fontSize: 10, color: T.gold }}>{s.envVar}</code>
                <a
                  href={s.signup} target="_blank" rel="noreferrer"
                  style={{ fontFamily: MONO, fontSize: 10, color: T.blue }}
                >get a free key</a>
                <span style={{ fontFamily: MONO, fontSize: 9.5, color: T.muted }}>{s.note}</span>
              </div>
            ))}
          </Panel>
        )}

        {sites?.available && (
          <Panel
            label="Flaring Board"
            meta="VIIRS radiant power · descriptive, not a forecast"
            style={{ padding: '30px 12px 14px' }}
          >
            <ObservationBoardPanel
              queryKey={['flaring-board', site, days]}
              fetcher={() => fetchFlaringBoard(site, days)}
              emptyLabel="Flaring board unavailable. The thermal feed did not return a usable series."
              footnote={
                'Radiant power is summed across every high-confidence detection inside the ' +
                'field polygon. Days with a satellite pass and no detection are real zeros; ' +
                'days with no pass are coverage gaps, and nothing is drawn across them.'
              }
            />
          </Panel>
        )}

        {eiaWired && (
          <Panel
            label="Production Context"
            meta="EIA official statistics · revised and published on a lag"
            style={{ padding: '30px 12px 14px' }}
          >
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              {ENERGY_BOARDS.map(b => {
                const on = b.id === energy
                return (
                  <button
                    key={b.id}
                    onClick={() => setEnergy(b.id)}
                    style={{
                      fontFamily: MONO, fontSize: 10, padding: '4px 9px', cursor: 'pointer',
                      background: on ? mix(T.gold, 14) : 'transparent',
                      color: on ? T.gold : T.muted,
                      border: `1px solid ${on ? T.gold : T.border}`,
                    }}
                  >{b.label}</button>
                )
              })}
            </div>
            <ObservationBoardPanel
              queryKey={['energy-board', energy]}
              fetcher={() => fetchEnergyBoard(energy)}
              emptyLabel="Energy board unavailable. EIA did not return a usable series."
              footnote={
                'Marketed production counts gas that reached market, so it already excludes ' +
                'what was flared. Read against the flaring board it separates the two readings ' +
                'a flare signal alone cannot: more drilling, or less capacity to take the gas away.'
              }
            />
          </Panel>
        )}
      </div>
    </PageWrapper>
  )
}
