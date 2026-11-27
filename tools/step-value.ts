// Upgrade step value as firepower capacity (balance.md §9). One unit at its best cell
// faces a dense stream of unkillable dummies for 60 s, so the result is not capped by how
// much HP happens to walk past. Three streams: plain (R-07), armored (H-02), shielded (S-04).
// Value = damage per credit invested, relative to the bare unit (T0 = 1.00).
// npm run step-value -- [unit ...]
import type { GameData, PathId } from '../src/sim/data.ts'
import { Sim } from '../src/sim/sim.ts'
import { rankedCells } from './depth.ts'
import { loadData } from './nodeData.ts'

export const STREAMS = { plain: 'r07', armored: 'h02', shielded: 's04', stealth: 'v09' } as const
export type Stream = keyof typeof STREAMS

function probeData(base: GameData, enemy: string): GameData {
  const d = structuredClone(base)
  const src = d.enemies.get(enemy)!
  d.enemies.set('probe', { ...src, id: 'probe', hp: 1e7, shield: src.shield ? 1e7 : 0, fixedHp: true, boss: false, split: null })
  d.waves.get('neon_district_normal')!.waves = [{ groups: [{ enemy: 'probe', count: 400, interval: 0.3, delay: 0 }] }]
  return d
}

const cache = new Map<string, { data: GameData; ranked: Map<string, [number, number][]> }>()

/** team: also place `team` bare SENTINELs on the ground cells nearest the subject and count everyone's damage */
export function capacity(base: GameData, unit: string, levels: [number, number, number], stream: Stream = 'plain', seconds = 60, team = 0, overpass = false) {
  const key = stream
  let c = cache.get(key)
  if (!c || c.data.units !== base.units) {
    const data = probeData(base, STREAMS[stream])
    c = { data, ranked: rankedCells(data, new Sim(data, 'neon_district', 'normal')) }
    cache.set(key, c)
  }
  // keep unit defs from the caller (tuning experiments edit them)
  c.data.units = base.units
  let cell = c.ranked.get(unit)![0]
  if (overpass) {
    // the ground cell whose range covers the most overpass path (where height matters)
    const probe = new Sim(c.data, 'neon_district', 'normal')
    const r = c.data.units.get(unit)!.base.range
    let best = -1
    for (const [x, y] of c.ranked.get(unit)!) {
      const v = probe.map.coverage(x + 0.5, y + 0.5, r, false) - probe.map.coverage(x + 0.5, y + 0.5, r, true)
      if (v > best) {
        best = v
        cell = [x, y]
      }
    }
  }
  const sim = new Sim(c.data, 'neon_district', 'normal', { unlockT6: true })
  sim.credits = 1e9
  sim.core = 1e9
  sim.command({ t: 'place', unit, cx: cell[0], cy: cell[1] })
  const u = sim.units[0]
  if (team > 0) {
    const near = c.ranked.get('sentinel')!
      .filter(([x, y]) => !(x === cell[0] && y === cell[1]))
      .map((xy) => ({ xy, d: Math.hypot(xy[0] - cell[0], xy[1] - cell[1]) }))
      .sort((a, b) => a.d - b.d || a.xy[1] - b.xy[1] || a.xy[0] - b.xy[0])
      .slice(0, team)
    for (const { xy } of near) sim.command({ t: 'place', unit: 'sentinel', cx: xy[0], cy: xy[1] })
  }
  const main = 'ABC'[levels.indexOf(Math.max(...levels))] as PathId
  const order: PathId[] = []
  ;(['A', 'B', 'C'] as PathId[]).forEach((p, i) => {
    for (let k = 0; k < levels[i]; k++) order.push(p)
  })
  order.sort((a, b) => (a === main ? 0 : 1) - (b === main ? 0 : 1))
  for (const p of order) if (!sim.command({ t: 'upgrade', id: u.id, path: p })) throw new Error(`upgrade ${p} rejected (${levels})`)
  sim.command({ t: 'wave' })
  const warm = 60 * 12 // let the stream reach the unit
  while (sim.tick < warm) {
    sim.step()
    sim.events.length = 0
  }
  const total = () => (team > 0 ? sim.units.reduce((a, x) => a + x.damage, 0) : u.damage)
  const d0 = total()
  while (sim.tick < warm + 60 * seconds) {
    sim.step()
    sim.events.length = 0
  }
  return { damage: total() - d0, invested: u.invested }
}

/** Marginal value of each step on one scale: 1.00 = as good as buying another bare SENTINEL
 *  against plain enemies (single-unit capacity per credit). Columns: own damage vs plain /
 *  armored / shielded / stealth streams, and team damage (subject + 4 bare SENTINELs nearby). */
export type Col = Stream | 'team' | 'teamStealth' | 'overpass'
export const COLS: Col[] = ['plain', 'armored', 'shielded', 'stealth', 'team', 'teamStealth', 'overpass']

export function table(data: GameData, unit: string) {
  const unitCost = data.units.get('sentinel')!.cost
  const ref = capacity(data, 'sentinel', [0, 0, 0], 'plain').damage / unitCost
  const run = (lv: [number, number, number]) =>
    Object.fromEntries(
      COLS.map((c) => [
        c,
        c === 'team'
          ? capacity(data, unit, lv, 'plain', 60, 6)
          : c === 'teamStealth'
            ? capacity(data, unit, lv, 'stealth', 60, 6)
            : c === 'overpass'
              ? capacity(data, unit, lv, 'plain', 60, 0, true)
              : capacity(data, unit, lv, c),
      ]),
    ) as Record<Col, { damage: number; invested: number }>
  const rows: { step: string; kind: string; invested: number; marginal: Record<Col, number> }[] = []
  const def = data.units.get(unit)!
  const base = run([0, 0, 0])
  rows.push({ step: 'T0', kind: '', invested: base.plain.invested, marginal: Object.fromEntries(COLS.map((c) => [c, base[c].damage / base[c].invested / ref])) as Record<Col, number> })
  ;(['A', 'B', 'C'] as PathId[]).forEach((p, pi) => {
    let prev = base
    for (let n = 1; n <= def.paths[p].length; n++) {
      const lv: [number, number, number] = [0, 0, 0]
      lv[pi] = n
      const cur = run(lv)
      const dc = cur.plain.invested - prev.plain.invested
      const marginal = Object.fromEntries(COLS.map((c) => [c, (cur[c].damage - prev[c].damage) / dc / ref])) as Record<Col, number>
      rows.push({ step: `${p}${n} ${def.paths[p][n - 1].name}`, kind: def.paths[p][n - 1].kind, invested: cur.plain.invested, marginal })
      prev = cur
    }
  })
  return rows
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const data = loadData()
  for (const unit of process.argv.slice(2).length ? process.argv.slice(2) : ['sentinel']) {
    console.log(`\n## ${unit} — 단계별 한계 효율 (1.00 = 일반 적 상대로 SENTINEL 하나를 더 사는 것과 같음, T0 행은 평균 효율)`)
    console.log('| 단계 | 종류 | 누적 투자 | 일반 | 중장갑 | 보호막 | 은폐 | 팀(+6) | 팀 은폐(+6) | 고가 옆 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const r of table(data, unit)) console.log(`| ${r.step} | ${r.kind} | ${r.invested} | ${COLS.map((c) => r.marginal[c].toFixed(2)).join(' | ')} |`)
  }
}
