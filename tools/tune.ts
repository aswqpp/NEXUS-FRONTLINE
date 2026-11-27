// Sensitivity sweep: which single data change moves the chapter-19 criteria, and
// the smallest combination that meets all of them. npm run tune
import type { GameData } from '../src/sim/data.ts'
import { evaluate, fmt } from './depth.ts'
import { loadData } from './nodeData.ts'

const N = Number(process.env.N ?? 30)
type Knob = { name: string; apply: (d: GameData, v: number) => void; values: number[]; base: number }

function clone(d: GameData): GameData {
  return structuredClone(d)
}

const KNOBS: Knob[] = [
  { name: 'RAIL-X 사거리', base: 5, values: [6, 4.5, 4], apply: (d, v) => (d.units.get('railx')!.base.range = v) },
  { name: '시작 크레딧', base: 650, values: [550, 500, 450], apply: (d, v) => (d.difficulty.get('normal')!.startCredits = v) },
  { name: '적 체력 배율', base: 1, values: [1.15, 1.3, 1.45], apply: (d, v) => (d.difficulty.get('normal')!.hp = v) },
  {
    name: 'W6·W9 중장갑 수 배율',
    base: 1,
    values: [1.5, 2],
    apply: (d, v) => {
      for (const w of [5, 8]) for (const g of d.waves.get('neon_district_normal')!.waves[w].groups) if (g.enemy === 'h02') g.count = Math.round(g.count * v)
    },
  },
]

const base = loadData()
const row = (label: string, r: ReturnType<typeof evaluate>) =>
  console.log(
    `| ${label} | ${fmt(r.mono)} | ${fmt(r.monoRail)} | ${fmt(r.random)} | ${fmt(r.balanced)} | ${Object.values(r.criteria).filter(Boolean).length}/4 |`,
  )
console.log(`N=${N}판씩\n\n| 변경 | SENTINEL 몰빵 | RAIL-X 몰빵 | 무작위 | 균형 | 기준 |\n| --- | --- | --- | --- | --- | --- |`)
row('현재 값', evaluate(base, N))
for (const k of KNOBS)
  for (const v of k.values) {
    const d = clone(base)
    k.apply(d, v)
    row(`${k.name} ${k.base}→${v}`, evaluate(d, N))
  }

// combinations of two knobs, smallest steps first
const combos: { label: string; set: [Knob, number][]; cost: number }[] = []
for (let a = 0; a < KNOBS.length; a++)
  for (let b = a + 1; b < KNOBS.length; b++)
    for (const [ia, va] of KNOBS[a].values.entries())
      for (const [ib, vb] of KNOBS[b].values.entries())
        combos.push({ label: `${KNOBS[a].name} ${va} + ${KNOBS[b].name} ${vb}`, set: [[KNOBS[a], va], [KNOBS[b], vb]], cost: ia + ib + 2 })
combos.sort((x, y) => x.cost - y.cost)
console.log('\n## 두 가지 조합 (작은 변경부터, 기준 4/4인 것만)')
let found = 0
for (const c of combos) {
  const d = clone(base)
  for (const [k, v] of c.set) k.apply(d, v)
  const r = evaluate(d, N)
  if (r.pass) {
    row(c.label, r)
    if (++found >= 4) break
  }
}
if (!found) console.log('(4/4를 만족하는 두 가지 조합 없음)')
