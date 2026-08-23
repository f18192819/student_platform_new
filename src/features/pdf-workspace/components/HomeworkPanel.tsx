import type { HomeworkDocument, HomeworkQuestion } from '../../../types'
import type { HomeworkQuestionLinkChip, PageQuestionEntry } from '../types'

export function HomeworkPanel({
  homeworkDocuments,
  selectedHomework,
  selectedHomeworkQuestion,
  selectedQuestionLinks,
  pageQuestionFilter,
  pageQuestionEntries,
  isExtractingHomework,
  isShowingHomeworkPreview,
  showReturnToLecture,
  onUploadHomework,
  onReturnToLecture,
  onSelectHomeworkDocument,
  onSelectHomeworkQuestion,
  onDeleteHomeworkDocument,
}: {
  homeworkDocuments: HomeworkDocument[]
  selectedHomework: HomeworkDocument | null
  selectedHomeworkQuestion: HomeworkQuestion | null
  selectedQuestionLinks: HomeworkQuestionLinkChip[]
  pageQuestionFilter: number | null
  pageQuestionEntries: PageQuestionEntry[]
  isExtractingHomework: boolean
  isShowingHomeworkPreview: boolean
  showReturnToLecture: boolean
  onUploadHomework: () => void
  onReturnToLecture: () => void
  onSelectHomeworkDocument: (documentId: string) => void
  onSelectHomeworkQuestion: (
    documentId: string,
    questionId: string | null,
    pageNumber?: number | null,
  ) => void
  onDeleteHomeworkDocument: (documentId: string) => void
}) {
  const isPageQuestionMode = pageQuestionFilter !== null

  return (
    <section className="pdf-text-dock homework-panel">
      <div className="pdf-text-dock__head">
        <div>
          <span>Homework</span>
          <strong>
            {isPageQuestionMode
              ? `第 ${pageQuestionFilter} 页关联题目`
              : selectedHomework
                ? selectedHomework.fileName
                : '练习提取'}
          </strong>
        </div>
        {isPageQuestionMode ? (
          showReturnToLecture ? (
            <button type="button" className="ghost-button doubt-back-button" onClick={onReturnToLecture}>
              返回讲义
            </button>
          ) : null
        ) : (
          <button
            type="button"
            className="ghost-button doubt-back-button"
            onClick={onUploadHomework}
            disabled={isExtractingHomework}
          >
            {isExtractingHomework ? '提取中...' : '上传练习'}
          </button>
        )}
      </div>
      <div className="pdf-text-dock__body homework-panel__body">
        {isPageQuestionMode ? (
          pageQuestionEntries.length ? (
            <div className="homework-question-browser">
              <div className="homework-question-browser__head">
                <div className="homework-question-browser__title">
                  <strong>题目列表</strong>
                  <span>{pageQuestionEntries.length} 题</span>
                </div>
              </div>
              <div className="homework-question-list">
                {pageQuestionEntries.map((entry, index) => (
                  <button
                    key={entry.linkId}
                    type="button"
                    className={`homework-question-card${selectedHomeworkQuestion?.id === entry.questionId ? ' is-active' : ''}`}
                    onClick={() =>
                      onSelectHomeworkQuestion(
                        entry.homeworkDocumentId,
                        entry.questionId,
                        entry.questionPageNumber,
                      )
                    }
                  >
                    <strong>{entry.questionTitle || `第 ${index + 1} 题`}</strong>
                    <span>
                      {entry.questionPageNumber ? `练习第 ${entry.questionPageNumber} 页` : '练习页码待定位'}
                    </span>
                    <p>{entry.homeworkFileName}</p>
                    <p>{entry.conceptTitle}</p>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="empty-state">这一页暂时还没有关联到任何已上传练习题目。</div>
          )
        ) : homeworkDocuments.length ? (
          <>
            <div className="homework-document-list">
              {homeworkDocuments.map((document) => (
                <div
                  key={document.id}
                  className={`homework-document-card${selectedHomework?.id === document.id ? ' is-active' : ''}`}
                >
                  <button
                    type="button"
                    className="homework-document-card__delete"
                    aria-label={`删除练习 ${document.fileName}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      onDeleteHomeworkDocument(document.id)
                    }}
                  >
                    ×
                  </button>
                  <button
                    type="button"
                    className="homework-document-card__button"
                    onClick={() => onSelectHomeworkDocument(document.id)}
                  >
                    <strong>{document.fileName}</strong>
                    <span>
                      {document.status === 'ready'
                        ? `${document.questions.length} 题`
                        : document.status === 'processing'
                          ? '提取中'
                          : '提取失败'}
                    </span>
                  </button>
                </div>
              ))}
            </div>

            {selectedHomework ? (
              <div className="homework-question-browser">
                <div className="homework-question-browser__head">
                  <div className="homework-question-browser__title">
                    <strong>题目列表</strong>
                    <span>{selectedHomework.questions.length} 题</span>
                  </div>
                  <button
                    type="button"
                    className="ghost-button doubt-back-button"
                    onClick={onReturnToLecture}
                    disabled={!isShowingHomeworkPreview}
                    hidden={!showReturnToLecture}
                  >
                    返回讲义
                  </button>
                </div>
                {selectedHomework.status === 'error' ? (
                  <div className="empty-state">{selectedHomework.errorMessage ?? '练习提取失败'}</div>
                ) : selectedHomework.questions.length ? (
                  <div className="homework-question-list">
                    {selectedHomework.questions.map((question, index) => (
                      <button
                        key={question.id}
                        type="button"
                        className={`homework-question-card${selectedHomeworkQuestion?.id === question.id ? ' is-active' : ''}`}
                        onClick={() =>
                          onSelectHomeworkQuestion(
                            selectedHomework.id,
                            question.id,
                            question.pageNumber,
                          )
                        }
                      >
                        <strong>{question.title || `第 ${index + 1} 题`}</strong>
                        <span>{question.pageNumber ? `练习第 ${question.pageNumber} 页` : '练习页码待定位'}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">题目正在整理中，稍后会显示在这里。</div>
                )}
                {selectedHomeworkQuestion ? (
                  <article className="homework-question-detail">
                    <strong>{selectedHomeworkQuestion.title}</strong>
                    <p>{selectedHomeworkQuestion.content}</p>
                    {selectedQuestionLinks.length ? (
                      <div className="homework-link-list">
                        {selectedQuestionLinks.map((link) => (
                          <span key={link.id} className="homework-link-chip">
                            {link.conceptTitle}
                            {link.lecturePageNumber ? ` · 讲义第 ${link.lecturePageNumber} 页` : ''}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="homework-link-empty">该题暂时还没有匹配到讲义知识点</span>
                    )}
                  </article>
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          <div className="empty-state">
            在当前讲义下上传 PDF 或图片练习，系统会调用 MinerU 提取内容，并把题目逐个整理出来。
          </div>
        )}
      </div>
    </section>
  )
}
