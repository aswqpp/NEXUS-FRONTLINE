// Scripted builds for headless balance runs (지시서 19장).
import { CELL_GROUND } from '../src/sim/map.ts'
import { Sim } from '../src/sim/sim.ts'

export type BuildName = 'balanced' | 'mono' | 'noSupport' | 'random'

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Free ground cells ranked by how much path the unit would cover. */
function rankedCells(sim: Sim, unitId: string): [number, number][] {
  const def = sim.data.units.get(unitId)!
  const out: { c: [number, number]; s: number }[] = []
  for (let y = 0; y < sim.map.rows; y++)
    for (let x = 0; x < sim.map.cols; x++) {
      if (sim.map.cell(x, y) !== CELL_GROUND) continue
      const s = sim.map.coverage(x + 0.5, y + 0.5, def.base.range, !def.base.elevated)
      if (s > 0) out.push({ c: [x, y], s })
    }
  out.sort((a, b) => b.s - a.s || a.c[1] - b.c[1] || a.c[0] - b.c[0])
  return out.map((o) => o.c)
}

const PLANS: Record<Exclude<BuildName, 'random'>, string[]> = {
  balanced: ['sentinel', 'sentinel', 'cryo', 'arc', 'railx', 'sentinel', 'arc', 'railx', 'cryo', 'arc', 'railx', 'sentinel'],
  mono: ['sentinel'],
  noSupport: ['sentinel', 'arc', 'railx'],
}

export function makeBot(name: BuildName, seed = 7) {
  const rnd = mulberry32(seed)
  const cache = new Map<string, [number, number][]>()
  let step = 0
  const units = ['sentinel', 'railx', 'arc', 'cryo']
  return (sim: Sim) => {
    for (let guard = 0; guard < 40; guard++) {
      const id = name === 'random' ? units[Math.floor(rnd() * units.length)] : PLANS[name][step % PLANS[name].length]
      const def = sim.data.units.get(id)!
      if (sim.credits < def.cost) return
      let cells = cache.get(id)
      if (!cells) cache.set(id, (cells = rankedCells(sim, id)))
      const free = cells.filter(([x, y]) => sim.canPlace(id, x, y).ok)
      if (!free.length) return
      const pick = name === 'random' ? free[Math.floor(rnd() * Math.min(free.length, 60))] : free[0]
      sim.command({ t: 'place', unit: id, cx: pick[0], cy: pick[1] })
      step++
    }
  }
}

/** Run a full battle; the bot spends at every build phase, then calls the next wave. */
export function runBuild(sim: Sim, bot: (s: Sim) => void, maxTicks = 60 * 60 * 40) {
  while (sim.state !== 'won' && sim.state !== 'lost' && sim.tick < maxTicks) {
    if (sim.canStartWave && !sim.busy) {
      bot(sim)
      sim.command({ t: 'wave' })
    }
    sim.step()
    sim.events.length = 0
  }
  return sim
}
