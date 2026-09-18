import { chromium } from 'playwright-core'

const browser = await chromium.launch({
  executablePath: process.env.PDF_BENCH_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
})
const useClick = process.argv.includes('--click')
try {
  for (const count of [10, 50, 120]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url())
      const response = await route.fetch({ url: `http://127.0.0.1:18080${url.pathname}${url.search}` })
      await route.fulfill({ response })
    })
    const rangeRequests = []
    page.on('response', response => {
      if (response.url().includes(`/api/knowledge/pdf/benchmark-${count}`)) {
        rangeRequests.push({ status: response.status(), range: response.request().headers().range || null })
      }
    })
    await page.addInitScript(() => {
      window.__pdfBench = {}
      const observe = () => {
        if (!location.pathname.startsWith('/pdf')) return requestAnimationFrame(observe)
        const start = window.__pdfBench.start ?? performance.now()
        window.__pdfBench.start = start
        if (document.querySelector('.pdf-stage__toolbar') && window.__pdfBench.shell === undefined) {
          window.__pdfBench.shell = performance.now() - start
        }
        for (const number of [1, 2]) {
          const article = document.querySelector(`[data-page-number='${number}']`)
          const surface = article?.querySelector('.pdf-stage__page-surface')
          const image = surface?.querySelector('img')
          if (surface?.dataset.visualReady === 'true' || (image?.complete && image.naturalWidth > 0)) {
            window.__pdfBench[`page${number}`] ??= performance.now() - start
          }
        }
        requestAnimationFrame(observe)
      }
      requestAnimationFrame(observe)
    })
    for (const cache of ['cold', 'warm']) {
      if (useClick) {
        await page.goto('http://127.0.0.1:4174/library?course=benchmark-course&folder=courseware')
        const link = page.locator(`a[href*='file=benchmark-${count}']`).first()
        await link.waitFor({ state: 'visible' })
        await page.evaluate(() => { window.__pdfBench = { start: performance.now() } })
        await link.click()
      } else {
        await page.goto(`http://127.0.0.1:4174/pdf?file=benchmark-${count}&course=benchmark-course`)
      }
      await page.waitForFunction(() => window.__pdfBench.page1 !== undefined, null, { timeout: 120000 })
      await page.waitForFunction(() => window.__pdfBench.page2 !== undefined, null, { timeout: 120000 })
      const metrics = await page.evaluate(() => window.__pdfBench)
      console.log(JSON.stringify({ mode: useClick ? 'click' : 'route', count, cache, shell: Math.round(metrics.shell),
        firstVisual: Math.round(metrics.page1), adjacent: Math.round(metrics.page2 - metrics.page1),
        ranges: rangeRequests.filter(value => value.range),
      }))
    }
    await context.close()
  }
} finally {
  await browser.close()
}
