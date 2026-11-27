// Headless balance run: npm run sim [-- build ...]
import { Sim } from '../src/sim/sim.ts'
import { makeBot, runBuild, type BuildName } from './bots.ts'
import { loadData } from './nodeData.ts'

const data = loadData()
const builds = (process.argv.slice(2).length ? process.argv.slice(2) : ['balanced', 'noSupport', 'mono', 'random']) as BuildName[]
for (const b of builds) {
  const t0 = performance.now()
  const sim = runBuild(new Sim(data, 'neon_district', 'normal'), makeBot(b))
  const ms = performance.now() - t0
  console.log(`\n## ${b}: ${sim.state === 'won' ? '클리어' : `실패 (웨이브 ${sim.wave})`} · 코어 ${sim.core}/${sim.coreMax} · ${(sim.tick / 60).toFixed(0)}s 게임 시간 · ${ms.toFixed(0)}ms`)
  console.log('| W | 코어 손상 | 수입 | 처치 |\n| --- | --- | --- | --- |')
  for (const s of sim.stats) console.log(`| ${s.wave} | ${s.coreDamage} | ${s.income} | ${s.kills} |`)
  const byType = new Map<string, number>()
  let total = 0
  for (const u of sim.units) {
    byType.set(u.def.name, (byType.get(u.def.name) ?? 0) + u.damage)
    total += u.damage
  }
  const share = [...byType].map(([k, v]) => `${k} ${((100 * v) / Math.max(1, total)).toFixed(0)}%`).join(' · ')
  console.log(`유닛 ${sim.units.length}기 · 피해 비율: ${share}`)
  const top = Math.max(0, ...[...byType.values()].map((v) => v / Math.max(1, total)))
  if (sim.state === 'won' && top >= 0.5) console.log('경고: 한 유닛이 피해 50% 이상인 빌드가 클리어 (19장 밸런스 문제)')
}
