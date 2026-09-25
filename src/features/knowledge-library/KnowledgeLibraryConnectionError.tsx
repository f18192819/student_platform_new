import React from 'react'

type Props = {
  onRetry: () => void
}

export function KnowledgeLibraryConnectionError({ onRetry }: Props) {
  return (
    <div className="octopus-empty-card" role="alert">
      <strong>本地后端暂时不可用</strong>
      <p>无法读取知识库，请检查本地服务后重新连接。</p>
      <button className="octopus-primary-button" type="button" onClick={onRetry}>
        重新连接
      </button>
    </div>
  )
}
