// Game data: types, schema checks with file:line errors, and assembly.
// Pure — callers pass raw JSON texts keyed by path (browser: import.meta.glob,
// Node: fs). See docs/design.md §10.

import { JsonSyntaxError, parseLocated, pathKey, type JPath } from './jsonloc.ts'

export type DamageType = 'kinetic' | 'energy' | 'electric' | 'explosive'
export type UnitKind = 'gun' | 'rail' | 'chain' | 'pulse'
export type Role = 'attack' | 'control' | 'support'

export interface UnitBase {
  kind: UnitKind
  damage: number
  damageType: DamageType
  fireInterval: number
  range: number
  pierce: number
  armorPen: number
  projectileSpeed: number
  chain: number
  chainRange: number
  chainFalloff: number
  slow: number
  slowDuration: number
  elevated: boolean
  detect: boolean
  antiAir: boolean
  /** projectiles per shot (twin barrels) */
  multishot: number
  /** focus fire: +step damage per consecutive hit on the same enemy, up to max stacks */
  focusStep: number
  focusMax: number
  /** mark on hit: duration, damage-taken bonus for everyone, spread radius on kill */
  markDuration: number
  markBonus: number
  markSpread: number
  /** root on hit (sticky rounds) */
  rootTime: number
  rootBoss: number
  rootCooldown: number
  /** command node: allies in radius prefer this unit's target and deal +bonus to it */
  commandRadius: number
  commandBonus: number
  /** rail: line length past the target range (0 = range); damage x(1+ramp) per enemy already pierced */
  lineLength: number
  pierceRamp: number
  /** knockback along the path (cells); knockbackAll: every enemy hit, else the first; armoured/boss immune unless heavy */
  knockback: number
  knockbackAll: boolean
  /** bonus damage against enemies at or above 50% hp */
  healthyBonus: number
  /** fraction of current shield removed on hit */
  shieldStrip: number
  /** extra multiplier on the shield coefficient for this unit's damage type */
  shieldMul: number
  /** armour shred: kinetic resistance -amount for seconds, applies to all attackers */
  shred: number
  shredTime: number
  /** chain: extra jumps on CRYO-slowed primary targets (06장 synergy) */
  chainSynergy: number
  /** burst at the primary target (radius, damage multiplier) */
  burstRadius: number
  burstMul: number
  /** damage over time on hit, and an explosion when an enemy dies while burning */
  dotDps: number
  dotTime: number
  dotBurst: number
  dotBurstRadius: number
  /** reveal stealth on hit for seconds */
  revealTime: number
  /** execute-jail: below hp fraction, root for seconds and take +vuln from this damage type */
  jailBelow: number
  jailTime: number
  jailVuln: number
  /** electric bridges to up to N allies within radius, damage per second to enemies crossing */
  bridgeCount: number
  bridgeRadius: number
  bridgeDps: number
  /** economy */
  energyPerKill: number
  energyPerWave: number
}

export type NumStat = { [K in keyof UnitBase]: UnitBase[K] extends number ? K : never }[keyof UnitBase]
export type BoolStat = { [K in keyof UnitBase]: UnitBase[K] extends boolean ? K : never }[keyof UnitBase]
export const NUM_STATS: NumStat[] = [
  'damage', 'fireInterval', 'range', 'pierce', 'armorPen', 'projectileSpeed', 'chain', 'chainRange', 'chainFalloff',
  'slow', 'slowDuration', 'multishot', 'focusStep', 'focusMax', 'markDuration', 'markBonus', 'markSpread',
  'rootTime', 'rootBoss', 'rootCooldown', 'commandRadius', 'commandBonus',
  'lineLength', 'pierceRamp', 'knockback', 'healthyBonus', 'shieldStrip', 'shieldMul', 'shred', 'shredTime',
  'chainSynergy', 'burstRadius', 'burstMul', 'dotDps', 'dotTime', 'dotBurst', 'dotBurstRadius', 'revealTime',
  'jailBelow', 'jailTime', 'jailVuln', 'bridgeCount', 'bridgeRadius', 'bridgeDps', 'energyPerKill', 'energyPerWave',
]
export const BOOL_STATS: BoolStat[] = ['elevated', 'detect', 'antiAir', 'knockbackAll']
export const BUFFS = ['range', 'attackSpeed', 'damage', 'detect', 'cooldown', 'elevated', 'bonusElectric'] as const
export type BuffType = (typeof BUFFS)[number]

