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
const skipHomework = process.env.PDF_SMOKE_SKIP_HOMEWORK === '1'
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

  const geometry = await page.locator(`[data-page-number='${pageNumber}']`).evaluate((article) => {
    const surface = article.querySelector('.pdf-stage__page-surface')
    const canvas = article.querySelector('canvas.pdf-stage__page-canvas')
    if (!(surface instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) return null
    const surfaceRect = surface.getBoundingClientRect()
    const canvasRect = canvas.getBoundingClientRect()
    return {
      surfaceWidth: surfaceRect.width,
      surfaceHeight: surfaceRect.height,
      canvasWidth: canvasRect.width,
      canvasHeight: canvasRect.height,
      visibility: getComputedStyle(canvas).visibility,
    }
  })
  assert.ok(geometry, `Page ${pageNumber} did not expose measurable geometry.`)
  assert.equal(geometry.visibility, 'visible')
  assert.ok(Math.abs(geometry.surfaceWidth - geometry.canvasWidth) < 2, JSON.stringify(geometry))
  assert.ok(Math.abs(geometry.surfaceHeight - geometry.canvasHeight) < 2, JSON.stringify(geometry))
}

async function readPageGeometry(page, pageNumber) {
  return page.locator(`[data-page-number='${pageNumber}'] .pdf-stage__page-surface`).evaluate((surface) => {
    const rect = surface.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  })
}

async function assertNoCanvasLifecycleViolations(page) {
  const violations = await page.evaluate(() => window.__pdfCanvasLifecycleViolations ?? [])
  assert.deepEqual(violations, [], JSON.stringify(violations, null, 2))
}

async function readFirstVisualTiming(page, pageNumber) {
  return page.evaluate((number) => {
    const marks = performance.getEntriesByType('mark')
    const find = (prefix) => marks.find(entry => entry.name.startsWith(prefix))?.startTime ?? null
    const documentReady = find('pdf:document-ready:')
    const renderStart = find(`pdf:render-start:page-${number}:`)
    const renderComplete = find(`pdf:render-complete:page-${number}:`)
    const visualReady = find(`pdf:visual-ready:page-${number}:`)
    const neighborRenderStart = marks.find(
      entry => entry.name.startsWith('pdf:render-start:page-')
        && !entry.name.startsWith(`pdf:render-start:page-${number}:`),
    )?.startTime ?? null
    return {
      documentReadyToFirstVisualMs:
        documentReady === null || visualReady === null ? null : visualReady - documentReady,
      currentRenderMs:
        renderStart === null || renderComplete === null ? null : renderComplete - renderStart,
      neighborStartedBeforeFirstVisual:
        neighborRenderStart !== null && visualReady !== null && neighborRenderStart < visualReady,
    }
  }, pageNumber)
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
  const names = {
    'smoke-a': 'Smoke A.pdf',
    'smoke-b': 'Smoke B.pdf',
    'smoke-120': 'Smoke 120.pdf',
    'smoke-landscape': 'Smoke Landscape.pdf',
    'smoke-mixed': 'Smoke Mixed.pdf',
  }
  const name = names[fileId]
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

async function readReaderLayout(page) {
  return page.evaluate(() => {
    const measure = (selector) => {
      const element = document.querySelector(selector)
      if (!(element instanceof HTMLElement)) return null
      const rect = element.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      }
    }
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      shell: measure('.app-shell--reader-page'),
      workspace: measure('.reader-workspace'),
      main: measure('.reader-workspace__main'),
      stage: measure('.reader-workspace__stage-frame'),
      left: measure('.reader-workspace__left'),
      right: measure('.reader-workspace__right'),
      leftRail: measure('.reader-workspace__activity--left'),
      rightRail: measure('.reader-workspace__activity--right'),
      header: measure('.octopus-app-header--reader'),
      leftOpen: document.querySelector('.reader-workspace__left')?.getAttribute('data-open'),
      rightOpen: document.querySelector('.reader-workspace__right')?.getAttribute('data-open'),
    }
  })
}

