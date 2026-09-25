import asyncio
import contextlib
import io
import sys
import unittest

from scripts import serve_local


class FakeServer:
  def __init__(self, failure=None):
    self.failure = failure
    self.should_exit = False
    self.loop_name = None

  async def serve(self):
    self.loop_name = type(asyncio.get_running_loop()).__name__
    if self.failure is not None:
      raise self.failure
    self.should_exit = True


class LocalServerTests(unittest.TestCase):
  @unittest.skipUnless(sys.platform == 'win32', 'Windows Selector loop only')
  def test_windows_uses_selector_loop(self):
    server = FakeServer()
    with contextlib.redirect_stdout(io.StringIO()) as output:
      serve_local.run_server(server)
    self.assertIn('SelectorEventLoop', server.loop_name)
    self.assertIn(f'loop={server.loop_name}', output.getvalue())

  def test_crash_restarts_with_bounded_backoff(self):
    servers = [FakeServer(OSError(64, 'Accept failed')) for _ in range(4)]
    servers.append(FakeServer())
    delays = []
    with contextlib.redirect_stdout(io.StringIO()), self.assertLogs('local_server', level='ERROR') as logs:
      serve_local.serve_with_restarts(lambda: servers.pop(0), sleep=delays.append)
    self.assertEqual(delays, [1, 2, 5, 5])
    self.assertEqual(servers, [])
    self.assertEqual(len(logs.records), 4)

  def test_keyboard_interrupt_does_not_restart(self):
    calls = []

    def factory():
      calls.append(1)
      return FakeServer(KeyboardInterrupt())

    with contextlib.redirect_stdout(io.StringIO()):
      serve_local.serve_with_restarts(factory, sleep=lambda _: self.fail('unexpected restart'))
    self.assertEqual(calls, [1])


if __name__ == '__main__':
  unittest.main()
