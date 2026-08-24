from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from .document_pipeline import (
  QDRANT_COLLECTION,
  ApiEmbeddingProvider,
  QdrantVectorStore,
)
from .question_pipeline import QUESTION_COLLECTION
from .question_relations import ApiReranker


class ChatContextRetriever:
  """Retrieve and rerank the small set of course fragments used by chat."""

  def __init__(
    self,
    *,
    embedding: ApiEmbeddingProvider,
    vector_store: QdrantVectorStore,
    reranker: ApiReranker,
  ) -> None:
    self.embedding = embedding
    self.vector_store = vector_store
    self.reranker = reranker

  @staticmethod
  def _collections(document_type: str) -> list[str]:
    if document_type == 'lecture':
      return [QDRANT_COLLECTION]
    if document_type in {'homework', 'past-exam', 'exercise-set'}:
      return [QUESTION_COLLECTION]
    return [QDRANT_COLLECTION, QUESTION_COLLECTION]

  def retrieve(
    self,
    *,
    query: str,
    course_id: str,
    document_id: str = '',
    document_type: str = '',
    top_n: int = 20,
    top_k: int = 6,
  ) -> dict[str, Any]:
    normalized_query = str(query or '').strip()
    normalized_course_id = str(course_id or '').strip()
    normalized_document_id = str(document_id or '').strip()
    normalized_document_type = str(document_type or '').strip()
    if not normalized_query:
      raise HTTPException(status_code=422, detail='query is required.')
    if not normalized_course_id:
      raise HTTPException(status_code=422, detail='course_id is required.')

    candidate_limit = max(1, min(int(top_n), 50))
    result_limit = max(1, min(int(top_k), candidate_limit))
    query_vector = self.embedding.embed([normalized_query])[0]
    filters = {
      'course_id': normalized_course_id,
      'document_id': normalized_document_id,
      'document_type': normalized_document_type,
    }

    candidates: list[dict[str, Any]] = []
    for collection_name in self._collections(normalized_document_type):
      found = self.vector_store.search(
        query_vector,
        candidate_limit,
        filters,
        collection_name=collection_name,
      )
      for item in found:
        payload = item.get('payload') if isinstance(item.get('payload'), dict) else {}
        content = str(payload.get('content') or '').strip()
        if not content:
          continue
        vector_score = float(item.get('score') or 0.0)
        candidates.append(
          payload | {
            'content': content,
            'vector_score': vector_score,
            'retrieval_collection': collection_name,
          }
        )

    candidates.sort(key=lambda item: float(item.get('vector_score') or 0.0), reverse=True)
    candidates = candidates[:candidate_limit]
    reranked, source, error = self.reranker.rerank(
      normalized_query,
      candidates,
      result_limit,
      batch_size=max(1, len(candidates)),
      max_text_chars=4000,
    )
    results = [
      item | {
        'score': float(item.get('rerank_score', item.get('vector_score', 0.0))),
      }
      for item in reranked
    ]
    return {
      'results': results,
      'candidate_count': len(candidates),
      'rerank_source': source,
      'rerank_error': error,
    }
