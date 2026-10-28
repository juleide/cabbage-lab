import { useId, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'

export function Modal({ title, onClose, children, className }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => { element.close() }
  }, [])
  return (
    <dialog className={className} ref={dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose() }} onClick={event => {
      if (event.target !== event.currentTarget) return
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose()
    }}>
      <div className="modal-head"><h3 id={titleId}>{title}</h3><button className="close" aria-label="关闭" onClick={onClose}>×</button></div>
      {children}
    </dialog>
  )
}
