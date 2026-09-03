from __future__ import annotations

import logging
import json
import shutil
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .document_pipeline import LocalMinerUParser, archive_parser_result
from .user_answers import StudentAnswerReconstruction, UserAnswerStore, UserQuestionAnswer


logger = logging.getLogger(__name__)


@dataclass
class StudentAnswerMineruResult:
  markdown: str = ''
  pages: list[dict[str, Any]] = field(default_factory=list)
  blocks: list[dict[str, Any]] = field(default_factory=list)
  raw_layout: dict[str, Any] = field(default_factory=dict)
  mineru_available: bool = False
  error: str = ''


class StudentAnswerMineruPreprocessor:
  """Reuse the local MinerU pipeline and expose only compact reconstruction evidence."""

  _lock = threading.Lock()

  def __init__(self, parser: LocalMinerUParser | None = None) -> None:
    self.parser = parser or LocalMinerUParser()

  def process(
    self,
    store: UserAnswerStore,
    attempt: UserQuestionAnswer,
    target: Path,
  ) -> StudentAnswerMineruResult:
    markdown_parts: list[str] = []
    blocks: list[dict[str, Any]] = []
    pages: list[dict[str, Any]] = []
    page_offset = 0
    try:
      with self._lock:
        for asset in sorted(attempt.assets, key=lambda item: item.order):
          source, _ = store.asset(
            attempt.course_id,
            attempt.source_document_id,
            attempt.question_id,
            asset.id,
            attempt.id,
          )
          asset_target = target / f'{asset.order:03d}-{asset.id}'
          isolated_input = asset_target / f'input{source.suffix.lower()}'
          isolated_input.parent.mkdir(parents=True, exist_ok=True)
          shutil.copyfile(source, isolated_input)
          try:
            result = self.parser.parse(isolated_input)
            markdown, asset_blocks, page_count = archive_parser_result(result['archive'], asset_target)
          finally:
            isolated_input.unlink(missing_ok=True)
            shutil.rmtree(isolated_input.parent / 'mineru-local-output', ignore_errors=True)
          actual_pages = max(page_count, *(int(item.get('pageNumber') or 0) for item in asset_blocks), 1)
          markdown_parts.append(f'## 上传内容 {asset.order + 1}\n\n{markdown.strip()}')
          grouped: dict[int, list[dict[str, Any]]] = {}
          for item in asset_blocks:
            compact = {
              'page': int(item.get('pageNumber') or 1) + page_offset,
              'type': str(item.get('kind') or item.get('label') or 'text'),
              'text': str(item.get('text') or '')[:4000],
              'bbox': list(item.get('bbox') or []),
            }
            blocks.append(compact)
            grouped.setdefault(compact['page'], []).append(compact)
          for local_page in range(1, actual_pages + 1):
            number = page_offset + local_page
            pages.append({'page': number, 'blocks': grouped.get(number, [])})
          page_offset += actual_pages
      compact_layout = {'page_count': page_offset, 'pages': pages, 'blocks': blocks}
      return StudentAnswerMineruResult(
        markdown='\n\n'.join(markdown_parts),
        pages=pages,
        blocks=blocks,
        raw_layout=compact_layout,
        mineru_available=True,
      )
    except Exception as exc:  # noqa: BLE001 - MinerU failure has an intentional image-only fallback.
      logger.warning('Student answer MinerU preprocessing failed for attempt %s: %s', attempt.id, exc)
      return StudentAnswerMineruResult(error=str(exc)[:1000])


class StudentAnswerReconstructionPrompt:
  """Build one provider-neutral prompt for both API and browser transports."""

  @staticmethod
  def system_instructions() -> str:
    return (
      'You reconstruct handwritten mathematics; you do not solve or grade it. First assign visual regions to '
      'the supplied question IDs, then faithfully recover each answer. Do not assume top-to-bottom reading order: '
      'work may continue left-to-right or from the left side to the right side of a page. Preserve scratch work, '
      'corrections, arrows, formulas, and final answers. The original page images are the strongest evidence; '
      'MinerU layout is secondary and Markdown is tertiary. If they conflict, follow the original image. Never '
      'use a reference answer, correct the student, or complete missing work. Use [无法辨认] and uncertain_parts '
      'for illegible content. Preserve regions that cannot be assigned in unassigned_blocks. Return JSON only.'
    )

  @staticmethod
  def schema() -> dict[str, Any]:
    return StudentAnswerReconstruction.model_json_schema()

  @classmethod
  def input_payload(
    cls,
    context: dict[str, Any],
    mineru: StudentAnswerMineruResult,
    provider_ocr: str = '',
  ) -> str:
    # Reference answers are intentionally excluded from this projection stage.
    payload = {
      'questions': context.get('all_questions') or [{
        'question_id': context.get('question_id', ''),
        'index': 1,
        'title': context.get('title', ''),
        'content': context.get('content', ''),
      }],
      'mineru_available': mineru.mineru_available,
      'mineru_pages': mineru.pages,
      'mineru_markdown': mineru.markdown[:60000],
      'provider_ocr': provider_ocr[:60000],
      'instruction': (
        'Determine how many questions are present and what each asks, then assign handwritten regions and '
        'reconstruct the student work. Return one questions item per answer found, keyed by the supplied question_id.'
      ),
      'output_schema': cls.schema(),
    }
    return json.dumps(payload, ensure_ascii=False)

  @classmethod
  def build(
    cls,
    context: dict[str, Any],
    mineru: StudentAnswerMineruResult,
    provider_ocr: str = '',
  ) -> str:
    return f'{cls.system_instructions()}\n\nINPUT:\n{cls.input_payload(context, mineru, provider_ocr)}'


__all__ = [
  'StudentAnswerMineruPreprocessor',
  'StudentAnswerMineruResult',
  'StudentAnswerReconstructionPrompt',
]
