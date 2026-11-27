// Deterministic battle simulation (지시서 16장). Fixed 60 ticks per second, no DOM,
// no Math.random, no wall clock. Same data + same commands at the same ticks =
// same result, so it can run headless for balance checks and be replayed to
// resume a saved battle.

import { PATHS, type BuffType, type DamageType, type Difficulty, type EnemyDef, type GameData, type PathId, type UnitBase, type UnitDef, type Upgrade, type WaveSet } from './data.ts'
import { CELL_GROUND, MapGeom } from './map.ts'

export const TICK_RATE = 60
export const DT = 1 / TICK_RATE

export type Priority = 'first' | 'last' | 'strong' | 'close'
export const PRIORITIES: Priority[] = ['first', 'last', 'strong', 'close']

export type Command =
  | { t: 'place'; unit: string; cx: number; cy: number }
  | { t: 'sell'; id: number }
  | { t: 'wave' }
  | { t: 'priority'; id: number; p: Priority }
  | { t: 'upgrade'; id: number; path: PathId }

export interface LoggedCommand {
  tick: number
  cmd: Command
}

export interface Unit {
  id: number
  def: UnitDef
  cx: number
  cy: number
  x: number
  y: number
  cooldown: number
  angle: number
  priority: Priority
  invested: number
  placedWave: number
  damage: number
  kills: number
  /** ticks since last shot, for recoil animation */
  fired: number
  /** upgrade levels for paths A, B, C */
  levels: [number, number, number]
  /** base stats with this unit's own upgrades applied */
  stats: UnitBase
  /** stacked buffs received from nearby units (06장 rules) */
  buffs: Buffs
  targetId: number
  /** command-node bonus that applies to the current target */
  cmdBonus: number
  focusId: number
  focusStacks: number
}

export interface BuffEntry {
  type: BuffType
  value: number
  /** share actually applied: 1, 0.6, 0.3 or 0 */
  weight: number
  src: number
}

export interface Buffs {
  range: number
  attackSpeed: number
  damage: number
  cooldown: number
  detect: boolean
  list: BuffEntry[]
}

const NO_BUFFS: Buffs = { range: 0, attackSpeed: 0, damage: 0, cooldown: 0, detect: false, list: [] }
const STACK_WEIGHTS = [1, 0.6, 0.3]
export const ATTACK_SPEED_CAP = 0.8

export interface UpgradeStatus {
  path: PathId
  level: number
  step?: Upgrade
  /** 'buy' | 'poor' | 'locked' | 'nodata' | 'max' */
  state: 'buy' | 'poor' | 'locked' | 'nodata' | 'max'
  reason?: string
}

export interface Enemy {
  id: number
  def: EnemyDef
  wave: number
  dist: number
  x: number
  y: number
  angle: number
  hp: number
  maxHp: number
  shield: number
  maxShield: number
  lastHit: number
  slow: number
  slowUntil: number
  markUntil: number
  markBonus: number
  markSpread: number
  rootUntil: number
  rootReadyAt: number
  alive: boolean
}

export interface Projectile {
  x: number
  y: number
  tx: number
  ty: number
  target: number
  owner: number
  speed: number
  damage: number
  dtype: DamageType
  armorPen: number
  alive: boolean
}

export type SimEvent =
  | { e: 'shot'; unit: number; x: number; y: number; angle: number }
  | { e: 'rail'; x1: number; y1: number; x2: number; y2: number }
  | { e: 'chain'; pts: number[] }
  | { e: 'pulse'; x: number; y: number; r: number }
  | { e: 'hit'; x: number; y: number; dtype: DamageType; shield: boolean }
  | { e: 'death'; x: number; y: number; enemy: string; reward: number }
  | { e: 'leak'; enemy: string; damage: number }
  | { e: 'waveStart'; wave: number }
  | { e: 'waveClear'; wave: number; bonus: number }
  | { e: 'placed'; unit: number }
  | { e: 'sold'; unit: number; refund: number }
  | { e: 'upgraded'; unit: number; path: PathId; level: number; tier: number }
  | { e: 'end'; won: boolean }

interface ActiveWave {
  index: number
  spawns: { time: number; enemy: string }[]
  next: number
  t: number
  alive: number
  done: boolean
}

