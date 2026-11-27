// Determinism, replay and data-error tests: npm test
import assert from 'node:assert/strict'
import { DataError, loadGameData } from '../src/sim/data.ts'
import { Sim } from '../src/sim/sim.ts'
import { makeBot, runBuild } from './bots.ts'
import { loadData, readDataFiles } from './nodeData.ts'

let failed = 0
const test = (name: string, fn: () => void) => {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (e) {
    failed++
    console.log(`FAIL ${name}\n     ${(e as Error).message.split('\n').join('\n     ')}`)
  }
}

const data = loadData()

test('같은 입력이면 같은 결과 (2회 실행 해시 일치)', () => {
  const a = runBuild(new Sim(data, 'neon_district', 'normal'), makeBot('balanced'))
  const b = runBuild(new Sim(data, 'neon_district', 'normal'), makeBot('balanced'))
  assert.equal(a.hash(), b.hash())
  assert.equal(a.tick, b.tick)
})

test('입력 기록 재생으로 중간 상태 복원 (이어하기)', () => {
  const live = new Sim(data, 'neon_district', 'normal')
  const bot = makeBot('random', 3)
  const stopAt = 60 * 150
  while (live.tick < stopAt && live.state !== 'lost' && live.state !== 'won') {
    if (live.canStartWave && !live.busy) {
      bot(live)
      live.command({ t: 'wave' })
    }
    live.step()
    live.events.length = 0
  }
  const copy = Sim.replay(data, 'neon_district', 'normal', JSON.parse(JSON.stringify(live.log)), live.tick)
  assert.equal(copy.tick, live.tick)
  assert.equal(copy.hash(), live.hash())
})

test('설치 판정: 경로·건물·중복·크레딧', () => {
  const s = new Sim(data, 'neon_district', 'normal')
  assert.equal(s.canPlace('sentinel', 2, 2).reason, '설치 불가: 경로 위')
  assert.equal(s.canPlace('sentinel', 4, 0).reason, '설치 불가: 건물')
  assert.ok(s.command({ t: 'place', unit: 'sentinel', cx: 3, cy: 6 }))
  assert.equal(s.canPlace('sentinel', 3, 6).reason, '설치 불가: 다른 유닛')
  s.credits = 10
  assert.match(s.canPlace('sentinel', 4, 6).reason!, /크레딧 부족/)
})

test('판매: 같은 웨이브 100%, 이후 70%', () => {
  const s = new Sim(data, 'neon_district', 'normal')
  s.command({ t: 'place', unit: 'sentinel', cx: 3, cy: 6 })
  const u = s.units[0]
  assert.equal(s.sellValue(u), 200)
  s.command({ t: 'wave' })
  assert.equal(s.sellValue(u), 140)
})

test('고가 구간: 높이 없는 유닛은 못 맞힘', () => {
  const s = new Sim(data, 'neon_district', 'normal')
  const d = (s.map.elevated[0][0] + s.map.elevated[0][1]) / 2
  assert.ok(s.map.isElevated(d))
  assert.ok(!s.map.isElevated(2))
})

test('피해 계수: 중장갑 운동 0.4, 보호막 전기 2.0·에너지 0.25', () => {
  const s = new Sim(data, 'neon_district', 'normal')
  s.command({ t: 'wave' })
  const mk = (id: string) => {
    const def = data.enemies.get(id)!
    return { id: 0, def, wave: 1, dist: 1, x: 0, y: 0, angle: 0, hp: 100, maxHp: 100, shield: def.shield ? 40 : 0, maxShield: 40, lastHit: 0, slow: 0, slowUntil: 0, alive: true }
  }
  const h = mk('h02')
  s.damage(h, 10, 'kinetic', 0)
  assert.equal(h.hp, 96)
  const sh = mk('s04')
  s.damage(sh, 10, 'electric', 0)
  assert.equal(sh.shield, 20)
  s.damage(sh, 40, 'energy', 0)
  assert.equal(sh.shield, 10)
  s.damage(sh, 15, 'kinetic', 0)
  assert.equal(sh.shield, 0)
  assert.equal(sh.hp, 95)
})

test('데이터 오류는 파일과 줄 번호로 알린다', () => {
  const files = readDataFiles()
  const k = 'data/units/sentinel.json'
  files[k] = files[k].replace('"range": 3.2', '"range": "far"')
  try {
    loadGameData(files)
    assert.fail('오류가 나야 함')
  } catch (e) {
    assert.ok(e instanceof DataError)
    const line = files[k].split('\n').findIndex((l) => l.includes('"far"')) + 1
    assert.ok(e.issues.some((m) => m.startsWith(`${k}:${line} base.range`)), e.issues.join('\n'))
  }
})

test('JSON 문법 오류도 줄 번호', () => {
  const files = readDataFiles()
  files['data/difficulty.json'] = '{\n  "normal": {\n    "hp": 1,,\n  }\n}'
  try {
    loadGameData(files)
    assert.fail('오류가 나야 함')
  } catch (e) {
    assert.ok(e instanceof DataError)
    assert.ok(e.issues.some((m) => m.startsWith('data/difficulty.json:3')), e.issues.join('\n'))
  }
})

if (failed) {
  console.log(`\n${failed}개 실패`)
  process.exit(1)
}
console.log('\n전부 통과')
