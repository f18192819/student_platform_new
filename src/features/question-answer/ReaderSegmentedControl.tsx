import { useId } from 'react'
import { motion } from 'motion/react'

export function ReaderSegmentedControl({
  value,
  answerCount,
  onChange,
}: {
  value: 'question' | 'answer'
  answerCount: number
  onChange: (value: 'question' | 'answer') => void
}) {
  const indicatorId = useId()
  const options = [
    { id: 'question' as const, label: '原题' },
    { id: 'answer' as const, label: `我的答案${answerCount ? ` · ${answerCount}` : ''}` },
  ]
  return (
    <div className="reader-segmented-control" role="tablist" aria-label="题目查看方式">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {value === option.id ? <motion.span className="reader-segmented-control__indicator" layoutId={`reader-tab-${indicatorId}`} transition={{ type: 'spring', stiffness: 440, damping: 38 }} /> : null}
          <span className="reader-segmented-control__label">{option.label}</span>
        </button>
      ))}
    </div>
  )
}

