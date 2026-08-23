from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

from app import transcribe_audio_file_with_chunking


def _parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(
    description="Transcribe local media with chunked FunASR and write Markdown."
  )
  parser.add_argument("--input", required=True, help="Source audio or video file.")
  parser.add_argument("--markdown-output", required=True, help="Target Markdown path.")
  parser.add_argument("--result-output", required=True, help="Target JSON result path.")
  return parser.parse_args()


def main() -> int:
  args = _parse_args()
  source_path = Path(args.input).expanduser().resolve()
  markdown_output = Path(args.markdown_output).expanduser().resolve()
  result_output = Path(args.result_output).expanduser().resolve()

  if not source_path.is_file():
    raise FileNotFoundError(f"Media file not found: {source_path}")

  result = transcribe_audio_file_with_chunking(source_path)
  generated_markdown = (PROJECT_ROOT / result["markdown_path"]).resolve()
  if not generated_markdown.is_file():
    raise FileNotFoundError(f"ASR Markdown was not generated: {generated_markdown}")

  markdown_output.parent.mkdir(parents=True, exist_ok=True)
  result_output.parent.mkdir(parents=True, exist_ok=True)
  shutil.copyfile(generated_markdown, markdown_output)
  result_output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
  print(json.dumps({
    "markdown_output": str(markdown_output),
    "result_output": str(result_output),
    "chunk_count": result["chunk_count"],
  }, ensure_ascii=False))
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