export type SimState = 'build' | 'running' | 'won' | 'lost'

export interface WaveStat {
  wave: number
  coreDamage: number
  income: number
  kills: number
}

const SHIELD_COEF: Record<DamageType, number> = { kinetic: 1, energy: 0.25, electric: 2, explosive: 1 }

export class Sim {
  readonly data: GameData
  readonly map: MapGeom
  readonly waveSet: WaveSet
  readonly diff: Difficulty
  readonly totalWaves: number

  tick = 0
  state: SimState = 'build'
  credits: number
  core: number
  readonly coreMax: number
  /** number of waves started */
  wave = 0
  units: Unit[] = []
  enemies: Enemy[] = []
  projectiles: Projectile[] = []
  events: SimEvent[] = []
  readonly log: LoggedCommand[] = []
  readonly stats: WaveStat[] = []
  /** damage taken by the core, per enemy id */
  readonly coreHitsBy = new Map<string, number>()

  private active: ActiveWave[] = []
  private nextId = 1
  private occupied: Int32Array

  /** Tier 6 needs chapter 3 (05장); the slice keeps it locked unless a test or ?unlock=t6 says otherwise */
  readonly unlockT6: boolean
  private buffsDirty = true

  constructor(data: GameData, mapId: string, difficulty: string, opts: { unlockT6?: boolean } = {}) {
    this.unlockT6 = !!opts.unlockT6
    this.data = data
    const md = data.maps.get(mapId)
    const ws = data.waves.get(`${mapId}_${difficulty}`)
    const df = data.difficulty.get(difficulty)
    if (!md || !ws || !df) throw new Error(`no data for ${mapId}/${difficulty}`)
    this.map = new MapGeom(md)
    this.waveSet = ws
    this.diff = df
    this.totalWaves = ws.waves.length
    this.credits = df.startCredits
    this.core = this.coreMax = df.core
    this.occupied = new Int32Array(md.cols * md.rows)
  }

  get time() {
    return this.tick * DT
  }

  /** Waves still spawning or with enemies alive. */
  get busy(): boolean {
    return this.active.length > 0
  }

  /** True when the player may call the next wave now (previous one finished spawning). */
  get canStartWave(): boolean {
    if (this.state === 'won' || this.state === 'lost') return false
    if (this.wave >= this.totalWaves) return false
    return this.active.every((w) => w.next >= w.spawns.length)
  }

  rewardMul(wave: number): number {
    const n = this.waveSet.inflationBase
    const infl = wave <= 0.6 * n ? 1 : wave <= 0.7 * n ? 0.85 : wave <= 0.85 * n ? 0.7 : 0.55
    return (1 + 0.07 * (wave - 1)) * infl * this.diff.reward
  }

  waveBonus(wave: number): number {
    return 80 + 17 * wave
  }

  hpMul(wave: number): number {
    return (1 + 0.09 * (wave - 1) + 0.004 * (wave - 1) ** 2) * this.diff.hp
  }

  /** Kill rewards + clear bonus for the next wave, if every enemy dies. */
  expectedIncome(wave = this.wave + 1): number {
    const w = this.waveSet.waves[wave - 1]
    if (!w) return 0
    let sum = 0
    const add = (id: string, n: number) => {
      const e = this.data.enemies.get(id)!
      sum += n * Math.round(e.reward * this.rewardMul(wave))
      if (e.split) add(e.split.into, n * e.split.count)
    }
    for (const g of w.groups) add(g.enemy, g.count)
    return sum + this.waveBonus(wave)
  }

  /** Evacuation completion (D-16). */
  evacuation(): number {
    if (this.state === 'won') return 1
    const cur = this.active.find((w) => w.index === this.wave)
    let prog = 0
    if (cur && cur.spawns.length) prog = cur.next / cur.spawns.length
    return Math.max(0, Math.min(1, (Math.max(0, this.wave - 1) + prog) / this.totalWaves))
  }

  unitAt(cx: number, cy: number): Unit | undefined {
    const id = this.occupied[cy * this.map.cols + cx]
    return id ? this.units.find((u) => u.id === id) : undefined
  }

