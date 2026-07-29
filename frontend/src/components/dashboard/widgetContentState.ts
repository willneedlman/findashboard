import { useEffect } from 'react'

export type WidgetContentState = 'loading' | 'ready' | 'empty' | 'error'

export const WIDGET_CONTENT_STATE_EVENT = 'dashboard-widget-content-state'

export function useWidgetContentState(widgetId: string, state: WidgetContentState) {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(WIDGET_CONTENT_STATE_EVENT, {
        detail: { widgetId, state },
      }))
    }, 0)
    return () => window.clearTimeout(timer)
  }, [state, widgetId])
}
