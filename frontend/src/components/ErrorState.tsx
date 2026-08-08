import EmptyState from './EmptyState'

// Failure placeholder. One treatment with the empty and loading states rather
// than a second bespoke panel, so a tool's three states share a layout.
//
// `title` is required on purpose. Its old default was the generic apology
// DESIGN.md bans by name: it tells the reader nothing and cannot be acted on.
// Name the failure ("Quote feed unavailable") and put what to do next in
// `message`.
interface ErrorStateProps {
  title: string
  message: string
  onRetry?: () => void
}

export default function ErrorState({ title, message, onRetry }: ErrorStateProps) {
  return <EmptyState variant="unavailable" title={title} hint={message} onRetry={onRetry} />
}