  canPlace(unitId: string, cx: number, cy: number): { ok: boolean; reason?: string } {
    const def = this.data.units.get(unitId)
    if (!def) return { ok: false, reason: '알 수 없는 유닛' }
    const c = this.map.cell(cx, cy)
    if (c < 0) return { ok: false, reason: '설치 불가: 맵 밖' }
    if (c !== CELL_GROUND) return { ok: false, reason: ['', '설치 불가: 경로 위', '설치 불가: 건물', '설치 불가: 변전소'][c] }
    if (this.occupied[cy * this.map.cols + cx]) return { ok: false, reason: '설치 불가: 다른 유닛' }
    if (this.credits < def.cost) return { ok: false, reason: `크레딧 부족 (−${def.cost - this.credits})` }
    if (this.state === 'won' || this.state === 'lost') return { ok: false, reason: '전투 종료' }
    return { ok: true }
  }

  sellValue(u: Unit): number {
    return Math.floor(u.invested * (u.placedWave === this.wave ? 1 : 0.7))
  }

  /** Apply a command now and record it for replay. Returns false if it was rejected. */
  command(cmd: Command): boolean {
    const ok = this.apply(cmd)
    if (ok) this.log.push({ tick: this.tick, cmd })
    return ok
  }

  private apply(cmd: Command): boolean {
    switch (cmd.t) {
      case 'place': {
        if (!this.canPlace(cmd.unit, cmd.cx, cmd.cy).ok) return false
        const def = this.data.units.get(cmd.unit)!
        const u: Unit = {
          id: this.nextId++,
          def,
          cx: cmd.cx,
          cy: cmd.cy,
          x: cmd.cx + 0.5,
          y: cmd.cy + 0.5,
          cooldown: 0,
          angle: -Math.PI / 2,
          priority: 'first',
          invested: def.cost,
          placedWave: this.wave,
          damage: 0,
          kills: 0,
          fired: 999,
          levels: [0, 0, 0],
          stats: { ...def.base },
          buffs: NO_BUFFS,
          targetId: 0,
          cmdBonus: 0,
          focusId: 0,
          focusStacks: 0,
        }
        this.credits -= def.cost
        this.units.push(u)
        this.occupied[cmd.cy * this.map.cols + cmd.cx] = u.id
        this.events.push({ e: 'placed', unit: u.id })
        this.buffsDirty = true
        return true
      }
      case 'sell': {
        const i = this.units.findIndex((u) => u.id === cmd.id)
        if (i < 0 || this.state === 'won' || this.state === 'lost') return false
        const u = this.units[i]
        const refund = this.sellValue(u)
        this.credits += refund
        this.units.splice(i, 1)
        this.occupied[u.cy * this.map.cols + u.cx] = 0
        this.events.push({ e: 'sold', unit: u.id, refund })
        this.buffsDirty = true
        return true
      }
      case 'priority': {
        const u = this.units.find((x) => x.id === cmd.id)
        if (!u || !PRIORITIES.includes(cmd.p)) return false
        u.priority = cmd.p
        return true
      }
      case 'upgrade': {
        const u = this.units.find((x) => x.id === cmd.id)
        if (!u || this.state === 'won' || this.state === 'lost') return false
        const st = this.upgradeStatus(u, cmd.path)
        if (st.state !== 'buy' || !st.step) return false
        const i = PATHS.indexOf(cmd.path)
        this.credits -= st.step.cost
        u.invested += st.step.cost
        u.levels[i]++
        this.applyStats(u)
        this.buffsDirty = true
        this.events.push({ e: 'upgraded', unit: u.id, path: cmd.path, level: u.levels[i], tier: this.tier(u) })
        return true
      }
      case 'wave': {
        if (!this.canStartWave) return false
        this.startWave()
        return true
      }
    }
  }

  // ------------------------------------------------------------------ upgrades

  /** Tier = the main path's level (05장). */
  tier(u: Unit): number {
    return Math.max(...u.levels)
  }

