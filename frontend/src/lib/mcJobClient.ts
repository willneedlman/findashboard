/**
 * Background-safe Monte Carlo job client.
 *
 * Flow: POST /start → poll GET /jobs/:id (no client deadline).
 * Server reports live progress; UI can show a progress bar.
 * Survives background-tab freezes better than a multi-minute open POST.
 */

import axios from 'axios'

export type McJobStatus = 'queued' | 'running' | 'done' | 'error'

export type McJobProgress = {
  progress: number
  progress_message: string
  status: McJobStatus
  job_id?: string
}

export type McJobResponse<T = unknown> = {
  job_id: string
  status: McJobStatus
  result?: T
  detail?: string
  created_at?: number
  started_at?: number | null
  finished_at?: number | null
  progress?: number
  progress_message?: string
}

/** Module-level handle so SPA remounts can reattach to an in-flight job. */
let activeJobId: string | null = null

export function getActiveMcJobId(): string | null {
  return activeJobId
}

export function clearActiveMcJobId(): void {
  activeJobId = null
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const start = Date.now()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      document.removeEventListener('visibilitychange', onVis)
      resolve()
    }
    const onVis = () => {
      if (!document.hidden) finish()
    }
    document.addEventListener('visibilitychange', onVis)
    const tick = () => {
      if (settled) return
      if (Date.now() - start >= ms) {
        finish()
        return
      }
      const remaining = ms - (Date.now() - start)
      window.setTimeout(tick, Math.min(document.hidden ? 2000 : 500, remaining))
    }
    window.setTimeout(tick, Math.min(document.hidden ? 2000 : 500, ms))
  })
}

/**
 * Start a combo Monte Carlo job and poll until done / error.
 * Does **not** client-timeout the wait — only individual HTTP calls have short
 * timeouts. Use `onProgress` for live UI updates.
 */
export async function runComboMonteCarloJob<T = unknown>(
  body: Record<string, unknown>,
  opts: {
    pollMsVisible?: number
    pollMsHidden?: number
    onProgress?: (p: McJobProgress) => void
  } = {},
): Promise<T> {
  const pollVis = opts.pollMsVisible ?? 1_200
  const pollHid = opts.pollMsHidden ?? 3_000
  const onProgress = opts.onProgress

  const { data: start } = await axios.post<McJobResponse>('/api/algo/combo-montecarlo/start', body, {
    timeout: 60_000,
  })
  if (!start?.job_id) {
    throw new Error('Monte Carlo job failed to start (no job_id)')
  }
  activeJobId = start.job_id
  onProgress?.({
    progress: start.progress ?? 0,
    progress_message: start.progress_message || 'Queued…',
    status: start.status,
    job_id: start.job_id,
  })

  if (start.status === 'done' && start.result !== undefined) {
    activeJobId = null
    onProgress?.({ progress: 100, progress_message: 'Complete', status: 'done', job_id: start.job_id })
    return start.result as T
  }
  if (start.status === 'error') {
    activeJobId = null
    const err: any = new Error(typeof start.detail === 'string' ? start.detail : 'Simulation failed')
    err.response = { data: { detail: start.detail }, status: 500 }
    throw err
  }

  // No overall client deadline — poll until the server finishes or errors.
  while (true) {
    await sleep(document.hidden ? pollHid : pollVis)
    let job: McJobResponse<T>
    try {
      const res = await axios.get<McJobResponse<T>>(
        `/api/algo/combo-montecarlo/jobs/${start.job_id}`,
        { timeout: 30_000 },
      )
      job = res.data
    } catch {
      // Transient network blip — keep polling forever until job resolves.
      onProgress?.({
        progress: 0,
        progress_message: 'Reconnecting to job status…',
        status: 'running',
        job_id: start.job_id,
      })
      continue
    }

    onProgress?.({
      progress: job.progress ?? (job.status === 'done' ? 100 : 0),
      progress_message: job.progress_message || (job.status === 'running' ? 'Running…' : job.status),
      status: job.status,
      job_id: start.job_id,
    })

    if (job.status === 'done') {
      activeJobId = null
      if (job.result === undefined) throw new Error('Job finished with no result')
      return job.result
    }
    if (job.status === 'error') {
      activeJobId = null
      const err: any = new Error(typeof job.detail === 'string' ? job.detail : 'Simulation failed')
      err.response = { data: { detail: job.detail }, status: 500 }
      throw err
    }
  }
}
