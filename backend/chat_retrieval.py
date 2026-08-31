from __future__ import annotations

from typing import Any, Protocol

from fastapi import HTTPException
from pydantic import BaseModel, Field, ValidationError

from .document_pipeline import (
  QDRANT_COLLECTION,
  ApiEmbeddingProvider,
  QdrantVectorStore,
)
from .question_pipeline import QUESTION_COLLECTION
from .question_relations import ApiReranker
from .provider_transport import ProviderTransportError, StructuredChatClient
from .runtime_config import load_api_config


MAX_REWRITE_MESSAGES = 4
MAX_REWRITE_MESSAGE_CHARS = 4000
MAX_REWRITE_QUERY_CHARS = 2000


class StandaloneQueryPayload(BaseModel):
  query: str = Field(min_length=1, max_length=MAX_REWRITE_QUERY_CHARS)


class QueryRewriter(Protocol):
  def rewrite(
    self,
    question: str,
    recent_messages: list[dict[str, Any]],
  ) -> tuple[str, str, str | None]: ...


class StandaloneQueryRewriter:
  """Resolve follow-up references before embedding without changing the answer question."""

  def __init__(self, chat_client: StructuredChatClient | None = None) -> None:
    self.chat_client = chat_client or StructuredChatClient()

  @staticmethod
  def _recent_messages(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    normalized: list[dict[str, str]] = []
    for message in messages[-MAX_REWRITE_MESSAGES:]:
      if not isinstance(message, dict):
        continue
      role = str(message.get('role') or '').strip()
      content = str(message.get('content') or '').strip()
      if role not in {'user', 'assistant'} or not content:
        continue
      normalized.append({
        'role': role,
        'content': content[:MAX_REWRITE_MESSAGE_CHARS],
      })
    return normalized

  @staticmethod
  def _response_payload(payload: dict[str, Any]) -> StandaloneQueryPayload:
    return StandaloneQueryPayload.model_validate(payload)

  def rewrite(
    self,
    question: str,
    recent_messages: list[dict[str, Any]],
  ) -> tuple[str, str, str | None]:
    original = str(question or '').strip()
    messages = self._recent_messages(recent_messages)
    # A welcome message alone provides no antecedent and does not justify another model call.
    if not original or not any(message['role'] == 'user' for message in messages):
      return original, 'original', None

    try:
      config = load_api_config() or {}
      base_url = str(config.get('baseUrl') or '').strip()
      api_key = str(config.get('apiKey') or '').strip()
      model = str(config.get('model') or '').strip()
      if not base_url or not api_key or not model:
        return original, 'fallback', 'Text model configuration is unavailable for query rewrite.'

      schema = StandaloneQueryPayload.model_json_schema()
      provider_payload = self.chat_client.complete_json(
        base_url=base_url,
        api_key=api_key,
        model=model,
        schema=schema,
        schema_name='standalone_retrieval_query',
        timeout=15,
        temperature=0,
        extra_payload={'max_tokens': 512},
        messages=[
          {
            'role': 'system',
            'content': (
              'Rewrite the latest user question as one concise, self-contained retrieval query. '
              'Resolve words such as this, that, here, it, or omitted subjects only from the recent '
              'conversation. Preserve formulas, symbols, constraints, and the user intent. Do not '
              'answer the question and do not add facts. If it is already standalone, return it '
              'unchanged. Return only an object that matches the JSON Schema.'
            ),
          },
          {
            'role': 'user',
            'content': json.dumps({
              'recent_conversation': messages,
              'latest_question': original,
            }, ensure_ascii=False),
          },
        ],
      )
      rewritten = self._response_payload(provider_payload).query.strip()
      return rewritten or original, 'text-model', None
    except (ProviderTransportError, TypeError, ValueError, ValidationError) as exc:
      return original, 'fallback', f'{type(exc).__name__}: {exc}'
    except Exception as exc:  # noqa: BLE001 - query rewriting must never break retrieval.
      return original, 'fallback', f'{type(exc).__name__}: {exc}'


class ChatContextRetriever:
  """Retrieve and rerank the small set of course fragments used by chat."""

  def __init__(
    self,
    *,
    embedding: ApiEmbeddingProvider,
    vector_store: QdrantVectorStore,
    reranker: ApiReranker,
    query_rewriter: QueryRewriter | None = None,
  ) -> None:
    self.embedding = embedding
    self.vector_store = vector_store
    self.reranker = reranker
    self.query_rewriter = query_rewriter or StandaloneQueryRewriter()

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
    recent_messages: list[dict[str, Any]] | None = None,
  ) -> dict[str, Any]:
    normalized_query = str(query or '').strip()
    normalized_course_id = str(course_id or '').strip()
    normalized_document_id = str(document_id or '').strip()
    normalized_document_type = str(document_type or '').strip()
    if not normalized_query:
      raise HTTPException(status_code=422, detail='query is required.')
    if not normalized_course_id:
      raise HTTPException(status_code=422, detail='course_id is required.')

    retrieval_query, rewrite_source, rewrite_error = self.query_rewriter.rewrite(
      normalized_query,
      recent_messages or [],
    )
    retrieval_query = str(retrieval_query or '').strip() or normalized_query
    candidate_limit = max(1, min(int(top_n), 50))
    result_limit = max(1, min(int(top_k), candidate_limit))
    query_vector = self.embedding.embed([retrieval_query])[0]
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
      retrieval_query,
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
      'retrieval_query': retrieval_query,
      'rewrite_source': rewrite_source,
      'rewrite_error': rewrite_error,
    }
