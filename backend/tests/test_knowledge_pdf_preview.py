from __future__ import annotations

import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import fitz
from fastapi import HTTPException
from PIL import Image

from backend import knowledge_storage


class KnowledgePdfPreviewTest(unittest.TestCase):
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


if __name__ == '__main__':
  unittest.main()
