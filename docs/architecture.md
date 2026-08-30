# Architecture Boundaries

This project is a local-first course learning service. New functionality must
extend a feature boundary rather than adding business logic directly to
`app.py`.

## Runtime Layers

- `src/features/*`: feature-owned React UI and state; shared rendering belongs
  in `src/lib/*` only when it is used by more than one feature.
- `app.py`: composition root only. It creates the process runtime, registers
  feature routers, and attaches the application lifespan.
- `backend/application_runtime.py`: process-scoped provider assembly, MinerU
  lifecycle, worker ownership, and deterministic shutdown.
- `backend/pipeline_router.py`: stable HTTP DTOs plus the document/question
  `PipelineApiService`; existing pipeline and relation API paths live here.
- `backend/knowledge_router.py`: knowledge-library and asset HTTP DTOs plus the
  deletion application service that coordinates tombstones and derived data.
- `backend/media_router.py`: isolated compatibility boundary for the existing
  ASR, classroom-alignment, recording, and Office conversion implementation.
- `backend/pipeline_orchestration.py`: application-level document/question
  processing and deletion orchestration. It depends on pipeline protocols,
  not FastAPI.
- `backend/document_pipeline.py`: local MinerU parsing, page/chunk generation,
  embedding, and Qdrant writes for course material.
- `backend/question_pipeline.py`: question extraction and structured question
  analysis.
- `backend/question_relations.py`: relation construction and projection writes.
- `backend/question_relation_query.py`: stable read-only relation interface used
  by Adaptive Test and reader features.
- `backend/learning_state.py`: physical course-partitioned SQLite implementation.
- `backend/learning_repositories.py`: narrow session/event/progress repository
  interfaces over the same compatible SQLite files.
- `backend/adaptive_testing.py`: HTTP DTO compatibility and test-session workflow.
- `backend/adaptive_candidates.py`, `adaptive_selection.py`,
  `adaptive_grading.py`, and `adaptive_results.py`: replaceable candidate,
  selection, grading, and result policies.
- `backend/assessment_planner.py`: persisted per-question answer contracts for
  choice, numeric, and short-text assessment parts. Private answer keys never
  cross the backend boundary.
- `backend/knowledge_storage.py`: course-scoped durable files and SQLite data.
- `backend/tsinghua_*.py`: external course synchronization only.

## Dependency Direction

Before this refactor, `app.py` constructed and coordinated concrete pipelines,
Adaptive Test queried the relation builder directly, and question parsing
imported private document helpers. Page components also owned long-running
polling loops.

The progressive target now in use is:

```text
Router / React Page
  -> Application service / feature hook
  -> Protocol or stable public facade
  -> SQLite, Qdrant, MinerU, LLM, requests
```

Adaptive Test depends on `QuestionRelationQuery`, not relation construction.
Question parsing uses public document artifact functions. React pages compose
`useRelatedMaterials` and `useKnowledgePipelinePolling`; both own cancellation
and cleanup for their requests and timers.

Application routes do not construct SQLite, Qdrant, MinerU, or LLM clients.
They obtain process-owned services from `ApplicationRuntime`; pipeline stage
coordination and deletion cascades are implemented outside FastAPI handlers.

## Compatibility Facades

The public API paths and persisted schemas remain unchanged. `knowledgeBase.ts`,
`ai.ts`, and `pdf.ts` remain import-compatible facades while their feature-owned
implementations move behind them. Existing private document helper names remain
temporarily available inside `document_pipeline.py`, but cross-module callers
must use `safe_storage_name`, `read_json_file`, `write_json_atomic`,
`archive_parser_result`, and `extract_middle_layout_blocks`.

## Extension Rules

### Audio Processing

Keep audio ingestion, transcription, segmentation, and lecture mapping inside
an audio-specific backend module. HTTP endpoints should call that module and
return stable DTOs. Audio artifacts must be stored under a course/document
scope and cleaned up through the same deletion path as their source document.

`media_router.py` intentionally preserves the existing algorithms as one
compatibility unit. New media behavior should be added behind explicit ASR,
alignment, or recording service interfaces rather than extending that module's
HTTP handlers with additional provider logic.

### Learning State

Implement learning state as a course-scoped persistence module. Store events
and derived progress separately: events are append-only facts, while progress
is a recalculable projection. References to a document page, chunk, question,
or audio timestamp must use stable IDs rather than UI indexes.

Adaptive mastery tests keep the source `question_id`; they do not copy or
generate questions. Subjective grading may use the configured text provider,
but the grader only returns evidence (`score`, `correct`, and confidence).
Mastery and test sequencing remain deterministic application code. Lecture
page recommendations must come from persisted `question_to_lecture_page`
relations so a missing relation produces no page rather than an invented one.

Learning-state SQLite files live below
`.runtime/learning-state/courses/<course>/learning-state.sqlite3`. Each course
has a separate physical database. `learning_events` is append-only during
normal operation; deletion cascades may remove rows when their source course,
lecture, or question document is explicitly deleted.
Answer edits append a new `LearningEvent` revision that points to the event it
supersedes. Adaptive selection and mastery projections use only the latest
revision for each session/question pair, while the full answer history remains
available for audit and future learning-state recalculation.
Assessment specs and shuffled choice options are generated once per source
question fingerprint and stored in the same course SQLite database. Choice and
numeric parts are graded deterministically; only short-text parts may call the
configured text model. A mixed-part submission still produces one learning
event so it contributes one unit of evidence to mastery projection.
When a real source question has no reference answer, or its answer omits a
required subtask, the assessment planner may generate a complete structured
reference answer with the configured text model. These answers live in
`question_reference_answers`, retain their model, confidence, and review
status, and are never exposed before the student submits an answer. A user
correction replaces this answer projection, invalidates the cached assessment
spec, and requires a new answer revision; it does not rewrite prior
`LearningEvent` evidence.

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

## Remaining Technical Debt

- The isolated media compatibility module is still large and mixes ASR,
  retrieval-assisted classroom mapping, recording storage, and Office
  conversion. Split it by those capabilities only when characterization tests
  exist for the real provider responses.
- `tsinghua_sync.py` still combines external-site adapters and sync workflows.
  Session ownership has moved to `tsinghua_sync_state.py`; subsequent changes
  should extract request adapters without changing the public router paths.
- `knowledgeBase.ts` and `ai.ts` remain intentionally broad compatibility
  facades. New stateful frontend behavior belongs in feature hooks/controllers,
  while callers can continue importing the facade during gradual migration.

