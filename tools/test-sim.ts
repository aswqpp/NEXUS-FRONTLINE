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
    return { id: 0, def, wave: 1, dist: 1, x: 0, y: 0, angle: 0, hp: 100, maxHp: 100, shield: def.shield ? 40 : 0, maxShield: 40, lastHit: 0, slow: 0, slowUntil: 0, markUntil: 0, markBonus: 0, markSpread: 0, rootUntil: 0, rootReadyAt: 0, alive: true }
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

// ---------------------------------------------------------------- upgrades (05장)
const rich = (opts = {}) => {
  const s = new Sim(data, 'neon_district', 'normal', opts)
  s.credits = 1e6
  s.command({ t: 'place', unit: 'sentinel', cx: 3, cy: 6 })
  return { s, u: s.units[0] }
}
const up = (s: Sim, id: number, path: 'A' | 'B' | 'C', n = 1) => {
  for (let i = 0; i < n; i++) if (!s.command({ t: 'upgrade', id, path })) return false
  return true
}

test('경로 규칙: 경로 2개까지, 주력 하나만 3단계 이상, 다른 경로 최대 2', () => {
  const { s, u } = rich()
  assert.ok(up(s, u.id, 'A', 3))
  assert.ok(up(s, u.id, 'B', 2))
  assert.equal(s.upgradeStatus(u, 'B').state, 'locked')
  assert.match(s.upgradeStatus(u, 'B').reason!, /A 경로가 주력/)
  assert.equal(s.upgradeStatus(u, 'C').reason, '경로는 2개까지')
  assert.equal(s.tier(u), 3)
})

test('2-2에서 어느 쪽이든 3단계로 갈 수 있다', () => {
  const { s, u } = rich()
  up(s, u.id, 'A', 2)
  up(s, u.id, 'C', 2)
  assert.equal(s.upgradeStatus(u, 'C').state, 'buy')
  assert.ok(up(s, u.id, 'C'))
  assert.equal(s.upgradeStatus(u, 'A').state, 'locked')
})

test('Tier 6: 3장 전에는 설계 데이터 없음, 해금 시 맵에 하나', () => {
  const a = rich()
  up(a.s, a.u.id, 'A', 5)
  assert.equal(a.s.upgradeStatus(a.u, 'A').state, 'nodata')
  const b = rich({ unlockT6: true })
  assert.ok(up(b.s, b.u.id, 'A', 6))
  b.s.command({ t: 'place', unit: 'sentinel', cx: 4, cy: 6 })
  const v = b.s.units[1]
  up(b.s, v.id, 'A', 5)
  assert.equal(b.s.upgradeStatus(v, 'A').reason, '같은 Tier 6은 맵에 하나')
})

test('효과: 연사·장갑 관통·쌍열·회전포·높이', () => {
  const { s, u } = rich()
  up(s, u.id, 'A', 1)
  assert.ok(Math.abs(s.interval(u) - 0.375) < 1e-3, String(s.interval(u)))
  up(s, u.id, 'A', 2)
  assert.equal(u.stats.armorPen, 0.5)
  assert.equal(u.stats.multishot, 2)
  up(s, u.id, 'A', 2)
  assert.equal(u.stats.multishot, 1)
  assert.ok(Math.abs(u.stats.damage / s.interval(u) - 120) < 1, `DPS ${u.stats.damage / s.interval(u)}`)
  const b = rich()
  up(b.s, b.u.id, 'B', 1)
  assert.ok(b.u.stats.elevated)
})

test('투자액: 판매 환급에 업그레이드 포함', () => {
  const { s, u } = rich()
  up(s, u.id, 'A', 2)
  assert.equal(u.invested, 200 + 120 + 200)
  assert.equal(s.sellValue(u), 520)
})

test('강화 중첩: 같은 종류 100% · 60% · 30%, 자기 자신 제외', () => {
  const s = new Sim(data, 'neon_district', 'normal')
  s.credits = 1e6
  const cells: [number, number][] = [[3, 6], [4, 6], [3, 5], [5, 6], [4, 5]]
  for (const [x, y] of cells) s.command({ t: 'place', unit: 'sentinel', cx: x, cy: y })
  const [target, ...relays] = s.units
  for (const r of relays) up(s, r.id, 'C', 3)
  s.step()
  assert.ok(Math.abs(target.buffs.range - (0.15 + 0.09 + 0.045)) < 1e-9, String(target.buffs.range))
  assert.deepEqual(target.buffs.list.filter((e) => e.type === 'range').map((e) => e.weight), [1, 0.6, 0.3, 0])
  assert.ok(target.buffs.detect)
  assert.ok(Math.abs(s.range(target) - 3.2 * 1.285) < 1e-9)
})

test('표식: 받는 피해 +25%', () => {
  const { s, u } = rich()
  up(s, u.id, 'B', 3)
  s.command({ t: 'wave' })
  for (let i = 0; i < 60 * 30 && !s.enemies.some((e) => e.markUntil > s.time); i++) s.step()
  const e = s.enemies.find((x) => x.markUntil > s.time)
  assert.ok(e, '표식된 적이 있어야 함')
  const hp = e!.hp
  s.damage(e!, 10, 'energy', 0)
  assert.ok(Math.abs(hp - e!.hp - 12.5) < 1e-9)
})

test('업그레이드가 섞여도 같은 입력이면 같은 결과', () => {
  const run = () => {
    const s = new Sim(data, 'neon_district', 'normal')
    s.command({ t: 'place', unit: 'sentinel', cx: 3, cy: 6 })
    s.command({ t: 'wave' })
    for (let i = 0; i < 60 * 200; i++) {
      if (s.canStartWave && !s.busy) {
        s.command({ t: 'upgrade', id: s.units[0].id, path: s.units[0].levels[0] < 3 ? 'A' : 'C' })
        s.command({ t: 'wave' })
      }
      s.step()
    }
    return s
  }
  const a = run()
  const b = run()
  assert.equal(a.hash(), b.hash())
  const c = Sim.replay(data, 'neon_district', 'normal', a.log, a.tick)
  assert.equal(c.hash(), a.hash())
})

if (failed) {
  console.log(`\n${failed}개 실패`)
  process.exit(1)
}
console.log('\n전부 통과')
