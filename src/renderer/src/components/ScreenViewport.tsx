import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

const BASE_WIDTH = 1024
const BASE_HEIGHT = 600

interface Props {
  children: ReactNode
  variant?: 'dashboard' | 'settings'
}

export function ScreenViewport({ children, variant = 'dashboard' }: Props) {
  const viewport = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const element = viewport.current!
    const resize = () => {
      const bounds = element.getBoundingClientRect()
      setScale(Math.min(bounds.width / BASE_WIDTH, bounds.height / BASE_HEIGHT))
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const style = { width: BASE_WIDTH * scale, height: BASE_HEIGHT * scale, '--screen-scale': scale } as CSSProperties
  return <div className="viewport" ref={viewport}><div className="screen-space" style={style}><div className={`app${variant === 'settings' ? ' app--settings' : ''}`}>{children}</div></div></div>
}
