// Read-only production browser check. The signed session stays in memory, never stdout.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const session = execFileSync('docker', ['compose','exec','-T','app','node','--input-type=module','-e',
  'import {makePasswordSession} from "./web/password.mjs"; process.stdout.write(makePasswordSession(process.env.LOGIN_PASSWORD_HASH))'], { encoding:'utf8' }).trim()
const browser = await chromium.launch({ headless:true,
  ...process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}, args:['--no-sandbox'] })
try {
  const context = await browser.newContext({ viewport:{width:1440,height:1000} })
  await context.addCookies([{ name:'__Host-ma_session',value:session,domain:'bot.myddls.com',path:'/',httpOnly:true,secure:true,sameSite:'Lax' }])
  const page = await context.newPage()
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto('https://bot.myddls.com', { waitUntil:'networkidle' })
  await page.waitForFunction(() => document.querySelector('#hsub')?.textContent.includes('独立项目上下文'))
  assert.equal(await page.locator('#members .mem').count(),4)
  assert.equal(await page.locator('#pdlg').evaluate(e => e.open),false)
  assert(await page.locator('#newcrew').isVisible())
  assert((await page.locator('#in').getAttribute('placeholder')).includes('新作品'))
  page.once('dialog', async d => { assert(d.message().includes('全新上下文')); await d.dismiss() })
  await page.locator('#newcrew').click()
  await page.screenshot({ path:'workspace/media-tests/project-crew-desktop.png',fullPage:true })
  await page.setViewportSize({width:390,height:844})
  await page.waitForFunction(() => document.documentElement.classList.contains('rail'))
  await page.waitForFunction(() => document.querySelector('main').getBoundingClientRect().width > 300)
  assert((await page.locator('main').boundingBox()).width > 300,'mobile chat keeps usable width')
  assert.equal(await page.locator('#side2').isVisible(),false)
  assert(await page.locator('#in').isVisible())
  await page.screenshot({ path:'workspace/media-tests/project-crew-mobile.png',fullPage:true })
  assert.equal(errors.length,0,errors.join('\n'))
  console.log('PASS: authenticated desktop/mobile UI; default crew chat; 4 roles; one-field create prompt; no API-key dialog; no JS errors')
} finally { await browser.close() }
