from __future__ import annotations

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from functools import partial
from .adaptive_testing import (
  configure_adaptive_testing,
  queue_related_assessment_preparations,
  resume_assessment_preparations,
)
from .chat_retrieval import ChatContextRetriever
from .document_pipeline import DocumentPipeline, QDRANT_COLLECTION, local_mineru_service
from .pipeline_orchestration import PipelineCoordinator
from .question_pipeline import QUESTION_COLLECTION, QuestionPipeline
from .question_relations import QuestionRelationPipeline


class ApplicationRuntime:
  """Owns process-scoped providers, workers, and application lifecycle."""

  def __init__(self) -> None:
    self.document_pipeline: DocumentPipeline | None = None
    self.question_pipeline: QuestionPipeline | None = None
    self.question_relations: QuestionRelationPipeline | None = None
    self.chat_retriever: ChatContextRetriever | None = None
    self.pipeline_coordinator: PipelineCoordinator | None = None
    self._pipeline_executor: ThreadPoolExecutor | None = None
    self._relation_executor: ThreadPoolExecutor | None = None
    self._question_resume_lock = threading.Lock()
    self._question_resume_running = False
    self._question_resume_task: asyncio.Task | None = None

  def require_document_pipeline(self) -> DocumentPipeline:
    if self.document_pipeline is None:
      raise RuntimeError('Document pipeline is not initialized.')
    return self.document_pipeline

  def require_question_pipeline(self) -> QuestionPipeline:
    if self.question_pipeline is None:
      raise RuntimeError('Question pipeline is not initialized.')
    return self.question_pipeline

  def require_question_relations(self) -> QuestionRelationPipeline:
    if self.question_relations is None:
      raise RuntimeError('Question relation pipeline is not initialized.')
    return self.question_relations

  def require_chat_retriever(self) -> ChatContextRetriever:
    if self.chat_retriever is None:
      raise RuntimeError('Chat context retriever is not initialized.')
    return self.chat_retriever

  def require_pipeline_coordinator(self) -> PipelineCoordinator:
    if self.pipeline_coordinator is None:
      raise RuntimeError('Pipeline coordinator is not initialized.')
    return self.pipeline_coordinator

  def start(self) -> None:
    if self.document_pipeline is not None:
      return
    self._pipeline_executor = ThreadPoolExecutor(
      max_workers=1,
      thread_name_prefix='document-pipeline',
    )
    self._relation_executor = ThreadPoolExecutor(
      max_workers=1,
      thread_name_prefix='question-relations',
    )
    documents = DocumentPipeline()
    questions = QuestionPipeline(
      parser=documents.parser,
      embedding=documents.embedding,
      vector_store=documents.vector_store,
    )
    relations = QuestionRelationPipeline(
      embedding=documents.embedding,
      vector_store=documents.vector_store,
    )
    self.document_pipeline = documents
    self.question_pipeline = questions
    self.question_relations = relations
    configure_adaptive_testing(relations.query)
    self.chat_retriever = ChatContextRetriever(
      embedding=documents.embedding,
      vector_store=documents.vector_store,
      reranker=relations.reranker,
    )
    self.pipeline_coordinator = PipelineCoordinator(
      documents=documents,
      questions=questions,
      relations=relations,
      relation_executor=self._relation_executor,
      queue_assessments=queue_related_assessment_preparations,
      resume_assessments=resume_assessment_preparations,
    )
    try:
      relations.rebuild_lecture_document_indexes()
    except Exception as exc:
      print(f'Lecture relation index repair deferred: {exc}')
    try:
      documents.vector_store.migrate_legacy_collections(
        [QDRANT_COLLECTION, QUESTION_COLLECTION]
      )
    except Exception as exc:
      print(f'Legacy Qdrant partition migration deferred: {exc}')
    local_mineru_service.start()

  async def run_pipeline_task(self, function, *args, **kwargs):
    if self._pipeline_executor is None:
      raise RuntimeError('Application runtime is not initialized.')
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
      self._pipeline_executor,
      partial(function, *args, **kwargs),
    )

  def resume_question_pipeline_once(self) -> int:
    with self._question_resume_lock:
      if self._question_resume_running:
        return 0
      self._question_resume_running = True
    try:
      return self.require_question_pipeline().resume_pending()
    finally:
      with self._question_resume_lock:
        self._question_resume_running = False

  def schedule_question_pipeline_resume(self) -> asyncio.Task:
    if self._question_resume_task is None or self._question_resume_task.done():
      self._question_resume_task = asyncio.create_task(
        self.run_pipeline_task(self.resume_question_pipeline_once)
      )
    return self._question_resume_task

  async def stop(self, resume_tasks: list[asyncio.Task] | None = None) -> None:
    # Cancelling an asyncio wrapper does not stop work already running in its
    # thread. Drain workers before releasing their shared Qdrant/MinerU clients.
    if resume_tasks:
      await asyncio.gather(*resume_tasks, return_exceptions=True)
    if (
      self._question_resume_task
      and self._question_resume_task not in (resume_tasks or [])
      and not self._question_resume_task.done()
    ):
      await asyncio.gather(self._question_resume_task, return_exceptions=True)
    self._question_resume_task = None
    for executor in (self._relation_executor, self._pipeline_executor):
      if executor is not None:
        executor.shutdown(wait=True, cancel_futures=True)
    self._relation_executor = None
    self._pipeline_executor = None
    configure_adaptive_testing(None)
    if self.document_pipeline is not None:
      self.document_pipeline.close()
    self.document_pipeline = None
    self.question_pipeline = None
    self.question_relations = None
    self.chat_retriever = None
    self.pipeline_coordinator = None
    local_mineru_service.stop()

  @asynccontextmanager
  async def lifespan(self, _app):
    self.start()
    coordinator = self.require_pipeline_coordinator()
    resume_tasks = [
      asyncio.create_task(
        self.run_pipeline_task(self.require_document_pipeline().resume_pending)
      ),
      self.schedule_question_pipeline_resume(),
    ]
    coordinator.queue_missing_question_relation_refreshes()
    coordinator.queue_assessment_preparation_resume()
    try:
      yield
    finally:
      await self.stop(resume_tasks)
