// Review screenshots of the battle screen at the target sizes (19장).
// Scene: a few units placed by touch, wave running, one unit selected, and a
// placement drag held over an invalid cell (shows hatch + reason).
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
const BASE = process.env.BASE ?? 'http://127.0.0.1:5190'
const sizes = process.argv.slice(2).length ? process.argv.slice(2) : ['1180x820', '1366x1024', '1194x834', '1024x768', '1280x800']
const dpr = Number(process.env.DPR ?? 1)
const browser = await chromium.launch()
for (const size of sizes) {
  const [w, hgt] = size.split('x').map(Number)
  const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, hasTouch: true, deviceScaleFactor: dpr })
  const page = await ctx.newPage()
  await page.goto(BASE + '/', { waitUntil: 'networkidle' })
  await page.waitForSelector('body[data-ready="1"]')
  const cdp = await ctx.newCDPSession(page)
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) })
  const cellPt = (cx, cy, lift = 0) => page.evaluate(([cx, cy, lift]) => {
    const r = document.getElementById('map').getBoundingClientRect()
    const [x, y] = window.__nf.view.toScreen(cx + 0.5, cy + 0.5)
    return [r.left + x, r.top + y + lift]
  }, [cx, cy, lift])
  const railPt = (id) => page.evaluate((id) => { const r = document.querySelector(`.ubtn[data-id="${id}"]`).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] }, id)
  const drag = async (a, b, hold = false) => {
    await touch('touchStart', [a])
    for (let i = 1; i <= 10; i++) await touch('touchMove', [[a[0] + ((b[0] - a[0]) * i) / 10, a[1] + ((b[1] - a[1]) * i) / 10]])
    if (!hold) await touch('touchEnd', [])
    await page.waitForTimeout(40)
  }
  await page.evaluate(() => { window.__nf.sim.credits = 2000 }) // scene setup only
  for (const [id, x, y] of [['sentinel', 3, 6], ['cryo', 4, 3], ['arc', 8, 6], ['railx', 12, 6], ['sentinel', 15, 8]]) await drag(await railPt(id), await cellPt(x, y, 64))
  await page.click('#b-wave')
  await page.waitForTimeout(5500)
  await drag(await railPt('sentinel'), await cellPt(10, 7, 64), true)
  await page.waitForTimeout(100)
  await page.screenshot({ path: `shots/tmp-place-${size}.png` })
  await touch('touchEnd', [])
  await page.waitForTimeout(100)
  const t = await cellPt(8, 6)
  await touch('touchStart', [t]); await touch('touchEnd', [])
  await page.waitForTimeout(400)
  await page.screenshot({ path: `shots/tmp-sel-${size}.png` })
  console.log('saved', size)
  await ctx.close()
}
await browser.close()
