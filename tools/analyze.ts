// Decision-depth analysis for chapter 1 waves 1-10 (raw material before tuning).
// npm run analyze
import { CELL_GROUND } from '../src/sim/map.ts'
import { Sim } from '../src/sim/sim.ts'
import { loadData } from './nodeData.ts'

const data = loadData()
const MAP = 'neon_district'
const fresh = () => new Sim(data, MAP, 'normal')
const units = ['sentinel', 'railx', 'arc', 'cryo']

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------- 1. coverage heatmap
const s0 = fresh()
const cov = new Map<string, number[][]>()
for (const id of units) {
  const d = data.units.get(id)!
  const grid: number[][] = []
  for (let y = 0; y < s0.map.rows; y++) {
    grid.push([])
    for (let x = 0; x < s0.map.cols; x++)
      grid[y].push(s0.map.cell(x, y) === CELL_GROUND ? s0.map.coverage(x + 0.5, y + 0.5, d.base.range, !d.base.elevated) : -1)
  }
  cov.set(id, grid)
}
console.log('## 1. 배치 커버리지 (사거리 안 경로 길이, 칸)')
for (const id of units) {
  const vals = cov.get(id)!.flat().filter((v) => v >= 0).sort((a, b) => b - a)
  const top = vals[0]
  const good = vals.filter((v) => v >= top * 0.8).length
  const any = vals.filter((v) => v > 0).length
  console.log(`- ${id}: 최고 ${top.toFixed(1)} · 최고의 80% 이상인 칸 ${good}개 · 경로에 닿는 칸 ${any}/${vals.length}`)
}
const sg = cov.get('sentinel')!
console.log('\nSENTINEL 히트맵 (# 경로/건물, 0-9 = 최고 대비 10% 단위)')
const smax = Math.max(...sg.flat())
for (const row of sg) console.log(row.map((v) => (v < 0 ? '#' : v === 0 ? '.' : String(Math.min(9, Math.floor((v / smax) * 10))))).join(''))

// ---------------------------------------------------------------- 2. cost efficiency
console.log('\n## 2. 100CR당 실효 DPS (단일 표적, 계수 적용, 연쇄·관통은 최대 표적 수로 곱함)')
const enemies = ['r07', 'r11', 'h02', 's04']
console.log(`| 유닛 | ${enemies.map((e) => data.enemies.get(e)!.code).join(' | ')} |`)
console.log(`| --- |${enemies.map(() => ' --- |').join('')}`)
for (const id of units) {
  const b = data.units.get(id)!.base
  const row = enemies.map((eid) => {
    const e = data.enemies.get(eid)!
    let k = 1
    if (e.armor && b.damageType === 'kinetic') k = 1 - e.armor * (1 - b.armorPen)
    if (e.shield) k *= ({ kinetic: 1, energy: 0.25, electric: 2, explosive: 1 } as const)[b.damageType] * 0.5 + k * 0.5 // half the HP pool is shield
    let mult = 1
    if (b.kind === 'rail') mult = b.pierce
    if (b.kind === 'chain') mult = (1 - b.chainFalloff ** (b.chain + 1)) / (1 - b.chainFalloff)
    const dps = (b.damage * k * mult) / b.fireInterval
    return ((dps * 100) / data.units.get(id)!.cost).toFixed(2)
  })
  console.log(`| ${id} | ${row.join(' | ')} |`)
}