  /** Path rules (05장): two paths at most, only one of them past 2, Tier 6 once per unit+path per map. */
  upgradeStatus(u: Unit, path: PathId): UpgradeStatus {
    const i = PATHS.indexOf(path)
    const lv = u.levels[i]
    const list = u.def.paths[path]
    if (lv >= list.length) return { path, level: lv, state: 'max', reason: lv ? '최대 단계' : '경로 없음' }
    const step = list[lv]
    const next = lv + 1
    const others = u.levels.map((l, j) => ({ l, p: PATHS[j] })).filter((_, j) => j !== i)
    if (lv === 0 && others.filter((o) => o.l > 0).length >= 2) return { path, level: lv, step, state: 'locked', reason: '경로는 2개까지' }
    const main = others.find((o) => o.l >= 3)
    if (next >= 3 && main) return { path, level: lv, step, state: 'locked', reason: `${main.p} 경로가 주력 (최대 2단계)` }
    if (next === 6) {
      if (!this.unlockT6) return { path, level: lv, step, state: 'nodata', reason: '설계 데이터 없음 — 3장 생산 라인 이후' }
      if (this.units.some((x) => x !== u && x.def.id === u.def.id && x.levels[i] >= 6))
        return { path, level: lv, step, state: 'locked', reason: '같은 Tier 6은 맵에 하나' }
    }
    if (this.credits < step.cost) return { path, level: lv, step, state: 'poor', reason: `크레딧 부족 (−${step.cost - this.credits})` }
    return { path, level: lv, step, state: 'buy' }
  }

  /** Base stats + this unit's own upgrades, in path order A, B, C and step order. */
  private applyStats(u: Unit) {
    const st: UnitBase = { ...u.def.base }
    PATHS.forEach((p, i) => {
      for (let k = 0; k < u.levels[i]; k++)
        for (const ef of u.def.paths[p][k].effects) {
          if (ef.op === 'mul') st[ef.stat] *= ef.value
          else if (ef.op === 'add') st[ef.stat] += ef.value
          else if (ef.op === 'set') (st as unknown as Record<string, number | boolean>)[ef.stat] = ef.value
        }
    })
    u.stats = st
  }

  /** Auras this unit gives, from its bought steps. */
  private aurasOf(u: Unit) {
    const out: { buff: BuffType; value: number; radius: number; filter?: DamageType }[] = []
    PATHS.forEach((p, i) => {
      for (let k = 0; k < u.levels[i]; k++) for (const ef of u.def.paths[p][k].effects) if (ef.op === 'aura') out.push(ef)
    })
    return out
  }

  /** Stacking (06장): per type, strongest first at 100% / 60% / 30%; attack speed capped at +80%. */
  private recomputeBuffs() {
    this.buffsDirty = false
    const auras = this.units.map((u) => ({ u, a: this.aurasOf(u) })).filter((x) => x.a.length)
    for (const u of this.units) {
      const entries: BuffEntry[] = []
      for (const { u: src, a } of auras) {
        if (src === u) continue
        const d = Math.hypot(src.x - u.x, src.y - u.y)
        for (const au of a) {
          if (d > au.radius + 1e-6) continue
          if (au.filter && au.filter !== u.stats.damageType) continue
          entries.push({ type: au.buff, value: au.value, weight: 0, src: src.id })
        }
      }
      const b: Buffs = { range: 0, attackSpeed: 0, damage: 0, cooldown: 0, detect: false, list: entries }
      for (const type of ['range', 'attackSpeed', 'damage', 'cooldown'] as const) {
        const list = entries.filter((e) => e.type === type).sort((x, y) => y.value - x.value || x.src - y.src)
        list.forEach((e, k) => {
          e.weight = STACK_WEIGHTS[k] ?? 0
          b[type] += e.value * e.weight
        })
      }
      b.attackSpeed = Math.min(ATTACK_SPEED_CAP, b.attackSpeed)
      b.detect = entries.some((e) => e.type === 'detect')
      for (const e of entries) if (e.type === 'detect') e.weight = 1
      u.buffs = b
    }
  }

  range(u: Unit): number {
    return u.stats.range * (1 + u.buffs.range)
  }

  interval(u: Unit): number {
    return u.stats.fireInterval / (1 + u.buffs.attackSpeed)
  }

  detects(u: Unit): boolean {
    return u.stats.detect || u.buffs.detect
  }

