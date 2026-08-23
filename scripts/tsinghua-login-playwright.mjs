import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'

const [, , inputPath, outputPath] = process.argv

if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/tsinghua-login-playwright.mjs <input.json> <output.json>')
  process.exit(1)
}

const COURSE_HOME_URL = 'https://learn.tsinghua.edu.cn/f/wlxt/index/course/student/'
const LOGIN_ENTRY_URL = 'https://learn.tsinghua.edu.cn/'
const LEARN_HOST = 'learn.tsinghua.edu.cn'
const LOGIN_HOST = 'id.tsinghua.edu.cn'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function normalize(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function writeResult(payload) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf8')
}

async function extractCourseEntries(page) {
  return page.evaluate(() => {
    const normalizeText = (value) => (value || '').replace(/\s+/g, ' ').trim()
    const panelSelectors = ['.paicbq3ow.paicbq3ow1', '.paicbq3ow1', '.paicbq3ow']
    let panel = null
    for (const selector of panelSelectors) {
      const panels = Array.from(document.querySelectorAll(selector))
      panel = panels.find((item) => item.querySelector('#selfcourse .item, #selfcourse .hdtitle a.title'))
      if (panel) {
        break
      }
    }
    const container =
      panel?.querySelector('#selfcourse') ||
      document.querySelector('#selfcourse') ||
      panel
    if (!container) {
      return []
    }

    return Array.from(container.querySelectorAll('.item'))
      .map((item) => {
        const titleAnchor = item.querySelector('.hdtitle a.title')
        if (!titleAnchor) {
          return null
        }
        const wlkcidInput = item.querySelector('input.wlkcid')
        const wlkcid = normalizeText(wlkcidInput ? wlkcidInput.value || '' : '')
        const kejianLabel = item.querySelector('span.name.kejian')
        const kejianAnchor = kejianLabel ? kejianLabel.closest('a') : null
        let coursewareHref = kejianAnchor ? kejianAnchor.getAttribute('href') || '' : ''
        if (!coursewareHref && wlkcid) {
          coursewareHref = `/f/wlxt/kj/wlkc_kjxxb/student/beforePageList?wlkcid=${wlkcid}&sfgk=0`
        }
        return {
          name: normalizeText(titleAnchor.getAttribute('title') || titleAnchor.textContent || ''),
          href: normalizeText(titleAnchor.getAttribute('href') || ''),
          wlkcid,
          coursewareHref: normalizeText(coursewareHref),
        }
      })
      .filter((item) => item && item.name)
  })
}

function getOpenPages(context) {
  return context.pages().filter((page) => !page.isClosed())
}

function getPreferredPage(context, fallbackPage = null) {
  const pages = getOpenPages(context)
  if (fallbackPage && !fallbackPage.isClosed()) {
    return fallbackPage
  }
  const learnPage = [...pages].reverse().find((page) => page.url().includes(LEARN_HOST))
  if (learnPage) {
    return learnPage
  }
  const loginPage = [...pages].reverse().find((page) => page.url().includes(LOGIN_HOST))
  if (loginPage) {
    return loginPage
  }
  return pages.at(-1) || fallbackPage
}

async function waitForDomReady(page, timeout = 20000) {
  if (!page || page.isClosed()) {
    return
  }
  await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {})
}