function assertNear(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected} +/- ${tolerance}, got ${actual}`)
}

async function verifyReaderLayout(page, width, height) {
  await page.setViewportSize({ width, height })
  await openDirectLecture(page, 'smoke-a', 1)
  let layout = await readReaderLayout(page)
  assert.equal(layout.leftOpen, 'false')
  assert.equal(layout.rightOpen, 'false')
  assertNear(layout.shell.bottom, height, 2, 'reader shell bottom')
  assertNear(layout.workspace.bottom, height, 2, 'reader workspace bottom')
  assert.ok(layout.header.height >= 58 && layout.header.height <= 62, JSON.stringify(layout))
  assertNear(layout.leftRail.width, 56, 1, 'left activity rail width')
  assertNear(layout.rightRail.width, 56, 1, 'right activity rail width')
  assert.ok(layout.stage.width >= layout.main.width * 0.8, JSON.stringify(layout))
  const defaultStageWidth = layout.stage.width

  await page.locator('.reader-activity-bar--right button').first().click()
  await page.waitForTimeout(550)
  layout = await readReaderLayout(page)
  assert.equal(layout.rightOpen, 'true')
  assert.ok(layout.right.width >= 378 && layout.right.width <= 442, JSON.stringify(layout))
  assert.ok(defaultStageWidth - layout.stage.width >= layout.right.width - 3, JSON.stringify(layout))
  assert.ok(layout.stage.right <= layout.right.left + 2, JSON.stringify(layout))

  await page.locator('.reader-activity-bar--right button').first().click()
  await page.waitForTimeout(550)
  layout = await readReaderLayout(page)
  assertNear(layout.stage.width, defaultStageWidth, 2, 'stage width after closing AI')

  await page.locator('.reader-activity-bar--left button').nth(1).click()
  await page.locator('.reader-activity-bar--right button').first().click()
  await page.waitForTimeout(550)
  layout = await readReaderLayout(page)
  assert.equal(layout.leftOpen, 'true')
  assert.equal(layout.rightOpen, 'true')
  assert.ok(layout.left.width >= 298 && layout.left.width <= 352, JSON.stringify(layout))
  assert.ok(layout.right.width >= 378 && layout.right.width <= 442, JSON.stringify(layout))
  assert.ok(layout.left.right <= layout.stage.left + 2, JSON.stringify(layout))
  assert.ok(layout.stage.right <= layout.right.left + 2, JSON.stringify(layout))

  return {
    viewport: `${width}x${height}`,
    headerHeight: layout.header.height,
    leftPanelWidth: layout.left.width,
    rightPanelWidth: layout.right.width,
    stageWidthWithBothPanels: layout.stage.width,
    defaultStageWidth,
    workspaceBottom: layout.workspace.bottom,
  }
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
    const messageText = message.text()
    const isNavigationAbortedPersistence =
      messageText.includes('persistKnowledgeLibrary failed: TypeError: Failed to fetch')
    if (
      message.type() === 'error' &&
      !messageText.includes('Failed to load resource') &&
      !isNavigationAbortedPersistence
    ) {
      runtimeErrors.push(messageText)
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
  await page.addInitScript(() => {
    window.__pdfCanvasLifecycleViolations = []
    const recorded = new WeakSet()
    const inspectCanvas = (canvas) => {
      if (!(canvas instanceof HTMLCanvasElement) || recorded.has(canvas)) return
      const surface = canvas.closest('.pdf-stage__page-surface')
      const ready = canvas.dataset.visualReady === 'true' && surface?.getAttribute('data-visual-ready') === 'true'
      const visibility = getComputedStyle(canvas).visibility
      if (!ready && visibility !== 'hidden') {
        recorded.add(canvas)
        window.__pdfCanvasLifecycleViolations.push({
          type: 'unready-canvas-visible',
          width: canvas.width,
          height: canvas.height,
          visibility,
        })
      }
    }
    const start = () => {
      document.querySelectorAll('canvas.pdf-stage__page-canvas').forEach(inspectCanvas)
      new MutationObserver((records) => {
        records.forEach((record) => {
          if (record.type === 'attributes') inspectCanvas(record.target)
          record.addedNodes.forEach((node) => {
            inspectCanvas(node)
            if (node instanceof Element) {
              node.querySelectorAll('canvas.pdf-stage__page-canvas').forEach(inspectCanvas)
            }
          })
        })
      }).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'data-visual-ready', 'style'],
        childList: true,
        subtree: true,
      })
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
    else start()
  })
  await page.goto(`${appOrigin}/pdf?file=smoke-a&course=smoke-course&page=1`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
  await waitForDocument(page, 'Smoke A.pdf', 1)
  await assertNoCanvasLifecycleViolations(page)
  const firstVisualTiming = await readFirstVisualTiming(page, 1)

  const layoutMeasurements = []
  layoutMeasurements.push(await verifyReaderLayout(page, 1440, 900))
  layoutMeasurements.push(await verifyReaderLayout(page, 1920, 1080))

  await openLecture(page, 'smoke-landscape', 1)
  const landscape = await readPageGeometry(page, 1)
  assert.ok(landscape.width > landscape.height, JSON.stringify(landscape))

  await openLecture(page, 'smoke-mixed', 1)
  const mixedPortrait = await readPageGeometry(page, 1)
  assert.ok(mixedPortrait.height > mixedPortrait.width, JSON.stringify(mixedPortrait))
  await page.getByRole('button', { name: '下一页' }).click()
  await waitForCanvas(page, 2)
  const mixedLandscape = await readPageGeometry(page, 2)
  assert.ok(mixedLandscape.width > mixedLandscape.height, JSON.stringify(mixedLandscape))
  await page.getByRole('button', { name: '下一页' }).click()
  await waitForCanvas(page, 3)
  const mixedTallPortrait = await readPageGeometry(page, 3)
  assert.ok(mixedTallPortrait.height > mixedTallPortrait.width, JSON.stringify(mixedTallPortrait))
  await assertNoCanvasLifecycleViolations(page)

  await openLecture(page, 'smoke-a', 1)

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

  if (!skipHomework) {
    // Keep the attachment regression independent from the document-switch stress run.
    await openDirectLecture(page, 'smoke-a', 1)
    for (let iteration = 0; iteration < 10; iteration += 1) {
      await openLecture(page, 'smoke-a', 1)
      await page.locator('.toolbar-pill--knowledge').first().click()
      await waitForDocument(page, 'Smoke Homework.pdf', 1)
      await openLecture(page, 'smoke-b', 1)
      await openLecture(page, 'smoke-a', 1)
    }
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
  await assertNoCanvasLifecycleViolations(page)
  assert.ok(
    rangeResponses.some(response => response.status === 206 && response.range),
    `Browser did not complete an HTTP Range request: ${JSON.stringify(rangeResponses)}`,
  )
  assert.ok(rangeResponses.some(response => response.acceptRanges === 'bytes'), 'Browser PDF response omitted Accept-Ranges.')
  console.log(JSON.stringify({
    pdfReaderSmoke: 'passed',
    stabilityIterations: 10,
    rangeResponseCount: rangeResponses.filter(response => response.status === 206).length,
    firstVisualTiming,
    layoutMeasurements,
  }))
  await context.close()
} finally {
  if (browser) await browser.close()
  for (const child of children.reverse()) child.kill()
}
