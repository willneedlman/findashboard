import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import { Clock3, Download, FileIcon, FileUp, RefreshCw, Trash2 } from 'lucide-react'
import useIsMobile from '../../hooks/useIsMobile'

interface TempFileItem {
  id: string
  name: string
  contentType: string
  size: number
  createdAt: number
  expiresAt: number
}

interface TempFileResponse {
  files: TempFileItem[]
  retentionSeconds: number
  limits: {
    maxFileBytes: number
    maxTotalBytes: number
    maxFiles: number
  }
}

const RED = 'var(--theme-negative, #ef4444)'
const RED_BORDER = 'color-mix(in srgb, var(--theme-negative) 25%, transparent)'
const RED_TINT = 'color-mix(in srgb, var(--theme-negative) 8%, transparent)'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

function formatRemaining(seconds: number): string {
  if (seconds <= 0) return 'Expired'
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

function fileExtension(name: string): string {
  const extension = name.split('.').pop()
  return extension && extension !== name ? extension.slice(0, 5).toUpperCase() : 'FILE'
}

function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    return error.response?.data?.detail || error.message || 'Request failed'
  }
  return error instanceof Error ? error.message : 'Request failed'
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export default function TemporaryFileDrop({ secret }: { secret: string }) {
  const isMobile = useIsMobile(640)
  const inputRef = useRef<HTMLInputElement>(null)
  const [data, setData] = useState<TempFileResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadName, setUploadName] = useState('')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [downloadingAll, setDownloadingAll] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())

  const headers = useMemo(() => ({ 'x-admin-secret': secret }), [secret])

  const loadFiles = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const response = await axios.get<TempFileResponse>('/api/admin/files', { headers })
      setData(response.data)
      setError('')
    } catch (loadError) {
      setError(errorMessage(loadError))
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [headers])

  useEffect(() => {
    loadFiles()
    const refresh = window.setInterval(() => loadFiles(true), 15_000)
    const clock = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => {
      window.clearInterval(refresh)
      window.clearInterval(clock)
    }
  }, [loadFiles])

  const uploadFiles = useCallback(async (selected: File[]) => {
    if (!selected.length || uploading) return
    setUploading(true)
    setError('')
    setUploadProgress(0)
    try {
      for (let index = 0; index < selected.length; index += 1) {
        const file = selected[index]
        setUploadName(file.name)
        const body = new FormData()
        body.append('file', file)
        await axios.post('/api/admin/files', body, {
          headers,
          onUploadProgress: progress => {
            const current = progress.total ? progress.loaded / progress.total : 0
            setUploadProgress(((index + current) / selected.length) * 100)
          },
        })
      }
      setUploadProgress(100)
      await loadFiles(true)
    } catch (uploadError) {
      setError(errorMessage(uploadError))
      await loadFiles(true)
    } finally {
      setUploading(false)
      setUploadName('')
      if (inputRef.current) inputRef.current.value = ''
    }
  }, [headers, loadFiles, uploading])

  const downloadFile = useCallback(async (item: TempFileItem) => {
    try {
      const response = await axios.get(`/api/admin/files/${item.id}`, {
        headers,
        responseType: 'blob',
      })
      saveBlob(response.data, item.name)
    } catch (downloadError) {
      setError(errorMessage(downloadError))
      loadFiles(true)
    }
  }, [headers, loadFiles])

  const deleteFile = useCallback(async (item: TempFileItem) => {
    try {
      await axios.delete(`/api/admin/files/${item.id}`, { headers })
      setData(current => current
        ? { ...current, files: current.files.filter(file => file.id !== item.id) }
        : current)
    } catch (deleteError) {
      setError(errorMessage(deleteError))
      loadFiles(true)
    }
  }, [headers, loadFiles])

  const files = (data?.files ?? []).filter(file => file.expiresAt * 1000 > now)
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  const maxFileBytes = data?.limits.maxFileBytes ?? 50 * 1024 * 1024
  const downloadAll = useCallback(async () => {
    if (downloadingAll || files.length === 0) return
    setDownloadingAll(true)
    setError('')
    try {
      const response = await axios.get('/api/admin/files/download-all', {
        headers,
        responseType: 'blob',
      })
      saveBlob(response.data, `alphatape-files-${new Date().toISOString().slice(0, 10)}.zip`)
    } catch (downloadError) {
      setError(errorMessage(downloadError))
      loadFiles(true)
    } finally {
      setDownloadingAll(false)
    }
  }, [downloadingAll, files.length, headers, loadFiles])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
        gap: 16, flexWrap: 'wrap',
      }}>
        <div>
          <h2 style={{
            margin: 0, color: 'var(--theme-text)', fontFamily: 'var(--theme-sans)',
            fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em',
          }}>
            Temporary file drop
          </h2>
          <p style={{
            margin: '5px 0 0', maxWidth: 620, color: 'var(--theme-text-dim)',
            fontFamily: 'var(--theme-sans)', fontSize: 11, lineHeight: 1.55,
          }}>
            Files stay private behind the admin secret and expire one hour after upload.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={downloadAll}
            disabled={files.length === 0 || downloadingAll}
            aria-busy={downloadingAll}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px',
              background: RED_TINT, border: `1px solid ${RED_BORDER}`, color: RED,
              fontFamily: 'var(--theme-mono)', fontSize: 9, fontWeight: 700,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              cursor: files.length === 0 || downloadingAll ? 'default' : 'pointer',
              opacity: files.length === 0 || downloadingAll ? 0.45 : 1,
            }}
          >
            <Download size={12} aria-hidden="true" />
            {downloadingAll ? 'Preparing ZIP' : 'Download all'}
          </button>
          <button
            type="button"
            onClick={() => loadFiles()}
            disabled={loading}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px',
              background: 'transparent', border: `1px solid ${RED_BORDER}`, color: RED,
              fontFamily: 'var(--theme-mono)', fontSize: 9, fontWeight: 700,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.55 : 1,
            }}
          >
            <RefreshCw size={12} aria-hidden="true" />
            Refresh
          </button>
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        onChange={event => uploadFiles(Array.from(event.target.files ?? []))}
        style={{ display: 'none' }}
      />
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload temporary files"
        aria-busy={uploading}
        onClick={() => !uploading && inputRef.current?.click()}
        onKeyDown={event => {
          if (!uploading && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            inputRef.current?.click()
          }
        }}
        onDragEnter={event => {
          event.preventDefault()
          if (!uploading) setDragging(true)
        }}
        onDragOver={event => event.preventDefault()}
        onDragLeave={event => {
          if (event.currentTarget === event.target) setDragging(false)
        }}
        onDrop={event => {
          event.preventDefault()
          setDragging(false)
          uploadFiles(Array.from(event.dataTransfer.files))
        }}
        style={{
          minHeight: 154, display: 'grid', placeItems: 'center', textAlign: 'center',
          padding: 22, boxSizing: 'border-box', cursor: uploading ? 'default' : 'pointer',
          background: dragging ? RED_TINT : 'var(--theme-bg)',
          border: `1px dashed ${dragging ? RED : RED_BORDER}`,
        }}
      >
        <div style={{ width: '100%', maxWidth: 520 }}>
          <FileUp size={24} color={RED} strokeWidth={1.5} aria-hidden="true" />
          <div style={{
            marginTop: 9, color: 'var(--theme-text)', fontFamily: 'var(--theme-sans)',
            fontSize: 12, fontWeight: 700,
          }}>
            {uploading ? `Uploading ${uploadName}` : 'Drop files here or choose from your device'}
          </div>
          <div style={{
            marginTop: 5, color: 'var(--theme-text-dim)', fontFamily: 'var(--theme-mono)',
            fontSize: 9,
          }}>
            Any file type | {formatBytes(maxFileBytes)} per file | automatic deletion after 60 minutes
          </div>
          {uploading && (
            <div style={{
              height: 4, marginTop: 14, background: 'rgba(255,255,255,0.06)',
              overflow: 'hidden',
            }}>
              <div style={{
                width: `${Math.max(2, uploadProgress)}%`, height: '100%',
                background: RED, transition: 'width 120ms ease-out',
              }} />
            </div>
          )}
        </div>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'repeat(3, minmax(0, 1fr))',
        border: `1px solid ${RED_BORDER}`, background: RED_TINT,
      }}>
        {[
          ['Stored', `${files.length} / ${data?.limits.maxFiles ?? 24} files`],
          ['Space used', `${formatBytes(totalBytes)} / ${formatBytes(data?.limits.maxTotalBytes ?? 200 * 1024 * 1024)}`],
          ['Retention', '60 minutes per file'],
        ].map(([label, value], index) => (
          <div key={label} style={{
            minWidth: 0, padding: '9px 11px',
            borderLeft: !isMobile && index ? `1px solid ${RED_BORDER}` : 'none',
            borderTop: isMobile && index ? `1px solid ${RED_BORDER}` : 'none',
          }}>
            <div style={{
              color: 'color-mix(in srgb, var(--theme-negative) 62%, transparent)',
              fontFamily: 'var(--theme-mono)', fontSize: 8, fontWeight: 700,
              letterSpacing: '0.1em', textTransform: 'uppercase',
            }}>
              {label}
            </div>
            <div style={{
              marginTop: 3, color: 'var(--theme-text)', fontFamily: 'var(--theme-mono)',
              fontSize: 10, fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {value}
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div role="alert" style={{
          padding: '9px 11px', border: `1px solid ${RED_BORDER}`, background: RED_TINT,
          color: RED, fontFamily: 'var(--theme-sans)', fontSize: 10.5, lineHeight: 1.45,
        }}>
          {error}. Check the file size or refresh the list and try again.
        </div>
      )}

      <div style={{ border: '1px solid var(--theme-border)', background: 'var(--theme-surface)' }}>
        <div style={{
          minHeight: 32, padding: '0 11px', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', gap: 12, borderBottom: '1px solid var(--theme-border)',
        }}>
          <span style={{
            color: 'var(--theme-text)', fontFamily: 'var(--theme-mono)', fontSize: 8.5,
            fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
          }}>
            Active files
          </span>
          <span style={{ color: 'var(--theme-text-dim)', fontFamily: 'var(--theme-mono)', fontSize: 8.5 }}>
            Countdown updates live
          </span>
        </div>

        {loading && !data ? (
          <div style={{ padding: 22, color: 'var(--theme-text-dim)', fontFamily: 'var(--theme-mono)', fontSize: 10 }}>
            Loading temporary storage...
          </div>
        ) : files.length === 0 ? (
          <div style={{ padding: '26px 18px', textAlign: 'center' }}>
            <FileIcon size={18} color="var(--theme-text-dim)" strokeWidth={1.4} aria-hidden="true" />
            <div style={{ marginTop: 7, color: 'var(--theme-text)', fontFamily: 'var(--theme-sans)', fontSize: 11 }}>
              No temporary files
            </div>
            <div style={{ marginTop: 3, color: 'var(--theme-text-dim)', fontFamily: 'var(--theme-mono)', fontSize: 8.5 }}>
              New uploads appear here with their remaining time.
            </div>
          </div>
        ) : (
          files.map((file, index) => {
            const remaining = Math.max(0, Math.ceil(file.expiresAt - now / 1000))
            const remainingPct = Math.min(100, (remaining / 3600) * 100)
            return (
              <div key={file.id} style={{
                display: 'grid',
                gridTemplateColumns: isMobile
                  ? '42px minmax(0, 1fr) auto'
                  : '42px minmax(0, 1fr) minmax(125px, 0.45fr) auto',
                alignItems: 'center', gap: 10, minHeight: 58, padding: '7px 10px',
                borderTop: index ? '1px solid var(--theme-border)' : 'none',
              }}>
                <div style={{
                  width: 38, height: 36, display: 'grid', placeItems: 'center',
                  border: `1px solid ${RED_BORDER}`, background: RED_TINT,
                  color: RED, fontFamily: 'var(--theme-mono)', fontSize: 8, fontWeight: 700,
                }}>
                  {fileExtension(file.name)}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div title={file.name} style={{
                    color: 'var(--theme-text)', fontFamily: 'var(--theme-sans)',
                    fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
                    overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {file.name}
                  </div>
                  <div style={{
                    display: 'flex', gap: 8, marginTop: 4, color: 'var(--theme-text-dim)',
                    fontFamily: 'var(--theme-mono)', fontSize: 8.5,
                  }}>
                    <span>{formatBytes(file.size)}</span>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {file.contentType || 'unknown type'}
                    </span>
                  </div>
                </div>
                <div style={{
                  minWidth: 0,
                  gridColumn: isMobile ? '2 / -1' : undefined,
                  gridRow: isMobile ? 2 : undefined,
                }}>
                  <div style={{
                    display: 'flex', justifyContent: 'space-between', gap: 8,
                    color: remaining < 600 ? RED : 'var(--theme-text-dim)',
                    fontFamily: 'var(--theme-mono)', fontSize: 8.5,
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <Clock3 size={10} aria-hidden="true" />
                      Expires
                    </span>
                    <span>{formatRemaining(remaining)}</span>
                  </div>
                  <div style={{ height: 2, marginTop: 6, background: 'rgba(255,255,255,0.06)' }}>
                    <div style={{
                      width: `${remainingPct}%`, height: '100%',
                      background: remaining < 600 ? RED : 'var(--theme-secondary)',
                    }} />
                  </div>
                </div>
                <div style={{
                  display: 'flex', gap: 5,
                  gridColumn: isMobile ? 3 : undefined,
                  gridRow: isMobile ? 1 : undefined,
                }}>
                  <button
                    type="button"
                    onClick={() => downloadFile(file)}
                    title={`Download ${file.name}`}
                    aria-label={`Download ${file.name}`}
                    style={{
                      width: 30, height: 30, display: 'grid', placeItems: 'center',
                      background: 'transparent', border: '1px solid var(--theme-border)',
                      color: 'var(--theme-text)', cursor: 'pointer',
                    }}
                  >
                    <Download size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteFile(file)}
                    title={`Delete ${file.name}`}
                    aria-label={`Delete ${file.name}`}
                    style={{
                      width: 30, height: 30, display: 'grid', placeItems: 'center',
                      background: 'transparent', border: `1px solid ${RED_BORDER}`,
                      color: RED, cursor: 'pointer',
                    }}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
