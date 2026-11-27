// Touch checks for Phase 2 (지시서 19장 기능 검수). Uses CDP touch events, so the
// page sees real (trusted) pointer events, including two-finger pinch.
// usage: node tests/touch.mjs   (dev server on :5190)
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')

const BASE = process.env.BASE ?? 'http://127.0.0.1:5190'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, deviceScaleFactor: 1 })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(BASE + '/', { waitUntil: 'networkidle' })
await page.waitForSelector('body[data-ready="1"]')
const cdp = await ctx.newCDPSession(page)
const wait = (ms) => page.waitForTimeout(ms)
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) })

async function drag(from, to, steps = 12) {
  await touch('touchStart', [from])
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    await touch('touchMove', [[from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]])
    await wait(8)
  }
  await touch('touchEnd', [])
  await wait(50)
}
async function tap(p) {
  await touch('touchStart', [p])
  await wait(30)
  await touch('touchEnd', [])
  await wait(80)
}
const state = () => page.evaluate(() => {
  const b = window.__nf
  return { units: b.sim.units.length, credits: b.sim.credits, s: b.view.cam.s, cx: b.view.cam.x, cy: b.view.cam.y, wave: b.sim.wave, st: b.sim.state, sel: b.view.selected }
})
// screen point (page coords) of a cell centre, with the drag lift applied when needed
const cellPt = (cx, cy, lift = 0) => page.evaluate(([cx, cy, lift]) => {
  const b = window.__nf
  const r = document.getElementById('map').getBoundingClientRect()
  const [x, y] = b.view.toScreen(cx + 0.5, cy + 0.5)
  return [r.left + x, r.top + y + lift]
}, [cx, cy, lift])
const railPt = (id) => page.evaluate((id) => {
  const r = document.querySelector(`.ubtn[data-id="${id}"]`).getBoundingClientRect()
  return [r.left + r.width / 2, r.top + r.height / 2]
}, id)
const btnPt = (sel) => page.evaluate((sel) => {
  const r = document.querySelector(sel).getBoundingClientRect()
  return [r.left + r.width / 2, r.top + r.height / 2]
}, sel)

