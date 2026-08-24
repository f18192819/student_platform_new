import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'

import {
  getActiveAdaptiveTest,
  startAdaptiveTest,
  submitAdaptiveAnswer,
  type AdaptiveTestQuestionImage,
  type AdaptiveTestPayload,
} from '../../lib/adaptiveTesting'
import { resolveBackendApiUrl } from '../../lib/apiConfig'
import { prepareMineruMarkdownMath } from '../../lib/latexMarkdown'

function percentage(value: number) {
  return `${Math.round(value * 100)}%`
}

function SourceText({ children }: { children: string }) {
  return (
    <div className="mastery-test__source-text">
      <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
        {prepareMineruMarkdownMath(children)}
      </ReactMarkdown>
    </div>
  )
}

function QuestionImages({ images }: { images: AdaptiveTestQuestionImage[] | undefined }) {
  if (!images?.length) {
    return null
  }
  return (
    <div className="mastery-question-images" aria-label="题目附图">
      {images.map((image) => (
        <figure key={image.id}>
          <a href={resolveBackendApiUrl(image.url)} target="_blank" rel="noreferrer">
            <img src={resolveBackendApiUrl(image.url)} alt={image.alt} />
          </a>
          <figcaption>原题 P.{image.page_number} 附图 · 点击查看原图</figcaption>
        </figure>
      ))}
    </div>
  )
}