export type Effect =
  | { op: 'mul' | 'add'; stat: NumStat; value: number }
  | { op: 'set'; stat: NumStat | BoolStat; value: number | boolean }
  | { op: 'aura'; buff: BuffType; value: number; radius: number; filter?: DamageType }
  | { op: 'ability'; id: string; cooldown: number; energy: number; params: Record<string, number> }

export interface Upgrade {
  name: string
  cost: number
  text: string
  kind: string
  effects: Effect[]
}

export type PathId = 'A' | 'B' | 'C'
export const PATHS: PathId[] = ['A', 'B', 'C']

export interface UnitDef {
  id: string
  name: string
  code: string
  role: Role
  cost: number
  footprint: number
  base: UnitBase
  summary: string
  /** 3 paths x up to 6 steps; empty arrays until a unit's paths are written */
  paths: Record<PathId, Upgrade[]>
}

export interface EnemyDef {
  id: string
  code: string
  name: string
  type: string
  hp: number
  shield: number
  speed: number
  reward: number
  leak: number
  radius: number
  armor: number
  stealth: boolean
  boss: boolean
  fixedHp: boolean
  split: { into: string; count: number } | null
}

export interface MapDef {
  id: string
  name: string
  cols: number
  rows: number
  path: [number, number][]
  core: { x: number; y: number; w: number; h: number }
  elevated: [number, number, number, number][]
  buildings: [number, number, number, number][]
  energyNodes: [number, number][]
}

export interface WaveGroup {
  enemy: string
  count: number
  interval: number
  delay: number
}

export interface WaveSet {
  map: string
  difficulty: string
  inflationBase: number
  waves: { groups: WaveGroup[] }[]
}

export interface Difficulty {
  name: string
  title: string
  hp: number
  speed: number
  reward: number
  startCredits: number
  core: number
}

export interface GameData {
  units: Map<string, UnitDef>
  enemies: Map<string, EnemyDef>
  maps: Map<string, MapDef>
  waves: Map<string, WaveSet>
  difficulty: Map<string, Difficulty>
}

export class DataError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join('\n'))
  }
}

/** Reads one file with path-aware checks; every problem is collected, not thrown on the first. */
class Reader {
  constructor(
    readonly file: string,
    readonly lines: Map<string, number>,
    readonly issues: string[],
  ) {}

  err(p: JPath, msg: string) {
    // fall back to the nearest parent that has a line
    let q = [...p]
    let ln = this.lines.get(pathKey(q))
    while (ln === undefined && q.length) {
      q = q.slice(0, -1)
      ln = this.lines.get(pathKey(q))
    }
    this.issues.push(`${this.file}:${ln ?? 1} ${pathKey(p) || '(root)'}: ${msg}`)
  }

  obj(v: unknown, p: JPath): Record<string, unknown> {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    this.err(p, '객체가 아님')
    return {}
  }

  arr(v: unknown, p: JPath): unknown[] {
    if (Array.isArray(v)) return v
    this.err(p, '배열이 아님')
    return []
  }

  num(o: Record<string, unknown>, k: string, p: JPath, opt?: { min?: number; max?: number; def?: number }): number {
    const v = o[k]
    if (v === undefined && opt?.def !== undefined) return opt.def
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.err([...p, k], v === undefined ? '필수 숫자 없음' : `숫자가 아님 (${JSON.stringify(v)})`)
      return opt?.def ?? 0
    }
    if (opt?.min !== undefined && v < opt.min) this.err([...p, k], `${opt.min} 이상이어야 함 (${v})`)
    if (opt?.max !== undefined && v > opt.max) this.err([...p, k], `${opt.max} 이하여야 함 (${v})`)
    return v
  }

  str(o: Record<string, unknown>, k: string, p: JPath, allowed?: readonly string[]): string {
    const v = o[k]
    if (typeof v !== 'string' || !v) {
      this.err([...p, k], v === undefined ? '필수 문자열 없음' : '문자열이 아님')
      return allowed?.[0] ?? ''
    }
    if (allowed && !allowed.includes(v)) this.err([...p, k], `허용 값: ${allowed.join(', ')} (받은 값: ${v})`)
    return v
  }

  bool(o: Record<string, unknown>, k: string, p: JPath, def = false): boolean {
    const v = o[k]
    if (v === undefined) return def
    if (typeof v !== 'boolean') this.err([...p, k], 'true/false가 아님')
    return v === true
  }

  tuple(v: unknown, n: number, p: JPath): number[] {
    const a = this.arr(v, p)
    if (a.length !== n || a.some((x) => typeof x !== 'number')) {
      this.err(p, `숫자 ${n}개 배열이어야 함`)
      return new Array(n).fill(0)
    }
    return a as number[]
  }
}