let fails = 0
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`)
  if (!ok) fails++
}

// 1. drag from rail to a valid cell
let s0 = await state()
await drag(await railPt('sentinel'), await cellPt(3, 6, 64))
let s1 = await state()
check('레일에서 맵으로 드래그 배치', s1.units === s0.units + 1 && s1.credits === s0.credits - 200)

// 2. drag onto the path -> cancelled
await drag(await railPt('sentinel'), await cellPt(2, 2, 64))
let s2 = await state()
check('설치 불가 지점에서 놓으면 취소', s2.units === s1.units && s2.credits === s1.credits)

// 3. drag back onto the rail -> cancelled
const rp = await railPt('sentinel')
await touch('touchStart', [rp]); await touch('touchMove', [[rp[0] - 40, rp[1]]]); await touch('touchMove', [[rp[0] - 200, rp[1]]]); await touch('touchMove', [[rp[0], rp[1]]]); await touch('touchEnd', [])
await wait(50)
let s3 = await state()
check('드래그를 레일로 되돌리면 취소', s3.units === s1.units)

// 4. tap rail -> tap map -> confirm
await tap(await railPt('railx'))
await tap(await cellPt(11, 6))
const hasConfirm = await page.$('.confirm')
check('탭 배치: 확인 버튼 표시', !!hasConfirm)
if (hasConfirm) await tap(await btnPt('.confirm'))
let s4 = await state()
check('탭 배치: 확인으로 설치', s4.units === s1.units + 1)

// 5. select + sell confirm
await tap(await cellPt(11, 6))
let s5 = await state()
check('유닛 탭으로 선택', s5.sel !== null)
await wait(200)
await tap(await btnPt('[data-sell]'))
const armedText = await page.textContent('[data-sell]')
check('판매 1회 탭: 확정 문구로 바뀜', /판매 확정/.test(armedText ?? ''), armedText)
await tap(await btnPt('[data-sell]'))
let s6 = await state()
check('판매 2회 탭: 판매, 같은 웨이브 전액 환급', s6.units === s4.units - 1 && s6.credits === s4.credits + 350)

// 6. pinch zoom
const c = await cellPt(12, 8)
await touch('touchStart', [[c[0] - 40, c[1]], [c[0] + 40, c[1]]])
for (let i = 1; i <= 10; i++) { await touch('touchMove', [[c[0] - 40 - i * 12, c[1]], [c[0] + 40 + i * 12, c[1]]]); await wait(8) }
await touch('touchEnd', [])
await wait(50)
let s7 = await state()
check('두 손가락 확대', s7.s > s6.s * 1.5 && s7.s <= 2, `${s6.s.toFixed(2)} -> ${s7.s.toFixed(2)}`)

// 7. one-finger pan on empty map
await drag([500, 400], [380, 300], 10)
let s8 = await state()
check('한 손가락 화면 이동', Math.abs(s8.cx - s7.cx) > 50 || Math.abs(s8.cy - s7.cy) > 50)
// zoom back out
await touch('touchStart', [[c[0] - 160, c[1]], [c[0] + 160, c[1]]])
for (let i = 1; i <= 10; i++) { await touch('touchMove', [[c[0] - 160 + i * 12, c[1]], [c[0] + 160 - i * 12, c[1]]]); await wait(8) }
await touch('touchEnd', [])
await page.evaluate(() => window.__nf.view.fit())

await page.screenshot({ path: 'shots/tmp-p2-touch.png' })

// 8a. pause -> resume
await tap(await btnPt('#b-pause'))
const paused = await page.evaluate(() => window.__nf.paused && document.getElementById('overlay').classList.contains('show'))
await page.screenshot({ path: 'shots/tmp-p2-pause.png' })
await tap(await btnPt('[data-a="resume"]'))
const resumed = await page.evaluate(() => !window.__nf.paused && !document.getElementById('overlay').classList.contains('show'))
check('일시정지 → 재개', paused && resumed)

// 8. play 10 waves by touch: between waves, drag units from the rail onto the
//    best-covering free cells (read-only hints from the sim), then tap the wave button.
const plan = ['sentinel', 'sentinel', 'cryo', 'arc', 'railx', 'sentinel', 'arc', 'railx', 'cryo', 'arc', 'railx', 'sentinel', 'arc', 'sentinel']
let k = 0
await tap(await btnPt('#b-speed')); await tap(await btnPt('#b-speed')) // 3x
for (let guard = 0; guard < 400; guard++) {
  const st = await state()
  if (st.st === 'won' || st.st === 'lost') break
  const canStart = await page.evaluate(() => window.__nf.sim.canStartWave && !window.__nf.sim.busy)
  if (canStart) {
    for (;;) {
      const id = plan[k % plan.length]
      const cell = await page.evaluate((id) => {
        const s = window.__nf.sim
        const def = s.data.units.get(id)
        if (s.credits < def.cost) return null
        let best = null, bs = 0
        for (let y = 0; y < s.map.rows; y++) for (let x = 0; x < s.map.cols; x++) {
          if (!s.canPlace(id, x, y).ok) continue
          const v = s.map.coverage(x + 0.5, y + 0.5, def.base.range, !def.base.elevated)
          if (v > bs) { bs = v; best = [x, y] }
        }
        return best
      }, id)
      if (!cell) break
      const before = (await state()).units
      await drag(await railPt(id), await cellPt(cell[0], cell[1], 64))
      if ((await state()).units === before) { console.log('  배치 실패', id, cell); break }
      k++
    }
    await tap(await btnPt('#b-wave'))
    if ((await state()).wave === 5) await page.screenshot({ path: 'shots/tmp-p2-w5.png' })
  }
  await wait(500)
}
const fin = await state()
check('10웨이브를 터치로 끝까지', fin.st === 'won', `state=${fin.st} wave=${fin.wave} units=${fin.units}`)
const resultText = await page.textContent('#overlay')
check('승리 화면 문구', /구역 유지\. 대피 완료율 100%/.test(resultText ?? ''))
await page.screenshot({ path: 'shots/tmp-p2-result.png' })
// playtest record: save from the result screen, then re-verify it headlessly
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-a="export"]')])
await dl.saveAs('shots/tmp-playtest.json')
const { execFileSync } = await import('node:child_process')
let replayOk = true
let replayOut = ''
try { replayOut = execFileSync('npx', ['tsx', 'tools/replay.ts', 'shots/tmp-playtest.json'], { encoding: 'utf8' }) } catch (e) { replayOk = false; replayOut = String(e.stdout ?? e) }
check('플레이 기록 저장 → 헤드리스 재생 일치', replayOk && /재생: 일치/.test(replayOut), replayOut.split('\n').find((l) => l.startsWith('재생')))
check('페이지 오류 없음', errors.length === 0, errors.join(' | '))
await browser.close()
console.log(fails ? `\n${fails}개 실패` : '\n전부 통과')
process.exit(fails ? 1 : 0)
