"""Rebind an existing timestamped recording to the correct lecture without rerunning ASR."""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from backend.audio_alignment import AudioAlignmentService, LectureRecording, TranscriptSegment
from backend.knowledge_storage import read_knowledge_library, write_knowledge_library


def build_classroom_session(recording_id: str, segments: list[dict[str, Any]], transcript: str) -> dict[str, Any]:
  now = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
  return {
    'id': recording_id,
    'transcript': transcript,
    'polishedOverview': '',
    'segments': [
      {
        'id': f'{recording_id}:page-transcript:{index}',
        'recordingId': recording_id,
        'title': str(item.get('title') or '').strip() or f"课堂原文 · 第 {item['page_number']} 页",
        'summary': str(item.get('text') or '').strip()[:120],
        'polishedText': str(item.get('text') or '').strip(),
        'anchorText': None,
        'pageNumbers': [int(item['page_number'])],
        'startSeconds': float(item['start_time']),
        'endSeconds': float(item['end_time']),
        'sourceSentenceIds': list(item.get('segment_ids') or []),
        'createdAt': now,
      }
      for index, item in enumerate(segments, start=1)
      if str(item.get('text') or '').strip()
    ],
    'createdAt': now,
    'updatedAt': now,
  }


def sync_session_to_library(document_id: str, session: dict[str, Any]) -> None:
  library = read_knowledge_library()
  for file in library.get('files') or []:
    if str(file.get('id') or '') != document_id:
      continue
    existing = [item for item in file.get('classroomSessions') or [] if item.get('id') != session['id']]
    file['classroomSessions'] = [session, *existing][:40]
    file['updatedAt'] = session['updatedAt']
    file['lastOpenedAt'] = session['updatedAt']
    write_knowledge_library(library)
    return
  raise ValueError(f'No knowledge-library document found for {document_id}.')


def main() -> None:
  parser = argparse.ArgumentParser()
  parser.add_argument('--source-state', required=True, help='Existing audio-alignment JSON state file.')
  parser.add_argument('--course-id', required=True)
  parser.add_argument('--document-id', required=True)
  parser.add_argument('--sync-library', action='store_true')
  args = parser.parse_args()

  source_path = Path(args.source_state).resolve()
  source = json.loads(source_path.read_text(encoding='utf-8'))
  source_recording = LectureRecording.model_validate(source.get('recording') or {})
  recording = source_recording.model_copy(update={
    'course_id': args.course_id,
    'document_id': args.document_id,
  })
  transcript_segments = [
    TranscriptSegment.model_validate(item).model_copy(update={'recording_id': recording.id})
    for item in source.get('transcript_segments') or []
  ]
  if not transcript_segments:
    raise ValueError('The source recording has no timestamped transcript segments.')

  pages_path = PROJECT_ROOT / '.runtime' / 'document-pipeline' / 'documents' / args.document_id / 'pages.json'
  pages = json.loads(pages_path.read_text(encoding='utf-8'))
  if not isinstance(pages, list) or not pages:
    raise ValueError(f'No DocumentPage records found for {args.document_id}.')

  service = AudioAlignmentService()
  service.register(recording, transcript_segments)
  state = service.align(args.course_id, recording.id, pages)
  page_transcripts = state.get('page_transcripts') or []
  if args.sync_library:
    transcript = '\n'.join(item.text for item in transcript_segments)
    sync_session_to_library(args.document_id, build_classroom_session(recording.id, page_transcripts, transcript))

  print(json.dumps({
    'recording_id': recording.id,
    'course_id': args.course_id,
    'document_id': args.document_id,
    'status': state.get('status'),
    'timestamped_transcript_segments': len(transcript_segments),
    'page_transcript_count': len(page_transcripts),
    'relation_count': len(state.get('relations') or []),
    'synced_to_library': args.sync_library,
  }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
  main()
