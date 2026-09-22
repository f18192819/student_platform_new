# DeepSeek Web Local Debug Bridge

This local-only service drives the public DeepSeek web UI through Playwright. It does not read browser cookies, persist credentials, extract tokens, or call private DeepSeek endpoints.

```powershell
python -m pip install -r tools/deepseek_web_bridge/requirements.txt
python -m playwright install chromium
```

Start the main backend and select `deepseek-web` for question answering or grading/OCR.
The backend automatically starts the Bridge when that mode is selected, including when
the provider is switched at runtime. API-only mode does not start it. The PowerShell
script remains available for standalone diagnostics:

```powershell
.\scripts\start_deepseek_web_bridge.ps1
```

The Bridge listens on `127.0.0.1:8765`. The first launch opens a dedicated persistent
profile under `.runtime/deepseek-web-profile`; complete login manually in that browser
window. Login cookies are not copied from the normal browser. If the session expires,
manual login is required again.

Endpoints: `GET /health`, `GET /status`, `POST /browser/open`, `POST /v1/chat`, and
multipart `POST /v1/ocr`. The main service also exposes combined diagnostics at
`GET http://127.0.0.1:8000/api/deepseek-web/status`.
