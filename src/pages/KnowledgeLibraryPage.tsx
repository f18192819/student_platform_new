import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  addKnowledgeHomeworkDocument,
  deleteKnowledgeFile,
  deleteKnowledgeHomeworkDocument,
  getKnowledgeCourse,
  getKnowledgeFilesByCourse,
  getKnowledgeHomeworkDocumentsByCourseFolder,
  getKnowledgeHomeworkFolderName,
  saveKnowledgeHomeworkDocuments,
  updateKnowledgeCourseSettings,
  upsertKnowledgeFile,
} from '../lib/knowledgeBase'
import { convertImageUploadToPdf, extractPdfPreview } from '../lib/pdf'
import {
  buildPendingHomeworkDocument,
  getMineruUploadError,
  getMineruUploadKind,
  MINERU_UPLOAD_ACCEPT,
  processHomeworkDocumentWithPipeline,
  readHomeworkAssetPayload,
  retryHomeworkDocumentProcessing,
  retryLectureDocumentProcessing,
  submitLectureDocumentForProcessing,
} from '../lib/mineru'
import { getKnowledgeCourseDisplayName } from '../lib/knowledgeBaseCourses'
import { parseTsinghuaCourseDisplayName } from '../lib/tsinghuaCourseLabels'
import {
  closeTsinghuaSync,
  fetchTsinghuaCoursewareFile,
  getTsinghuaSyncStatus,
  importTsinghuaCourses,
  listTsinghuaCoursewareByCourse,
  loadTsinghuaSemesters,
  loadTsinghuaCoursewareAutoSyncState,
  pullTsinghuaCoursewareByCourse,
  restoreTsinghuaCourseware,
  startTsinghuaSync,
  type TsinghuaCourseCandidate,
  type TsinghuaCoursewareFile,
  type TsinghuaSemesterOption,
} from '../lib/tsinghuaCourses'
import {
  buildCoursewareImportName,
  formatCoursewareImportSummary,
  importCoursewareFiles,
} from '../features/knowledge-library/coursewareImport'
import { useKnowledgeLibraryState } from '../features/knowledge-library/useKnowledgeLibraryState'
import {
  applyQuestionPipelineResult,
  syncLecturePipelineResult,
} from '../features/knowledge-library/pipelineProjection'
import { useKnowledgePipelinePolling } from '../features/knowledge-library/useKnowledgePipelinePolling'
import type { HomeworkDocument, KnowledgeFile, KnowledgeLibraryFolderType } from '../types'

type LibraryFolderType = KnowledgeLibraryFolderType | 'homework' | 'past-exam'
type CoursewarePickerItem = TsinghuaCoursewareFile & { wasDeleted: boolean }

const LIBRARY_FOLDER_NAMES: Record<KnowledgeLibraryFolderType, string> = {
  courseware: '课件',
  other: '其他',
}

function formatFileDate(value: string) {
  return new Date(value).toLocaleDateString('zh-CN')
}

function normalizeCoursewareFileName(value: string) {
  return value.trim().toLocaleLowerCase()
}