async function ensureLearnLoginEntry(page) {
  const deadline = Date.now() + 30000
  let currentPage = page

  while (Date.now() < deadline) {
    currentPage = page.context() ? getPreferredPage(page.context(), currentPage) : currentPage
    if (!currentPage || currentPage.isClosed()) {
      throw new Error('登录页面在自动跳转过程中被关闭。')
    }

    const currentUrl = currentPage.url()
    if (currentUrl.includes(LOGIN_HOST)) {
      return currentPage
    }

    const relogin = currentPage.locator('a.chongxin, .re_log a.chongxin').first()
    if ((await relogin.count()) > 0) {
      await relogin.click({ force: true })
      await waitForDomReady(currentPage)
      await sleep(500)
      continue
    }

    if (currentUrl.includes('/f/login')) {
      const loginButton = currentPage.locator('#loginButtonId').first()
      if ((await loginButton.count()) > 0) {
        const targetUrl = normalize(
          await currentPage.evaluate(() => {
            const button = document.querySelector('#loginButtonId')
            if (!button) {
              return ''
            }
            const onclickValue = button.getAttribute('onclick') || ''
            const matched = onclickValue.match(/window\.location\.href=['"]([^'"]+)['"]/)
            return matched ? matched[1] : ''
          }),
        )
        if (targetUrl) {
          await currentPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
        } else {
          await loginButton.click({ force: true })
          await waitForDomReady(currentPage)
        }
        await sleep(500)
        continue
      }
    }

    if (currentUrl === 'https://learn.tsinghua.edu.cn/' || currentUrl === 'https://learn.tsinghua.edu.cn') {
      await currentPage.goto(COURSE_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
      await sleep(500)
      continue
    }

    await sleep(500)
  }

  throw new Error('未能从网络学堂登录入口进入统一认证页面。')
}

async function submitCredentials(page, username, password) {
  const userInput = page.locator('#i_user, input[name="i_user"]').first()
  const passInput = page.locator('#i_pass, input[type="password"]').first()
  await userInput.waitFor({ state: 'visible', timeout: 30000 })
  await passInput.waitFor({ state: 'visible', timeout: 30000 })
  await userInput.fill(username)
  await passInput.fill(password)

  const submitButton = page.locator("a.btn.btn-lg.btn-primary.btn-block, button[type='submit'], input[type='submit']").first()
  if ((await submitButton.count()) > 0) {
    await Promise.allSettled([
      page.waitForLoadState('domcontentloaded', { timeout: 30000 }),
      submitButton.click({ force: true }),
    ])
  } else {
    await page.evaluate(() => {
      if (typeof window.doLogin === 'function') {
        window.doLogin()
      } else {
        const form = document.querySelector('#theform')
        if (form instanceof HTMLFormElement) {
          form.submit()
        }
      }
    })
  }
}

async function waitForLoggedInLearnPage(context, initialPage) {
  const deadline = Date.now() + 180000
  let lastPage = initialPage
  let secondaryAuthSubmitted = false

  while (Date.now() < deadline) {
    const currentPage = getPreferredPage(context, lastPage)
    if (!currentPage) {
      await sleep(400)
      continue
    }
    lastPage = currentPage

    const currentUrl = currentPage.url()
    if (currentUrl.includes(LEARN_HOST) && currentUrl.includes('/f/wlxt/')) {
      return currentPage
    }

    if (currentUrl.includes(LEARN_HOST) && !currentUrl.includes('/f/login')) {
      await currentPage.goto(COURSE_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
      await sleep(800)
      if (currentPage.url().includes('/f/wlxt/')) {
        return currentPage
      }
    }

    if (currentUrl.includes(LOGIN_HOST)) {
      const title = normalize(await currentPage.title().catch(() => ''))
      if (currentUrl.includes('/do/off/ui/auth/login/check') || title.includes('二次认证')) {
        if (!secondaryAuthSubmitted) {
          const confirmButton = currentPage
            .locator("text=确定, button:has-text('确定'), input[value='确定'], .btn-primary")
            .first()
          if ((await confirmButton.count().catch(() => 0)) > 0) {
            await confirmButton.click({ force: true }).catch(() => {})
            secondaryAuthSubmitted = true
            await sleep(1000)
            continue
          }
        }
      }

      const note = normalize(
        await currentPage
          .locator('#msg_note, #c_note, .alert-danger, .alert')
          .first()
          .textContent()
          .catch(() => ''),
      )
      if (note) {
        throw new Error(`统一认证返回提示：${note}`)
      }
      const captchaVisible = await currentPage.locator('#c_code:not(.hidden)').count().catch(() => 0)
      if (captchaVisible > 0) {
        throw new Error('统一认证页面要求图形验证码，当前自动登录无法继续。')
      }
    }

    await waitForDomReady(currentPage, 4000)
    await sleep(500)
  }

  throw new Error('登录后未能在 180 秒内进入网络学堂课程页，可能仍需要你在企业微信或手机上完成二次认证。')
}

async function main() {
  const request = JSON.parse(await fs.readFile(inputPath, 'utf8'))
  const { username, password, browserBinary, storageDir, headless = false } = request

  if (!username || !password) {
    throw new Error('username and password are required')
  }

  if (!browserBinary || !(await fileExists(browserBinary))) {
    throw new Error(`browser binary not found: ${browserBinary || 'empty'}`)
  }

  await fs.mkdir(storageDir, { recursive: true })

  const browser = await chromium.launch({
    headless,
    executablePath: browserBinary,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-default-browser-check',
      '--no-first-run',
    ],
  })

  const context = await browser.newContext({
    viewport: { width: 1440, height: 980 },
    acceptDownloads: false,
  })
  let page = await context.newPage()

  try {
    await page.goto(COURSE_HOME_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    page = await ensureLearnLoginEntry(page)
    await submitCredentials(page, username, password)
    page = await waitForLoggedInLearnPage(context, page)
    await waitForDomReady(page, 10000)

    const cookies = (await context.cookies()).filter(
      (item) => typeof item.domain === 'string' && item.domain.includes('tsinghua.edu.cn'),
    )
    const courseEntries = await extractCourseEntries(page).catch(() => [])

    await writeResult({
      ok: true,
      currentUrl: page.url(),
      title: await page.title(),
      cookies,
      courseEntries,
    })
  } catch (error) {
    const capturePage = getPreferredPage(context, page)
    const screenshotPath = path.join(storageDir, 'login-failure.png')
    await capturePage?.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
    await writeResult({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      currentUrl: capturePage?.url?.() || '',
      title: (await capturePage?.title?.().catch(() => '')) || '',
      screenshotPath,
    })
    throw error
  } finally {
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}

main().catch(async (error) => {
  if (!(await fileExists(outputPath))) {
    await writeResult({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {})
  }
  process.exit(1)
})