const DTYPES = ['kinetic', 'energy', 'electric', 'explosive'] as const
const KINDS = ['gun', 'rail', 'chain', 'pulse'] as const
const ROLES = ['attack', 'control', 'support'] as const

function readUnit(r: Reader, v: unknown): UnitDef {
  const o = r.obj(v, [])
  const b = r.obj(o.base, ['base'])
  const bp: JPath = ['base']
  const kind = r.str(b, 'kind', bp, KINDS) as UnitKind
  const unit: UnitDef = {
    id: r.str(o, 'id', []),
    name: r.str(o, 'name', []),
    code: r.str(o, 'code', []),
    role: r.str(o, 'role', [], ROLES) as Role,
    cost: r.num(o, 'cost', [], { min: 1 }),
    footprint: r.num(o, 'footprint', [], { min: 1, max: 2 }),
    summary: typeof o.summary === 'string' ? o.summary : '',
    base: {
      kind,
      damage: r.num(b, 'damage', bp, { min: 0 }),
      damageType: r.str(b, 'damageType', bp, DTYPES) as DamageType,
      fireInterval: r.num(b, 'fireInterval', bp, { min: 0.02 }),
      range: r.num(b, 'range', bp, { min: 0.5, max: 30 }),
      pierce: r.num(b, 'pierce', bp, { min: 1, def: 1 }),
      armorPen: r.num(b, 'armorPen', bp, { min: 0, max: 1, def: 0 }),
      projectileSpeed: r.num(b, 'projectileSpeed', bp, { min: 1, def: 14 }),
      chain: r.num(b, 'chain', bp, { min: 0, def: 0 }),
      chainRange: r.num(b, 'chainRange', bp, { min: 0, def: 0 }),
      chainFalloff: r.num(b, 'chainFalloff', bp, { min: 0, max: 2, def: 1 }),
      slow: r.num(b, 'slow', bp, { min: 0, max: 0.95, def: 0 }),
      slowDuration: r.num(b, 'slowDuration', bp, { min: 0, def: 0 }),
      elevated: r.bool(b, 'elevated', bp),
      detect: r.bool(b, 'detect', bp),
      antiAir: r.bool(b, 'antiAir', bp),
      multishot: r.num(b, 'multishot', bp, { min: 1, def: 1 }),
      focusStep: r.num(b, 'focusStep', bp, { min: 0, def: 0 }),
      focusMax: r.num(b, 'focusMax', bp, { min: 0, def: 0 }),
      markDuration: r.num(b, 'markDuration', bp, { min: 0, def: 0 }),
      markBonus: r.num(b, 'markBonus', bp, { min: 0, def: 0 }),
      markSpread: r.num(b, 'markSpread', bp, { min: 0, def: 0 }),
      rootTime: r.num(b, 'rootTime', bp, { min: 0, def: 0 }),
      rootBoss: r.num(b, 'rootBoss', bp, { min: 0, def: 0 }),
      rootCooldown: r.num(b, 'rootCooldown', bp, { min: 0, def: 0 }),
      commandRadius: r.num(b, 'commandRadius', bp, { min: 0, def: 0 }),
      commandBonus: r.num(b, 'commandBonus', bp, { min: 0, def: 0 }),
      lineLength: r.num(b, 'lineLength', bp, { min: 0, def: 0 }),
      pierceRamp: r.num(b, 'pierceRamp', bp, { min: 0, def: 0 }),
      knockback: r.num(b, 'knockback', bp, { min: 0, def: 0 }),
      knockbackAll: r.bool(b, 'knockbackAll', bp),
      healthyBonus: r.num(b, 'healthyBonus', bp, { min: 0, def: 0 }),
      shieldStrip: r.num(b, 'shieldStrip', bp, { min: 0, max: 1, def: 0 }),
      shieldMul: r.num(b, 'shieldMul', bp, { min: 0, def: 1 }),
      shred: r.num(b, 'shred', bp, { min: 0, max: 1, def: 0 }),
      shredTime: r.num(b, 'shredTime', bp, { min: 0, def: 0 }),
      chainSynergy: r.num(b, 'chainSynergy', bp, { min: 0, def: kind === 'chain' ? 2 : 0 }),
      burstRadius: r.num(b, 'burstRadius', bp, { min: 0, def: 0 }),
      burstMul: r.num(b, 'burstMul', bp, { min: 0, def: 0 }),
      dotDps: r.num(b, 'dotDps', bp, { min: 0, def: 0 }),
      dotTime: r.num(b, 'dotTime', bp, { min: 0, def: 0 }),
      dotBurst: r.num(b, 'dotBurst', bp, { min: 0, def: 0 }),
      dotBurstRadius: r.num(b, 'dotBurstRadius', bp, { min: 0, def: 0 }),
      revealTime: r.num(b, 'revealTime', bp, { min: 0, def: 0 }),
      jailBelow: r.num(b, 'jailBelow', bp, { min: 0, max: 1, def: 0 }),
      jailTime: r.num(b, 'jailTime', bp, { min: 0, def: 0 }),
      jailVuln: r.num(b, 'jailVuln', bp, { min: 0, def: 0 }),
      bridgeCount: r.num(b, 'bridgeCount', bp, { min: 0, def: 0 }),
      bridgeRadius: r.num(b, 'bridgeRadius', bp, { min: 0, def: 0 }),
      bridgeDps: r.num(b, 'bridgeDps', bp, { min: 0, def: 0 }),
      energyPerKill: r.num(b, 'energyPerKill', bp, { min: 0, def: 0 }),
      energyPerWave: r.num(b, 'energyPerWave', bp, { min: 0, def: 0 }),
    },
    paths: { A: [], B: [], C: [] },
  }
  if (o.paths !== undefined) {
    const po = r.obj(o.paths, ['paths'])
    for (const pid of PATHS) {
      const list = po[pid] === undefined ? [] : r.arr(po[pid], ['paths', pid])
      if (list.length > 6) r.err(['paths', pid], '경로는 6단계까지')
      unit.paths[pid] = list.map((st, i) => readUpgrade(r, st, ['paths', pid, i]))
      // 05장: at most two pure-number steps per path
      const numeric = unit.paths[pid].filter((u) => u.kind === '수치').length
      if (numeric > 2) r.err(['paths', pid], `수치만 오르는 단계가 ${numeric}개 (최대 2)`)
    }
  }
  if (kind === 'chain' && unit.base.chainRange <= 0) r.err([...bp, 'chainRange'], 'chain 유닛은 chainRange가 필요함')
  if (kind === 'pulse' && unit.base.slowDuration <= 0 && unit.base.slow > 0) r.err([...bp, 'slowDuration'], '둔화 시간이 필요함')
  return unit
}