function formatCoursewareSize(byteSize: number) {
  if (!byteSize || byteSize < 0) return ''
  if (byteSize < 1024 * 1024) return `${Math.max(1, Math.round(byteSize / 1024))} KB`
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`
}

function isProcessableCourseware(file: TsinghuaCoursewareFile) {
  return file.kind === 'pdf' || file.kind === 'office'
}

function formatCoursewareKind(file: TsinghuaCoursewareFile) {
  if (file.kind === 'pdf') return 'PDF'
  if (file.kind === 'office') return 'Office 文档'
  if (file.kind === 'archive') return '压缩包'
  return '其他文件'
}

function isPipelineFailure(status: string | null | undefined) {
  return Boolean(status && status.endsWith('_failed'))
}

function formatQuestionPipelineStatus(document: HomeworkDocument) {
  switch (document.pipelineStatus) {
    case 'queued': return '等待 MinerU 解析'
    case 'parsing': return '正在用 MinerU 解析'
    case 'extracting_questions': return '正在切分题目'
    case 'analyzing': return '正在分析题目'
    case 'embedding': return '正在生成 Embedding'
    case 'vector': return '正在写入 Qdrant'
    case 'completed': return '已完成题目索引'
    case 'parser_failed': return 'MinerU 解析失败'
    case 'extraction_failed': return '题目切分失败'
    case 'analysis_failed': return '题目分析失败'
    case 'embedding_failed': return 'Embedding 失败'
    case 'vector_failed': return 'Qdrant 写入失败'
    default: return document.status === 'error' ? '题目处理失败' : '正在处理题目'
  }
}

function QuestionPipelineProgress({ document }: { document: HomeworkDocument }) {
  if (document.status !== 'processing') return null
  const completed = document.embeddingStatus === 'completed'
    ? (document.vectorCompletedQuestions ?? 0)
    : (document.embeddingCompletedQuestions ?? 0)
  const total = document.questions.length
  return (
    <div className="octopus-pipeline-progress" aria-label="题目处理进度">
      <span className="octopus-pipeline-progress__stage is-active">
        {formatQuestionPipelineStatus(document)}
      </span>
      {total > 0 && completed > 0 ? (
        <span className="octopus-pipeline-progress__count">{completed}/{total} 题</span>
      ) : null}
    </div>
  )
}

function formatPipelineStatus(status: string | null | undefined) {
  switch (status) {
    case 'queued': return '等待 MinerU 解析'
    case 'mineru': return 'MinerU 解析中'
    case 'embedding': return '正在生成 Embedding'
    case 'vector': return '正在写入 Qdrant'
    case 'completed': return '已完成索引'
    case 'mineru_failed': return 'MinerU 解析失败'
    case 'embedding_failed': return 'Embedding 失败'
    case 'vector_failed': return 'Qdrant 写入失败'
    case 'state_failed': return '任务状态保存失败'
    default: return status ? '正在处理文档' : '未提交处理任务'
  }
}

function PipelineStageProgress({ file }: { file: KnowledgeFile }) {
  if (!file.pipelineStatus || file.pipelineStatus === 'completed' || isPipelineFailure(file.pipelineStatus)) {
    return null
  }
  const currentStage = file.pipelineStatus
  const stages = [
    {
      id: 'mineru',
      label: 'MinerU 解析',
      complete: file.mineruStatus === 'completed',
      active: currentStage === 'queued' || currentStage === 'mineru',
    },
    {
      id: 'embedding',
      label: 'Embedding',
      complete: file.embeddingStatus === 'completed',
      active: currentStage === 'embedding',
    },
    {
      id: 'vector',
      label: 'Qdrant 写入',
      complete: file.vectorStatus === 'completed',
      active: currentStage === 'vector',
    },
  ]
  const progress = file.chunkCount && file.indexedChunkCount !== null && file.indexedChunkCount !== undefined
    ? `${file.indexedChunkCount}/${file.chunkCount}`
    : null

  return (
    <div className="octopus-pipeline-progress" aria-label="文档处理进度">
      <div className="octopus-pipeline-progress__stages">
        {stages.map((stage) => (
          <span
            key={stage.id}
            className={`octopus-pipeline-progress__stage${stage.complete ? ' is-complete' : ''}${stage.active ? ' is-active' : ''}`}
          >
            {stage.label}
          </span>
        ))}
      </div>
      {progress ? <span className="octopus-pipeline-progress__count">{progress} 块</span> : null}
    </div>
  )
}

function getLibraryFolderName(folderType: LibraryFolderType) {
  return folderType === 'homework' || folderType === 'past-exam'
    ? getKnowledgeHomeworkFolderName(folderType)
    : LIBRARY_FOLDER_NAMES[folderType]
}

function FolderCard({
  courseId,
  folderType,
  count,
}: {
  courseId: string
  folderType: LibraryFolderType
  count: number
}) {
  const name = getLibraryFolderName(folderType)
  return (
    <Link
      to={`/library?course=${courseId}&folder=${folderType}`}
      className="octopus-file-card octopus-file-card--folder"
    >
      <div className="octopus-file-card__preview">
        <div className="octopus-folder-glyph" aria-hidden="true">
          <div className="octopus-folder-glyph__tab" />
          <div className="octopus-folder-glyph__body" />
        </div>
      </div>
      <div className="octopus-file-card__content">
        <strong>{name}</strong>
        <p>{count} 个文件</p>
      </div>
      <div className="octopus-file-card__meta">
        <span>文件夹</span>
        <span>{name}</span>
      </div>
    </Link>
  )
}

export function KnowledgeLibraryPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { knowledgeLibrary, isReady } = useKnowledgeLibraryState()
  const courseId = searchParams.get('course')
  const folderTypeParam = searchParams.get('folder')
  const activeCourse =
    (courseId ? getKnowledgeCourse(courseId) : null) ?? knowledgeLibrary.courses[0] ?? null
  const activeFolderType: LibraryFolderType | null =
    folderTypeParam === 'past-exam' || folderTypeParam === 'homework' ||
    folderTypeParam === 'courseware' || folderTypeParam === 'other'
      ? folderTypeParam
      : null
  const files = activeCourse ? getKnowledgeFilesByCourse(activeCourse.id) : []
  const activeFolderFiles = activeCourse && activeFolderType
    ? files.filter((file) =>
        activeFolderType === 'courseware'
          ? (file.libraryFolder ?? 'courseware') === 'courseware'
          : activeFolderType === 'other'
            ? file.libraryFolder === 'other'
            : false,
      )
    : []
  const isHomeworkFolder = activeFolderType === 'homework' || activeFolderType === 'past-exam'
  const activeFolderDocuments =
    activeCourse && isHomeworkFolder && activeFolderType
      ? getKnowledgeHomeworkDocumentsByCourseFolder(activeCourse.id, activeFolderType)
      : []
  const activeCourseId = activeCourse?.id ?? ''

  const [syncBusy, setSyncBusy] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')
  const syncSessionRef = useRef<string | null>(null)
  const [isCoursewarePickerOpen, setIsCoursewarePickerOpen] = useState(false)
  const [coursewarePickerFiles, setCoursewarePickerFiles] = useState<CoursewarePickerItem[]>([])
  const [selectedCoursewareIds, setSelectedCoursewareIds] = useState<Set<string>>(() => new Set())
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const [uploadError, setUploadError] = useState('')
  const [isDraggingPdf, setIsDraggingPdf] = useState(false)
  const [expandedErrorId, setExpandedErrorId] = useState<string | null>(null)
  const [retryingQuestionIds, setRetryingQuestionIds] = useState<Set<string>>(() => new Set())
  const [isCourseSettingsOpen, setIsCourseSettingsOpen] = useState(false)
  const [courseSettingsBusy, setCourseSettingsBusy] = useState(false)
  const [courseSettingsError, setCourseSettingsError] = useState('')
  const [courseSettingsDisplayName, setCourseSettingsDisplayName] = useState('')
  const [courseSettingsSemesters, setCourseSettingsSemesters] = useState<TsinghuaSemesterOption[]>([])
  const [courseSettingsSemesterId, setCourseSettingsSemesterId] = useState('')
  const [courseSettingsCandidates, setCourseSettingsCandidates] = useState<TsinghuaCourseCandidate[]>([])
  const [courseSettingsAssociationId, setCourseSettingsAssociationId] = useState('')

  useKnowledgePipelinePolling({
    files,
    courseId: activeCourseId,
    folderType: isHomeworkFolder
      ? (activeFolderType === 'past-exam' ? 'past-exam' : 'homework')
      : null,
    documents: activeFolderDocuments,
  })

  useEffect(() => () => {
    const sessionId = syncSessionRef.current
    syncSessionRef.current = null
    if (sessionId) {
      void closeTsinghuaSync(sessionId).catch((error) => {
        console.warn('close tsinghua sync session failed:', error)
      })
    }
  }, [])

  const finishHomeworkUpload = async (
    file: File,
    courseId: string,
    folderType: 'homework' | 'past-exam',
    document: ReturnType<typeof buildPendingHomeworkDocument>,
  ) => {
    try {
      const result = await processHomeworkDocumentWithPipeline(file, courseId, folderType, document.id)
      const latest = getKnowledgeHomeworkDocumentsByCourseFolder(courseId, folderType)
        .find((item) => item.id === document.id) ?? document
      const completedDocument = applyQuestionPipelineResult(latest, result)
      const current = getKnowledgeHomeworkDocumentsByCourseFolder(courseId, folderType)
      saveKnowledgeHomeworkDocuments(courseId, folderType, [
        completedDocument,
        ...current.filter((item) => item.id !== completedDocument.id),
      ])
    } catch (error) {
      const current = getKnowledgeHomeworkDocumentsByCourseFolder(courseId, folderType)
      const latest = current.find((item) => item.id === document.id) ?? document
      const failedDocument: HomeworkDocument = {
        ...latest,
        status: 'error',
        errorMessage: error instanceof Error ? error.message : '题目解析失败。',
        updatedAt: new Date().toISOString(),
      }
      saveKnowledgeHomeworkDocuments(courseId, folderType, [
        failedDocument,
        ...current.filter((item) => item.id !== failedDocument.id),
      ])
    }
  }

  const retryHomeworkDocument = async (
    document: HomeworkDocument,
    folderType: 'homework' | 'past-exam',
  ) => {
    if (!activeCourse || retryingQuestionIds.has(document.id)) return
    setUploadError('')
    setExpandedErrorId(null)
    setRetryingQuestionIds((current) => new Set(current).add(document.id))
    const markProcessing: HomeworkDocument = {
      ...document,
      status: 'processing',
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    }
    const beforeRetry = getKnowledgeHomeworkDocumentsByCourseFolder(activeCourse.id, folderType)
    saveKnowledgeHomeworkDocuments(activeCourse.id, folderType, [
      markProcessing,
      ...beforeRetry.filter((item) => item.id !== document.id),
    ])
    try {
      const result = await retryHomeworkDocumentProcessing(document.id)
      const current = getKnowledgeHomeworkDocumentsByCourseFolder(activeCourse.id, folderType)
      const latest = current.find((item) => item.id === document.id) ?? markProcessing
      const updated = applyQuestionPipelineResult(latest, result)
      saveKnowledgeHomeworkDocuments(activeCourse.id, folderType, [
        updated,
        ...current.filter((item) => item.id !== document.id),
      ])
    } catch (error) {
      const current = getKnowledgeHomeworkDocumentsByCourseFolder(activeCourse.id, folderType)
      const latest = current.find((item) => item.id === document.id) ?? markProcessing
      const failed: HomeworkDocument = {
        ...latest,
        status: 'error',
        errorMessage: error instanceof Error ? error.message : '题目任务重试失败。',
        updatedAt: new Date().toISOString(),
      }
      saveKnowledgeHomeworkDocuments(activeCourse.id, folderType, [
        failed,
        ...current.filter((item) => item.id !== document.id),
      ])
    } finally {
      setRetryingQuestionIds((current) => {
        const next = new Set(current)
        next.delete(document.id)
        return next
      })
    }
  }

  const uploadFile = async (file: File) => {
    if (!activeCourse) return
    const uploadKind = getMineruUploadKind(file)
    if (!uploadKind) {
      setUploadError(getMineruUploadError(file))
      return
    }
    setUploadError('')
    try {
      if (activeFolderType === 'homework' || activeFolderType === 'past-exam') {
        const pendingDocument = buildPendingHomeworkDocument(file)
        await addKnowledgeHomeworkDocument(
          activeCourse.id,
          activeFolderType,
          pendingDocument,
          await readHomeworkAssetPayload(file),
        )
        void finishHomeworkUpload(file, activeCourse.id, activeFolderType, pendingDocument)
        navigate(
          `/pdf?course=${activeCourse.id}&folder=${activeFolderType}&homework=${pendingDocument.id}`,
        )
        return
      }

      const previewFile = uploadKind === 'image' ? await convertImageUploadToPdf(file) : file
      const preview = await extractPdfPreview(previewFile)
      const storedFile = await upsertKnowledgeFile({
        fileName: file.name,
        pageCount: preview.pageCount,
        byteSize: preview.buffer.byteLength,
        markdown: '',
        layoutBlocks: [],
        pdfBuffer: preview.buffer,
        courseId: activeCourse.id,
        libraryFolder: activeFolderType === 'other' ? 'other' : 'courseware',
        ...(activeFolderType === 'other'
          ? { pipelineStatus: null, mineruStatus: null, embeddingStatus: null, vectorStatus: null, pipelineError: null }
          : {
        pipelineStatus: 'queued',
        mineruStatus: 'pending',
        embeddingStatus: 'pending',
        vectorStatus: 'pending',
        pipelineError: null,
          }),
      })
      if (activeFolderType !== 'other') {
        const status = await submitLectureDocumentForProcessing(previewFile, activeCourse.id, storedFile.id)
        await syncLecturePipelineResult(storedFile.id, status)
      }
      navigate(`/pdf?file=${storedFile.id}&course=${activeCourse.id}`)
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : '文件上传失败。')
    }
  }

  const retryFile = async (fileId: string) => {
    setUploadError('')
    try {
      await syncLecturePipelineResult(fileId, await retryLectureDocumentProcessing(fileId))
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : '重试任务未能启动。')
    }
  }

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    setIsDraggingPdf(false)
    if (event.dataTransfer.files.length > 1) {
      setUploadError('当前一次处理一个文件，请分别拖入，避免多份文档同时占用 MinerU。')
      return
    }
    const file = event.dataTransfer.files.item(0)
    if (file) {
      void uploadFile(file)
    } else {
      setUploadError('没有检测到可上传的本地文件。')
    }
  }

  const handleDeleteFile = async (fileId: string, fileName: string) => {
    const confirmed = window.confirm(`确认删除讲义“${fileName}”吗？相关疑点和聊天记录也会一起删除。`)
    if (!confirmed) {
      return
    }

    await deleteKnowledgeFile(fileId)
  }

  const handleDeleteHomeworkDocument = async (
    documentId: string,
    fileName: string,
    folderType: 'homework' | 'past-exam',
  ) => {
    if (!activeCourse) {
      return
    }
    const confirmed = window.confirm(
      `确认删除“${fileName}”吗？对应的题目 JSON、关联记录和检索向量也会一起删除。`,
    )
    if (!confirmed) {
      return
    }

    setUploadError('')
    try {
      const deleted = await deleteKnowledgeHomeworkDocument(
        activeCourse.id,
        folderType,
        documentId,
      )
      if (!deleted) {
        setUploadError('没有找到要删除的题目文档，请刷新课程库后重试。')
      }
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : '题目文档删除失败。')
    }
  }

  const ensureSyncSession = async (): Promise<string | null> => {
    if (syncSessionRef.current) {
      return syncSessionRef.current
    }

    setSyncMessage('正在启动网络学堂同步窗口，请稍候。')
    const status = await startTsinghuaSync()
    syncSessionRef.current = status.sessionId
    return status.sessionId
  }

  const waitUntilReady = async (sessionId: string): Promise<boolean> => {
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      const status = await getTsinghuaSyncStatus(sessionId)
      if (status.stage === 'ready' || status.stage === 'completed') {
        return true
      }

      if (status.stage === 'awaiting_2fa') {
        setSyncMessage('网络学堂需要二次认证，请在弹出的浏览器窗口中完成认证。')
      } else if (status.stage === 'awaiting_login') {
        setSyncMessage('请在弹出的网络学堂窗口中完成登录。')
      } else {
        setSyncMessage('正在登录网络学堂并进入课程列表，请稍候。')
      }

      await new Promise((resolve) => setTimeout(resolve, 2500))
    }

    setSyncMessage('等待网络学堂登录超时，请确认登录完成后重试。')
    return false
  }

  const getActiveCoursewareIdentity = () => {
    if (!activeCourse) return null
    const parsedCourse = parseTsinghuaCourseDisplayName(activeCourse.name)
    const semesterId = activeCourse.semesterId || parsedCourse.semesterId || ''
    if (activeCourse.source === 'tsinghua-sync' && !semesterId) {
      setSyncMessage('该网络学堂课程缺少所属学期，已阻止下载以避免误拉取当前学期课件。请重新同步课程后再试。')
      return null
    }
    return {
      courseName: parsedCourse.courseName || activeCourse.name,
      semesterId,
      courseCode: activeCourse.courseCode || '',
      wlkcid: activeCourse.wlkcid || '',
      strictIdentity: Boolean(activeCourse.wlkcid),
    }
  }

  const closeCurrentSyncSession = async () => {
    const sessionId = syncSessionRef.current
    syncSessionRef.current = null
    if (!sessionId) return
    try {
      await closeTsinghuaSync(sessionId)
    } catch (error) {
      console.warn('close tsinghua sync session failed:', error)
    }
  }

  const loadCourseSettingsCandidates = async (semesterId: string) => {
    if (!semesterId) {
      setCourseSettingsCandidates([])
      setCourseSettingsAssociationId('')
      return
    }

    setCourseSettingsBusy(true)
    setCourseSettingsError('')
    try {
      const sessionId = await ensureSyncSession()
      if (!sessionId || !(await waitUntilReady(sessionId))) return
      const result = await importTsinghuaCourses(sessionId, semesterId)
      setCourseSettingsCandidates(result.courses)
      setCourseSettingsAssociationId((current) => (
        result.courses.some((course) => course.wlkcid === current) ? current : ''
      ))
    } catch (error) {
      setCourseSettingsError(error instanceof Error ? error.message : '读取网络学堂课程失败。')
    } finally {
      setCourseSettingsBusy(false)
      await closeCurrentSyncSession()
    }
  }

  const openCourseSettings = async () => {
    if (!activeCourse) return
    setIsCourseSettingsOpen(true)
    setCourseSettingsBusy(true)
    setCourseSettingsError('')
    setCourseSettingsDisplayName(getKnowledgeCourseDisplayName(activeCourse))
    setCourseSettingsCandidates([])
    setCourseSettingsAssociationId(activeCourse.wlkcid || '')
    try {
      const sessionId = await ensureSyncSession()
      if (!sessionId || !(await waitUntilReady(sessionId))) return
      const result = await loadTsinghuaSemesters(sessionId)
      const selectedSemesterId = activeCourse.semesterId
        || result.currentSemesterId
        || result.semesters.find((semester) => semester.isCurrent)?.semesterId
        || result.semesters[0]?.semesterId
        || ''
      setCourseSettingsSemesters(result.semesters)
      setCourseSettingsSemesterId(selectedSemesterId)
      if (!selectedSemesterId) return
      const courses = await importTsinghuaCourses(sessionId, selectedSemesterId)
      setCourseSettingsCandidates(courses.courses)
      setCourseSettingsAssociationId(
        courses.courses.some((course) => course.wlkcid === activeCourse.wlkcid)
          ? (activeCourse.wlkcid || '')
          : '',
      )
    } catch (error) {
      setCourseSettingsError(error instanceof Error ? error.message : '读取网络学堂课程失败。')
    } finally {
      setCourseSettingsBusy(false)
      await closeCurrentSyncSession()
    }
  }

  const handleCourseSettingsSemesterChange = (semesterId: string) => {
    setCourseSettingsSemesterId(semesterId)
    setCourseSettingsAssociationId('')
    setCourseSettingsCandidates([])
    void loadCourseSettingsCandidates(semesterId)
  }

  const saveCourseSettings = async () => {
    if (!activeCourse) return
    const displayName = courseSettingsDisplayName.trim()
    const selectedSemester = courseSettingsSemesters.find(
      (semester) => semester.semesterId === courseSettingsSemesterId,
    )
    const selectedCourse = courseSettingsCandidates.find(
      (course) => course.wlkcid === courseSettingsAssociationId,
    )
    if (!displayName) {
      setCourseSettingsError('请填写课程显示名称。')
      return
    }
    if (courseSettingsSemesterId && !selectedCourse) {
      setCourseSettingsError('请选择该学期对应的网络学堂课程，或将学期设为“不关联”。')
      return
    }

    setCourseSettingsBusy(true)
    setCourseSettingsError('')
    try {
      await updateKnowledgeCourseSettings(activeCourse.id, {
        displayName,
        association: selectedCourse && selectedSemester
          ? {
              name: selectedCourse.name,
              semesterId: selectedSemester.semesterId,
              semesterName: selectedSemester.semesterName,
              courseCode: selectedCourse.courseCode || '',
              wlkcid: selectedCourse.wlkcid || '',
            }
          : null,
      })
      setIsCourseSettingsOpen(false)
      setSyncMessage('课程设置已保存。之后可按该关联自动检查和下载网络学堂课件。')
    } catch (error) {
      setCourseSettingsError(error instanceof Error ? error.message : '保存课程设置失败。')
    } finally {
      setCourseSettingsBusy(false)
    }
  }

  const handleOpenCoursewarePicker = async () => {
    if (!activeCourse) return
    if (isCoursewarePickerOpen) {
      setIsCoursewarePickerOpen(false)
      return
    }
    const courseIdentity = getActiveCoursewareIdentity()
    if (!courseIdentity) return

    setSyncBusy(true)
    setSyncMessage(`正在读取“${courseIdentity.courseName}”的可下载课件…`)
    try {
      const sessionId = await ensureSyncSession()
      if (!sessionId || !(await waitUntilReady(sessionId))) return
      const [catalog, autoSyncState] = await Promise.all([
        listTsinghuaCoursewareByCourse(sessionId, courseIdentity),
        loadTsinghuaCoursewareAutoSyncState(),
      ])
      const existingSourceKeys = new Set(files.map((file) => file.sourceKey))
      const existingNames = new Set(files.map((file) => normalizeCoursewareFileName(file.fileName)))
      const suppressedSourceKeys = new Set(autoSyncState.suppressed.map((item) => item.sourceKey))
      const available = catalog.files
        .filter((remoteFile) => {
          const sourceKey = `tsinghua-courseware:${remoteFile.id}`
          const importName = normalizeCoursewareFileName(buildCoursewareImportName(remoteFile))
          return !existingSourceKeys.has(sourceKey) && !existingNames.has(importName)
        })
        .map((remoteFile) => ({
          ...remoteFile,
          wasDeleted: suppressedSourceKeys.has(`tsinghua-courseware:${remoteFile.id}`),
        }))
      setCoursewarePickerFiles(available)
      setSelectedCoursewareIds(new Set())
      setIsCoursewarePickerOpen(true)
      setSyncMessage(available.length
        ? `找到 ${available.length} 份可下载课件，请勾选后下载。`
        : `“${courseIdentity.courseName}”没有未下载的课件。`)
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : '读取网络学堂课件失败。')
    } finally {
      setSyncBusy(false)
      await closeCurrentSyncSession()
    }
  }

  const toggleCoursewareSelection = (fileId: string) => {
    setSelectedCoursewareIds((current) => {
      const next = new Set(current)
      if (next.has(fileId)) next.delete(fileId)
      else next.add(fileId)
      return next
    })
  }

  const toggleSelectAllCourseware = () => {
    const selectableFiles = coursewarePickerFiles.filter(isProcessableCourseware)
    setSelectedCoursewareIds((current) => (
      selectableFiles.length > 0 && selectableFiles.every((file) => current.has(file.id))
        ? new Set()
        : new Set(selectableFiles.map((file) => file.id))
    ))
  }

  const handleDownloadSelectedCourseware = async () => {
    if (!activeCourse || !selectedCoursewareIds.size) return
    const courseIdentity = getActiveCoursewareIdentity()
    if (!courseIdentity) return
    const selectedFiles = coursewarePickerFiles.filter(
      (file) => isProcessableCourseware(file) && selectedCoursewareIds.has(file.id),
    )
    if (!selectedFiles.length) return

    setSyncBusy(true)
    setSyncMessage(`正在下载 ${selectedFiles.length} 份课件…`)
    try {
      const sessionId = await ensureSyncSession()
      if (!sessionId || !(await waitUntilReady(sessionId))) return
      await restoreTsinghuaCourseware(selectedFiles.map((file) => `tsinghua-courseware:${file.id}`))
      const result = await pullTsinghuaCoursewareByCourse(sessionId, {
        ...courseIdentity,
        requestedFileIds: selectedFiles.map((file) => file.id),
      })
      const importOutcome = await importCoursewareFiles({
        remoteFiles: result.files,
        fetchFile: (remoteFile) => fetchTsinghuaCoursewareFile(sessionId, remoteFile.id),
        resolveCourseId: () => activeCourse.id,
        onProgressMessage: (message) => setSyncMessage(message),
      })
      const failureReasons = [
        ...result.skipped.map(
          (item) => `${item.fileName || '未命名文件'}：${item.reason || '下载阶段已跳过'}`,
        ),
        ...importOutcome.failureReasons,
      ]
      setSyncMessage(formatCoursewareImportSummary({
        downloadedCount: result.count,
        importedCount: importOutcome.importedCount,
        failedCount: result.skipped.length + importOutcome.importFailedCount,
        failureReasons,
        successLabel: `“${courseIdentity.courseName}”`,
      }))
      setIsCoursewarePickerOpen(false)
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : '下载网络学堂课件失败。')
    } finally {
      setSyncBusy(false)
      await closeCurrentSyncSession()
    }
  }

  let content: ReactNode

  if (!isReady) {
    content = (
      <section className="octopus-empty-card">
        <strong>正在加载知识库</strong>
        <p>项目目录中的课程与讲义正在同步到当前页面。</p>
      </section>
    )
  } else if (!activeCourse) {
    content = (
      <section className="octopus-empty-card">
        <strong>还没有课程标签</strong>
        <p>先回到首页创建课程标签，再管理你的 PDF 知识库。</p>
      </section>
    )
  } else if (activeFolderType && isHomeworkFolder) {
    content = (
      <section className="octopus-file-grid">
        {activeFolderDocuments.length ? (
          activeFolderDocuments.map((document) => (
            <Link
              key={document.id}
              to={`/pdf?course=${activeCourse.id}&folder=${activeFolderType}&homework=${document.id}`}
              className="octopus-file-card"
            >
              <button
                type="button"
                className="octopus-card-close"
                aria-label={`删除题目文档 ${document.fileName}`}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  void handleDeleteHomeworkDocument(
                    document.id,
                    document.fileName,
                    activeFolderType,
                  )
                }}
              >
                x
              </button>
              <div className="octopus-file-card__preview">
                <div className="octopus-file-card__sheet">
                  <div className="octopus-file-card__band" />
                  <div className="octopus-file-card__line" />
                  <div className="octopus-file-card__line octopus-file-card__line--short" />
                </div>
              </div>
              <div className="octopus-file-card__content">
                <strong>{document.fileName}</strong>
                <p>
                  {document.questions.length} 题 · {document.pageCount ?? '?'} 页
                </p>
                {document.status === 'processing' ? (
                  <div className="octopus-pipeline-status">
                    <span>{formatQuestionPipelineStatus(document)}</span>
                  </div>
                ) : null}
                {document.status === 'error' ? (
                  <div className="octopus-pipeline-status octopus-pipeline-status--failed">
                    <span>{formatQuestionPipelineStatus(document)}</span>
                    <button
                      type="button"
                      className={`octopus-pipeline-status__retry-icon${retryingQuestionIds.has(document.id) ? ' is-spinning' : ''}`}
                      aria-label="从失败步骤重新处理"
                      title="从失败步骤重试"
                      disabled={retryingQuestionIds.has(document.id)}
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        void retryHomeworkDocument(
                          document,
                          activeFolderType === 'past-exam' ? 'past-exam' : 'homework',
                        )
                      }}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M20 7v5h-5M4 17v-5h5M6.1 8.2A7 7 0 0 1 18.7 7M17.9 15.8A7 7 0 0 1 5.3 17" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="octopus-pipeline-status__error"
                      aria-label="查看失败原因"
                      aria-expanded={expandedErrorId === document.id}
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        setExpandedErrorId((current) => current === document.id ? null : document.id)
                      }}
                    >!</button>
                  </div>
                ) : null}
                <QuestionPipelineProgress document={document} />
                {document.status === 'error' && expandedErrorId === document.id ? (
                  <p className="octopus-pipeline-error-detail">
                    {document.errorMessage || '未返回具体错误，请检查 API 配置后重试。'}
                  </p>
                ) : null}
              </div>
              <div className="octopus-file-card__meta">
                <span>{document.sourceType === 'image' ? '图片题目' : 'PDF 题目'}</span>
                <span>{formatFileDate(document.updatedAt)}</span>
              </div>
            </Link>
          ))
        ) : (
          <div className="octopus-empty-card">
            <strong>{getLibraryFolderName(activeFolderType)} 里还没有题目</strong>
            <p>拖入 PDF 或题目照片，系统会自动调用 MinerU 识别并切分。</p>
          </div>
        )}
      </section>
    )
  } else if (activeFolderType) {
    content = (
      <section className="octopus-file-grid">
        {activeFolderFiles.length ? activeFolderFiles.map((file) => (
          <Link
            key={file.id}
            to={`/pdf?file=${file.id}&course=${activeCourse.id}`}
            className="octopus-file-card"
          >
            <button
              type="button"
              className="octopus-card-close"
              aria-label={`删除文件 ${file.fileName}`}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                void handleDeleteFile(file.id, file.fileName)
              }}
            >x</button>
            <div className="octopus-file-card__preview">
              <div className="octopus-file-card__sheet">
                <div className="octopus-file-card__band" />
                <div className="octopus-file-card__line" />
                <div className="octopus-file-card__line octopus-file-card__line--short" />
              </div>
            </div>
            <div className="octopus-file-card__content">
              <strong>{file.fileName}</strong>
              <p>{file.pageCount} 页</p>
              {activeFolderType === 'courseware' && file.pipelineStatus ? (
                <div className="octopus-pipeline-status">
                  <span>{formatPipelineStatus(file.pipelineStatus)}</span>
                  {isPipelineFailure(file.pipelineStatus) ? (
                    <>
                      <button
                        type="button"
                        className="octopus-pipeline-status__retry"
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          void retryFile(file.id)
                        }}
                      >
                        重试
                      </button>
                      <button
                        type="button"
                        className="octopus-pipeline-status__error"
                        aria-label="查看失败原因"
                        aria-expanded={expandedErrorId === file.id}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          setExpandedErrorId((current) => current === file.id ? null : file.id)
                        }}
                      >!
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
              {activeFolderType === 'courseware' ? <PipelineStageProgress file={file} /> : null}
              {activeFolderType === 'courseware' && expandedErrorId === file.id && isPipelineFailure(file.pipelineStatus) ? (
                <p className="octopus-pipeline-error-detail">{file.pipelineError || '未返回具体错误，请重试或检查 API 配置。'}</p>
              ) : null}
            </div>
            <div className="octopus-file-card__meta">
              <span>{/\.(png|jpe?g|webp)$/i.test(file.fileName) ? '图片课件' : 'PDF'}</span>
              <span>{formatFileDate(file.updatedAt)}</span>
            </div>
          </Link>
        )) : (
          <div className="octopus-empty-card">
            <strong>{getLibraryFolderName(activeFolderType)} 里还没有文件</strong>
            <p>可以直接拖入 PDF 或图片，文件会保存到当前文件夹。</p>
          </div>
        )}
      </section>
    )
  } else if (files.length || activeCourse) {
    content = (
      <>
        <section className="octopus-file-grid">
          {(activeFolderType ? activeFolderFiles : []).map((file) => (
            <Link
              key={file.id}
              to={activeCourse ? `/pdf?file=${file.id}&course=${activeCourse.id}` : `/pdf?file=${file.id}`}
              className="octopus-file-card"
            >
              <button
                type="button"
                className="octopus-card-close"
                aria-label={`删除讲义 ${file.fileName}`}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  void handleDeleteFile(file.id, file.fileName)
                }}
              >
                x
              </button>
              <div className="octopus-file-card__preview">
                <div className="octopus-file-card__sheet">
                  <div className="octopus-file-card__band" />
                  <div className="octopus-file-card__line" />
                  <div className="octopus-file-card__line octopus-file-card__line--short" />
                </div>
              </div>
              <div className="octopus-file-card__content">
                <strong>{file.fileName}</strong>
                <p>
                  {file.annotations.length} 条疑点 · {file.pageCount} 页
                </p>
                {file.pipelineStatus ? (
                  <div className={`octopus-pipeline-status${isPipelineFailure(file.pipelineStatus) ? ' octopus-pipeline-status--failed' : ''}`}>
                    <span>{formatPipelineStatus(file.pipelineStatus)}</span>
                    {isPipelineFailure(file.pipelineStatus) ? (
                      <>
                        <button
                          type="button"
                          className="octopus-pipeline-status__retry"
                          onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            void retryFile(file.id)
                          }}
                        >
                          重试
                        </button>
                        <button
                          type="button"
                          className="octopus-pipeline-status__error"
                          aria-label="查看失败原因"
                          aria-expanded={expandedErrorId === file.id}
                          onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            setExpandedErrorId((current) => current === file.id ? null : file.id)
                          }}
                        >!
                        </button>
                      </>
                    ) : null}
                  </div>
                ) : null}
                <PipelineStageProgress file={file} />
                {expandedErrorId === file.id && isPipelineFailure(file.pipelineStatus) ? (
                  <p className="octopus-pipeline-error-detail">{file.pipelineError || '未返回具体错误，请重试或检查 API 配置。'}</p>
                ) : null}
              </div>
              <div className="octopus-file-card__meta">
                <span>PDF</span>
                <span>{formatFileDate(file.updatedAt)}</span>
              </div>
            </Link>
          ))}
        </section>

        <section className="octopus-file-grid">
          {(['courseware', 'other', 'homework', 'past-exam'] as const).map((folderType) => (
            <FolderCard
              key={folderType}
              courseId={activeCourse.id}
              folderType={folderType}
              count={folderType === 'homework' || folderType === 'past-exam'
                ? getKnowledgeHomeworkDocumentsByCourseFolder(activeCourse.id, folderType).length
                : files.filter((file) => (file.libraryFolder ?? 'courseware') === folderType).length}
            />
          ))}
        </section>
      </>
    )
  } else {
    content = (
      <section className="octopus-empty-card">
        <strong>当前课程里还没有讲义</strong>
        <p>先在 PDF 阅读器里上传讲义，或者直接从网络学堂下载课件。</p>
      </section>
    )
  }

  return (
    <main
      className={`octopus-library-shell${isDraggingPdf ? ' octopus-library-shell--dragging' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        setIsDraggingPdf(true)
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setIsDraggingPdf(false)
      }}
      onDrop={handleDrop}
    >
      <section className="octopus-library-toolbar octopus-library-toolbar--compact">
        <div className="octopus-breadcrumb">
          <Link to="/">课程知识库</Link>
          <span>/</span>
          <strong>{activeCourse ? getKnowledgeCourseDisplayName(activeCourse) : '未选择课程'}</strong>
          {activeFolderType ? (
            <>
              <span>/</span>
              <strong>{getLibraryFolderName(activeFolderType)}</strong>
            </>
          ) : null}
        </div>
        <div className="octopus-library-toolbar__actions">
          {activeFolderType ? (
            <Link
              to={`/library?course=${activeCourse.id}`}
              className="ghost-button octopus-ghost-button--link"
            >
              返回课程
            </Link>
          ) : null}
          {activeCourse && !activeFolderType ? (
            <div className="octopus-courseware-picker">
              <button
                type="button"
                className="ghost-button octopus-ghost-button--link"
                onClick={handleOpenCoursewarePicker}
                disabled={syncBusy}
                aria-expanded={isCoursewarePickerOpen}
                aria-controls="courseware-download-picker"
              >
                {syncBusy ? '正在读取课件…' : '下载课件'}
              </button>
              {isCoursewarePickerOpen ? (
                <section
                  id="courseware-download-picker"
                  className="octopus-courseware-picker__panel"
                  aria-label="选择要下载的课件"
                >
                  <div className="octopus-courseware-picker__head">
                    <div>
                      <strong>选择课件</strong>
                      <p>仅显示当前课程尚未保存的课件。</p>
                    </div>
                    <button
                      type="button"
                      className="octopus-courseware-picker__close"
                      onClick={() => setIsCoursewarePickerOpen(false)}
                      aria-label="关闭课件列表"
                    >
                      ×
                    </button>
                  </div>
                  <div className="octopus-courseware-picker__tools">
                    <button
                      type="button"
                      onClick={toggleSelectAllCourseware}
                      disabled={!coursewarePickerFiles.some(isProcessableCourseware)}
                    >
                      {coursewarePickerFiles.filter(isProcessableCourseware).length > 0 &&
                      coursewarePickerFiles.filter(isProcessableCourseware).every((file) => selectedCoursewareIds.has(file.id))
                        ? '取消全选'
                        : '一键全选'}
                    </button>
                    <span>{coursewarePickerFiles.filter(isProcessableCourseware).length} 份可处理</span>
                  </div>
                  <div className="octopus-courseware-picker__list">
                    {coursewarePickerFiles.length ? coursewarePickerFiles.map((file) => {
                      const supported = isProcessableCourseware(file)
                      const content = (
                        <>
                          {supported ? (
                            <input
                              type="checkbox"
                              checked={selectedCoursewareIds.has(file.id)}
                              onChange={() => toggleCoursewareSelection(file.id)}
                            />
                          ) : <span className="octopus-courseware-picker__checkbox-placeholder" aria-hidden="true" />}
                          <span className="octopus-courseware-picker__item-copy">
                            <strong>{file.displayName || file.fileName}</strong>
                            <small>
                              {[formatCoursewareKind(file), formatCoursewareSize(file.byteSize)]
                                .filter(Boolean)
                                .join(' · ')}
                            </small>
                          </span>
                          {supported && file.wasDeleted ? <em>已删除，可重新下载</em> : null}
                          {!supported ? <em className="octopus-courseware-picker__unsupported">暂不支持处理</em> : null}
                        </>
                      )
                      return supported ? (
                        <label key={file.id} className="octopus-courseware-picker__item">
                          {content}
                        </label>
                      ) : (
                        <div key={file.id} className="octopus-courseware-picker__item is-unsupported" aria-disabled="true">
                          {content}
                        </div>
                      )
                    }) : (
                      <p className="octopus-courseware-picker__empty">当前课程没有未下载的课件。</p>
                    )}
                  </div>
                  <div className="octopus-courseware-picker__footer">
                    <span>已选 {coursewarePickerFiles.filter((file) => isProcessableCourseware(file) && selectedCoursewareIds.has(file.id)).length} 份</span>
                    <button
                      type="button"
                      className="octopus-primary-button"
                      disabled={!coursewarePickerFiles.some((file) => isProcessableCourseware(file) && selectedCoursewareIds.has(file.id)) || syncBusy}
                      onClick={handleDownloadSelectedCourseware}
                    >
                      下载所选课件
                    </button>
                  </div>
                </section>
              ) : null}
            </div>
          ) : null}
          <input
            ref={uploadInputRef}
            type="file"
            accept={MINERU_UPLOAD_ACCEPT}
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void uploadFile(file)
            }}
          />
          <button
            type="button"
            className="octopus-primary-button"
            disabled={!activeCourse}
            onClick={() => uploadInputRef.current?.click()}
          >
            {isHomeworkFolder ? '上传题目' : activeFolderType === 'other' ? '上传文件' : '上传课件'}
          </button>
        </div>
      </section>

      {activeCourse && (
        activeFolderType === 'courseware' ||
        activeFolderType === 'homework' ||
        activeFolderType === 'past-exam'
      ) ? (
        <button
          type="button"
          className={`octopus-upload-dropzone${isDraggingPdf ? ' is-dragging' : ''}`}
          aria-label={`上传${getLibraryFolderName(activeFolderType)}`}
          onClick={() => uploadInputRef.current?.click()}
        >
          <span className="octopus-upload-dropzone__glyph" aria-hidden="true">
            <i />
          </span>
          <span className="octopus-upload-dropzone__copy">
            <strong>拖拽 PDF 或图片到这里</strong>
            <small>
              {isHomeworkFolder
                ? '图片将保留原图并自动识别、切分题目'
                : '图片会转换为单页课件并自动建立索引'}
            </small>
          </span>
          <span className="octopus-upload-dropzone__formats">PDF · PNG · JPG · WebP</span>
        </button>
      ) : null}

      {activeCourse && !activeFolderType ? (
        <button
          type="button"
          className="octopus-course-settings-trigger"
          onClick={() => void openCourseSettings()}
          aria-label="编辑课程信息"
          title="编辑课程信息"
        >
          &#9881;
        </button>
      ) : null}

      {isCourseSettingsOpen && activeCourse ? (
        <div
          className="octopus-course-settings-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !courseSettingsBusy) {
              setIsCourseSettingsOpen(false)
            }
          }}
        >
          <section
            className="octopus-course-settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="course-settings-title"
          >
            <header className="octopus-course-settings-dialog__head">
              <div>
                <span>COURSE SETTINGS</span>
                <h2 id="course-settings-title">编辑课程信息</h2>
              </div>
              <button
                type="button"
                onClick={() => setIsCourseSettingsOpen(false)}
                disabled={courseSettingsBusy}
                aria-label="关闭课程设置"
              >
                x
              </button>
            </header>

            <p className="octopus-course-settings-dialog__intro">
              显示名称只用于本项目展示；关联后会保存网络学堂的真实课程名称和课程标识，用于后续自动拉取课件。
            </p>

            <label className="octopus-course-settings-field">
              <span>课程显示名称</span>
              <input
                value={courseSettingsDisplayName}
                onChange={(event) => setCourseSettingsDisplayName(event.target.value)}
                placeholder="例如：程序设计实训"
                disabled={courseSettingsBusy}
              />
            </label>

            <label className="octopus-course-settings-field">
              <span>所属学期</span>
              <select
                value={courseSettingsSemesterId}
                onChange={(event) => handleCourseSettingsSemesterChange(event.target.value)}
                disabled={courseSettingsBusy}
              >
                <option value="">不关联网络学堂</option>
                {courseSettingsSemesters.map((semester) => (
                  <option key={semester.semesterId} value={semester.semesterId}>
                    {semester.semesterName}{semester.isCurrent ? '（当前）' : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className="octopus-course-settings-field">
              <span>课程关联</span>
              <select
                value={courseSettingsAssociationId}
                onChange={(event) => setCourseSettingsAssociationId(event.target.value)}
                disabled={courseSettingsBusy || !courseSettingsSemesterId}
              >
                <option value="">
                  {courseSettingsSemesterId
                    ? (courseSettingsCandidates.length ? '请选择网络学堂课程' : '正在读取该学期课程…')
                    : '请先选择学期'}
                </option>
                {courseSettingsCandidates.map((course) => (
                  <option key={course.wlkcid || `${course.name}:${course.href}`} value={course.wlkcid || ''}>
                    {course.name}
                  </option>
                ))}
              </select>
            </label>

            {courseSettingsSemesterId && courseSettingsAssociationId ? (
              <p className="octopus-course-settings-dialog__hint">
                同一网络学堂课程只能关联一个本地课程文件夹，保存时会再次校验。
              </p>
            ) : null}
            {courseSettingsError ? <p className="octopus-course-settings-dialog__error" role="alert">{courseSettingsError}</p> : null}

            <footer className="octopus-course-settings-dialog__footer">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setIsCourseSettingsOpen(false)}
                disabled={courseSettingsBusy}
              >
                取消
              </button>
              <button
                type="button"
                className="octopus-primary-button"
                onClick={() => void saveCourseSettings()}
                disabled={courseSettingsBusy}
              >
                {courseSettingsBusy ? '处理中…' : '保存设置'}
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {syncMessage ? (
        <p className="octopus-sync-card__message" role="status" aria-live="polite">
          {syncMessage}
        </p>
      ) : null}

      {uploadError ? <p className="octopus-upload-error" role="alert">{uploadError}</p> : null}

      {content}
    </main>
  )
}
