# DeepSeek Web Local Debug Bridge

This local-only service drives the public DeepSeek web UI through Playwright. It does not read browser cookies, persist credentials, extract tokens, or call private DeepSeek endpoints.

```powershell
python -m pip install -r tools/deepseek_web_bridge/requirements.txt
python -m playwright install chromium
.\scripts\start_deepseek_web_bridge.ps1
```

The bridge listens on `127.0.0.1:8765`. The first launch opens a dedicated persistent profile under `.runtime/deepseek-web-profile`; complete login manually in that browser window.

Endpoints: `GET /health`, `GET /status`, `POST /browser/open`, `POST /v1/chat`, and multipart `POST /v1/ocr`.
