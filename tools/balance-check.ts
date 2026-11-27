// Balance regression for chapter 1 waves 1-10 (docs/balance.md). Fails the run
// when any criterion slips. npm run check:balance
import { evaluate, fmt } from './depth.ts'
import { loadData } from './nodeData.ts'

const N = Number(process.env.N ?? 40)
const SEEDS = [1, 2, 3]
let bad = 0
for (const seed of SEEDS) {
const r = evaluate(loadData(), N, seed)
console.log(`\n### 배치 시드 ${seed} · ${N}판씩`)
const criteria: [string, boolean, string][] = [
  ['균형 빌드는 배치가 달라도 전부 클리어', r.balanced.wins === r.balanced.n, fmt(r.balanced)],
  ['균형 빌드에서 한 유닛 피해 50% 이상인 승리 없음', r.balanced.topHeavyWins === 0, `${r.balanced.topHeavyWins}판`],
  ['무작위 빌드의 중앙값은 패배', r.random.wins < r.random.n / 2, fmt(r.random)],
  ['RAIL-X 몰빵은 크게 벌 받는다 (코어 중앙값 50 이하)', r.monoRail.coreMed <= 50, fmt(r.monoRail)],
  ['RAIL-X 몰빵이 균형보다 코어 중앙값 40 이상 낮다', r.balanced.coreMed - r.monoRail.coreMed >= 40, `${r.balanced.coreMed} vs ${r.monoRail.coreMed}`],
]
for (const [name, ok, info] of criteria) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} — ${info}`)
  if (!ok) bad++
}
console.log(`참고 (판정 제외, W11 이후 판정): SENTINEL 몰빵 ${fmt(r.mono)}`)
}
if (bad) {
  console.log(`\n${bad}개 기준 미충족`)
  process.exit(1)
}
console.log('\n밸런스 기준 전부 충족')
