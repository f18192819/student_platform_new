from __future__ import annotations

import hashlib
import json
import re
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Literal

import requests
from pydantic import BaseModel, Field, ValidationError

from .config import PROJECT_ROOT
from .runtime_config import load_api_config


AUDIO_ALIGNMENT_ROOT = PROJECT_ROOT / '.runtime' / 'audio-alignment'
AlignmentCaller = Callable[[dict[str, Any]], dict[str, Any]]


class LectureRecording(BaseModel):
  id: str
  course_id: str
  document_id: str
  audio_path: str
  duration: float = Field(ge=0)


class TranscriptSegment(BaseModel):
  id: str
  recording_id: str
  start_time: float = Field(ge=0)
  end_time: float = Field(ge=0)
  text: str


class TranscriptWindow(BaseModel):
  id: str
  recording_id: str
  start_time: float = Field(ge=0)
  end_time: float = Field(ge=0)
  text: str
  segment_ids: list[str]


class AudioPageAlignment(BaseModel):
  start_time: float = Field(ge=0)
  end_time: float = Field(ge=0)
  primary_page_id: str | None = None
  referenced_page_ids: list[str] = Field(default_factory=list)
  confidence: float = Field(ge=0, le=1)
  alignment_type: Literal['direct', 'transition', 'reference', 'off_slide', 'uncertain']
  reason: str


class PageAudioRelation(BaseModel):
  id: str
  course_id: str
  recording_id: str
  document_id: str
  page_id: str
  start_time: float = Field(ge=0)
  end_time: float = Field(ge=0)
  confidence: float = Field(ge=0, le=1)
  alignment_type: Literal['direct', 'transition', 'reference']
  source: str = 'ai_sequential_alignment'


class PageTranscript(BaseModel):
  """A timestamped source-text excerpt that the existing PDF reader can render per page."""

  page_id: str
  page_number: int = Field(ge=1)
  title: str = ''
  start_time: float = Field(ge=0)
  end_time: float = Field(ge=0)
  text: str
  segment_ids: list[str]
  confidence: float = Field(ge=0, le=1)
  alignment_type: Literal['direct', 'transition', 'reference']


def _course_key(course_id: str) -> str:
  value = str(course_id).strip()
  if not value:
    raise ValueError('course_id is required.')
  safe = re.sub(r'[^A-Za-z0-9._-]+', '-', value).strip('.-') or 'course'
  return f'{safe}-{hashlib.sha256(value.encode()).hexdigest()[:12]}'


class AudioAlignmentStore:
  """Course-scoped JSON persistence; unrelated to Qdrant and vector retrieval."""

  def _path(self, course_id: str, recording_id: str) -> Path:
    return AUDIO_ALIGNMENT_ROOT / 'courses' / _course_key(course_id) / f'{recording_id}.json'

  def save(self, recording: LectureRecording, segments: list[TranscriptSegment], payload: dict[str, Any]) -> None:
    path = self._path(recording.course_id, recording.id)
    path.parent.mkdir(parents=True, exist_ok=True)
    value = {'recording': recording.model_dump(), 'transcript_segments': [item.model_dump() for item in segments]} | payload
    temporary = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)

  def read(self, course_id: str, recording_id: str) -> dict[str, Any]:
    path = self._path(course_id, recording_id)
    if not path.is_file():
      raise FileNotFoundError(f'Recording {recording_id} was not found.')
    value = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(value, dict):
      raise ValueError('Stored recording is invalid.')
    return value


def build_transcript_windows(
  segments: list[TranscriptSegment],
  *,
  minimum_seconds: float = 30,
  maximum_seconds: float = 120,
) -> list[TranscriptWindow]:
  ordered = sorted(segments, key=lambda item: (item.start_time, item.end_time))
  windows: list[TranscriptWindow] = []
  buffer: list[TranscriptSegment] = []

  def flush() -> None:
    if not buffer:
      return
    text = '\n'.join(item.text.strip() for item in buffer if item.text.strip()).strip()
    if text:
      windows.append(TranscriptWindow(
        id=f'{buffer[0].recording_id}:window:{len(windows) + 1}',
        recording_id=buffer[0].recording_id,
        start_time=buffer[0].start_time,
        end_time=buffer[-1].end_time,
        text=text,
        segment_ids=[item.id for item in buffer],
      ))
    buffer.clear()

  for segment in ordered:
    if segment.end_time < segment.start_time:
      raise ValueError(f'Transcript segment {segment.id} ends before it starts.')
    if buffer and segment.start_time - buffer[-1].end_time > 8:
      flush()
    buffer.append(segment)
    duration = buffer[-1].end_time - buffer[0].start_time
    complete = bool(re.search(r'[。！？!?]$', segment.text.strip()))
    if duration >= maximum_seconds or (duration >= minimum_seconds and complete):
      flush()
  flush()
  return windows


