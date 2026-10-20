/**
 * Completion notifications: a quiet OS-level nudge when a long model run
 * finishes while the window is not focused. When the user is already
 * staring at the app, the sidebar attention marks carry the same signal.
 */
export function shouldNotifyCompletion(): boolean {
  if (typeof document === 'undefined') return false
  return document.hidden || !document.hasFocus()
}

export function showCompletionNotification(title: string, body: string): void {
  if (typeof Notification === 'undefined') return
  try {
    new Notification(title, { body, silent: false })
  } catch {
    // Notification construction can throw in unsupported contexts.
  }
}