const KINDS_OF_STEP = ['수치', '공격 방식', '표적 규칙', '새 능력', '상호작용', '자원']

function readEffect(r: Reader, v: unknown, p: JPath): Effect {
  const o = r.obj(v, p)
  const op = r.str(o, 'op', p, ['mul', 'add', 'set', 'aura', 'ability'])
  if (op === 'mul' || op === 'add') {
    const stat = r.str(o, 'stat', p, NUM_STATS) as NumStat
    return { op, stat, value: r.num(o, 'value', p) }
  }
  if (op === 'set') {
    const stat = r.str(o, 'stat', p, [...NUM_STATS, ...BOOL_STATS]) as NumStat | BoolStat
    const isBool = (BOOL_STATS as string[]).includes(stat)
    const value = isBool ? r.bool(o, 'value', p) : r.num(o, 'value', p)
    if (isBool && typeof o.value !== 'boolean') r.err([...p, 'value'], `${stat}는 true/false`)
    return { op, stat, value }
  }
  if (op === 'aura') {
    const filter = o.filter === undefined ? undefined : (r.str(o, 'filter', p, DTYPES) as DamageType)
    return { op, buff: r.str(o, 'buff', p, BUFFS) as BuffType, value: r.num(o, 'value', p, { def: 1 }), radius: r.num(o, 'radius', p, { min: 0.5, max: 12 }), filter }
  }
  const params: Record<string, number> = {}
  if (o.params !== undefined) for (const [k, x] of Object.entries(r.obj(o.params, [...p, 'params']))) params[k] = typeof x === 'number' ? x : (r.err([...p, 'params', k], '숫자가 아님'), 0)
  return { op: 'ability', id: r.str(o, 'id', p), cooldown: r.num(o, 'cooldown', p, { min: 1 }), energy: r.num(o, 'energy', p, { min: 0, def: 0 }), params }
}

