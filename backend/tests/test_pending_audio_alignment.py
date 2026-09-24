from __future__ import annotations

import asyncio
import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import UploadFile

from backend.audio_alignment import (
  UNASSIGNED_AUDIO_COURSE_ID,
  AudioAlignmentService,
  AudioAlignmentStore,
  LectureRecording,
  SequentialPageAligner,
  TranscriptSegment,
)
from backend.media_router import (
  list_lecture_recordings,
  queue_pending_lecture_recordings,
  transcribe_audio,
)


class PendingAudioAlignmentTest(unittest.TestCase):
  @staticmethod
  def _page(document_id: str = 'lecture-1') -> dict:
    return {
      'course_id': 'course-1',
      'document_id': document_id,
      'page_id': 'page-1',
      'page_number': 1,
      'title': 'Lecture',
      'content': 'Lecture content',
    }

  def test_course_recording_waits_without_document_then_aligns_to_uploaded_lecture(self):
    with tempfile.TemporaryDirectory() as temporary:
      root = Path(temporary)
      with patch('backend.audio_alignment.AUDIO_ALIGNMENT_ROOT', root):
        store = AudioAlignmentStore()
        recording = LectureRecording(
          id='recording-1',
          course_id='course-1',
          document_id=None,
          audio_path='.runtime/audio-recordings/course-1/recording-1/source.webm',
          duration=12,
        )
        segment = TranscriptSegment(
          id='segment-1',
          recording_id=recording.id,
          start_time=0,
          end_time=12,
          text='这一段讲解平行板电容器。',
        )
        service = AudioAlignmentService(
          store=store,
          aligner=SequentialPageAligner(caller=lambda _payload: {
            'start_time': 0,
            'end_time': 12,
            'primary_page_id': 'page-1',
            'referenced_page_ids': [],
            'confidence': 0.95,
            'alignment_type': 'direct',
            'reason': 'topic match',
          }),
        )
        service.register(recording, [segment])

        pending = store.for_course('course-1')
        self.assertEqual('transcribed', pending[0]['status'])
        self.assertIsNone(pending[0]['recording']['document_id'])

        result = service.align_pending_for_document(
          'course-1',
          'lecture-1',
          [{
            'course_id': 'course-1',
            'document_id': 'lecture-1',
            'page_id': 'page-1',
            'page_number': 1,
            'title': '平行板电容器',
            'content': '平行板电容器的电场。',
          }],
        )

        self.assertEqual({'checked': 1, 'aligned': 1, 'failed': 0}, result)
        stored = store.read('course-1', 'recording-1')
        self.assertEqual('aligned', stored['status'])
        self.assertEqual('lecture-1', stored['recording']['document_id'])
        self.assertEqual(1, stored['page_transcripts'][0]['page_number'])

  def test_pending_recordings_remain_course_isolated(self):
    with tempfile.TemporaryDirectory() as temporary:
      with patch('backend.audio_alignment.AUDIO_ALIGNMENT_ROOT', Path(temporary)):
        store = AudioAlignmentStore()
        for course_id in ('course-1', 'course-2'):
          recording = LectureRecording(
            id=f'recording-{course_id}',
            course_id=course_id,
            audio_path=f'audio/{course_id}.webm',
            duration=5,
          )
          store.save(recording, [], {
            'status': 'transcribed',
            'updated_at': 1,
          })

        service = AudioAlignmentService(store=store)
        result = service.align_pending_for_document('course-1', 'lecture-1', [])

        self.assertEqual(1, result['checked'])
        self.assertIsNone(
          store.read('course-2', 'recording-course-2')['recording']['document_id'],
        )

  def test_empty_alignment_is_failed_and_remains_retryable(self):
    with tempfile.TemporaryDirectory() as temporary:
      with patch('backend.audio_alignment.AUDIO_ALIGNMENT_ROOT', Path(temporary)):
        store = AudioAlignmentStore()
        recording = LectureRecording(
          id='recording-empty',
          course_id='course-1',
          document_id='lecture-1',
          audio_path='audio/empty.webm',
          duration=5,
        )
        segment = TranscriptSegment(
          id='segment-empty',
          recording_id=recording.id,
          start_time=0,
          end_time=5,
          text='Lecture content',
        )
        empty_aligner = SimpleNamespace(align=lambda *_args: ([], []))
        service = AudioAlignmentService(store=store, aligner=empty_aligner)
        service.register(recording, [segment])

        with self.assertRaisesRegex(ValueError, 'did not produce any page transcripts'):
          service.align('course-1', recording.id, [self._page()], 'lecture-1')

        stored = store.read('course-1', recording.id)
        self.assertEqual('alignment_failed', stored['status'])
        self.assertEqual([], stored['page_transcripts'])

  def test_recording_bound_to_existing_other_lecture_is_not_rebound(self):
    with tempfile.TemporaryDirectory() as temporary:
      with patch('backend.audio_alignment.AUDIO_ALIGNMENT_ROOT', Path(temporary)):
        store = AudioAlignmentStore()
        recording = LectureRecording(
          id='recording-other',
          course_id='course-1',
          document_id='lecture-2',
          audio_path='audio/other.webm',
          duration=5,
        )
        service = AudioAlignmentService(store=store)
        service.register(recording, [])

        result = service.align_pending_for_document(
          'course-1',
          'lecture-1',
          [self._page()],
        )

        self.assertEqual({'checked': 0, 'aligned': 0, 'failed': 0}, result)
        self.assertEqual(
          'lecture-2',
          store.read('course-1', recording.id)['recording']['document_id'],
        )

  def test_open_lecture_endpoint_queues_pending_alignment(self):
    queued: list[tuple[str, str]] = []
    pipeline = SimpleNamespace(pages=lambda _document_id: [self._page()])
    coordinator = SimpleNamespace(
      queue_pending_audio_alignment=lambda course_id, document_id: queued.append(
        (course_id, document_id),
      ),
    )
    runtime = SimpleNamespace(
      pipeline_coordinator=coordinator,
      require_document_pipeline=lambda: pipeline,
    )
    with patch('backend.media_router._application_runtime', runtime):
      result = asyncio.run(queue_pending_lecture_recordings({
        'course_id': 'course-1',
        'document_id': 'lecture-1',
      }))

    self.assertTrue(result['queued'])
    self.assertEqual([('course-1', 'lecture-1')], queued)

  def test_unassigned_recording_is_claimed_by_first_uploaded_lecture(self):
    with tempfile.TemporaryDirectory() as temporary:
      with patch('backend.audio_alignment.AUDIO_ALIGNMENT_ROOT', Path(temporary)):
        store = AudioAlignmentStore()
        recording = LectureRecording(
          id='recording-unassigned',
          course_id=UNASSIGNED_AUDIO_COURSE_ID,
          audio_path='audio/unassigned.webm',
          duration=5,
        )
        segment = TranscriptSegment(
          id='segment-unassigned',
          recording_id=recording.id,
          start_time=0,
          end_time=5,
          text='未归属课堂录音',
        )
        service = AudioAlignmentService(
          store=store,
          aligner=SequentialPageAligner(caller=lambda _payload: {
            'start_time': 0,
            'end_time': 5,
            'primary_page_id': 'page-1',
            'referenced_page_ids': [],
            'confidence': 0.9,
            'alignment_type': 'direct',
            'reason': 'topic match',
          }),
        )
        service.register(recording, [segment])

        result = service.align_pending_for_document('course-1', 'lecture-1', [{
          'course_id': 'course-1',
          'document_id': 'lecture-1',
          'page_id': 'page-1',
          'page_number': 1,
          'title': 'Lecture',
          'content': '未归属课堂录音',
        }])

        self.assertEqual({'checked': 1, 'aligned': 1, 'failed': 0}, result)
        claimed = store.read('course-1', recording.id)
        self.assertEqual('course-1', claimed['recording']['course_id'])
        self.assertEqual('lecture-1', claimed['recording']['document_id'])
        with self.assertRaises(FileNotFoundError):
          store.read(UNASSIGNED_AUDIO_COURSE_ID, recording.id)

  def test_course_only_transcribe_route_persists_audio_and_timestamped_asr(self):
    with tempfile.TemporaryDirectory() as temporary:
      root = Path(temporary)
      result_payload = {
        'text': '课堂转写',
        'duration_seconds': 5,
        'chunks': [{
          'text': '课堂转写',
          'start_seconds': 0,
          'end_seconds': 5,
          'segments': [{
            'text': '课堂转写',
            'start_seconds': 0,
            'end_seconds': 5,
          }],
        }],
      }
      upload = UploadFile(filename='lesson.webm', file=io.BytesIO(b'audio-bytes'))
      with (
        patch('backend.media_router.PROJECT_ROOT', root),
        patch('backend.audio_alignment.AUDIO_ALIGNMENT_ROOT', root / 'audio-alignment'),
        patch(
          'backend.media_router.transcribe_audio_file_with_chunking',
          return_value=result_payload,
        ),
      ):
        result = asyncio.run(transcribe_audio(
          file=upload,
          course_id='course-1',
          document_id=None,
        ))

        recording = result['recording']
        self.assertIsNone(recording['document_id'])
        self.assertTrue((root / recording['audio_path']).is_file())
        stored = AudioAlignmentStore().read('course-1', recording['id'])
        self.assertEqual('transcribed', stored['status'])
        self.assertEqual('课堂转写', stored['transcript_segments'][0]['text'])

  def test_transcribe_without_course_persists_unassigned_audio(self):
    with tempfile.TemporaryDirectory() as temporary:
      root = Path(temporary)
      result_payload = {
        'text': '先录音后上传讲义',
        'duration_seconds': 4,
        'chunks': [{
          'text': '先录音后上传讲义',
          'start_seconds': 0,
          'end_seconds': 4,
          'segments': [{
            'text': '先录音后上传讲义',
            'start_seconds': 0,
            'end_seconds': 4,
          }],
        }],
      }
      upload = UploadFile(filename='lesson.webm', file=io.BytesIO(b'audio-bytes'))
      with (
        patch('backend.media_router.PROJECT_ROOT', root),
        patch('backend.audio_alignment.AUDIO_ALIGNMENT_ROOT', root / 'audio-alignment'),
        patch(
          'backend.media_router.transcribe_audio_file_with_chunking',
          return_value=result_payload,
        ),
      ):
        result = asyncio.run(transcribe_audio(file=upload, course_id=None, document_id=None))

        recording = result['recording']
        self.assertEqual(UNASSIGNED_AUDIO_COURSE_ID, recording['course_id'])
        self.assertTrue(result['pending_course_assignment'])
        self.assertTrue((root / recording['audio_path']).is_file())
        stored = AudioAlignmentStore().read(UNASSIGNED_AUDIO_COURSE_ID, recording['id'])
        self.assertEqual('transcribed', stored['status'])

  def test_unassigned_recordings_can_be_listed_before_a_course_is_selected(self):
    with tempfile.TemporaryDirectory() as temporary:
      with patch('backend.audio_alignment.AUDIO_ALIGNMENT_ROOT', Path(temporary)):
        store = AudioAlignmentStore()
        recording = LectureRecording(
          id='recording-unassigned',
          course_id=UNASSIGNED_AUDIO_COURSE_ID,
          audio_path='audio/unassigned.webm',
          duration=5,
        )
        store.save(recording, [], {'status': 'transcribed', 'updated_at': 1})

        result = asyncio.run(list_lecture_recordings(course_id=None, document_id=None))

        self.assertEqual(1, len(result['recordings']))
        self.assertEqual('recording-unassigned', result['recordings'][0]['recording']['id'])


  def test_transcribe_persists_raw_audio_before_asr_failure(self):
    with tempfile.TemporaryDirectory() as temporary:
      root = Path(temporary)
      upload = UploadFile(filename='lesson.webm', file=io.BytesIO(b'audio-bytes'))
      with (
        patch('backend.media_router.PROJECT_ROOT', root),
        patch('backend.audio_alignment.AUDIO_ALIGNMENT_ROOT', root / 'audio-alignment'),
        patch(
          'backend.media_router.transcribe_audio_file_with_chunking',
          side_effect=RuntimeError('simulated ASR failure'),
        ),
      ):
        with self.assertRaisesRegex(RuntimeError, 'simulated ASR failure'):
          asyncio.run(transcribe_audio(
            file=upload,
            course_id='course-1',
            document_id=None,
            client_recording_id='draft-recording-1',
          ))

        stored = AudioAlignmentStore().read('course-1', 'draft-recording-1')
        self.assertEqual('transcription_failed', stored['status'])
        self.assertIn('simulated ASR failure', stored['transcription_error'])
        audio_path = root / stored['recording']['audio_path']
        self.assertTrue(audio_path.is_file())
        self.assertEqual(b'audio-bytes', audio_path.read_bytes())


if __name__ == '__main__':
  unittest.main()
