import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = fileURLToPath(new URL('..', import.meta.url))
const browserPath = process.env.PDF_SMOKE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const appOrigin = 'http://127.0.0.1:4174'
const apiOrigin = 'http://127.0.0.1:18081'
const python = process.env.PYTHON || 'python'
const viteScript = 'node_modules/vite/bin/vite.js'
const children = []

function start(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, PYTHONUNBUFFERED: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', chunk => process.stdout.write(chunk))
  child.stderr.on('data', chunk => process.stderr.write(chunk))
  children.push(child)
  return child
}

async function waitForUrl(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

async function waitForCanvas(page, pageNumber, timeout = 30_000) {
  await page.waitForFunction((number) => {
    const article = document.querySelector(`[data-page-number='${number}']`)
    const surface = article?.querySelector('.pdf-stage__page-surface')
    const canvas = article?.querySelector('canvas.pdf-stage__page-canvas')
    if (!(canvas instanceof HTMLCanvasElement) || surface?.getAttribute('data-visual-ready') !== 'true') return false
    if (canvas.width <= 0 || canvas.height <= 0) return false
    const context = canvas.getContext('2d')
    if (!context) return false
    const points = 24
    for (let yi = 0; yi < points; yi += 1) {
      for (let xi = 0; xi < points; xi += 1) {
        const x = Math.min(canvas.width - 1, Math.floor((xi + 0.5) * canvas.width / points))
        const y = Math.min(canvas.height - 1, Math.floor((yi + 0.5) * canvas.height / points))
        const [red, green, blue, alpha] = context.getImageData(x, y, 1, 1).data
        if (alpha > 0 && (red < 245 || green < 245 || blue < 245)) return true
      }
    }
    return false
  }, pageNumber, { timeout })
}

async function waitForDocument(page, name, pageNumber) {
  try {
    await page.locator('.pdf-stage__document strong').filter({ hasText: name }).waitFor({ state: 'visible' })
    await waitForCanvas(page, pageNumber)
  } catch (error) {
    const bodyText = await page.locator('body').innerText().catch(() => '<body unavailable>')
    console.error(JSON.stringify({
      smokeFailure: { name, pageNumber, url: page.url(), bodyText: bodyText.slice(0, 2_000) },
    }, null, 2))
    throw error
  }
}

async function spaNavigate(page, path) {
  await page.evaluate((nextPath) => {
    window.history.pushState({}, '', nextPath)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
}

async function openLecture(page, fileId, pageNumber = 1) {
  await spaNavigate(page, `/pdf?file=${fileId}&course=smoke-course&page=${pageNumber}`)
  const name = fileId === 'smoke-a' ? 'Smoke A.pdf' : fileId === 'smoke-b' ? 'Smoke B.pdf' : 'Smoke 120.pdf'
  await waitForDocument(page, name, pageNumber)
}

async function openDirectLecture(page, fileId, pageNumber) {
  await page.goto(`${appOrigin}/pdf?file=${fileId}&course=smoke-course&page=${pageNumber}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
  const name = fileId === 'smoke-a' ? 'Smoke A.pdf' : fileId === 'smoke-b' ? 'Smoke B.pdf' : 'Smoke 120.pdf'
  await waitForDocument(page, name, pageNumber)
}

let browser
try {
  start(python, ['scripts/pdf_reader_smoke_server.py'])
  start(
    process.execPath,
    [viteScript, '--host', '127.0.0.1', '--port', '4174', '--strictPort'],
    { VITE_API_PROXY_TARGET: apiOrigin },
  )

  await Promise.all([
    waitForUrl(`${apiOrigin}/health`),
    waitForUrl(appOrigin),
  ])

  const directRangeResponse = await fetch(`${apiOrigin}/api/knowledge/pdf/smoke-a`, {
    headers: { Range: 'bytes=0-65535' },
  })
  assert.equal(directRangeResponse.status, 206)
  assert.equal(directRangeResponse.headers.get('accept-ranges'), 'bytes')
  assert.match(directRangeResponse.headers.get('content-range') || '', /^bytes 0-/)
  assert.ok(Number(directRangeResponse.headers.get('content-length')) > 0)

  browser = await chromium.launch({ executablePath: browserPath, headless: true })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const page = await context.newPage()
  const runtimeErrors = []
  const rangeResponses = []

  page.on('pageerror', error => runtimeErrors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
      runtimeErrors.push(message.text())
    }
  })
  page.on('response', response => {
    if (response.url().includes('/api/knowledge/pdf/')) {
      rangeResponses.push({
        status: response.status(),
        range: response.request().headers().range || null,
        acceptRanges: response.headers()['accept-ranges'] || null,
        contentRange: response.headers()['content-range'] || null,
      })
    }
  })
  await page.goto(`${appOrigin}/pdf?file=smoke-a&course=smoke-course&page=1`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
  await waitForDocument(page, 'Smoke A.pdf', 1)

  for (let iteration = 0; iteration < 10; iteration += 1) {
    console.log(`[smoke] refresh-and-turn ${iteration + 1}/10`)
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
    await waitForDocument(page, 'Smoke A.pdf', 1)
    await page.getByRole('button', { name: '下一页' }).click()
    await waitForCanvas(page, 2)
    await page.getByRole('button', { name: '上一页' }).click()
    await waitForCanvas(page, 1)
  }

  await openLecture(page, 'smoke-120', 1)
  await openDirectLecture(page, 'smoke-120', 50)

  for (let iteration = 0; iteration < 10; iteration += 1) {
    await openLecture(page, 'smoke-a', 1)
    await openLecture(page, 'smoke-b', 1)
    await openLecture(page, 'smoke-a', 1)
  }

  for (let iteration = 0; iteration < 10; iteration += 1) {
    await openLecture(page, 'smoke-a', 1)
    await page.locator('.toolbar-pill--knowledge').first().click()
    await waitForDocument(page, 'Smoke Homework.pdf', 1)
    await openLecture(page, 'smoke-b', 1)
    await openLecture(page, 'smoke-a', 1)
  }

  await openLecture(page, 'smoke-a', 1)
  for (let iteration = 0; iteration < 10; iteration += 1) {
    await page.locator('.reader-activity-bar--left button').nth(1).click()
    await waitForCanvas(page, 1)
    await page.locator('.reader-activity-bar--right button').first().click()
    await waitForCanvas(page, 1)
    await page.setViewportSize({ width: iteration % 2 ? 1600 : 1200, height: 900 })
    await waitForCanvas(page, 1)
  }

  await page.setViewportSize({ width: 1600, height: 1000 })
  for (let iteration = 0; iteration < 10; iteration += 1) {
    await page.getByRole('button', { name: '下一页' }).click()
    await page.getByRole('button', { name: '下一页' }).click()
    await page.getByRole('button', { name: '上一页' }).click()
    await page.getByRole('button', { name: '上一页' }).click()
    await waitForCanvas(page, 1)
  }

  assert.equal(runtimeErrors.length, 0, runtimeErrors.join('\n'))
  assert.ok(
    rangeResponses.some(response => response.status === 206 && response.range),
    `Browser did not complete an HTTP Range request: ${JSON.stringify(rangeResponses)}`,
  )
  assert.ok(rangeResponses.some(response => response.acceptRanges === 'bytes'), 'Browser PDF response omitted Accept-Ranges.')
  console.log(JSON.stringify({
    pdfReaderSmoke: 'passed',
    stabilityIterations: 10,
    rangeResponseCount: rangeResponses.filter(response => response.status === 206).length,
  }))
  await context.close()
} finally {
  if (browser) await browser.close()
  for (const child of children.reverse()) child.kill()
}