  private startWave() {
    const index = ++this.wave
    const spawns: ActiveWave['spawns'] = []
    for (const g of this.waveSet.waves[index - 1].groups)
      for (let k = 0; k < g.count; k++) spawns.push({ time: g.delay + k * g.interval, enemy: g.enemy })
    // stable sort: equal times keep data order
    spawns.sort((a, b) => a.time - b.time)
    this.active.push({ index, spawns, next: 0, t: 0, alive: 0, done: false })
    this.stats.push({ wave: index, coreDamage: 0, income: 0, kills: 0 })
    this.state = 'running'
    this.events.push({ e: 'waveStart', wave: index })
  }

  private spawn(def: EnemyDef, wave: number, dist: number) {
    const hp = def.fixedHp ? def.hp * this.diff.hp : def.hp * this.hpMul(wave)
    const sh = def.shield * this.hpMul(wave)
    const e: Enemy = {
      id: this.nextId++,
      def,
      wave,
      dist,
      x: 0,
      y: 0,
      angle: 0,
      hp,
      maxHp: hp,
      shield: sh,
      maxShield: sh,
      lastHit: -99,
      slow: 0,
      slowUntil: 0,
      markUntil: 0,
      markBonus: 0,
      markSpread: 0,
      rootUntil: 0,
      rootReadyAt: 0,
      alive: true,
    }
    this.map.posAt(dist, e)
    this.enemies.push(e)
    const w = this.active.find((a) => a.index === wave)
    if (w) w.alive++
  }

  private statFor(wave: number): WaveStat | undefined {
    return this.stats[wave - 1]
  }

  // ------------------------------------------------------------------ step

  /** Advance one tick. Commands for replay are applied by replay(), not here. */
  step() {
    if (this.state === 'won' || this.state === 'lost') return
    this.tick++
    const now = this.time
    if (this.buffsDirty) this.recomputeBuffs()
    this.spawnStep()
    this.moveEnemies(now)
    for (const u of this.units) this.unitStep(u, now)
    this.projectileStep()
    this.cleanup()
    this.waveBookkeeping()
  }

  private spawnStep() {
    for (const w of this.active) {
      w.t += DT
      while (w.next < w.spawns.length && w.spawns[w.next].time <= w.t + 1e-9) {
        this.spawn(this.data.enemies.get(w.spawns[w.next].enemy)!, w.index, 0)
        w.next++
      }
    }
  }

  private moveEnemies(now: number) {
    const len = this.map.length
    for (const e of this.enemies) {
      if (!e.alive) continue
      if (now > e.slowUntil) e.slow = 0
      if (now >= e.rootUntil) e.dist += e.def.speed * this.diff.speed * (1 - e.slow) * DT
      if (e.maxShield > 0 && e.shield < e.maxShield && now - e.lastHit > 3)
        e.shield = Math.min(e.maxShield, e.shield + 0.08 * e.maxShield * DT)
      if (e.dist >= len) {
        e.alive = false
        const dmg = e.def.boss ? this.core : Math.min(this.core, e.def.leak)
        this.core -= dmg
        this.coreHitsBy.set(e.def.id, (this.coreHitsBy.get(e.def.id) ?? 0) + dmg)
        const st = this.statFor(e.wave)
        if (st) st.coreDamage += dmg
        this.events.push({ e: 'leak', enemy: e.def.id, damage: dmg })
        this.enemyGone(e)
        if (this.core <= 0) {
          this.core = 0
          this.state = 'lost'
          this.events.push({ e: 'end', won: false })
          return
        }
        continue
      }
      this.map.posAt(e.dist, e)
    }
  }

  private marked(e: Enemy): boolean {
    return e.markUntil > this.time
  }

  private targetable(u: Unit, e: Enemy): boolean {
    if (!e.alive) return false
    if (e.def.stealth && !this.detects(u) && !this.marked(e)) return false
    if (!u.stats.elevated && this.map.isElevated(e.dist)) return false
    return true
  }

  private inReach(u: Unit, e: Enemy, r: number): boolean {
    const reach = r + e.def.radius * 0.5
    return (e.x - u.x) ** 2 + (e.y - u.y) ** 2 <= reach * reach
  }

