import { AnimatePresence, motion } from 'motion/react'
import type { ReactNode } from 'react'

export function FloatingWorkspacePanel({
  open,
  side,
  title,
  pinned,
  role = 'complementary',
  autoPinOnInteract = false,
  onEnter,
  onLeave,
  onClose,
  onPin,
  children,
}: {
  open: boolean
  side: 'left' | 'right' | 'bottom'
  title: string
  pinned: boolean
  role?: 'dialog' | 'complementary' | 'region'
  autoPinOnInteract?: boolean
  onEnter: () => void
  onLeave: () => void
  onClose: () => void
  onPin: () => void
  children: ReactNode
}) {
  const axis = side === 'left' ? -24 : side === 'right' ? 24 : 0
  return (
    <AnimatePresence>
      {open ? (
        <motion.aside
          className={`reader-floating-panel reader-floating-panel--${side}`}
          role={role}
          aria-label={title}
          initial={{ opacity: 0, x: axis, y: side === 'bottom' ? 18 : 0, scale: 0.985 }}
          animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
          exit={{ opacity: 0, x: axis * 0.55, y: side === 'bottom' ? 10 : 0, scale: 0.99 }}
          transition={{ type: 'spring', stiffness: 420, damping: 38, mass: 0.8 }}
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
          onPointerDownCapture={autoPinOnInteract ? onPin : undefined}
          onFocusCapture={autoPinOnInteract ? onPin : undefined}
        >
          <header className="reader-floating-panel__header">
            <div><strong>{title}</strong>{pinned ? <span>已固定</span> : <span>预览</span>}</div>
            <button type="button" aria-label={`关闭${title}`} onClick={onClose}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
            </button>
          </header>
          <div className="reader-floating-panel__content">{children}</div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  )
}
