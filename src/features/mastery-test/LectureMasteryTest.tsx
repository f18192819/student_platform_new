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
  type AdaptiveTestAnswer,
  type AdaptiveTestQuestion,
  type AdaptiveTestQuestionImage,
  type AdaptiveTestPayload,
  type AssessmentPart,
  type AssessmentResponse,
} from '../../lib/adaptiveTesting'
import { resolveBackendApiUrl } from '../../lib/apiConfig'
import { prepareMineruMarkdownMath } from '../../lib/latexMarkdown'

function percentage(value: number) {
  return `${Math.round(value * 100)}%`
}

type DraftResponses = Record<string, Record<string, string>>

const LEGACY_ASSESSMENT_PART: AssessmentPart = {
  id: 'legacy-answer',
  type: 'text',
  prompt: '简要说明你的结论或思路。',
  weight: 1,
  required: true,
  options: [],
}

function assessmentParts(question: AdaptiveTestQuestion | null | undefined): AssessmentPart[] {
  return question?.assessment_spec?.parts?.length
    ? question.assessment_spec.parts
    : [LEGACY_ASSESSMENT_PART]
}

function savedResponseMap(
  answer: AdaptiveTestAnswer | undefined,
  parts: AssessmentPart[],
): Record<string, string> {
  if (!answer) return {}
  if (answer.responses?.length) {
    return Object.fromEntries(answer.responses.map((response) => [response.part_id, response.value]))
  }
  return parts.length === 1 && answer.response_text
    ? { [parts[0].id]: answer.response_text }
    : {}
}

