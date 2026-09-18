from __future__ import annotations

import io
import tempfile
import unittest
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import fitz
from fastapi import HTTPException
from PIL import Image

from backend import knowledge_storage


class KnowledgePdfPreviewTest(unittest.TestCase):
  def _write_pdf(self, path: Path, pages: int = 2):
    document = fitz.open()
    for number in range(pages):
      page = document.new_page(width=320, height=180)
      page.insert_text((30, 60), f'Page {number + 1}')
    document.save(path)
    document.close()

  def test_page_preview_is_rendered_and_cached(self):
    with tempfile.TemporaryDirectory() as temporary_directory:
      root = Path(temporary_directory)
      pdf_directory = root / 'pdf-files'
      preview_directory = root / 'pdf-page-previews'
      pdf_directory.mkdir(parents=True)
      document = fitz.open()
      page = document.new_page(width=320, height=180)
      page.insert_text((30, 60), 'Linear regression')
      document.save(pdf_directory / 'lecture-1.pdf')
      document.close()
      asset_path = root / '.runtime' / 'document-pipeline' / 'documents' / 'lecture-1' / 'mineru' / 'artifacts' / 'images' / 'figure.png'
      asset_path.parent.mkdir(parents=True)
      Image.new('RGB', (40, 40), '#d92525').save(asset_path)

      with (
        patch.object(knowledge_storage, 'KNOWLEDGE_PDF_DIR', pdf_directory),
        patch.object(knowledge_storage, 'KNOWLEDGE_PDF_PAGE_DIR', preview_directory),
        patch.object(knowledge_storage, 'PROJECT_ROOT', root),
        patch.object(knowledge_storage, 'read_knowledge_library', return_value={
          'files': [{
            'id': 'lecture-1',
            'layoutBlocks': [{
              'pageNumber': 1,
              'kind': 'image',
              'bbox': [50, 50, 100, 100],
              'assetPath': 'images/figure.png',
            }],
          }],
        }),
      ):
        first = knowledge_storage.read_pdf_page_image('lecture-1', 1)
        cached_path = preview_directory / 'lecture-1' / 'v3-1.png'
        self.assertTrue(first.startswith(b'\x89PNG'))
        self.assertEqual(first, cached_path.read_bytes())
        with Image.open(io.BytesIO(first)) as preview:
          red, green, blue = preview.convert('RGB').getpixel((100, 100))
          self.assertGreater(red, 180)
          self.assertLess(green, 80)
          self.assertLess(blue, 80)

        cached_path.write_bytes(b'cached-page')
        self.assertEqual(b'cached-page', knowledge_storage.read_pdf_page_image('lecture-1', 1))

  def test_page_preview_rejects_out_of_range_page(self):
    with tempfile.TemporaryDirectory() as temporary_directory:
      root = Path(temporary_directory)
      pdf_directory = root / 'pdf-files'
      pdf_directory.mkdir(parents=True)
      document = fitz.open()
      document.new_page()
      document.save(pdf_directory / 'lecture-1.pdf')
      document.close()

      with (
        patch.object(knowledge_storage, 'KNOWLEDGE_PDF_DIR', pdf_directory),
        patch.object(knowledge_storage, 'KNOWLEDGE_PDF_PAGE_DIR', root / 'previews'),
      ):
        with self.assertRaises(HTTPException) as context:
          knowledge_storage.read_pdf_page_image('lecture-1', 2)
        self.assertEqual(404, context.exception.status_code)

  def test_different_pages_render_concurrently_and_same_page_is_deduplicated(self):
    with tempfile.TemporaryDirectory() as temporary_directory:
      root = Path(temporary_directory)
      pdf_directory = root / 'pdf-files'
      pdf_directory.mkdir()
      self._write_pdf(pdf_directory / 'lecture-1.pdf')
      preview_directory = root / 'previews'
      original_save = Image.Image.save
      barrier = threading.Barrier(2)
      calls = 0
      calls_lock = threading.Lock()

      def observed_save(image, output, *args, **kwargs):
        nonlocal calls
        with calls_lock:
          calls += 1
        barrier.wait(timeout=3)
        return original_save(image, output, *args, **kwargs)

      with (
        patch.object(knowledge_storage, 'KNOWLEDGE_PDF_DIR', pdf_directory),
        patch.object(knowledge_storage, 'KNOWLEDGE_PDF_PAGE_DIR', preview_directory),
        patch.object(knowledge_storage, 'read_knowledge_library', return_value={'files': []}),
        patch.object(Image.Image, 'save', observed_save),
        ThreadPoolExecutor(max_workers=2) as executor,
      ):
        payloads = list(executor.map(lambda number: knowledge_storage.read_pdf_page_image('lecture-1', number), (1, 2)))
      self.assertEqual(2, calls)
      self.assertTrue(all(payload.startswith(b'\x89PNG') for payload in payloads))

      # Remove only page one and prove concurrent requests publish it once.
      (preview_directory / 'lecture-1' / 'v3-1.png').unlink()
      calls = 0
      def counted_save(image, output, *args, **kwargs):
        nonlocal calls
        with calls_lock:
          calls += 1
        return original_save(image, output, *args, **kwargs)
      with (
        patch.object(knowledge_storage, 'KNOWLEDGE_PDF_DIR', pdf_directory),
        patch.object(knowledge_storage, 'KNOWLEDGE_PDF_PAGE_DIR', preview_directory),
        patch.object(knowledge_storage, 'read_knowledge_library', return_value={'files': []}),
        patch.object(Image.Image, 'save', counted_save),
        ThreadPoolExecutor(max_workers=2) as executor,
      ):
        payloads = list(executor.map(lambda _: knowledge_storage.read_pdf_page_image('lecture-1', 1), range(2)))
      self.assertEqual(1, calls)
      self.assertEqual(payloads[0], payloads[1])

  def test_failed_atomic_publish_does_not_leave_a_cache_file(self):
    with tempfile.TemporaryDirectory() as temporary_directory:
      root = Path(temporary_directory)
      pdf_directory = root / 'pdf-files'
      pdf_directory.mkdir()
      self._write_pdf(pdf_directory / 'lecture-1.pdf', 1)
      preview_directory = root / 'previews'
      with (
        patch.object(knowledge_storage, 'KNOWLEDGE_PDF_DIR', pdf_directory),
        patch.object(knowledge_storage, 'KNOWLEDGE_PDF_PAGE_DIR', preview_directory),
        patch.object(knowledge_storage, 'read_knowledge_library', return_value={'files': []}),
        patch.object(knowledge_storage.os, 'replace', side_effect=OSError('publish failed')),
      ):
        with self.assertRaises(OSError):
          knowledge_storage.read_pdf_page_image('lecture-1', 1)
      self.assertFalse((preview_directory / 'lecture-1' / 'v3-1.png').exists())

  def test_persisted_page_sizes_keep_known_values_and_fill_missing_pages(self):
    previous = [
      {'width': 320, 'height': 180},
      None,
      None,
    ]
    discovered = [
      {'width': 321, 'height': 181},
      {'width': 400, 'height': 240},
      {'width': 500, 'height': 300},
    ]

    self.assertEqual(
      [
        {'width': 320, 'height': 180},
        {'width': 400, 'height': 240},
        {'width': 500, 'height': 300},
      ],
      knowledge_storage._merge_page_sizes(previous, discovered),
    )
    self.assertEqual(previous, knowledge_storage._merge_page_sizes(previous, None))


if __name__ == '__main__':
  unittest.main()