def merge_page_audio_relations(relations: list[PageAudioRelation]) -> list[PageAudioRelation]:
  merged: list[PageAudioRelation] = []
  for relation in sorted(relations, key=lambda item: (item.page_id, item.start_time, item.end_time)):
    if merged:
      previous = merged[-1]
      if (
        previous.page_id == relation.page_id
        and previous.recording_id == relation.recording_id
        and previous.alignment_type == relation.alignment_type
        and relation.start_time <= previous.end_time + 1
      ):
        merged[-1] = previous.model_copy(update={
          'end_time': max(previous.end_time, relation.end_time),
          'confidence': round((previous.confidence + relation.confidence) / 2, 4),
        })
        continue
    merged.append(relation)
  return merged


def build_page_transcripts(
  windows: list[TranscriptWindow],
  alignments: list[AudioPageAlignment],
  pages: list[dict[str, Any]],
) -> list[PageTranscript]:
  """Keep raw transcript windows visible as uninterrupted clips on primary pages."""
  page_lookup = {str(page.get('page_id') or ''): page for page in pages}
  records: list[PageTranscript] = []
  for window, alignment in zip(windows, alignments):
    if not alignment.primary_page_id or alignment.alignment_type not in {'direct', 'transition', 'reference'}:
      continue
    page = page_lookup.get(alignment.primary_page_id)
    if not page:
      continue
    page_number = int(page.get('page_number') or 0)
    if page_number <= 0 or not window.text.strip():
      continue
    current = PageTranscript(
      page_id=alignment.primary_page_id,
      page_number=page_number,
      title=str(page.get('title') or '').strip(),
      start_time=window.start_time,
      end_time=window.end_time,
      text=window.text.strip(),
      segment_ids=window.segment_ids,
      confidence=alignment.confidence,
      alignment_type=alignment.alignment_type,
    )
    previous = records[-1] if records else None
    if (
      previous
      and previous.page_id == current.page_id
      and current.start_time <= previous.end_time + 1
    ):
      # Adjacent ASR windows become one clip, but never span another page's audio.
      records[-1] = previous.model_copy(update={
        'end_time': max(previous.end_time, current.end_time),
        'text': f'{previous.text}\n{current.text}'.strip(),
        'segment_ids': list(dict.fromkeys([*previous.segment_ids, *current.segment_ids])),
        'confidence': round((previous.confidence + current.confidence) / 2, 4),
        'alignment_type': current.alignment_type,
      })
      continue
    records.append(current)
  return records


