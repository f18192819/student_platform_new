"""Run the local API with a Windows socket loop that survives sleep/wake."""

from __future__ import annotations

import asyncio
import logging
import sys
import time
from pathlib import Path
from typing import Callable

import uvicorn


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
  sys.path.insert(0, str(PROJECT_ROOT))

HOST = '127.0.0.1'
PORT = 8000
RESTART_DELAYS_SECONDS = (1, 2, 5)
LOG = logging.getLogger('local_server')


async def _serve(server: uvicorn.Server) -> None:
  loop = asyncio.get_running_loop()
  print(
    f'[local server] python={sys.version.split()[0]} '
    f'uvicorn={uvicorn.__version__} platform={sys.platform} '
    f'loop={type(loop).__name__} host={HOST} port={PORT}',
    flush=True,
  )
  await server.serve()
  if not server.should_exit:
    raise RuntimeError('Uvicorn stopped without a shutdown request')


def run_server(server: uvicorn.Server) -> None:
  if sys.platform == 'win32':
    with asyncio.Runner(loop_factory=asyncio.SelectorEventLoop) as runner:
      runner.run(_serve(server))
  else:
    asyncio.run(_serve(server))


def serve_with_restarts(
  server_factory: Callable[[], uvicorn.Server],
  *,
  sleep: Callable[[float], None] = time.sleep,
) -> None:
  failures = 0
  while True:
    server = server_factory()
    started_at = time.monotonic()
    try:
      run_server(server)
      return
    except KeyboardInterrupt:
      return
    except Exception:
      LOG.exception('[local server crashed]')

    if time.monotonic() - started_at >= 60:
      failures = 0
    delay = RESTART_DELAYS_SECONDS[min(failures, len(RESTART_DELAYS_SECONDS) - 1)]
    failures += 1
    try:
      sleep(delay)
    except KeyboardInterrupt:
      return


def main() -> None:
  logging.basicConfig(level=logging.INFO)
  serve_with_restarts(lambda: uvicorn.Server(uvicorn.Config(
    'app:app', host=HOST, port=PORT, loop='none',
  )))


if __name__ == '__main__':
  main()