  private pickTarget(u: Unit): Enemy | undefined {
    const r = this.range(u)
    u.cmdBonus = 0
    // command node (SENTINEL C5): allies in radius take the node's target if they can reach it
    let cmd: Enemy | undefined
    for (const c of this.units) {
      if (c === u || c.stats.commandRadius <= 0 || !c.targetId) continue
      if (Math.hypot(c.x - u.x, c.y - u.y) > c.stats.commandRadius) continue
      const t = this.enemies.find((e) => e.id === c.targetId)
      if (t && this.targetable(u, t) && this.inReach(u, t, r) && c.stats.commandBonus >= u.cmdBonus) {
        cmd = t
        u.cmdBonus = c.stats.commandBonus
      }
    }
    if (cmd) return cmd
    let best: Enemy | undefined
    let score = -Infinity
    for (const e of this.enemies) {
      if (!this.targetable(u, e) || !this.inReach(u, e, r)) continue
      const d2 = (e.x - u.x) ** 2 + (e.y - u.y) ** 2
      let s: number
      switch (u.priority) {
        case 'first':
          s = e.dist
          break
        case 'last':
          s = -e.dist
          break
        case 'strong':
          s = (e.hp + e.shield) * 1000 + e.dist
          break
        case 'close':
          s = -d2
          break
      }
      if (s > score) {
        score = s
        best = e
      }
    }
    return best
  }

  private unitStep(u: Unit, now: number) {
    const b = u.stats
    u.fired++
    u.cooldown -= DT
    if (b.kind === 'pulse') {
      if (u.cooldown > 0) return
      let any = false
      const r = this.range(u)
      for (const e of this.enemies) {
        if (!e.alive || this.map.isElevated(e.dist)) continue
        if ((e.x - u.x) ** 2 + (e.y - u.y) ** 2 > r * r) continue
        any = true
        this.damage(e, b.damage, b.damageType, 0, u)
        if (e.alive && b.slow >= e.slow) {
          e.slow = b.slow
          e.slowUntil = now + b.slowDuration
        }
      }
      if (any) {
        u.cooldown = this.interval(u)
        u.fired = 0
        this.events.push({ e: 'pulse', x: u.x, y: u.y, r })
      }
      return
    }
    const t = this.pickTarget(u)
    u.targetId = t ? t.id : 0
    if (!t) return
    u.angle = Math.atan2(t.y - u.y, t.x - u.x)
    if (u.cooldown > 0) return
    u.cooldown = this.interval(u)
    u.fired = 0
    const dmg = b.damage * (1 + u.buffs.damage) * (1 + u.cmdBonus)
    if (b.kind === 'gun') {
      const ca = Math.cos(u.angle)
      const sa = Math.sin(u.angle)
      const n = Math.max(1, Math.round(b.multishot))
      for (let k = 0; k < n; k++) {
        const off = n === 1 ? 0 : (k - (n - 1) / 2) * 0.17
        const mx = u.x + ca * 0.5 - sa * off
        const my = u.y + sa * 0.5 + ca * off
        this.projectiles.push({
          x: mx,
          y: my,
          tx: t.x,
          ty: t.y,
          target: t.id,
          owner: u.id,
          speed: b.projectileSpeed,
          damage: dmg,
          dtype: b.damageType,
          armorPen: b.armorPen,
          alive: true,
        })
        this.events.push({ e: 'shot', unit: u.id, x: mx, y: my, angle: u.angle })
      }
    } else if (b.kind === 'rail') {
      const dx = Math.cos(u.angle)
      const dy = Math.sin(u.angle)
      const hits: { e: Enemy; along: number }[] = []
      const r = this.range(u)
      for (const e of this.enemies) {
        if (!e.alive) continue
        if (!b.elevated && this.map.isElevated(e.dist)) continue
        const along = (e.x - u.x) * dx + (e.y - u.y) * dy
        if (along < 0 || along > r) continue
        const perp = Math.abs((e.x - u.x) * dy - (e.y - u.y) * dx)
        if (perp <= e.def.radius + 0.08) hits.push({ e, along })
      }
      hits.sort((a, c) => a.along - c.along || a.e.id - c.e.id)
      const n = Math.min(b.pierce, hits.length)
      for (let i = 0; i < n; i++) this.hitWith(u, hits[i].e, dmg)
      const end = n === b.pierce && n > 0 ? hits[n - 1].along + 0.4 : r
      this.events.push({ e: 'rail', x1: u.x + dx * 0.5, y1: u.y + dy * 0.5, x2: u.x + dx * end, y2: u.y + dy * end })
    } else if (b.kind === 'chain') {
      // CRYO + ARC synergy (06장): slowed primary target -> +2 jumps
      const jumps = b.chain + (t.slow > 0 ? 2 : 0)
      const pts = [u.x, u.y - 0.25, t.x, t.y]
      const hit = new Set<number>([t.id])
      let d = dmg
      let cur = t
      this.hitWith(u, t, d)
      for (let j = 0; j < jumps; j++) {
        let next: Enemy | undefined
        let bd = b.chainRange * b.chainRange
        for (const e of this.enemies) {
          if (hit.has(e.id) || !this.targetable(u, e)) continue
          const d2 = (e.x - cur.x) ** 2 + (e.y - cur.y) ** 2
          if (d2 <= bd) {
            bd = d2
            next = e
          }
        }
        if (!next) break
        d *= b.chainFalloff
        hit.add(next.id)
        pts.push(next.x, next.y)
        this.hitWith(u, next, d)
        cur = next
      }
      this.events.push({ e: 'chain', pts })
    }
  }