@dataclass
class SequentialPageAligner:
  caller: AlignmentCaller
  backward_pages: int = 2
  forward_pages: int = 6

  @classmethod
  def from_runtime_config(cls) -> 'SequentialPageAligner':
    config = load_api_config() or {}
    base_url = str(config.get('baseUrl') or '').rstrip('/')
    api_key = str(config.get('apiKey') or '')
    model = str(config.get('model') or '')
    if not (base_url and api_key and model):
      raise ValueError('Text model configuration is required for audio page alignment.')

    root = re.sub(r'/chat/completions$', '', base_url)

    def caller(payload: dict[str, Any]) -> dict[str, Any]:
      response = requests.post(
        f'{root}/chat/completions',
        headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
        json={'model': model, 'temperature': 0.1, 'response_format': {'type': 'json_object'}, 'messages': [
          {'role': 'system', 'content': (
            'You align a lecture transcript to an ordered PDF. Return JSON only. '
            'Prefer the current slide sequence; do not jump far for a passing reference. '
            'primary_page_id is the page currently explained, referenced_page_ids are only secondary references. '
            'Keep every primary-page time range uninterrupted: only keep the current page while its explanation '
            'continues, and switch primary_page_id at a genuine slide or topic transition. Never assign a later '
            'window back to a page if another primary page was explained in between. '
            'Use null primary_page_id for off-slide or uncertain content.'
          )},
          {'role': 'user', 'content': json.dumps(payload, ensure_ascii=False)},
        ]},
        timeout=120,
      )
      response.raise_for_status()
      content = str(((response.json().get('choices') or [{}])[0].get('message') or {}).get('content') or '')
      start, end = content.find('{'), content.rfind('}')
      return json.loads(content[start:end + 1])

    return cls(caller=caller)

  def align(
    self,
    recording: LectureRecording,
    windows: list[TranscriptWindow],
    pages: list[dict[str, Any]],
  ) -> tuple[list[AudioPageAlignment], list[PageAudioRelation]]:
    ordered_pages = sorted(pages, key=lambda item: int(item.get('page_number') or 0))
    if not ordered_pages:
      raise ValueError('The selected lecture has no DocumentPage records.')
    page_ids = {str(page.get('page_id') or '') for page in ordered_pages}
    cursor = 0
    previous_page_id: str | None = None
    alignments: list[AudioPageAlignment] = []
    relations: list[PageAudioRelation] = []

    for index, window in enumerate(windows):
      start = max(0, cursor - self.backward_pages)
      end = min(len(ordered_pages), cursor + self.forward_pages + 1)
      candidates = ordered_pages[start:end]
      payload = {
        'transcript_window': window.model_dump(),
        'previous_primary_page_id': previous_page_id,
        'next_window_preview': windows[index + 1].text[:800] if index + 1 < len(windows) else '',
        'candidate_pages': [{
          'page_id': page.get('page_id'),
          'page_number': page.get('page_number'),
          'title': page.get('title'),
          'content': str(page.get('content') or '')[:5000],
        } for page in candidates],
        'required_schema': AudioPageAlignment.model_json_schema(),
      }
      try:
        alignment = AudioPageAlignment.model_validate(self.caller(payload))
      except Exception as exc:  # noqa: BLE001
        # One malformed provider response must not discard a long, already-transcribed recording.
        alignment = AudioPageAlignment(
          start_time=window.start_time,
          end_time=window.end_time,
          primary_page_id=None,
          referenced_page_ids=[],
          confidence=0,
          alignment_type='uncertain',
          reason=f'AI alignment unavailable: {exc}',
        )
      if abs(alignment.start_time - window.start_time) > 1 or abs(alignment.end_time - window.end_time) > 1:
        alignment = alignment.model_copy(update={'start_time': window.start_time, 'end_time': window.end_time})
      if alignment.primary_page_id is not None and alignment.primary_page_id not in page_ids:
        raise ValueError('Audio page alignment selected an unknown primary page.')
      candidate_ids = {str(page.get('page_id') or '') for page in candidates}
      if (
        alignment.primary_page_id
        and alignment.primary_page_id not in candidate_ids
        and alignment.confidence < 0.9
      ):
        alignment = alignment.model_copy(update={
          'primary_page_id': None,
          'alignment_type': 'uncertain',
          'reason': f'{alignment.reason} Distant page selection was rejected.',
        })
      references = [page_id for page_id in alignment.referenced_page_ids if page_id in page_ids and page_id != alignment.primary_page_id]
      alignment = alignment.model_copy(update={'referenced_page_ids': list(dict.fromkeys(references))})
      alignments.append(alignment)

      if alignment.primary_page_id:
        primary_index = next(i for i, page in enumerate(ordered_pages) if page.get('page_id') == alignment.primary_page_id)
        # A distant jump needs strong evidence. Keep the current sequence otherwise.
        if abs(primary_index - cursor) <= self.forward_pages + self.backward_pages or alignment.confidence >= 0.9:
          cursor = primary_index
        previous_page_id = alignment.primary_page_id
        if alignment.alignment_type in {'direct', 'transition', 'reference'}:
          relations.append(PageAudioRelation(
            id=uuid.uuid4().hex,
            course_id=recording.course_id,
            recording_id=recording.id,
            document_id=recording.document_id,
            page_id=alignment.primary_page_id,
            start_time=alignment.start_time,
            end_time=alignment.end_time,
            confidence=alignment.confidence,
            alignment_type=alignment.alignment_type,
          ))
    return alignments, merge_page_audio_relations(relations)


class AudioAlignmentService:
  def __init__(self, store: AudioAlignmentStore | None = None, aligner: SequentialPageAligner | None = None) -> None:
    self.store = store or AudioAlignmentStore()
    self.aligner = aligner

  def register(self, recording: LectureRecording, segments: list[TranscriptSegment]) -> dict[str, Any]:
    if any(item.recording_id != recording.id for item in segments):
      raise ValueError('Every TranscriptSegment must reference the recording.')
    self.store.save(recording, segments, {
      'windows': [],
      'alignments': [],
      'relations': [],
      'page_transcripts': [],
      'status': 'transcribed',
      'updated_at': time.time(),
    })
    return self.store.read(recording.course_id, recording.id)

  def align(self, course_id: str, recording_id: str, pages: list[dict[str, Any]]) -> dict[str, Any]:
    stored = self.store.read(course_id, recording_id)
    recording = LectureRecording.model_validate(stored['recording'])
    segments = [TranscriptSegment.model_validate(item) for item in stored.get('transcript_segments') or []]
    windows = build_transcript_windows(segments)
    aligner = self.aligner or SequentialPageAligner.from_runtime_config()
    alignments, relations = aligner.align(recording, windows, pages)
    page_transcripts = build_page_transcripts(windows, alignments, pages)
    self.store.save(recording, segments, {
      'windows': [item.model_dump() for item in windows],
      'alignments': [item.model_dump() for item in alignments],
      'relations': [item.model_dump() for item in relations],
      'page_transcripts': [item.model_dump() for item in page_transcripts],
      'status': 'aligned',
      'updated_at': time.time(),
    })
    return self.store.read(course_id, recording_id)
