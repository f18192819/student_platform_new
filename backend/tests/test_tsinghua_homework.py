from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.tsinghua_homework import (
  _assignment_rows,
  _detail_attachments,
  _filename_from_disposition,
  download_homework_files,
  fetch_homework_catalog,
  homework_download_id,
  public_homework_file,
)
from backend.tsinghua_sync import tsinghua_router


class FakeResponse:
  def __init__(self, *, status_code=200, headers=None, payload=None, text='', content=b''):
    self.status_code = status_code
    self.headers = headers or {}
    self._payload = payload
    self.text = text
    self._content = content

  def json(self):
    return self._payload

  def iter_content(self, chunk_size=65536):
    del chunk_size
    yield self._content


class AssignmentSession:
  def __init__(self, rows_by_endpoint):
    self.rows_by_endpoint = rows_by_endpoint

  def post(self, url, **_kwargs):
    rows = next((rows for endpoint, rows in self.rows_by_endpoint.items() if endpoint in url), [])
    return FakeResponse(payload={'result': 'success', 'object': {'aaData': rows}})


class DetailSession:
  def __init__(self, markup):
    self.markup = markup

  def get(self, _url, **_kwargs):
    return FakeResponse(text=self.markup)

  def post(self, _url, **_kwargs):
    return FakeResponse(payload={
      'result': 'success',
      'msg': '<p>请独立完成作业。</p>',
    })


class DownloadSession:
  def __init__(self, response):
    self.response = response
    self.calls = []

  def get(self, url, **kwargs):
    self.calls.append((url, kwargs))
    return self.response