export function LectureMasteryTest({
  courseId,
  lectureDocumentId,
  lectureName,
  onOpenPage,
}: {
  courseId: string
  lectureDocumentId: string
  lectureName: string
  onOpenPage: (pageNumber: number) => void
}) {
  const [payload, setPayload] = useState<AdaptiveTestPayload | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState('')
  const [showAnswerReview, setShowAnswerReview] = useState(false)
  const questionStartedAt = useRef(Date.now())

  useEffect(() => {
    const controller = new AbortController()
    setPayload(null)
    setError('')
    void getActiveAdaptiveTest(courseId, lectureDocumentId, controller.signal)
      .then((active) => setPayload(active))
      .catch((reason) => {
        if (!controller.signal.aborted) {
          console.warn('adaptive test restore failed:', reason)
        }
      })
    return () => controller.abort()
  }, [courseId, lectureDocumentId])

  useEffect(() => {
    questionStartedAt.current = Date.now()
    setAnswer('')
  }, [payload?.current_question?.question_id])

  const openTest = async () => {
    setError('')
    setIsOpen(true)
    if (payload?.session.status === 'active') {
      return
    }
    setIsLoading(true)
    try {
      const next = await startAdaptiveTest(courseId, lectureDocumentId)
      setPayload(next)
      setShowAnswerReview(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '暂时无法开始测试。')
    } finally {
      setIsLoading(false)
    }
  }

  const submitAnswer = async () => {
    if (!payload?.current_question || !answer.trim() || isLoading) {
      return
    }
    setError('')
    setIsLoading(true)
    try {
      const next = await submitAdaptiveAnswer(
        payload.session.id,
        answer.trim(),
        Math.max(0, Date.now() - questionStartedAt.current),
      )
      setPayload(next)
      setShowAnswerReview(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '答案评分失败，请稍后重试。')
    } finally {
      setIsLoading(false)
    }
  }

  const close = () => {
    setIsOpen(false)
    setError('')
    setShowAnswerReview(false)
  }

  const currentQuestion = payload?.current_question
  const result = payload?.result
  const isContinuable = payload?.session.status === 'active'

  return (
    <>
      <button
        type="button"
        className="mastery-test-launcher"
        onClick={() => void openTest()}
      >
        <span>{isContinuable ? '继续测试' : '开始测试'}</span>
        {isContinuable ? (
          <small>{payload.progress.answered}/{payload.progress.target}</small>
        ) : null}
      </button>

      {isOpen && typeof document !== 'undefined' ? createPortal(
        <div className="mastery-test-modal" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            close()
          }
        }}>
          <section className="mastery-test-dialog" role="dialog" aria-modal="true" aria-label="课件掌握度测试">
            <header className="mastery-test-dialog__header">
              <div>
                <span>Lecture Check</span>
                <h2>课件掌握度测试</h2>
                <p title={lectureName}>{lectureName}</p>
              </div>
              <button type="button" aria-label="关闭测试" onClick={close}>×</button>
            </header>

            {isLoading && !payload ? (
              <div className="mastery-test__state">正在整理这份课件的可用原题…</div>
            ) : error && !payload ? (
              <div className="mastery-test__state mastery-test__state--error">
                <strong>暂时无法开始</strong>
                <p>{error}</p>
                <button type="button" className="primary-button" onClick={() => void openTest()}>
                  重试
                </button>
              </div>
            ) : result && !showAnswerReview ? (
              <div className="mastery-result">
                <section className="mastery-result__hero">
                  <div className="mastery-result__score" style={{ '--score': result.overall_mastery } as CSSProperties}>
                    <strong>{percentage(result.overall_mastery)}</strong>
                    <span>总体掌握度</span>
                  </div>
                  <div className="mastery-result__summary">
                    <span>本次完成</span>
                    <strong>{result.questions_answered} 题，答对 {result.questions_correct} 题</strong>
                    <p>结论置信度 {percentage(result.confidence)}，掌握度综合了题目难度与知识点覆盖。</p>
                  </div>
                </section>

                <section className="mastery-result__section">
                  <div className="mastery-result__section-title">
                    <span>Concepts</span>
                    <h3>知识点掌握度</h3>
                  </div>
                  <div className="mastery-concept-list">
                    {result.concept_mastery.map((concept) => (
                      <div className="mastery-concept" key={concept.knowledge_point}>
                        <div>
                          <strong>{concept.knowledge_point}</strong>
                          <span>{concept.evidence_count} 条证据 · 置信度 {percentage(concept.confidence)}</span>
                        </div>
                        <div className="mastery-concept__meter"><i style={{ width: percentage(concept.mastery) }} /></div>
                        <b>{percentage(concept.mastery)}</b>
                      </div>
                    ))}
                  </div>
                </section>

                <div className="mastery-result__columns">
                  <section className="mastery-result__section">
                    <div className="mastery-result__section-title">
                      <span>Weak spots</span>
                      <h3>薄弱知识点</h3>
                    </div>
                    {result.weak_concepts.length ? (
                      <div className="mastery-result__chips">
                        {result.weak_concepts.map((concept) => (
                          <span key={concept.knowledge_point}>
                            {concept.knowledge_point} · {percentage(concept.mastery)}
                          </span>
                        ))}
                      </div>
                    ) : <p className="mastery-result__empty">当前没有明显薄弱知识点。</p>}
                  </section>

                  <section className="mastery-result__section">
                    <div className="mastery-result__section-title">
                      <span>Review pages</span>
                      <h3>推荐复习页</h3>
                    </div>
                    {result.recommended_pages.length ? (
                      <div className="mastery-page-list">
                        {result.recommended_pages.map((page) => (
                          <button
                            type="button"
                            key={`${page.document_id}:${page.page_number}`}
                            onClick={() => {
                              onOpenPage(page.page_number)
                              close()
                            }}
                          >
                            <strong>P.{page.page_number}</strong>
                            <span>{page.knowledge_points.join('、')}</span>
                          </button>
                        ))}
                      </div>
                    ) : <p className="mastery-result__empty">没有可验证的关联页，不会虚构推荐页码。</p>}
                  </section>
                </div>

                <section className="mastery-result__section">
                  <div className="mastery-result__section-title">
                    <span>Review</span>
                    <h3>错题回顾</h3>
                  </div>
                  {result.wrong_questions.length ? result.wrong_questions.map((question) => (
                    <details className="mastery-wrong-question" key={question.question_id}>
                      <summary>
                        <strong>{question.title || question.question_id}</strong>
                        <span>得分 {percentage(question.score)}</span>
                      </summary>
                      <p>{question.feedback}</p>
                      <QuestionImages images={question.images} />
                      <div><b>你的答案</b><SourceText>{question.answer}</SourceText></div>
                      <div><b>参考解答</b><SourceText>{question.reference_answer}</SourceText></div>
                    </details>
                  )) : <p className="mastery-result__empty">本次没有错题。</p>}
                </section>
              </div>
            ) : showAnswerReview && payload?.grading && payload.answered_question ? (
              <div className="mastery-answer-review">
                <div className={payload.grading.correct ? 'is-correct' : 'is-wrong'}>
                  <span>{payload.grading.correct ? '回答正确' : '还需巩固'}</span>
                  <strong>{percentage(payload.grading.score)}</strong>
                </div>
                <p>{payload.grading.feedback}</p>
                <details>
                  <summary>查看参考解答</summary>
                  <SourceText>{payload.answered_question.reference_answer || ''}</SourceText>
                </details>
                <button
                  type="button"
                  className="primary-button primary-button--full"
                  onClick={() => setShowAnswerReview(false)}
                >
                  {payload.session.status === 'completed' ? '查看掌握度结果' : '下一题'}
                </button>
              </div>
            ) : currentQuestion && payload ? (
              <div className="mastery-question">
                <div className="mastery-question__progress">
                  <span>第 {payload.progress.answered + 1} / {payload.progress.target} 题</span>
                  <i><b style={{ width: percentage(payload.progress.answered / payload.progress.target) }} /></i>
                  <span>已答对 {payload.progress.correct} 题</span>
                </div>
                <div className="mastery-question__meta">
                  <span>{currentQuestion.source_type === 'lecture_example' ? '课堂例题' : '关联作业原题'}</span>
                  <span>难度 {currentQuestion.difficulty}/5</span>
                  {currentQuestion.source_page_number ? <span>原文 P.{currentQuestion.source_page_number}</span> : null}
                </div>
                <h3>{currentQuestion.title}</h3>
                <SourceText>{currentQuestion.prompt}</SourceText>
                <QuestionImages images={currentQuestion.images} />
                <div className="mastery-question__concepts">
                  {currentQuestion.knowledge_points.map((concept) => <span key={concept}>{concept}</span>)}
                </div>
                <label className="mastery-question__answer">
                  <span>你的答案</span>
                  <textarea
                    value={answer}
                    onChange={(event) => setAnswer(event.target.value)}
                    placeholder="写下结论、关键公式或推导思路。系统会接受与参考解答等价的表达。"
                    rows={7}
                    disabled={isLoading}
                  />
                </label>
                {error ? <p className="mastery-test__inline-error">{error}</p> : null}
                <button
                  type="button"
                  className="primary-button primary-button--full"
                  disabled={!answer.trim() || isLoading}
                  onClick={() => void submitAnswer()}
                >
                  {isLoading ? '正在评分…' : '提交答案'}
                </button>
              </div>
            ) : (
              <div className="mastery-test__state">正在恢复测试状态…</div>
            )}
          </section>
        </div>,
        document.body,
      ) : null}
    </>
  )
}
