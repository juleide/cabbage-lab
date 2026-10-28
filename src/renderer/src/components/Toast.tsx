import { useEffect, useState } from 'react'

export function Toast({ notice }: { notice: { sequence: number; message: string } }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!notice.sequence) return
    setVisible(true)
    const timer = window.setTimeout(() => setVisible(false), 3000)
    return () => window.clearTimeout(timer)
  }, [notice.sequence])
  return <div className={`toast${visible ? ' show' : ''}`} role="status" aria-live="polite">{visible ? notice.message : ''}</div>
}
