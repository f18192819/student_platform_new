from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
  prompt: str = Field(min_length=1, max_length=200_000)
  conversation_id: str | None = None
  response_format: Literal['text', 'json'] = 'text'


class ChatResponse(BaseModel):
  text: str
  provider: str = 'deepseek-web'


class OcrResponse(BaseModel):
  text: str
  provider: str = 'deepseek-web'
  page_count: int


class BridgeStatus(BaseModel):
  browser_running: bool
  logged_in: bool
  chat_available: bool
  image_upload_available: bool
