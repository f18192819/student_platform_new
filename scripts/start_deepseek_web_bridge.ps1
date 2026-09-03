$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  throw 'Python was not found on PATH.'
}

python -c "import fastapi, uvicorn, multipart, playwright" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'DeepSeek Web Bridge dependencies are missing.' -ForegroundColor Yellow
  Write-Host 'Run: python -m pip install -r tools/deepseek_web_bridge/requirements.txt'
  exit 1
}

$browserCheck = python -c "from pathlib import Path; from playwright.sync_api import sync_playwright; p=sync_playwright().start(); print(Path(p.chromium.executable_path).is_file()); p.stop()"
if ($browserCheck.Trim() -ne 'True') {
  Write-Host 'Playwright Chromium is not installed.' -ForegroundColor Yellow
  Write-Host 'Run: python -m playwright install chromium'
  exit 1
}

python -m uvicorn tools.deepseek_web_bridge.app:app --host 127.0.0.1 --port 8765