function responseSignature(responses: Record<string, string>) {
  return JSON.stringify(
    Object.entries(responses)
      .map(([partId, value]) => [partId, value.trim()])
      .sort(([left], [right]) => left.localeCompare(right)),
  )
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
  const [selectedQuestionId, setSelectedQuestionId] = useState('')
  const [draftAnswers, setDraftAnswers] = useState<DraftResponses>({})
  const [error, setError] = useState('')
  const [showResults, setShowResults] = useState(false)
  const questionStartedAt = useRef(Date.now())

  useEffect(() => {
    const controller = new AbortController()
    setPayload(null)
    setError('')
    void getActiveAdaptiveTest(courseId, lectureDocumentId, controller.signal)
      .then((active) => {
        setPayload(active)
        if (active) {
          setSelectedQuestionId(
            active.current_question?.question_id || active.questions?.[0]?.question_id || '',
          )
          setShowResults(active.session.status === 'completed')
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          console.warn('adaptive test restore failed:', reason)
        }
      })
    return () => controller.abort()
  }, [courseId, lectureDocumentId])

  useEffect(() => {
    const sessionId = payload?.session.id
    if (!sessionId) return
    const storageKey = `adaptive-test-drafts:${sessionId}`
    let stored: DraftResponses = {}
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) || '{}') as Record<string, unknown>
      stored = Object.fromEntries(
        Object.entries(parsed).flatMap(([questionId, value]) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return []
          const responses = Object.fromEntries(
            Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
          )
          return [[questionId, responses]]
        }),
      )
    } catch {
      stored = {}
    }
    setDraftAnswers((current) => {
      const unlockedIds = new Set([
        ...(payload.questions ?? []).map((question) => question.question_id),
        ...(payload.current_question ? [payload.current_question.question_id] : []),
      ])
      const next: DraftResponses = {}
      for (const [questionId, value] of Object.entries({ ...stored, ...current })) {
        if (unlockedIds.has(questionId)) next[questionId] = value
      }
      for (const saved of payload.answers ?? []) {
        if (next[saved.question_id] === undefined) {
          const question = payload.questions.find((item) => item.question_id === saved.question_id)
          next[saved.question_id] = savedResponseMap(saved, assessmentParts(question))
        }
      }
      return next
    })
  }, [payload?.session.id, payload?.answers, payload?.questions, payload?.current_question])

  useEffect(() => {
    const sessionId = payload?.session.id
    if (!sessionId) return
    localStorage.setItem(`adaptive-test-drafts:${sessionId}`, JSON.stringify(draftAnswers))
  }, [draftAnswers, payload?.session.id])

  const selectQuestion = (questionId: string) => {
    setSelectedQuestionId(questionId)
    setShowResults(false)
    setError('')
    questionStartedAt.current = Date.now()
  }

  const openTest = async () => {
    setError('')
    setIsOpen(true)
    if (payload?.session.status === 'active') {
      selectQuestion(payload.current_question?.question_id || payload.questions?.[0]?.question_id || '')
      return
    }
    if (payload?.session.status === 'completed') {
      setShowResults(true)
      return
    }
    setIsLoading(true)
    try {
      const next = await startAdaptiveTest(courseId, lectureDocumentId)
      setPayload(next)
      setSelectedQuestionId(next.current_question?.question_id || next.questions?.[0]?.question_id || '')
      setShowResults(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '暂时无法开始测试。')
    } finally {
      setIsLoading(false)
    }
  }

  const submitAnswer = async () => {
    const selectedQuestion = payload?.questions?.find(
      (question) => question.question_id === selectedQuestionId,
    ) ?? payload?.current_question
    const selectedParts = assessmentParts(selectedQuestion)
    const hasStructuredAssessment = Boolean(selectedQuestion?.assessment_spec?.parts?.length)
    const partValues = selectedQuestion ? draftAnswers[selectedQuestion.question_id] ?? {} : {}
    const responses: AssessmentResponse[] = selectedQuestion
      ? selectedParts
          .map((part) => ({ part_id: part.id, value: partValues[part.id]?.trim() ?? '' }))
          .filter((response) => response.value)
      : []
    const requiredComplete = selectedParts
      .filter((part) => part.required)
      .every((part) => Boolean(partValues[part.id]?.trim())) ?? false
    if (!selectedQuestion || !requiredComplete || isLoading || !payload) {
      return
    }
    setError('')
    setIsLoading(true)
    try {
      const next = await submitAdaptiveAnswer(
        payload.session.id,
        selectedQuestion.question_id,
        responses,
        Math.max(0, Date.now() - questionStartedAt.current),
        hasStructuredAssessment ? undefined : partValues[LEGACY_ASSESSMENT_PART.id]?.trim(),
      )
      setPayload(next)
      setDraftAnswers((current) => ({
        ...current,
        [selectedQuestion.question_id]: next.saved_answer
          ? savedResponseMap(next.saved_answer, selectedParts)
          : partValues,
      }))
      setSelectedQuestionId(selectedQuestion.question_id)
      setShowResults(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '答案评分失败，请稍后重试。')
    } finally {
      setIsLoading(false)
    }
  }

  const close = () => {
    setIsOpen(false)
    setError('')
  }

  const questions = payload?.questions?.length
    ? payload.questions
    : payload?.current_question ? [payload.current_question] : []
  const currentQuestion = questions.find(
    (question) => question.question_id === selectedQuestionId,
  ) ?? payload?.current_question ?? questions[0]
  const savedAnswer = payload?.answers?.find(
    (item) => item.question_id === currentQuestion?.question_id,
  )
  const currentAssessmentParts = assessmentParts(currentQuestion)
  const savedResponses = savedResponseMap(savedAnswer, currentAssessmentParts)
  const answer = currentQuestion ? draftAnswers[currentQuestion.question_id] ?? savedResponses : {}
  const answerIsDirty = Boolean(
    savedAnswer && responseSignature(answer) !== responseSignature(savedResponses),
  )
  const requiredPartsComplete = currentAssessmentParts
    .filter((part) => part.required)
    .every((part) => Boolean(answer[part.id]?.trim()))
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

            {payload && questions.length ? (
              <nav className="mastery-question-nav" aria-label="切换测试题目">
                <div>
                  {questions.map((question, index) => {
                    const saved = payload.answers?.find((item) => item.question_id === question.question_id)
                    const isCurrent = payload.current_question?.question_id === question.question_id
                    const isSelected = currentQuestion?.question_id === question.question_id && !showResults
                    return (
                      <button
                        type="button"
                        key={question.question_id}
                        className={`${isSelected ? 'is-selected' : ''} ${saved ? 'is-answered' : ''}`}
                        onClick={() => selectQuestion(question.question_id)}
                        disabled={isLoading}
                        aria-current={isSelected ? 'step' : undefined}
                      >
                        <strong>{index + 1}</strong>
                        <span>{saved ? '已作答' : isCurrent ? '待作答' : '已解锁'}</span>
                      </button>
                    )
                  })}
                </div>
                {result ? (
                  <button
                    type="button"
                    className={showResults ? 'is-selected mastery-question-nav__result' : 'mastery-question-nav__result'}
                    onClick={() => setShowResults(true)}
                  >
                    查看结果
                  </button>
                ) : (
                  <small>答完当前题后会按掌握情况解锁下一题</small>
                )}
              </nav>
            ) : null}

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
            ) : result && showResults ? (
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
                    <button
                      type="button"
                      className="mastery-result__edit-answers"
                      onClick={() => selectQuestion(questions[0]?.question_id || '')}
                    >
                      返回检查或修改答案
                    </button>
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
            ) : currentQuestion && payload ? (
              <div className="mastery-question">
                <div className="mastery-question__progress">
                  <span>第 {Math.max(1, questions.findIndex((item) => item.question_id === currentQuestion.question_id) + 1)} / {payload.progress.target} 题</span>
                  <i><b style={{ width: percentage(payload.progress.answered / payload.progress.target) }} /></i>
                  <span>已完成 {payload.progress.answered} 题</span>
                </div>
                <div className="mastery-question__meta">
                  <span>{currentQuestion.source_type === 'lecture_example'
                    ? '课堂例题'
                    : currentQuestion.source_type === 'past-exam' ? '关联往年题原题' : '关联作业原题'}</span>
                  <span>难度 {currentQuestion.difficulty}/5</span>
                  {currentQuestion.source_page_number ? <span>原文 P.{currentQuestion.source_page_number}</span> : null}
                </div>
                <h3>{currentQuestion.title}</h3>
                <SourceText>{currentQuestion.prompt}</SourceText>
                <QuestionImages images={currentQuestion.images} />
                <div className="mastery-question__concepts">
                  {currentQuestion.knowledge_points.map((concept) => <span key={concept}>{concept}</span>)}
                </div>
                <section className="mastery-assessment-parts" aria-label="本题作答部分">
                  {currentAssessmentParts.map((part, index) => {
                    const partResult = savedAnswer?.part_grading_results?.find(
                      (item) => item.part_id === part.id,
                    )
                    const updatePart = (value: string) => setDraftAnswers((current) => ({
                      ...current,
                      [currentQuestion.question_id]: {
                        ...(current[currentQuestion.question_id] ?? savedResponses),
                        [part.id]: value,
                      },
                    }))
                    return (
                      <article className="mastery-assessment-part" key={part.id}>
                        <header>
                          <strong>Part {index + 1}</strong>
                          <span>{Math.round(part.weight * 100)}%</span>
                        </header>
                        <SourceText>{part.prompt}</SourceText>
                        {part.type === 'choice' ? (
                          <div className="mastery-choice-grid" role="radiogroup" aria-label={`Part ${index + 1} 选项`}>
                            {part.options.map((option) => (
                              <label
                                key={option.id}
                                className={answer[part.id] === option.id ? 'is-selected' : ''}
                              >
                                <input
                                  type="radio"
                                  name={`${currentQuestion.question_id}:${part.id}`}
                                  value={option.id}
                                  checked={answer[part.id] === option.id}
                                  onChange={() => updatePart(option.id)}
                                  disabled={isLoading}
                                />
                                <b>{option.id}</b>
                                <SourceText>{option.content}</SourceText>
                              </label>
                            ))}
                          </div>
                        ) : part.type === 'numeric' ? (
                          <label className="mastery-numeric-answer">
                            <span>答案</span>
                            <input
                              type="text"
                              inputMode="decimal"
                              value={answer[part.id] ?? ''}
                              onChange={(event) => updatePart(event.currentTarget.value)}
                              placeholder="支持小数、科学计数法或简单分数"
                              disabled={isLoading}
                            />
                          </label>
                        ) : (
                          <label className="mastery-text-answer">
                            <span>简要说明你的思路即可</span>
                            <textarea
                              value={answer[part.id] ?? ''}
                              onChange={(event) => updatePart(event.currentTarget.value)}
                              placeholder="写下关键结论和理由，不必输入完整复杂公式。"
                              rows={4}
                              disabled={isLoading}
                            />
                          </label>
                        )}
                        {partResult ? (
                          <div className={`mastery-part-feedback ${partResult.correct ? 'is-correct' : 'is-wrong'}`}>
                            <strong>
                              {part.type === 'text'
                                ? `AI 评分 ${percentage(partResult.score)}`
                                : partResult.correct ? `Part ${index + 1} 正确` : `Part ${index + 1} 错误`}
                            </strong>
                            {partResult.feedback ? <span>{partResult.feedback}</span> : null}
                          </div>
                        ) : null}
                      </article>
                    )
                  })}
                </section>
                {savedAnswer ? (
                  <section className={`mastery-saved-answer ${savedAnswer.correct ? 'is-correct' : 'is-wrong'}`}>
                    <div>
                      <span>{savedAnswer.correct ? '当前答案达到掌握标准' : '当前答案还需巩固'}</span>
                      <strong>{percentage(savedAnswer.score)}</strong>
                      <small>第 {savedAnswer.revision} 版</small>
                    </div>
                    <h4>本题得分：{percentage(savedAnswer.score)}</h4>
                    <p>{savedAnswer.feedback}</p>
                    {answerIsDirty ? <em>上方修改尚未保存</em> : null}
                    <details>
                      <summary>查看参考解答</summary>
                      <SourceText>{savedAnswer.reference_answer}</SourceText>
                    </details>
                  </section>
                ) : null}
                {error ? <p className="mastery-test__inline-error">{error}</p> : null}
                <div className="mastery-question__actions">
                  {payload.current_question && payload.current_question.question_id !== currentQuestion.question_id ? (
                    <button
                      type="button"
                      className="mastery-question__next"
                      onClick={() => selectQuestion(payload.current_question?.question_id || '')}
                      disabled={isLoading}
                    >
                      前往待答题
                    </button>
                  ) : null}
                  {result ? (
                    <button
                      type="button"
                      className="mastery-question__next"
                      onClick={() => setShowResults(true)}
                      disabled={isLoading}
                    >
                      查看掌握度结果
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="primary-button mastery-question__submit"
                    disabled={!requiredPartsComplete || isLoading || Boolean(savedAnswer && !answerIsDirty)}
                    onClick={() => void submitAnswer()}
                  >
                    {isLoading
                      ? '正在评分…'
                      : savedAnswer
                        ? answerIsDirty ? '保存修改并重新评分' : '答案已保存'
                        : '提交答案并解锁下一题'}
                  </button>
                </div>
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
