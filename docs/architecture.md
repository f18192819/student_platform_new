# Architecture Boundaries

This project is a local-first course learning service. New functionality must
extend a feature boundary rather than adding business logic directly to
`app.py`.

## Runtime Layers

- `src/features/*`: feature-owned React UI and state; shared rendering belongs
  in `src/lib/*` only when it is used by more than one feature.
- `app.py`: FastAPI composition, lifecycle hooks, and thin HTTP adapters. It
  may validate request data and schedule work, but it must not own persistence
  formats or provider-specific workflows.
- `backend/document_pipeline.py`: local MinerU parsing, page/chunk generation,
  embedding, and Qdrant writes for course material.
- `backend/question_pipeline.py`: question extraction and structured question
  analysis.
- `backend/question_relations.py`: retrieval and persisted relations between
  questions and course material.
- `backend/knowledge_storage.py`: course-scoped durable files and SQLite data.
- `backend/tsinghua_*.py`: external course synchronization only.

## Extension Rules

### Audio Processing

Keep audio ingestion, transcription, segmentation, and lecture mapping inside
an audio-specific backend module. HTTP endpoints should call that module and
return stable DTOs. Audio artifacts must be stored under a course/document
scope and cleaned up through the same deletion path as their source document.

### Learning State

Implement learning state as a course-scoped persistence module. Store events
and derived progress separately: events are append-only facts, while progress
is a recalculable projection. References to a document page, chunk, question,
or audio timestamp must use stable IDs rather than UI indexes.

### Providers and Storage

Provider contracts stay behind the existing document interfaces:
`DocumentParser`, `EmbeddingProvider`, and `VectorStore`. A new provider must
be injected through configuration and must not be called from React code.
Course data is isolated by course storage roots; cross-course operations must
be explicit and use a course ID filter.

## Deletion and Retries

Every feature that creates derived data must expose two operations:

1. Retry only the failed stage, preserving successful prior stages.
2. Delete the source and all derived storage, vectors, relations, and future
   feature artifacts associated with its stable document ID.

## Current Compatibility Policy

The active PDF route is `/api/documents/process` backed by local MinerU.
The retired cloud MinerU route is intentionally absent. Avoid adding a second
parser path; add behavior to `DocumentPipeline` or a provider implementation
instead.
