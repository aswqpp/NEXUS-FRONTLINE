// Does buying upgrades create a dominant strategy? (balance.md §9)
import { evaluate, fmt, play, rankedCells, rng, BALANCED, type UpgradePlan } from './depth.ts'
import type { PathId } from '../src/sim/data.ts'
import { loadData } from './nodeData.ts'
import { Sim } from '../src/sim/sim.ts'

const N = Number(process.env.N ?? 30)
const data = loadData()
const ranked = rankedCells(data, new Sim(data, 'neon_district', 'normal'))
const A5: PathId[] = ['A', 'A', 'A', 'A', 'A', 'C', 'C']
const C5: PathId[] = ['C', 'C', 'C', 'C', 'C', 'A', 'A']
const B5: PathId[] = ['B', 'B', 'B', 'B', 'B', 'A', 'A']
const A3: PathId[] = ['A', 'A', 'A', 'C', 'C']
const plans: [string, string[], UpgradePlan, number][] = [
  ['SENTINEL 몰빵 · 업그레이드 없음', ['sentinel'], {}, 1.5],
  ['SENTINEL 몰빵 · 전원 A', ['sentinel'], { sentinel: A5 }, 6],
  ['SENTINEL 몰빵 · 1기 C + 나머지 A', ['sentinel'], { sentinel: [{ order: C5, units: 1 }, { order: A5, units: 99 }] }, 6],
  ['균형 · 업그레이드 없음', BALANCED, {}, 1.5],
  ['균형 · SENTINEL 전원 A', BALANCED, { sentinel: A5 }, 1.5],
  ['균형 · SENTINEL 전원 A3 까지', BALANCED, { sentinel: A3 }, 1.5],
  ['균형 · SENTINEL 1기 C, 나머지 A', BALANCED, { sentinel: [{ order: C5, units: 1 }, { order: A5, units: 99 }] }, 1.5],
  ['균형 · SENTINEL 1기 B, 나머지 A', BALANCED, { sentinel: [{ order: B5, units: 1 }, { order: A5, units: 99 }] }, 1.5],
  ['균형 · SENTINEL 1기 C만, 나머지 없음', BALANCED, { sentinel: [{ order: C5, units: 1 }] }, 1.5],
]
console.log(`N=${N}\n\n| 빌드 | 결과 | 승리 중 한 유닛 50%+ |\n| --- | --- | --- |`)
for (const [name, order, plan, ratio] of plans) {
  const R = rng(9)
  const runs = Array.from({ length: N }, () => play(data, order, Array.from({ length: 24 }, () => Math.floor(R() * 1000)), 6, ranked, plan, ratio))
  const cores = runs.map((r) => (r.won ? r.core : -1)).sort((a, b) => a - b)
  console.log(`| ${name} | ${runs.filter((r) => r.won).length}/${N} 클리어, 코어 최소 ${cores[0]} 중앙 ${cores[N >> 1]} | ${runs.filter((r) => r.won && r.top >= 0.5).length} |`)
}
void evaluate
void fmt
