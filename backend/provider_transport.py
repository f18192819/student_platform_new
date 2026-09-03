from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Any

import requests


_API_SUFFIX = re.compile(
  r'/(?:chat/completions|embeddings|rerank|audio/transcriptions|models|ocr)$',
  re.IGNORECASE,
)

_MULTIMODAL_PROTOCOL_ERRORS = (
  'expected str instance, list found',
  'multimodal content unsupported',
  'multimodal content is not supported',
  'image content unsupported',
  'image content is not supported',
)
_OCR_PROTOCOL_ERRORS = (
  'ocr is not supported for provider',
  'ocr endpoint is not supported',
  'unsupported ocr endpoint',
)


class ProviderTransportError(RuntimeError):
  """Normalized failure raised by an OpenAI-compatible provider transport."""

  def __init__(
    self,
    message: str,
    *,
    status_code: int | None = None,
    error_type: str = 'provider_error',
  ) -> None:
    super().__init__(message)
    self.status_code = status_code
    self.error_type = error_type


def normalize_openai_api_root(base_url: str) -> str:
  normalized = str(base_url or '').strip().rstrip('/')
  return _API_SUFFIX.sub('', normalized)


def is_multimodal_protocol_error(error: BaseException | str) -> bool:
  if isinstance(error, ProviderTransportError) and error.error_type == 'multimodal_protocol_error':
    return True
  message = str(error or '').casefold()
  return any(marker in message for marker in _MULTIMODAL_PROTOCOL_ERRORS)


def is_ocr_protocol_error(error: BaseException | str) -> bool:
  message = str(error or '').casefold()
  return any(marker in message for marker in _OCR_PROTOCOL_ERRORS)


def _response_detail(response: requests.Response, limit: int = 1000) -> str:
  try:
    return str(response.text or '').strip()[:limit]
  except Exception:  # noqa: BLE001 - diagnostics must not hide the provider failure.
    return ''


def _contains_multimodal_content(messages: list[dict[str, Any]]) -> bool:
  return any(isinstance(message.get('content'), list) for message in messages)


def extract_json_object(content: str) -> dict[str, Any]:
  """Extract the first complete JSON object from a provider response."""
  cleaned = str(content or '').strip()
  if cleaned.startswith('```'):
    cleaned = re.sub(
      r'^```(?:json)?\s*|\s*```$',
      '',
      cleaned,
      flags=re.IGNORECASE,
    ).strip()
  decoder = json.JSONDecoder()
  for match in re.finditer(r'\{', cleaned):
    try:
      value, _ = decoder.raw_decode(cleaned[match.start():])
    except json.JSONDecodeError:
      continue
    if isinstance(value, dict):
      return value
  raise ProviderTransportError(
    'Provider response does not contain a JSON object.',
    error_type='invalid_json',
  )


class StructuredChatClient:
  """Transport-only client for structured OpenAI-compatible chat requests."""

  def __init__(self, post: Callable[..., requests.Response] | None = None) -> None:
    self._post = post or requests.post

  def complete_json(
    self,
    *,
    base_url: str,
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    schema: dict[str, Any] | None,
    schema_name: str = 'structured_response',
    timeout: float = 120,
    temperature: float = 0,
    extra_payload: dict[str, Any] | None = None,
    allow_plain_fallback: bool = False,
  ) -> dict[str, Any]:
    root = normalize_openai_api_root(base_url)
    if not root or not str(api_key or '').strip() or not str(model or '').strip():
      raise ProviderTransportError(
        'Provider base URL, API key, and model are required.',
        error_type='configuration_error',
      )

    payload: dict[str, Any] = {
      'model': model,
      'temperature': temperature,
      'messages': messages,
      **(extra_payload or {}),
    }
    response_formats: list[dict[str, Any] | None] = []
    if schema is not None:
      response_formats.append({
        'type': 'json_schema',
        'json_schema': {
          'name': schema_name,
          'strict': True,
          'schema': schema,
        },
      })
    response_formats.append({'type': 'json_object'})
    if allow_plain_fallback:
      response_formats.append(None)

    last_response: requests.Response | None = None
    last_parse_error: ProviderTransportError | None = None
    for response_format in response_formats:
      request_payload = dict(payload)
      if response_format is not None:
        request_payload['response_format'] = response_format
      try:
        response = self._post(
          f'{root}/chat/completions',
          headers={
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json',
          },
          json=request_payload,
          timeout=timeout,
        )
      except requests.RequestException as exc:
        raise ProviderTransportError(
          f'Provider request failed: {exc}',
          error_type='network_error',
        ) from exc
      last_response = response
      if response.status_code >= 400:
        detail = _response_detail(response)
        if _contains_multimodal_content(messages) and is_multimodal_protocol_error(detail):
          raise ProviderTransportError(
            f'Provider returned HTTP {response.status_code}: {detail}',
            status_code=response.status_code,
            error_type='multimodal_protocol_error',
          )
        continue
      try:
        content = response.json()['choices'][0]['message']['content']
      except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise ProviderTransportError(
          f'Provider returned an invalid chat completion payload: {exc}',
          status_code=response.status_code,
          error_type='invalid_response',
        ) from exc
      try:
        return extract_json_object(str(content))
      except ProviderTransportError as exc:
        last_parse_error = exc
        continue

    if (
      last_parse_error is not None
      and last_response is not None
      and last_response.status_code < 400
    ):
      raise ProviderTransportError(
        str(last_parse_error),
        status_code=last_response.status_code,
        error_type='invalid_json',
      ) from last_parse_error

    status_code = last_response.status_code if last_response is not None else None
    detail = ''
    if last_response is not None:
      detail = _response_detail(last_response)
    message = f'Provider returned HTTP {status_code}' if status_code else 'Provider request failed'
    if detail:
      message = f'{message}: {detail}'
    raise ProviderTransportError(
      message,
      status_code=status_code,
      error_type='http_error',
    )