class TsinghuaHomeworkTest(unittest.TestCase):
  def test_assignment_lists_cover_all_states_and_deduplicate(self):
    session = AssignmentSession({
      'zyListWj': [{'zyid': 'assignment-1', 'bt': '第一次作业'}],
      'zyListYjwg': [
        {'zyid': 'assignment-1', 'bt': '第一次作业'},
        {'zyid': 'assignment-2', 'bt': '第二次作业'},
      ],
      'zyListYpg': [{'zyid': 'assignment-3', 'bt': '第三次作业'}],
    })

    rows = _assignment_rows(session, [], 'course-remote-id')

    self.assertEqual(['assignment-1', 'assignment-2', 'assignment-3'], [row['zyid'] for row in rows])
    self.assertEqual(['pending', 'submitted', 'graded'], [row['_state'] for row in rows])

  def test_detail_reads_only_question_attachment_and_deduplicates_nested_link(self):
    markup = '''
      <div class="detail">
        <div class="list fujian">
          <span class="ftitle">第一次作业.pdf</span>
          <span class="color_999">278.65K</span>
          <a href="/b/wlxt/kczy/zy/student/downloadFile/remote-course/question-file">下载</a>
          <a href="/f/wlxt/common/download?downloadUrl=%2Fb%2Fwlxt%2Fkczy%2Fzy%2Fstudent%2FdownloadFile%2Fremote-course%2Fquestion-file">第一次作业.pdf</a>
        </div>
        <div class="list fujian">
          <a href="/b/wlxt/kczy/zy/student/downloadFile/remote-course/reference-answer">参考答案.pdf</a>
        </div>
      </div>
    '''

    attachments, description = _detail_attachments(
      DetailSession(markup),
      [],
      'remote-course',
      {'zyid': 'assignment-1', 'xszyid': 'student-assignment-1', '_state': 'pending'},
    )

    self.assertEqual(1, len(attachments))
    self.assertEqual('question-file', attachments[0]['attachmentId'])
    self.assertEqual('第一次作业.pdf', attachments[0]['fileName'])
    self.assertGreater(attachments[0]['byteSize'], 278 * 1024)
    self.assertEqual('请独立完成作业。', description)

  def test_catalog_keeps_course_identity_and_stable_download_id(self):
    attachment = {
      'attachmentId': 'question-file',
      'fileName': '第一次作业.pdf',
      'byteSize': 42,
      'mimeType': 'application/pdf',
      'downloadPath': '/b/wlxt/kczy/zy/student/downloadFile/remote-course/question-file',
    }
    row = {
      'zyid': 'assignment-1',
      'xszyid': 'student-assignment-1',
      'bt': '第一次作业',
      'jzsjStr': '2026-09-22 23:59',
      '_state': 'pending',
    }
    with (
      patch('backend.tsinghua_homework._session', return_value=object()),
      patch('backend.tsinghua_homework._assignment_rows', return_value=[row]),
      patch('backend.tsinghua_homework._detail_attachments', return_value=([attachment], '作业说明')),
    ):
      catalog = fetch_homework_catalog(
        [],
        course_name='形式语言与自动机',
        course_code='44100563',
        wlkcid='2026-2027-1152227978',
        semester_id='2026-2027-1',
        semester_name='2026-2027 秋季学期',
      )

    self.assertEqual(1, len(catalog))
    record = catalog[0]
    self.assertEqual('形式语言与自动机', record['courseName'])
    self.assertEqual('homework', record['resourceType'])
    self.assertEqual('第一次作业 - 第一次作业.pdf', record['displayName'])
    self.assertEqual(
      homework_download_id('2026-2027-1152227978', 'assignment-1', 'question-file'),
      record['id'],
    )
    self.assertNotEqual(
      record['id'],
      homework_download_id('another-course', 'assignment-1', 'question-file'),
    )

  def test_unchanged_assignment_reuses_cached_details(self):
    row = {'zyid': 'assignment-1', 'bt': 'Assignment', '_state': 'pending'}
    attachment = {
      'attachmentId': 'question-file',
      'fileName': 'assignment.pdf',
      'byteSize': 42,
      'mimeType': 'application/pdf',
      'downloadPath': '/download/question-file',
    }
    detail_cache = {}
    with (
      patch('backend.tsinghua_homework._session', return_value=object()),
      patch('backend.tsinghua_homework._assignment_rows', return_value=[row]),
      patch(
        'backend.tsinghua_homework._detail_attachments',
        return_value=([attachment], 'Description'),
      ) as detail,
    ):
      for _ in range(2):
        fetch_homework_catalog(
          [],
          course_name='Course',
          course_code='C1',
          wlkcid='remote-course',
          semester_id='2026-1',
          semester_name='Current',
          detail_cache=detail_cache,
        )

    self.assertEqual(1, detail.call_count)

  def test_download_writes_valid_pdf_and_hides_private_paths(self):
    response = FakeResponse(
      headers={
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="\xe7\xac\xac\xe4\xb8\x80\xe6\xac\xa1\xe4\xbd\x9c\xe4\xb8\x9a.pdf"',
      },
      content=b'%PDF-1.7\nassignment',
    )
    session = DownloadSession(response)
    record = {
      'id': 'homework-file-1',
      'courseName': '形式语言与自动机',
      'wlkcid': 'remote-course',
      'fileName': 'fallback.pdf',
      'kind': 'pdf',
      'downloadPath': '/b/wlxt/kczy/zy/student/downloadFile/remote-course/question-file',
    }

    with tempfile.TemporaryDirectory() as temporary_directory:
      with patch('backend.tsinghua_homework._session', return_value=session):
        downloaded, skipped = download_homework_files(
          [],
          [record],
          Path(temporary_directory),
          batch_id='batch-1',
          requested_file_ids={'homework-file-1'},
        )

      self.assertEqual([], skipped)
      self.assertEqual('第一次作业.pdf', downloaded[0]['fileName'])
      self.assertTrue(Path(downloaded[0]['path']).read_bytes().startswith(b'%PDF'))
      self.assertNotIn('path', public_homework_file(downloaded[0]))
      self.assertNotIn('downloadPath', public_homework_file(downloaded[0]))

  def test_download_skips_legacy_document_by_import_display_name(self):
    record = {
      'id': 'homework-file-1',
      'courseName': '形式语言与自动机',
      'fileName': '第一次作业.pdf',
      'displayName': '第一次作业 - 第一次作业.pdf',
      'kind': 'pdf',
      'downloadPath': '/b/wlxt/kczy/zy/student/downloadFile/remote-course/question-file',
    }

    with tempfile.TemporaryDirectory() as temporary_directory:
      downloaded, skipped = download_homework_files(
        [],
        [record],
        Path(temporary_directory),
        batch_id='batch-1',
        known_file_names={'第一次作业 - 第一次作业.pdf'.casefold()},
      )

    self.assertEqual([], downloaded)
    self.assertEqual('本地已保存同名作业，跳过下载。', skipped[0]['reason'])

  def test_filename_supports_rfc5987_utf8(self):
    response = FakeResponse(headers={
      'Content-Disposition': "attachment; filename*=UTF-8''%E7%AC%AC%E4%B8%80%E6%AC%A1%E4%BD%9C%E4%B8%9A.pdf",
    })
    self.assertEqual('第一次作业.pdf', _filename_from_disposition(response, 'fallback.pdf'))

  def test_router_exposes_homework_catalog_pull_and_file_routes(self):
    paths = {route.path for route in tsinghua_router.routes}
    self.assertIn('/api/tsinghua-sync/{session_id}/homework/list-by-course', paths)
    self.assertIn('/api/tsinghua-sync/{session_id}/homework/pull-by-course', paths)
    self.assertIn('/api/tsinghua-sync/{session_id}/homework/{download_id}', paths)


if __name__ == '__main__':
  unittest.main()
