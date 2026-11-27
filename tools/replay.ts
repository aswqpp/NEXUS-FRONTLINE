// Verify and summarise playtest records: npm run replay -- file.json [...]
// Re-runs the command log on the current data and checks it lands on the same state.
import { readFileSync } from 'node:fs'
import { Sim, type LoggedCommand } from '../src/sim/sim.ts'
import { loadData, readDataFiles } from './nodeData.ts'

function dataHash(files: Record<string, string>): string {
  let h = 0x811c9dc5
  for (const k of Object.keys(files).sort()) for (const ch of k + files[k]) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}

const files = readDataFiles()
const current = dataHash(files)
const data = loadData()
let bad = 0
for (const f of process.argv.slice(2)) {
  const rec = JSON.parse(readFileSync(f, 'utf8')) as {
    dataHash: string; map: string; difficulty: string; endTick: number; hash: string
    result: { state: string; core: number; wave: number; evacuation: number }; log: LoggedCommand[]; cmdMs: number[]; pausedMs: number
  }
  console.log(`\n## ${f}`)
  if (rec.dataHash !== current) console.log(`주의: 기록 당시 데이터(${rec.dataHash})와 지금 데이터(${current})가 다르다. 재생 결과가 달라도 정상일 수 있음.`)
  const sim = Sim.replay(data, rec.map, rec.difficulty, rec.log, rec.endTick)
  const same = sim.hash() === rec.hash
  if (!same && rec.dataHash === current) bad++
  console.log(`재생: ${same ? '일치' : '불일치'} (tick ${sim.tick}, ${sim.state}, 코어 ${sim.core}, 웨이브 ${sim.wave})`)
  console.log(`기록 결과: ${rec.result.state}, 코어 ${rec.result.core}, 대피 ${(rec.result.evacuation * 100).toFixed(0)}%`)
  // think time: real seconds between a wave start and the previous command
  const waves = rec.log.map((l, i) => ({ l, ms: rec.cmdMs[i] })).filter((x) => x.l.cmd.t === 'wave')
  const gaps = waves.slice(1).map((w, i) => (w.ms - waves[i].ms) / 1000)
  const placed = rec.log.filter((l) => l.cmd.t === 'place').length
  const sold = rec.log.filter((l) => l.cmd.t === 'sell').length
  const prio = rec.log.filter((l) => l.cmd.t === 'priority').length
  console.log(`설치 ${placed} · 판매 ${sold} · 우선순위 변경 ${prio} · 일시정지 ${(rec.pausedMs / 1000).toFixed(0)}s`)
  if (gaps.length) console.log(`웨이브 시작 간격(실제 초): ${gaps.map((g) => g.toFixed(0)).join(' ')}`)
  console.log('| W | 코어 손상 | 수입 | 처치 |\n| --- | --- | --- | --- |')
  for (const s of sim.stats) console.log(`| ${s.wave} | ${s.coreDamage} | ${s.income} | ${s.kills} |`)
}
process.exit(bad ? 1 : 0)