function readUpgrade(r: Reader, v: unknown, p: JPath): Upgrade {
  const o = r.obj(v, p)
  const effects = r.arr(o.effects, [...p, 'effects']).map((e, i) => readEffect(r, e, [...p, 'effects', i]))
  if (!effects.length) r.err([...p, 'effects'], '효과가 없음')
  return {
    name: r.str(o, 'name', p),
    cost: r.num(o, 'cost', p, { min: 1 }),
    text: r.str(o, 'text', p),
    kind: r.str(o, 'kind', p, KINDS_OF_STEP),
    effects,
  }
}

function readEnemies(r: Reader, v: unknown): EnemyDef[] {
  const o = r.obj(v, [])
  return r.arr(o.enemies, ['enemies']).map((e, i) => {
    const p: JPath = ['enemies', i]
    const x = r.obj(e, p)
    let split: EnemyDef['split'] = null
    if (x.split !== undefined) {
      const s = r.obj(x.split, [...p, 'split'])
      split = { into: r.str(s, 'into', [...p, 'split']), count: r.num(s, 'count', [...p, 'split'], { min: 1 }) }
    }
    return {
      id: r.str(x, 'id', p),
      code: r.str(x, 'code', p),
      name: r.str(x, 'name', p),
      type: r.str(x, 'type', p),
      hp: r.num(x, 'hp', p, { min: 1 }),
      shield: r.num(x, 'shield', p, { min: 0, def: 0 }),
      speed: r.num(x, 'speed', p, { min: 0.05, max: 10 }),
      reward: r.num(x, 'reward', p, { min: 0 }),
      leak: r.num(x, 'leak', p, { min: 0 }),
      radius: r.num(x, 'radius', p, { min: 0.05, max: 1.5 }),
      armor: r.num(x, 'armor', p, { min: 0, max: 0.95, def: 0 }),
      stealth: r.bool(x, 'stealth', p),
      boss: r.bool(x, 'boss', p),
      fixedHp: r.bool(x, 'fixedHp', p),
      split,
    }
  })
}

function readMap(r: Reader, v: unknown): MapDef {
  const o = r.obj(v, [])
  const cols = r.num(o, 'cols', [], { min: 4, max: 64 })
  const rows = r.num(o, 'rows', [], { min: 4, max: 64 })
  const path = r.arr(o.path, ['path']).map((pt, i) => r.tuple(pt, 2, ['path', i]) as [number, number])
  if (path.length < 2) r.err(['path'], '경로 점이 2개 이상이어야 함')
  path.forEach((pt, i) => {
    if (i === 0) return
    const q = path[i - 1]
    if (pt[0] !== q[0] && pt[1] !== q[1]) r.err(['path', i], '경로는 가로·세로 구간만 허용')
  })
  const c = r.obj(o.core, ['core'])
  const rects = (k: string) => r.arr(o[k], [k]).map((b, i) => r.tuple(b, 4, [k, i]) as [number, number, number, number])
  const buildings = rects('buildings')
  buildings.forEach((b, i) => {
    if (b[0] < 0 || b[1] < 0 || b[0] + b[2] > cols || b[1] + b[3] > rows) r.err(['buildings', i], '맵 밖으로 나감')
  })
  return {
    id: r.str(o, 'id', []),
    name: r.str(o, 'name', []),
    cols,
    rows,
    path,
    core: { x: r.num(c, 'x', ['core']), y: r.num(c, 'y', ['core']), w: r.num(c, 'w', ['core']), h: r.num(c, 'h', ['core']) },
    elevated: rects('elevated'),
    buildings,
    energyNodes: r.arr(o.energyNodes ?? [], ['energyNodes']).map((pt, i) => r.tuple(pt, 2, ['energyNodes', i]) as [number, number]),
  }
}

