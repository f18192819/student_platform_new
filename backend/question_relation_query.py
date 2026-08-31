from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol

from fastapi import HTTPException

from .document_pipeline import read_json_file, safe_storage_name


class QuestionRelationQuery(Protocol):
  def result(self, question_id: str) -> dict[str, Any]: ...
  def assessment_relation_targets(self, question_ids: set[str] | None = None) -> list[dict[str, Any]]: ...
  def lecture_page_relations(
    self, course_id: str, lecture_document_id: str, page_number: int
  ) -> dict[str, Any]: ...
  def lecture_document_questions(
    self, course_id: str, lecture_document_id: str
  ) -> dict[str, Any]: ...


class FileQuestionRelationQuery:
  """Read-only projection over persisted relation and source-question artifacts."""

  def __init__(
    self,
    *,
    relations_dir: Path,
    lecture_page_index_dir: Path,
    lecture_document_index_dir: Path,
    question_reverse_index_dir: Path,
    question_documents_root: Path,
    lecture_documents_root: Path,
  ) -> None:
    self.relations_dir = relations_dir
    self.lecture_page_index_dir = lecture_page_index_dir
    self.lecture_document_index_dir = lecture_document_index_dir
    self.question_reverse_index_dir = question_reverse_index_dir
    self.question_documents_root = question_documents_root
    self.lecture_documents_root = lecture_documents_root

  def result(self, question_id: str) -> dict[str, Any]:
    record = read_json_file(
      self.relations_dir / f'{safe_storage_name(question_id)}.json',
      None,
    )
    reverse = read_json_file(
      self.question_reverse_index_dir / f'{safe_storage_name(question_id)}.json',
      None,
    )
    if not isinstance(record, dict) and not isinstance(reverse, dict):
      raise HTTPException(status_code=404, detail='Question relation record not found.')
    result = dict(record) if isinstance(record, dict) else {
      'version': 2,
      'question_id': question_id,
      'status': 'completed',
      'relations': [],
      'runs': [],
    }
    relations = list(result.get('relations') or [])
    if isinstance(reverse, dict):
      relations.extend(reverse.get('relations') or [])
    unique: dict[tuple[str, str, int], dict[str, Any]] = {}
    for relation in relations:
      if not isinstance(relation, dict):
        continue
      target = relation.get('target') if isinstance(relation.get('target'), dict) else {}
      key = (
        str(target.get('question_id') or target.get('document_id') or ''),
        str(relation.get('relation_type') or ''),
        int(target.get('page_number') or 0),
      )
      previous = unique.get(key)
      if previous is None or float(relation.get('rerank_score') or 0.0) > float(
        previous.get('rerank_score') or 0.0
      ):
        unique[key] = relation
    result['relations'] = sorted(
      unique.values(),
      key=lambda item: float(item.get('rerank_score') or 0.0),
      reverse=True,
    )
    return result

  def assessment_relation_targets(
    self,
    question_ids: set[str] | None = None,
  ) -> list[dict[str, Any]]:
    selected = {
      str(value or '').strip() for value in question_ids or set() if str(value or '').strip()
    }
    if question_ids is not None and not selected:
      return []
    targets = []
    paths = (
      [self.relations_dir / f'{safe_storage_name(question_id)}.json' for question_id in sorted(selected)]
      if question_ids is not None
      else sorted(self.relations_dir.glob('*.json')) if self.relations_dir.is_dir() else []
    )
    for path in paths:
      record = read_json_file(path, {})
      if not isinstance(record, dict) or record.get('status') != 'completed':
        continue
      question_id = str(record.get('question_id') or '').strip()
      if not question_id or (selected and question_id not in selected):
        continue
      lecture_document_ids = {
        str((relation.get('target') or {}).get('document_id') or '').strip()
        for relation in record.get('relations') or []
        if isinstance(relation, dict)
        and relation.get('relation_type') == 'question_to_lecture_page'
        and int((relation.get('target') or {}).get('page_number') or 0) > 0
      }
      lecture_document_ids.discard('')
      if lecture_document_ids:
        targets.append({
          'course_id': str(record.get('course_id') or '').strip(),
          'question_id': question_id,
          'source_document_id': str(record.get('question_document_id') or '').strip(),
          'lecture_document_ids': sorted(lecture_document_ids),
        })
    return targets

  def lecture_page_relations(
    self,
    course_id: str,
    lecture_document_id: str,
    page_number: int,
  ) -> dict[str, Any]:
    index_path = (
      self.lecture_page_index_dir
      / safe_storage_name(lecture_document_id)
      / f'page-{int(page_number)}.json'
    )
    indexed = read_json_file(index_path, None)
    if isinstance(indexed, dict) and indexed.get('course_id') == course_id:
      return indexed
    matches = []
    for path in self.relations_dir.glob('*.json') if self.relations_dir.is_dir() else []:
      record = read_json_file(path, {})
      if not isinstance(record, dict) or record.get('course_id') != course_id:
        continue
      source_question = self._question_summary(
        str(record.get('question_document_id') or ''),
        str(record.get('question_id') or ''),
      )
      for relation in record.get('relations') or []:
        target = relation.get('target') if isinstance(relation, dict) else {}
        if (
          isinstance(relation, dict)
          and relation.get('relation_type') == 'question_to_lecture_page'
          and str(target.get('document_id') or '') == lecture_document_id
          and int(target.get('page_number') or 0) == page_number
        ):
          matches.append({**relation, 'question': source_question})
    matches.sort(key=lambda item: float(item.get('rerank_score') or 0.0), reverse=True)
    return {
      'course_id': course_id,
      'lecture_document_id': lecture_document_id,
      'page_number': page_number,
      'relations': matches,
    }

  def lecture_document_questions(
    self,
    course_id: str,
    lecture_document_id: str,
  ) -> dict[str, Any]:
    valid_pages = {
      int(page.get('page_number') or 0)
      for page in self._lecture_pages(lecture_document_id)
      if int(page.get('page_number') or 0) > 0
    }
    questions: dict[str, dict[str, Any]] = {}
    if valid_pages and self.relations_dir.is_dir():
      for path in self._lecture_relation_paths(course_id, lecture_document_id):
        record = read_json_file(path, {})
        if not isinstance(record, dict) or str(record.get('course_id') or '') != course_id:
          continue
        matching = []
        for relation in record.get('relations') or []:
          target = relation.get('target') if isinstance(relation, dict) else {}
          if (
            isinstance(relation, dict)
            and relation.get('relation_type') == 'question_to_lecture_page'
            and str(target.get('document_id') or '') == lecture_document_id
            and int(target.get('page_number') or 0) in valid_pages
          ):
            matching.append(relation)
        if not matching:
          continue
        question_id = str(record.get('question_id') or '').strip()
        question = self._question_summary(
          str(record.get('question_document_id') or '').strip(),
          question_id,
        )
        if not question:
          continue
        current = questions.setdefault(question_id, {**question, 'lecture_relations': []})
        current['lecture_relations'].extend(matching)
    result = []
    for question in questions.values():
      deduplicated: dict[tuple[str, int], dict[str, Any]] = {}
      for relation in question['lecture_relations']:
        target = relation.get('target') if isinstance(relation.get('target'), dict) else {}
        key = (str(target.get('document_id') or ''), int(target.get('page_number') or 0))
        previous = deduplicated.get(key)
        if previous is None or float(relation.get('rerank_score') or 0.0) > float(
          previous.get('rerank_score') or 0.0
        ):
          deduplicated[key] = relation
      question['lecture_relations'] = sorted(
        deduplicated.values(),
        key=lambda item: int((item.get('target') or {}).get('page_number') or 0),
      )
      result.append(question)
    result.sort(key=lambda item: (
      str(item.get('document_name') or ''),
      int(item.get('page_number') or 0),
      str(item.get('question_id') or ''),
    ))
    return {
      'course_id': course_id,
      'lecture_document_id': lecture_document_id,
      'questions': result,
    }

  def _lecture_relation_paths(self, course_id: str, lecture_document_id: str) -> list[Path]:
    """Resolve only the relation records referenced by a lecture index when available."""
    index = read_json_file(
      self.lecture_document_index_dir / f'{safe_storage_name(lecture_document_id)}.json',
      None,
    )
    if (
      isinstance(index, dict)
      and str(index.get('course_id') or '') == course_id
      and str(index.get('lecture_document_id') or '') == lecture_document_id
      and isinstance(index.get('question_ids'), list)
    ):
      return [
        self.relations_dir / f'{safe_storage_name(question_id)}.json'
        for question_id in sorted({
          str(value or '').strip() for value in index['question_ids'] if str(value or '').strip()
        })
      ]
    # Compatibility for relation data written before lecture-document indexes existed.
    return sorted(self.relations_dir.glob('*.json'))

  def _lecture_pages(self, document_id: str) -> list[dict[str, Any]]:
    pages = read_json_file(
      self.lecture_documents_root / safe_storage_name(document_id) / 'pages.json',
      [],
    )
    return [page for page in pages if isinstance(page, dict)] if isinstance(pages, list) else []

  def _question_summary(self, document_id: str, question_id: str) -> dict[str, Any]:
    directory = self.question_documents_root / safe_storage_name(document_id)
    state = read_json_file(directory / 'state.json', {})
    if not isinstance(state, dict) or not state:
      return {}
    question_dir = directory / 'questions'
    if question_dir.is_dir():
      questions = [read_json_file(path, {}) for path in sorted(question_dir.glob('*.json'))]
    else:
      questions = read_json_file(directory / 'questions.json', [])
    question = next(
      (
        item for item in questions or []
        if isinstance(item, dict) and str(item.get('question_id') or '') == question_id
      ),
      {},
    )
    if not question:
      return {}
    return {
      'question_id': question_id,
      'document_id': str(state.get('document_id') or document_id),
      'document_name': str(state.get('document_name') or ''),
      'document_type': str(state.get('document_type') or ''),
      'page_number': question.get('page_number'),
      'title': question.get('title'),
      'content': question.get('content'),
      'analysis': question.get('analysis'),
      'page_numbers': question.get('page_numbers') or [question.get('page_number')],
      'source_block_ids': question.get('source_block_ids') or [],
      'source_segment_ids': question.get('source_segment_ids') or [],
    }
