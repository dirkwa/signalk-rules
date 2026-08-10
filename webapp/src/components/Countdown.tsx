import { useEffect, useState } from 'react'

interface CountdownProps {
  /** Absolute epoch millis (server-provided); interpolated locally. */
  until: number
  label: string
}

/** "hold 42s" style pill that ticks down between /state polls. */
export function Countdown({ until, label }: CountdownProps) {
  const [, force] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => force((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [])
  const remaining = Math.max(0, until - Date.now())
  const s = Math.ceil(remaining / 1000)
  const text = s >= 120 ? `${Math.ceil(s / 60)}m` : `${s}s`
  return (
    <span className="countdown">
      {label} {text}
    </span>
  )
}