function readWaves(r: Reader, v: unknown, enemyIds: Set<string>): WaveSet {
  const o = r.obj(v, [])
  return {
    map: r.str(o, 'map', []),
    difficulty: r.str(o, 'difficulty', []),
    inflationBase: r.num(o, 'inflationBase', [], { min: 1 }),
    waves: r.arr(o.waves, ['waves']).map((w, i) => {
      const wo = r.obj(w, ['waves', i])
      const groups = r.arr(wo.groups, ['waves', i, 'groups']).map((g, j) => {
        const p: JPath = ['waves', i, 'groups', j]
        const go = r.obj(g, p)
        const enemy = r.str(go, 'enemy', p)
        if (enemy && !enemyIds.has(enemy)) r.err([...p, 'enemy'], `enemies.json에 없는 적 "${enemy}"`)
        return {
          enemy,
          count: r.num(go, 'count', p, { min: 1, max: 500 }),
          interval: r.num(go, 'interval', p, { min: 0, def: 0 }),
          delay: r.num(go, 'delay', p, { min: 0, def: 0 }),
        }
      })
      if (!groups.length) r.err(['waves', i, 'groups'], '빈 웨이브')
      return { groups }
    }),
  }
}

/** files: path (e.g. "data/units/sentinel.json") -> text */
export function loadGameData(files: Record<string, string>): GameData {
  const issues: string[] = []
  const parsed = new Map<string, Reader & { value: unknown }>()
  for (const [file, text] of Object.entries(files)) {
    try {
      const { value, lines } = parseLocated(text)
      parsed.set(file, Object.assign(new Reader(file, lines, issues), { value }))
    } catch (e) {
      if (e instanceof JsonSyntaxError) issues.push(`${file}:${e.line} JSON 문법 오류: ${e.message}`)
      else throw e
    }
  }
  const pick = (re: RegExp) => [...parsed.entries()].filter(([f]) => re.test(f)).sort(([a], [b]) => a.localeCompare(b))

  const data: GameData = { units: new Map(), enemies: new Map(), maps: new Map(), waves: new Map(), difficulty: new Map() }
  for (const [, r] of pick(/\/units\/[^/]+\.json$/)) {
    const u = readUnit(r, r.value)
    if (data.units.has(u.id)) r.err(['id'], `중복 유닛 id "${u.id}"`)
    data.units.set(u.id, u)
  }
  for (const [, r] of pick(/\/enemies\.json$/)) for (const e of readEnemies(r, r.value)) data.enemies.set(e.id, e)
  for (const [, r] of pick(/\/enemies\.json$/)) {
    const list = (r.value as { enemies?: unknown[] }).enemies ?? []
    list.forEach((_, i) => {
      const e = [...data.enemies.values()][i]
      if (e?.split && !data.enemies.has(e.split.into)) r.err(['enemies', i, 'split', 'into'], `없는 적 "${e.split.into}"`)
    })
  }
  for (const [, r] of pick(/\/maps\/[^/]+\.json$/)) {
    const m = readMap(r, r.value)
    data.maps.set(m.id, m)
  }
  for (const [, r] of pick(/\/difficulty\.json$/)) {
    const o = r.obj(r.value, [])
    for (const [k, v] of Object.entries(o)) {
      const d = r.obj(v, [k])
      data.difficulty.set(k, {
        name: r.str(d, 'name', [k]),
        title: r.str(d, 'title', [k]),
        hp: r.num(d, 'hp', [k], { min: 0.1 }),
        speed: r.num(d, 'speed', [k], { min: 0.1 }),
        reward: r.num(d, 'reward', [k], { min: 0 }),
        startCredits: r.num(d, 'startCredits', [k], { min: 0 }),
        core: r.num(d, 'core', [k], { min: 1 }),
      })
    }
  }
  const enemyIds = new Set(data.enemies.keys())
  for (const [file, r] of pick(/\/waves\/[^/]+\.json$/)) {
    const w = readWaves(r, r.value, enemyIds)
    if (!data.maps.has(w.map)) r.err(['map'], `없는 맵 "${w.map}"`)
    if (!data.difficulty.has(w.difficulty)) r.err(['difficulty'], `없는 난이도 "${w.difficulty}"`)
    void file
    data.waves.set(`${w.map}_${w.difficulty}`, w)
  }
  if (issues.length) throw new DataError(issues)
  return data
}
