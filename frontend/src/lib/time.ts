export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local time'

export const localDateInputValue = (date = new Date()) => {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 10)
}

// The local calendar date, not the UTC one.
//
// toISOString() converts to UTC first, so anywhere west of Greenwich the date
// rolls early in the evening. Home's header read FRI, AUG 14 while the same
// page requested an earnings calendar starting 2026-08-15, and the Economic
// Calendar opened on a window beginning tomorrow, hiding anything released
// today. Every default date comes through here.
export const todayLocal = () => localDateInputValue()

// The local calendar date N days from now. Negative goes back.
export const localDateOffset = (days: number) =>
  localDateInputValue(new Date(Date.now() + days * 86_400_000))

export const formatLocalTime = (value: string | number | Date, options: Intl.DateTimeFormatOptions = {}) => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short', ...options })
}

export const formatLocalDateTime = (value: string | number | Date) => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' })
}

export const formatLocalDate = (value: string | number | Date) => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