  /** One hit from a unit: on-hit upgrades (focus fire, mark, sticky rounds), then damage. */
  private hitWith(u: Unit | undefined, e: Enemy, amount: number, dtype?: DamageType, armorPen?: number) {
    if (!e.alive) return
    let dmg = amount
    if (u) {
      const s = u.stats
      if (s.focusStep > 0) {
        if (u.focusId === e.id) u.focusStacks = Math.min(s.focusMax, u.focusStacks + 1)
        else {
          u.focusId = e.id
          u.focusStacks = 0
        }
        dmg *= 1 + s.focusStep * u.focusStacks
      }
      if (s.markDuration > 0) {
        e.markUntil = Math.max(e.markUntil, this.time + s.markDuration)
        e.markBonus = Math.max(e.markBonus, s.markBonus)
        e.markSpread = Math.max(e.markSpread, s.markSpread)
      }
      if (s.rootTime > 0 && this.time >= e.rootReadyAt) {
        e.rootUntil = this.time + (e.def.boss ? s.rootBoss : s.rootTime)
        e.rootReadyAt = this.time + s.rootCooldown
      }
    }
    this.damage(e, dmg, dtype ?? u?.stats.damageType ?? 'kinetic', armorPen ?? u?.stats.armorPen ?? 0, u)
  }

  private projectileStep() {
    for (const p of this.projectiles) {
      if (!p.alive) continue
      const t = this.enemies.find((e) => e.id === p.target && e.alive)
      if (t) {
        p.tx = t.x
        p.ty = t.y
      }
      const dx = p.tx - p.x
      const dy = p.ty - p.y
      const d = Math.hypot(dx, dy)
      const stepLen = p.speed * DT
      const hitR = t ? t.def.radius : 0.05
      if (d <= stepLen + hitR) {
        p.alive = false
        if (t) this.hitWith(this.units.find((u) => u.id === p.owner), t, p.damage, p.dtype, p.armorPen)
        continue
      }
      p.x += (dx / d) * stepLen
      p.y += (dy / d) * stepLen
    }
  }

  /** Damage with type coefficients (design.md 2-1). Shield first, overflow to the body. */
  damage(e: Enemy, amount: number, dtype: DamageType, armorPen: number, src?: Unit) {
    if (!e.alive || amount <= 0) return
    let raw = amount * (this.marked(e) ? 1 + e.markBonus : 1)
    let dealt = 0
    let onShield = false
    if (e.shield > 0) {
      onShield = true
      const k = SHIELD_COEF[dtype]
      const eff = raw * k
      if (eff <= e.shield) {
        e.shield -= eff
        dealt += eff
        raw = 0
      } else {
        dealt += e.shield
        raw = (eff - e.shield) / k
        e.shield = 0
      }
    }
    if (raw > 0) {
      let k = 1
      if (e.def.armor > 0) {
        if (dtype === 'kinetic') k = 1 - e.def.armor * (1 - armorPen)
        else if (dtype === 'explosive') k = 1.1
      }
      const body = Math.min(e.hp, raw * k)
      e.hp -= raw * k
      dealt += body
    }
    e.lastHit = this.time
    if (src) src.damage += dealt
    this.events.push({ e: 'hit', x: e.x, y: e.y, dtype, shield: onShield })
    if (e.hp <= 0) this.kill(e, src)
  }