// ---------------------------------------------------------------- 3/4. adversarial search
type Gene = { order: string[]; picks: number[] }
function play(g: Gene, topK: number) {
  const sim = fresh()
  const ranked = new Map<string, [number, number][]>()
  for (const id of units) {
    const grid = cov.get(id)!
    const cells: { c: [number, number]; v: number }[] = []
    grid.forEach((row, y) => row.forEach((v, x) => v > 0 && cells.push({ c: [x, y], v })))
    cells.sort((a, b) => b.v - a.v)
    ranked.set(id, cells.map((c) => c.c))
  }
  let i = 0
  const spend = () => {
    for (;;) {
      const id = g.order[i % g.order.length]
      const def = data.units.get(id)!
      if (sim.credits < def.cost) return
      const free = ranked.get(id)!.filter(([x, y]) => sim.canPlace(id, x, y).ok).slice(0, topK)
      if (!free.length) return
      const c = free[g.picks[i % g.picks.length] % free.length]
      sim.command({ t: 'place', unit: id, cx: c[0], cy: c[1] })
      i++
    }
  }
  while (sim.state !== 'won' && sim.state !== 'lost' && sim.tick < 60 * 60 * 30) {
    if (sim.canStartWave && !sim.busy) {
      spend()
      sim.command({ t: 'wave' })
    }
    sim.step()
    sim.events.length = 0
  }
  let tot = 0
  const by = new Map<string, number>()
  for (const u of sim.units) {
    by.set(u.def.id, (by.get(u.def.id) ?? 0) + u.damage)
    tot += u.damage
  }
  const top = Math.max(...by.values()) / Math.max(1, tot)
  return { won: sim.state === 'won', core: sim.core, wave: sim.wave, top, units: sim.units.length }
}
// score: higher = better for the player
const score = (r: ReturnType<typeof play>) => (r.won ? 1000 + r.core : r.wave * 10 + r.core / 10)

function search(name: string, pool: string[], fixedOrder: boolean, n: number, seed: number) {
  const R = rng(seed)
  const results: ReturnType<typeof play>[] = []
  let best: ReturnType<typeof play> | null = null
  let worst: ReturnType<typeof play> | null = null
  for (let t = 0; t < n; t++) {
    const order = fixedOrder ? pool : Array.from({ length: 16 }, () => pool[Math.floor(R() * pool.length)])
    const picks = Array.from({ length: 16 }, () => Math.floor(R() * 1000))
    const r = play({ order, picks }, fixedOrder ? 6 : 60)
    results.push(r)
    if (!best || score(r) > score(best)) best = r
    if (!worst || score(r) < score(worst)) worst = r
  }
  const wins = results.filter((r) => r.won).length
  const cores = results.map((r) => r.core).sort((a, b) => a - b)
  console.log(`- ${name}: ${n}판 중 클리어 ${wins} · 코어 최소 ${cores[0]} / 중앙 ${cores[Math.floor(n / 2)]} / 최대 ${cores[n - 1]} · 최악 ${worst!.won ? '클리어' : `W${worst!.wave} 패배`} · 승리 판 한 유닛 피해 50%↑ ${results.filter((r) => r.won && r.top >= 0.5).length}`)
  return { wins, n, cores }
}

console.log('\n## 3. 빌드별 결과 분포 (배치 시드 무작위)')
const N = Number(process.env.N ?? 60)
const mono = search('SENTINEL 몰빵 (상위 6칸 중 무작위)', ['sentinel'], true, N, 11)
const bal = search('균형 (고정 순서, 상위 6칸 중 무작위)', ['sentinel', 'sentinel', 'cryo', 'arc', 'railx', 'sentinel', 'arc', 'railx'], true, N, 12)
const rnd = search('무작위 (유닛·칸 모두 무작위, 상위 60칸)', units, false, N, 13)
const worstMono = search('SENTINEL 몰빵 (상위 60칸 중 무작위 — 배치 실력 낮음)', ['sentinel'], false, N, 14)

console.log('\n## 4. 19장 기준 판정 (1~10웨이브)')
const v = (ok: boolean) => (ok ? '충족' : '미충족')
console.log(`- 몰빵 최선이 패배: ${v(mono.wins === 0)} (몰빵 클리어 ${mono.wins}/${mono.n})`)
console.log(`- 무작위 중앙값이 패배: ${v(rnd.wins < rnd.n / 2)} (무작위 클리어 ${rnd.wins}/${rnd.n})`)
console.log(`- 균형 최소값이 클리어: ${v(bal.wins === bal.n)} (균형 클리어 ${bal.wins}/${bal.n})`)
console.log(`- 배치 실력이 결과를 바꾸는가: 몰빵 좋은 배치 코어 중앙 ${mono.cores[Math.floor(N / 2)]} vs 나쁜 배치 ${worstMono.cores[Math.floor(N / 2)]}`)
