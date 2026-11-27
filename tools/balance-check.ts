// Balance regression for chapter 1 waves 1-10 (docs/balance.md). Fails the run
// when any criterion slips. npm run check:balance
import { evaluate, fmt } from './depth.ts'
import { loadData } from './nodeData.ts'
import { table } from './step-value.ts'

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
// upgrade value band (balance.md §9): 1.00 = buying another bare SENTINEL against plain enemies
console.log('\n### 업그레이드 단계 가치 (한계 효율)')
const all = Object.fromEntries(['sentinel', 'railx', 'arc'].map((u) => [u, table(loadData(), u)]))
const mm = (unit: string, prefix: string) => all[unit].find((r) => r.step.startsWith(prefix))!.marginal
const m = (prefix: string) => mm('sentinel', prefix)
const bands: [string, number, number, number][] = [
  ['RAIL-X A1 일반', mm('railx', 'A1').plain, 0.8, 1.6],
  ['RAIL-X A3 일반', mm('railx', 'A3').plain, 0.8, 1.6],
  ['RAIL-X A4 일반', mm('railx', 'A4').plain, 0.8, 1.6],
  ['RAIL-X A5 일반', mm('railx', 'A5').plain, 0.8, 1.6],
  ['RAIL-X A2 중장갑 (T0 중장갑 대비)', mm('railx', 'A2').armored / mm('railx', 'T0').armored, 0.9, 3],
  ['ARC A1 일반', mm('arc', 'A1').plain, 0.8, 1.6],
  ['ARC A3 일반', mm('arc', 'A3').plain, 0.8, 1.6],
  ['ARC A4 일반', mm('arc', 'A4').plain, 0.8, 1.6],
  ['ARC A5 일반', mm('arc', 'A5').plain, 0.8, 1.6],
  ['ARC B1 보호막', mm('arc', 'B1').shielded, 0.9, 99],
  ['ARC B2 일반', mm('arc', 'B2').plain, 0.8, 1.6],
  ['ARC B3 팀 은폐', mm('arc', 'B3').teamStealth, 1.0, 99],
  ['ARC C3 팀', mm('arc', 'C3').team, 0.8, 99],
  ['A1 일반', m('A1').plain, 0.8, 1.6],
  // against armour the alternative is another SENTINEL against armour, so divide by T0's armoured value
  ['A2 중장갑 (T0 중장갑 대비)', m('A2').armored / m('T0').armored, 0.9, 2.5],
  ['A3 일반', m('A3').plain, 0.8, 1.6],
  ['A4 일반', m('A4').plain, 0.8, 1.6],
  ['A5 일반', m('A5').plain, 0.8, 1.6],
  ['C1 은폐', m('C1').stealth, 1.0, 99],
  ['C3 팀 은폐', m('C3').teamStealth, 1.0, 99],
]
for (const [name, v, lo, hi] of bands) {
  const ok = v >= lo && v <= hi
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.startsWith('RAIL') || name.startsWith('ARC') ? '' : 'SENTINEL '}${name} ${v.toFixed(2)} (기준 ${lo}~${hi === 99 ? '' : hi})`)
  if (!ok) bad++
}

if (bad) {
  console.log(`\n${bad}개 기준 미충족`)
  process.exit(1)
}
console.log('\n밸런스 기준 전부 충족')