class MultimodalChatClient(StructuredChatClient):
  """Narrow transport for OpenAI-compatible image + structured JSON requests."""

  def complete_json(
    self,
    *,
    base_url: str,
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    schema: dict[str, Any] | None,
    schema_name: str = 'multimodal_response',
    timeout: float = 180,
    temperature: float = 0,
    extra_payload: dict[str, Any] | None = None,
    allow_plain_fallback: bool = False,
  ) -> dict[str, Any]:
    return super().complete_json(
      base_url=base_url,
      api_key=api_key,
      model=model,
      messages=messages,
      schema=schema,
      schema_name=schema_name,
      timeout=timeout,
      temperature=temperature,
      extra_payload=extra_payload,
      allow_plain_fallback=allow_plain_fallback,
    )


class LiteLLMOcrClient:
  """Narrow client for LiteLLM's document OCR endpoint."""

  def __init__(self, post: Callable[..., requests.Response] | None = None) -> None:
    self._post = post or requests.post

  def transcribe(
    self,
    *,
    base_url: str,
    api_key: str,
    model: str,
    image_url: str,
    timeout: float = 180,
  ) -> str:
    root = normalize_openai_api_root(base_url)
    if not root or not str(api_key or '').strip() or not str(model or '').strip():
      raise ProviderTransportError(
        'Provider base URL, API key, and OCR model are required.',
        error_type='configuration_error',
      )
    try:
      response = self._post(
        f'{root}/ocr',
        headers={
          'Authorization': f'Bearer {api_key}',
          'Content-Type': 'application/json',
        },
        json={
          'model': model,
          'document': {
            'type': 'image_url',
            'image_url': image_url,
          },
        },
        timeout=timeout,
      )
    except requests.RequestException as exc:
      raise ProviderTransportError(
        f'OCR provider request failed: {exc}',
        error_type='network_error',
      ) from exc
    if response.status_code >= 400:
      detail = _response_detail(response)
      message = f'OCR provider returned HTTP {response.status_code}'
      if detail:
        message = f'{message}: {detail}'
      raise ProviderTransportError(
        message,
        status_code=response.status_code,
        error_type='http_error',
      )
    try:
      payload = response.json()
    except ValueError as exc:
      raise ProviderTransportError(
        'OCR provider returned invalid JSON.',
        status_code=response.status_code,
        error_type='invalid_response',
      ) from exc
    pages = payload.get('pages') if isinstance(payload, dict) else None
    if not isinstance(pages, list) and isinstance(payload, dict) and isinstance(payload.get('data'), dict):
      pages = payload['data'].get('pages')
    markdown_pages = [
      str(page.get('markdown') or '').strip()
      for page in pages or []
      if isinstance(page, dict) and str(page.get('markdown') or '').strip()
    ]
    if not markdown_pages:
      raise ProviderTransportError(
        'OCR provider response does not contain pages[].markdown.',
        status_code=response.status_code,
        error_type='invalid_response',
      )
    return '\n\n'.join(markdown_pages)


__all__ = [
  'ProviderTransportError',
  'LiteLLMOcrClient',
  'MultimodalChatClient',
  'StructuredChatClient',
  'extract_json_object',
  'is_multimodal_protocol_error',
  'is_ocr_protocol_error',
  'normalize_openai_api_root',
]
