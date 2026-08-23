from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIST = PROJECT_ROOT / 'frontend' / 'dist'
PUBLIC_DIR = PROJECT_ROOT / 'public'
UI_PREFIX = '/ui/service/student-learning-platform-demo'

AUDIO_CHUNK_SECONDS = float(os.environ.get('ASR_AUDIO_CHUNK_SECONDS', '60'))
CLOUD_ASR_CHUNK_SECONDS = float(os.environ.get('CLOUD_ASR_AUDIO_CHUNK_SECONDS', '25'))
AUDIO_CHUNK_SAMPLE_RATE = int(os.environ.get('ASR_AUDIO_CHUNK_SAMPLE_RATE', '16000'))
AUDIO_REQUEST_TIMEOUT_SECONDS = float(os.environ.get('ASR_REQUEST_TIMEOUT_SECONDS', '300'))
LOCAL_ASR_MODEL = os.environ.get('LOCAL_ASR_MODEL', 'paraformer-zh').strip() or 'paraformer-zh'
# Keep operational ASR diagnostics under runtime storage instead of the source
# tree. The writer retains only recent transcripts so repeated uploads do not
# grow the workspace without bound.
ASR_DEBUG_DIR = PROJECT_ROOT / '.runtime' / 'debug' / 'asr'
ASR_DEBUG_TRANSCRIPT_LIMIT = max(1, int(os.environ.get('ASR_DEBUG_TRANSCRIPT_LIMIT', '12')))

CLASSROOM_EMBEDDING_MODEL = (
  os.environ.get('CLASSROOM_EMBEDDING_MODEL', 'GLM-Embedding-3').strip()
  or 'GLM-Embedding-3'
)
CLASSROOM_RERANK_MODEL = (
  os.environ.get('CLASSROOM_RERANK_MODEL', 'GLM-Rerank').strip() or 'GLM-Rerank'
)
CLASSROOM_MAPPING_MODEL = (
  os.environ.get('CLASSROOM_MAPPING_MODEL', 'DeepSeek-V4-Flash').strip()
  or 'DeepSeek-V4-Flash'
)
CLASSROOM_EMBEDDING_BATCH_SIZE = 16
CLASSROOM_PAGE_CANDIDATE_COUNT = 8
CLASSROOM_PAGE_TOP_COUNT = 3
CLASSROOM_PAGE_WINDOW_PADDING = 6

LOCAL_ASR_PYTHON = Path(os.environ.get('LOCAL_ASR_PYTHON', r'C:\anaconda3\python.exe')).expanduser()
LOCAL_ASR_SCRIPT = PROJECT_ROOT / 'scripts' / 'local_funasr_transcribe.py'
LOCAL_ASR_CACHE_ROOT = Path(
  os.environ.get(
    'LOCAL_ASR_CACHE_ROOT',
    str(Path.home() / '.cache' / 'modelscope' / 'hub' / 'models' / 'iic'),
  )
).expanduser()
LOCAL_ASR_MODEL_DIR = Path(
  os.environ.get(
    'LOCAL_ASR_MODEL_DIR',
    str(
      LOCAL_ASR_CACHE_ROOT
      / 'speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch'
    ),
  )
).expanduser()
LOCAL_ASR_VAD_DIR = Path(
  os.environ.get(
    'LOCAL_ASR_VAD_DIR',
    str(LOCAL_ASR_CACHE_ROOT / 'speech_fsmn_vad_zh-cn-16k-common-pytorch'),
  )
).expanduser()
LOCAL_ASR_PUNC_DIR = Path(
  os.environ.get(
    'LOCAL_ASR_PUNC_DIR',
    str(LOCAL_ASR_CACHE_ROOT / 'punc_ct-transformer_cn-en-common-vocab471067-large'),
  )
).expanduser()
LOCAL_ASR_DEVICE = os.environ.get('LOCAL_ASR_DEVICE', '').strip()
