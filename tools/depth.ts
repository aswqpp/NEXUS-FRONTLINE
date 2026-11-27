// Shared decision-depth evaluation: outcome distributions per build over
// placement seeds, and the chapter-19 criteria (see docs/balance.md).
import type { GameData, PathId } from '../src/sim/data.ts'
import { CELL_GROUND } from '../src/sim/map.ts'
import { Sim } from '../src/sim/sim.ts'

export const UNITS = ['sentinel', 'railx', 'arc', 'cryo']
export const BALANCED = ['sentinel', 'sentinel', 'cryo', 'arc', 'railx', 'sentinel', 'arc', 'railx']

export function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface RunResult {
  won: boolean
  core: number
  wave: number
  top: number
}

export function rankedCells(data: GameData, sim: Sim) {
  const out = new Map<string, [number, number][]>()
  for (const id of UNITS) {
    const d = data.units.get(id)!
    const cells: { c: [number, number]; v: number }[] = []
    for (let y = 0; y < sim.map.rows; y++)
      for (let x = 0; x < sim.map.cols; x++) {
        if (sim.map.cell(x, y) !== CELL_GROUND) continue
        const v = sim.map.coverage(x + 0.5, y + 0.5, d.base.range, !d.base.elevated)
        if (v > 0) cells.push({ c: [x, y], v })
      }
    cells.sort((a, b) => b.v - a.v || a.c[1] - b.c[1] || a.c[0] - b.c[0])
    out.set(id, cells.map((c) => c.c))
  }
  return out
}

/** Upgrade plans: unit id -> path order to climb. Bots buy an upgrade when it costs no more than
 *  `upRatio` x the next placement, upgrading the least-upgraded unit of that type first. */
export type UpgradePlan = Partial<Record<string, PathId[] | { order: PathId[]; units: number }[]>>

export function play(
  data: GameData,
  order: string[],
  picks: number[],
  topK: number,
  ranked: Map<string, [number, number][]>,
  plan: UpgradePlan = {},
  upRatio = 1.5,
): RunResult {
  const sim = new Sim(data, 'neon_district', 'normal')
  let i = 0
  const tryUpgrade = (budget: number): boolean => {
    let best: { id: number; path: PathId; cost: number } | null = null
    // roles: the first `units` units of a type (by placement order) follow role 1, the next follow role 2, ...
    const seen = new Map<string, number>()
    for (const u of sim.units) {
      const raw = plan[u.def.id]
      if (!raw) continue
      const idx = seen.get(u.def.id) ?? 0
      seen.set(u.def.id, idx + 1)
      let pl: PathId[] | undefined
      if (typeof raw[0] === 'string') pl = raw as PathId[]
      else {
        let k = idx
        for (const role of raw as { order: PathId[]; units: number }[]) {
          if (k < role.units) {
            pl = role.order
            break
          }
          k -= role.units
        }
      }
      if (!pl) continue
      const done = u.levels[0] + u.levels[1] + u.levels[2]
      const path = pl[done]
      if (!path) continue
      const st = sim.upgradeStatus(u, path)
      if (st.state !== 'buy' || !st.step || st.step.cost > budget) continue
      if (!best || st.step.cost < best.cost) best = { id: u.id, path, cost: st.step.cost }
    }
    if (!best) return false
    return sim.command({ t: 'upgrade', id: best.id, path: best.path })
  }
  const spend = () => {
    for (let guard = 0; guard < 200; guard++) {
      const nextId = order[i % order.length]
      const nextCost = data.units.get(nextId)!.cost
      if (sim.units.length >= 3 && tryUpgrade(Math.min(sim.credits, nextCost * upRatio))) continue
      const id = order[i % order.length]
      if (sim.credits < data.units.get(id)!.cost) {
        if (tryUpgrade(sim.credits)) continue
        return
      }
      const free = ranked.get(id)!.filter(([x, y]) => sim.canPlace(id, x, y).ok).slice(0, topK)
      if (!free.length) {
        if (tryUpgrade(sim.credits)) continue
        return
      }
      const c = free[picks[i % picks.length] % free.length]
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
  return { won: sim.state === 'won', core: sim.core, wave: sim.wave, top: by.size ? Math.max(...by.values()) / Math.max(1, tot) : 0 }
}

export interface Dist {
  n: number
  wins: number
  coreMin: number
  coreMed: number
  topHeavyWins: number
  runs: RunResult[]
}

function dist(runs: RunResult[]): Dist {
  const cores = runs.map((r) => (r.won ? r.core : -1)).sort((a, b) => a - b)
  return {
    n: runs.length,
    wins: runs.filter((r) => r.won).length,
    coreMin: cores[0],
    coreMed: cores[Math.floor(cores.length / 2)],
    topHeavyWins: runs.filter((r) => r.won && r.top >= 0.5).length,
    runs,
  }
}

/** Builds: mono = SENTINEL only, skilled placement (top 6 cells); balanced = fixed order, top 6;
 *  random = random unit and cell among the top 60; monoRail = RAIL-X only (dominance probe). */
export function evaluate(data: GameData, n: number, seed = 1) {
  const ranked = rankedCells(data, new Sim(data, 'neon_district', 'normal'))
  const R = rng(seed)
  const picks = () => Array.from({ length: 24 }, () => Math.floor(R() * 1000))
  const runs = (f: () => RunResult) => dist(Array.from({ length: n }, f))
  const mono = runs(() => play(data, ['sentinel'], picks(), 6, ranked))
  const monoRail = runs(() => play(data, ['railx'], picks(), 6, ranked))
  const balanced = runs(() => play(data, BALANCED, picks(), 6, ranked))
  const random = runs(() => play(data, Array.from({ length: 24 }, () => UNITS[Math.floor(R() * UNITS.length)]), picks(), 60, ranked))
  const criteria = {
    monoFails: mono.wins === 0 && monoRail.wins === 0,
    randomMedianFails: random.wins < random.n / 2,
    balancedAlwaysClears: balanced.wins === balanced.n,
    noTopHeavyWin: balanced.topHeavyWins === 0,
  }
  return { mono, monoRail, balanced, random, criteria, pass: Object.values(criteria).every(Boolean) }
}

export function fmt(d: Dist) {
  return `${d.wins}/${d.n} 클리어, 코어 최소 ${d.coreMin} 중앙 ${d.coreMed}`
}
