import { AnimatePresence, motion } from 'motion/react'
import type { ReactNode } from 'react'

export function WorkspacePanel({
  panelKey,
  placement,
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
  panelKey: string | null
  placement: 'left' | 'right' | 'bottom'
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
  const offset = placement === 'left' ? -12 : placement === 'right' ? 12 : 0
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {panelKey ? (
        <motion.aside
          key={panelKey}
          className={`reader-workspace-panel reader-floating-panel reader-workspace-panel--${placement}`}
          role={role}
          aria-label={title}
          initial={{ opacity: 0, x: offset, y: placement === 'bottom' ? 8 : 0 }}
          animate={{ opacity: 1, x: 0, y: 0 }}
          exit={{ opacity: 0, x: offset * 0.5, y: placement === 'bottom' ? 5 : 0 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
          onPointerDownCapture={autoPinOnInteract ? onPin : undefined}
          onFocusCapture={autoPinOnInteract ? onPin : undefined}
        >
          <header className="reader-workspace-panel__header">
            <div><strong>{title}</strong><span>{pinned ? '已固定' : '预览'}</span></div>
            <button type="button" aria-label={`关闭${title}`} onClick={onClose}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
            </button>
          </header>
          <div className="reader-workspace-panel__content">{children}</div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  )
}
