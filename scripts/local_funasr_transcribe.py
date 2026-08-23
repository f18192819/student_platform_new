from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any


def _parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description="Batch transcription with local FunASR models.")
  parser.add_argument("--input", nargs="+", required=True, help="One or more audio paths.")
  parser.add_argument("--output", required=True, help="Output JSON path.")
  parser.add_argument("--model-dir", required=True, help="Local ASR model directory.")
  parser.add_argument("--vad-dir", required=True, help="Local VAD model directory.")
  parser.add_argument("--punc-dir", required=True, help="Local punctuation model directory.")
  parser.add_argument("--device", default="", help="Force device, for example cuda:0 or cpu.")
  return parser.parse_args()


def _clean_text(text: str) -> str:
  return " ".join(text.replace("\r", " ").replace("\n", " ").split()).strip()


def _audio_duration_seconds(audio_path: Path) -> float | None:
  try:
    import soundfile as sf

    return round(float(sf.info(str(audio_path)).duration), 3)
  except Exception:
    return None


def _extract_result(generated: Any, audio_path: Path) -> dict[str, Any]:
  generated_items = generated if isinstance(generated, list) else [generated]
  text_parts: list[str] = []
  segments: list[dict[str, Any]] = []

  for result in generated_items:
    if not isinstance(result, dict):
      continue
    text = _clean_text(str(result.get("text") or ""))
    if text and (not text_parts or text != text_parts[-1]):
      text_parts.append(text)

    sentence_info = result.get("sentence_info")
    if not isinstance(sentence_info, list):
      continue
    for item in sentence_info:
      if not isinstance(item, dict):
        continue
      text = _clean_text(str(item.get("sentence") or item.get("text") or ""))
      if not text:
        continue
      segments.append(
        {
          "start": item.get("start"),
          "end": item.get("end"),
          "text": text,
        }
      )

  return {
    "file_path": str(audio_path),
    "file_name": audio_path.name,
    "text": "\n".join(text_parts).strip(),
    "segments": segments,
    "duration_seconds": _audio_duration_seconds(audio_path),
  }


def _write_payload(
  output_path: Path,
  *,
  device: str,
  model_dir: Path,
  vad_dir: Path,
  punc_dir: Path,
  started_at: float,
  results: list[dict[str, Any]],
) -> None:
  """Atomically persist completed chunks so a long job remains inspectable."""
  payload = {
    "device": device,
    "model_dir": str(model_dir),
    "vad_dir": str(vad_dir),
    "punc_dir": str(punc_dir),
    "processing_seconds": round(time.time() - started_at, 3),
    "results": results,
  }
  serialized = json.dumps(payload, ensure_ascii=False, indent=2)
  last_error: PermissionError | None = None
  for attempt in range(6):
    temporary_path = output_path.with_name(f".{output_path.name}.{uuid.uuid4().hex}.tmp")
    try:
      temporary_path.write_text(serialized, encoding="utf-8")
      os.replace(temporary_path, output_path)
      return
    except PermissionError as exc:
      last_error = exc
      if attempt < 5:
        time.sleep(0.1 * (attempt + 1))
    finally:
      try:
        temporary_path.unlink(missing_ok=True)
      except OSError:
        pass
  if last_error is not None:
    raise last_error


def main() -> int:
  args = _parse_args()
  output_path = Path(args.output).expanduser().resolve()
  output_path.parent.mkdir(parents=True, exist_ok=True)

  input_paths = [Path(item).expanduser().resolve() for item in args.input]
  for input_path in input_paths:
    if not input_path.is_file():
      raise FileNotFoundError(f"Audio file not found: {input_path}")

  model_dir = Path(args.model_dir).expanduser().resolve()
  vad_dir = Path(args.vad_dir).expanduser().resolve()
  punc_dir = Path(args.punc_dir).expanduser().resolve()

  for required_path in (model_dir, vad_dir, punc_dir):
    if not required_path.is_dir():
      raise FileNotFoundError(f"Required FunASR model directory not found: {required_path}")

  os.environ.setdefault("HF_HUB_OFFLINE", "1")
  os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

  import torch
  from funasr import AutoModel

  device = args.device.strip() or ("cuda:0" if torch.cuda.is_available() else "cpu")

  started_at = time.time()
  model = AutoModel(
    model=str(model_dir),
    vad_model=str(vad_dir),
    punc_model=str(punc_dir),
    device=device,
    disable_update=True,
  )

  results: list[dict[str, Any]] = []
  for input_path in input_paths:
    one_started_at = time.time()
    try:
      generated = model.generate(input=str(input_path), batch_size=1)
      item = _extract_result(generated, input_path)
    except Exception as exc:  # noqa: BLE001
      item = {
        "file_path": str(input_path),
        "file_name": input_path.name,
        "text": "",
        "segments": [],
        "duration_seconds": _audio_duration_seconds(input_path),
        "error": str(exc),
      }
    item["processing_seconds"] = round(time.time() - one_started_at, 3)
    results.append(item)
    _write_payload(
      output_path,
      device=device,
      model_dir=model_dir,
      vad_dir=vad_dir,
      punc_dir=punc_dir,
      started_at=started_at,
      results=results,
    )
  return 0


if __name__ == "__main__":
  try:
    raise SystemExit(main())
  except Exception as exc:  # noqa: BLE001
    error_payload = {
      "error": str(exc),
      "error_type": type(exc).__name__,
    }
    sys.stderr.write(json.dumps(error_payload, ensure_ascii=False) + "\n")
    raise
