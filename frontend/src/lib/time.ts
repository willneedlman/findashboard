export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local time'

export const localDateInputValue = (date = new Date()) => {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 10)
}

export const formatLocalTime = (value: string | number | Date, options: Intl.DateTimeFormatOptions = {}) => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false, ...options })
}

export const formatLocalDateTime = (value: string | number | Date) => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}