  private kill(e: Enemy, src?: Unit) {
    e.alive = false
    const reward = Math.round(e.def.reward * this.rewardMul(e.wave))
    this.credits += reward
    const st = this.statFor(e.wave)
    if (st) {
      st.income += reward
      st.kills++
    }
    if (src) src.kills++
    this.events.push({ e: 'death', x: e.x, y: e.y, enemy: e.def.id, reward })
    // mark spread (SENTINEL B4): the mark jumps to the nearest enemy within the radius
    if (this.marked(e) && e.markSpread > 0) {
      let best: Enemy | undefined
      let bd = e.markSpread * e.markSpread
      for (const o of this.enemies) {
        if (!o.alive || o === e) continue
        const d2 = (o.x - e.x) ** 2 + (o.y - e.y) ** 2
        if (d2 <= bd) {
          bd = d2
          best = o
        }
      }
      if (best) {
        best.markUntil = e.markUntil
        best.markBonus = Math.max(best.markBonus, e.markBonus)
        best.markSpread = Math.max(best.markSpread, e.markSpread)
      }
    }
    if (e.def.split) {
      const child = this.data.enemies.get(e.def.split.into)!
      for (let k = 0; k < e.def.split.count; k++) this.spawn(child, e.wave, Math.max(0, e.dist - 0.25 * k))
    }
    this.enemyGone(e)
  }

  private enemyGone(e: Enemy) {
    const w = this.active.find((a) => a.index === e.wave)
    if (w) w.alive--
  }

  private cleanup() {
    if (this.enemies.some((e) => !e.alive)) this.enemies = this.enemies.filter((e) => e.alive)
    if (this.projectiles.some((p) => !p.alive)) this.projectiles = this.projectiles.filter((p) => p.alive)
  }

  private waveBookkeeping() {
    if (this.state !== 'running') return
    for (const w of this.active) {
      if (w.next >= w.spawns.length && w.alive <= 0 && !w.done) {
        w.done = true
        const bonus = this.waveBonus(w.index)
        this.credits += bonus
        const st = this.statFor(w.index)
        if (st) st.income += bonus
        this.events.push({ e: 'waveClear', wave: w.index, bonus })
      }
    }
    this.active = this.active.filter((w) => !w.done)
    if (!this.active.length) {
      if (this.wave >= this.totalWaves) {
        this.state = 'won'
        this.events.push({ e: 'end', won: true })
      } else this.state = 'build'
    }
  }

  // ------------------------------------------------------------------ replay & hash

  /** Re-run a command log on a fresh sim up to `untilTick` (resume, determinism tests). */
  static replay(data: GameData, mapId: string, difficulty: string, log: LoggedCommand[], untilTick: number, opts: { unlockT6?: boolean } = {}): Sim {
    const s = new Sim(data, mapId, difficulty, opts)
    let i = 0
    while (s.tick < untilTick && s.state !== 'won' && s.state !== 'lost') {
      while (i < log.length && log[i].tick === s.tick) s.command(log[i++].cmd)
      s.step()
      s.events.length = 0
    }
    while (i < log.length && log[i].tick === s.tick) s.command(log[i++].cmd)
    return s
  }

  /** FNV-1a over the observable state. */
  hash(): string {
    let h = 0x811c9dc5
    const mix = (n: number) => {
      const v = Math.round(n * 1e4) | 0
      h ^= v & 0xff
      h = Math.imul(h, 0x01000193)
      h ^= (v >>> 8) & 0xffffff
      h = Math.imul(h, 0x01000193)
    }
    mix(this.tick)
    mix(this.credits)
    mix(this.core)
    mix(this.wave)
    for (const e of this.enemies) {
      mix(e.id)
      mix(e.dist)
      mix(e.hp)
      mix(e.shield)
    }
    for (const u of this.units) {
      mix(u.id)
      mix(u.damage)
      mix(u.cooldown)
      for (const l of u.levels) mix(l)
    }
    return (h >>> 0).toString(16).padStart(8, '0')
  }
}
