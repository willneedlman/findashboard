import { fetchChokepointBoard } from '../hooks/useApi'
import ObservationBoardPanel from './ObservationBoardPanel'

// Chokepoint flavour of the shared observation board.

export default function StationBoardPanel({ chokepointId, days = 120, compact = true }: {
  chokepointId: string
  days?: number
  compact?: boolean
}) {
  return (
    <ObservationBoardPanel
      queryKey={['chokepoint-board', chokepointId, days]}
      fetcher={() => fetchChokepointBoard(chokepointId, days)}
      enabled={Boolean(chokepointId)}
      compact={compact}
      emptyLabel="Station board unavailable. The transit feed did not return a usable series."
      footnote={
        'Each transit measure is read on its own. They are never pooled into a single ' +
        'traffic index, because a crude disruption and a container reroute look identical ' +
        'once summed. Breaks in a line are real coverage gaps where the feed saw nothing.'
      }
    />
  )
}
