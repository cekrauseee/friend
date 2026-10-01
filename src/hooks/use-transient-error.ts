import { useEffect, useState } from 'react'

export function useTransientError(message: string | null, resetKey: string, durationMs = 6000) {
  const [notice, setNotice] = useState({ message, resetKey, visible: Boolean(message) })
  let visible = notice.visible
  if (message !== notice.message || resetKey !== notice.resetKey) {
    visible = Boolean(message)
    setNotice({ message, resetKey, visible })
  }

  useEffect(() => {
    if (!message || !visible) return
    const timer = setTimeout(() => {
      setNotice((current) => current.message === message && current.resetKey === resetKey
        ? { ...current, visible: false } : current)
    }, durationMs)
    return () => clearTimeout(timer)
  }, [message, resetKey, visible, durationMs])

  return visible ? message : null
}
