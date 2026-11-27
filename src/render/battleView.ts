// Phase 2 battle renderer: simple shapes on Pixi (WebGL). The vector art from
// src/render/units replaces the unit/enemy shapes in Phase 3; layers, camera and
// effects stay.

import { Application, Container, Graphics } from 'pixi.js'
import type { Enemy, Sim, SimEvent, Unit } from '../sim/sim.ts'
import { CELL_PATH } from '../sim/map.ts'
import { C, GROUND, MAT } from './palette.ts'

const CELL = 48
const hex = (s: string) => parseInt(s.slice(1), 16)

/** Circle/arc as explicit points. Pixi picks segment counts from the local radius,
 *  which is tiny here (1 unit = 1 cell), so its own circles come out polygonal. */
function arcPts(x: number, y: number, r: number, a0 = 0, a1 = Math.PI * 2): number[] {
  const n = Math.max(12, Math.ceil(((a1 - a0) / (Math.PI * 2)) * 96))
  const out: number[] = []
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n
    out.push(x + Math.cos(a) * r, y + Math.sin(a) * r)
  }
  return out
}
function strokeArc(g: Graphics, x: number, y: number, r: number, a0: number, a1: number) {
  const p = arcPts(x, y, r, a0, a1)
  g.moveTo(p[0], p[1])
  for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1])
}

export interface Camera {
  x: number
  y: number
  s: number
}

export interface Preview {
  unit: string
  cx: number
  cy: number
  ok: boolean
  range: number
  supportRange?: boolean
}

interface Fx {
  kind: 'rail' | 'chain' | 'pulse' | 'spark' | 'debris' | 'leak' | 'muzzle'
  ttl: number
  life: number
  a: number[]
}

export class BattleView {
  readonly app = new Application()
  readonly world = new Container()
  private ground = new Graphics()
  private grid = new Graphics()
  private overlay = new Graphics()
  private dyn = new Graphics()
  private fxG = new Graphics()
  private fx: Fx[] = []
  cam: Camera = { x: 0, y: 0, s: 1 }
  showGrid = false
  selected: number | null = null
  preview: Preview | null = null
  private sim!: Sim
  private host!: HTMLElement
  /** decorative effects are thinned at 2x/3x (14장) */
  fxDensity = 1

  async init(host: HTMLElement, sim: Sim) {
    this.host = host
    await this.app.init({
      resizeTo: host,
      background: hex(C.bg),
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      preference: 'webgl',
    })
    host.appendChild(this.app.canvas)
    this.world.addChild(this.ground, this.grid, this.overlay, this.dyn, this.fxG)
    this.app.stage.addChild(this.world)
    this.setSim(sim)
    this.fit()
  }

  setSim(sim: Sim) {
    this.sim = sim
    this.fx = []
    this.selected = null
    this.preview = null
    this.drawGround()
    this.drawGrid()
  }

  get viewW() {
    return this.host.clientWidth
  }
  get viewH() {
    return this.host.clientHeight
  }

  /** Fit the whole map, clamped to the 0.75–2.0 zoom range (03장). */
  fit() {
    const m = this.sim.map
    const s = Math.max(0.75, Math.min(2, Math.min(this.viewW / (m.cols * CELL), (this.viewH - 8) / (m.rows * CELL))))
    this.cam.s = s
    this.cam.x = (this.viewW - m.cols * CELL * s) / 2
    this.cam.y = (this.viewH - m.rows * CELL * s) / 2
    this.clampCam()
  }

  clampCam() {
    const m = this.sim.map
    const w = m.cols * CELL * this.cam.s
    const h = m.rows * CELL * this.cam.s
    const margin = 48
    const fitX = (this.viewW - w) / 2
    const fitY = (this.viewH - h) / 2
    this.cam.x = w + 2 * margin <= this.viewW ? fitX : Math.min(margin, Math.max(this.viewW - w - margin, this.cam.x))
    this.cam.y = h + 2 * margin <= this.viewH ? fitY : Math.min(margin, Math.max(this.viewH - h - margin, this.cam.y))
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const ns = Math.max(0.75, Math.min(2, this.cam.s * factor))
    const wx = (sx - this.cam.x) / this.cam.s
    const wy = (sy - this.cam.y) / this.cam.s
    this.cam.s = ns
    this.cam.x = sx - wx * ns
    this.cam.y = sy - wy * ns
    this.clampCam()
  }

  /** Screen (host-relative pt) -> cell coordinates (fractional). */
  toCell(sx: number, sy: number): [number, number] {
    return [(sx - this.cam.x) / (this.cam.s * CELL), (sy - this.cam.y) / (this.cam.s * CELL)]
  }

  toScreen(x: number, y: number): [number, number] {
    return [this.cam.x + x * CELL * this.cam.s, this.cam.y + y * CELL * this.cam.s]
  }

  // ------------------------------------------------------------- static layers

  private drawGround() {
    const g = this.ground
    const m = this.sim.map
    g.clear()
    g.rect(0, 0, m.cols, m.rows).fill(hex(GROUND.ground))
    // city blocks: slightly lighter ground in a checker of 4x4 lots, very low contrast
    for (let y = 0; y < m.rows; y += 4)
      for (let x = (y / 4) % 2 ? 0 : 4; x < m.cols; x += 8) g.rect(x, y, 4, 4).fill(hex(GROUND.groundAlt))
    // path
    for (let y = 0; y < m.rows; y++)
      for (let x = 0; x < m.cols; x++) if (m.cell(x, y) === CELL_PATH) g.rect(x, y, 1, 1).fill(hex(GROUND.path))
    g.rect(2, -1, 1, 1).fill(hex(GROUND.path)) // entrance runs off the top edge
    const lw = 1 / CELL
    const edge = hex(GROUND.pathEdge)
    for (let y = 0; y < m.rows; y++)
      for (let x = 0; x < m.cols; x++) {
        if (m.cell(x, y) !== CELL_PATH) continue
        const n = (dx: number, dy: number) => {
          const c = m.cell(x + dx, y + dy)
          return c === CELL_PATH || c === 3 || (c === -1 && y + dy < 0)
        }
        if (!n(0, -1)) g.rect(x, y, 1, lw).fill(edge)
        if (!n(0, 1)) g.rect(x, y + 1 - lw, 1, lw).fill(edge)
        if (!n(-1, 0)) g.rect(x, y, lw, 1).fill(edge)
        if (!n(1, 0)) g.rect(x + 1 - lw, y, lw, 1).fill(edge)
      }
    // overpass: parapet bands either side, shadow face below-right
    for (const [x0, y0, x1] of m.def.elevated) {
      const a = Math.min(x0, x1) - 0.5
      const b = Math.max(x0, x1) + 0.5
      const top = y0 - 0.5
      g.rect(a, top + 1, b - a, 0.12).fill(hex(MAT.frame.shadow))
      g.rect(a, top - 0.1, b - a, 0.1).fill(hex(MAT.frame.light))
      g.rect(a, top + 1 - 0.02, b - a, 0.1).fill(hex(MAT.frame.base))
      for (let x = Math.ceil(a); x < b; x += 2) g.rect(x + 0.4, top + 1.12, 0.2, 0.18).fill(hex(MAT.frame.shadow))
    }
    // buildings: roof base, lit top/left edge, shadow bottom/right edge
    for (const [bx, by, bw, bh] of m.def.buildings) {
      const t = 0.08
      g.rect(bx + 0.06, by + 0.06, bw - 0.12, bh - 0.12).fill(hex('#1C2229'))
      g.rect(bx + 0.06, by + 0.06, bw - 0.12, t).fill(hex('#262D35'))
      g.rect(bx + 0.06, by + 0.06, t, bh - 0.12).fill(hex('#262D35'))
      g.rect(bx + 0.06, by + bh - 0.06 - t, bw - 0.12, t).fill(hex('#141920'))
      g.rect(bx + bw - 0.06 - t, by + 0.06, t, bh - 0.12).fill(hex('#141920'))
      g.rect(bx + 0.5, by + 0.5, Math.max(0.2, bw - 1), Math.max(0.2, bh - 1)).stroke({ width: lw, color: hex(C.line) })
    }
    // energy nodes (unclaimed: no glow)
    for (const [nx, ny] of m.def.energyNodes) {
      g.rect(nx - 0.3, ny - 0.3, 0.6, 0.6).fill(hex(MAT.gun.base)).stroke({ width: lw, color: hex(MAT.gun.light) })
      g.rect(nx - 0.08, ny - 0.08, 0.16, 0.16).fill(hex(C.textDim))
    }
    // core: district substation
    const c = m.def.core
    g.rect(c.x + 0.1, c.y + 0.1, c.w - 0.2, c.h - 0.2).fill(hex(MAT.frame.base))
    g.rect(c.x + 0.1, c.y + 0.1, c.w - 0.2, 0.1).fill(hex(MAT.frame.light))
    g.rect(c.x + 0.1, c.y + c.h - 0.2, c.w - 0.2, 0.1).fill(hex(MAT.frame.shadow))
    g.rect(c.x + 0.45, c.y + 0.45, c.w - 0.9, c.h - 0.9).fill(hex(MAT.gun.base))
    const cx = c.x + c.w / 2
    const cy = c.y + c.h / 2
    g.poly(arcPts(cx, cy, 0.42)).fill({ color: hex(C.cyan), alpha: 0.12 })
    g.rect(cx - 0.16, cy - 0.16, 0.32, 0.32).fill(hex(C.cyan))
    g.rect(cx - 0.06, cy - 0.06, 0.12, 0.12).fill(hex('#C9F6FC'))
  }

  private drawGrid() {
    const g = this.grid
    const m = this.sim.map
    g.clear()
    const lw = 1 / CELL
    for (let x = 0; x <= m.cols; x++) g.rect(x - lw / 2, 0, lw, m.rows).fill(hex(C.line))
    for (let y = 0; y <= m.rows; y++) g.rect(0, y - lw / 2, m.cols, lw).fill(hex(C.line))
    g.visible = false
  }

  // ------------------------------------------------------------- per frame

  pushEvents(events: SimEvent[]) {
    for (const ev of events) {
      switch (ev.e) {
        case 'rail':
          this.fx.push({ kind: 'rail', ttl: 0.18, life: 0.18, a: [ev.x1, ev.y1, ev.x2, ev.y2] })
          break
        case 'chain':
          this.fx.push({ kind: 'chain', ttl: 0.14, life: 0.14, a: ev.pts })
          break
        case 'pulse':
          this.fx.push({ kind: 'pulse', ttl: 0.35, life: 0.35, a: [ev.x, ev.y, ev.r] })
          break
        case 'burst':
          this.fx.push({ kind: 'pulse', ttl: 0.2, life: 0.2, a: [ev.x, ev.y, ev.r] })
          break
        case 'shot':
          if (this.fxDensity >= 0.5) this.fx.push({ kind: 'muzzle', ttl: 0.06, life: 0.06, a: [ev.x, ev.y, ev.angle] })
          break
        case 'hit':
          if (Math.random() < this.fxDensity) this.fx.push({ kind: 'spark', ttl: 0.18, life: 0.18, a: [ev.x, ev.y, ev.shield ? 1 : 0] })
          break
        case 'death':
          this.fx.push({ kind: 'debris', ttl: 0.4, life: 0.4, a: [ev.x, ev.y] })
          break
        case 'leak': {
          const [cx, cy] = this.sim.map.coreCenter
          this.fx.push({ kind: 'leak', ttl: 0.5, life: 0.5, a: [cx, cy] })
          break
        }
      }
    }
    if (this.fx.length > 1500) this.fx.splice(0, this.fx.length - 1500)
  }

  render(dt: number) {
    this.world.position.set(this.cam.x, this.cam.y)
    this.world.scale.set(this.cam.s * CELL)
    this.grid.visible = this.showGrid
    const px = 1 / (this.cam.s * CELL)
    this.drawOverlay(px)
    this.drawDynamic(px)
    this.drawFx(dt, px)
  }

  private drawOverlay(px: number) {
    const g = this.overlay
    g.clear()
    const sel = this.selected !== null ? this.sim.units.find((u) => u.id === this.selected) : undefined
    if (sel) this.rangeCircle(g, sel.x, sel.y, sel.def.base.range, px, sel.def.role !== 'attack')
    const p = this.preview
    if (p) {
      const x = p.cx + 0.5
      const y = p.cy + 0.5
      if (p.ok) {
        this.rangeCircle(g, x, y, p.range, px, !!p.supportRange)
        g.rect(p.cx, p.cy, 1, 1).stroke({ width: px * 1.5, color: hex(C.cyan) })
      } else {
        // cannot place: red outline + 45° hatch (+ reason text in the DOM)
        g.rect(p.cx, p.cy, 1, 1).stroke({ width: px * 1.5, color: hex(C.red) })
        for (let k = 1; k < 6; k++) {
          const t = k / 6
          g.moveTo(p.cx + t, p.cy).lineTo(p.cx, p.cy + t)
          g.moveTo(p.cx + 1, p.cy + t).lineTo(p.cx + t, p.cy + 1)
        }
        g.stroke({ width: px, color: hex(C.red), alpha: 0.8 })
      }
    }
  }

  private rangeCircle(g: Graphics, x: number, y: number, r: number, px: number, dashed: boolean) {
    if (!dashed) {
      g.poly(arcPts(x, y, r)).fill({ color: hex(C.cyan), alpha: 0.08 })
      strokeArc(g, x, y, r, 0, Math.PI * 2)
      g.stroke({ width: px, color: hex(C.cyan), alpha: 0.9 })
      return
    }
    // support range: 1px dashed (4pt dash, 4pt gap)
    const circ = 2 * Math.PI * r
    const dash = 4 * px
    const n = Math.max(8, Math.floor(circ / (2 * dash)))
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2
      const a1 = a0 + (Math.PI * 2) / n / 2
      strokeArc(g, x, y, r, a0, a1)
    }
    g.stroke({ width: px, color: hex(C.cyan), alpha: 0.9 })
  }

  private drawDynamic(px: number) {
    const g = this.dyn
    g.clear()
    for (const e of this.sim.enemies) this.drawEnemy(g, e, px)
    for (const u of this.sim.units) this.drawUnit(g, u, px, u.id === this.selected)
    const p = this.preview
    if (p) {
      const def = this.sim.data.units.get(p.unit)
      if (def) {
        this.drawUnitShape(g, def.id, p.cx + 0.5, p.cy + 0.5, -Math.PI / 2, px, 0, p.ok ? 0.85 : 0.45)
      }
    }
    // ARC C5 bridges: thin static lines between linked units
    for (const [a, b] of this.sim.bridgeList) {
      g.moveTo(a.x, a.y).lineTo((a.x + b.x) / 2 + (b.y - a.y) * 0.08, (a.y + b.y) / 2 - (b.x - a.x) * 0.08).lineTo(b.x, b.y)
    }
    if (this.sim.bridgeList.length) g.stroke({ width: px * 1.5, color: hex(C.cyan), alpha: 0.55 })
    // projectiles: short tracer along flight direction
    for (const pr of this.sim.projectiles) {
      const dx = pr.tx - pr.x
      const dy = pr.ty - pr.y
      const d = Math.hypot(dx, dy) || 1
      g.moveTo(pr.x - (dx / d) * 0.25, pr.y - (dy / d) * 0.25).lineTo(pr.x, pr.y)
    }
    g.stroke({ width: px * 2, color: hex(C.text) })
  }

  private drawEnemy(g: Graphics, e: Enemy, px: number) {
    const r = e.def.radius
    const ca = Math.cos(e.angle)
    const sa = Math.sin(e.angle)
    const P = (lx: number, ly: number): [number, number] => [e.x + lx * ca - ly * sa, e.y + lx * sa + ly * ca]
    const id = e.def.id
    if (e.def.stealth) {
      // undetected: outline only
      g.ellipse(e.x, e.y, r, r * 0.75).stroke({ width: px, color: hex(C.textDim) })
      return
    }
    if (id === 'r11') {
      // afterimage lines behind fast units
      for (const s of [-0.5, 0.5]) {
        const [x1, y1] = P(-r * 1.1, s * r)
        const [x2, y2] = P(-r * 2.4, s * r)
        g.moveTo(x1, y1).lineTo(x2, y2)
      }
      g.stroke({ width: px, color: hex(C.textDim) })
    }
    // hull: ellipse aligned to travel direction (drawn as polygon so it can rotate)
    const pts: number[] = []
    const rx = id === 'r11' ? r * 1.3 : r
    const ry = id === 'r11' ? r * 0.6 : r * 0.72
    for (let k = 0; k < 20; k++) {
      const a = (k / 20) * Math.PI * 2
      pts.push(...P(Math.cos(a) * rx, Math.sin(a) * ry))
    }
    if (id === 'h02') {
      // thick outer plates
      const plates: number[] = []
      for (let k = 0; k < 20; k++) {
        const a = (k / 20) * Math.PI * 2
        plates.push(...P(Math.cos(a) * (rx + 0.07), Math.sin(a) * (ry + 0.07)))
      }
      g.poly(plates).fill(hex(MAT.enemy.light))
    }
    g.poly(pts).fill(hex(MAT.enemy.base)).stroke({ width: px, color: hex(MAT.enemy.light) })
    // repeated segment joints
    const segs = e.def.boss ? 5 : 3
    for (let k = 1; k < segs; k++) {
      const lx = -rx + (2 * rx * k) / segs - rx * 0.15
      const h = ry * Math.sqrt(Math.max(0, 1 - (lx / rx) ** 2))
      const [x1, y1] = P(lx, -h)
      const [x2, y2] = P(lx, h)
      g.moveTo(x1, y1).lineTo(x2, y2)
    }
    g.stroke({ width: px, color: hex(MAT.enemy.shadow) })
    const [sx, sy] = P(rx * 0.72, 0)
    g.circle(sx, sy, Math.max(0.035, r * 0.12)).fill(hex(C.red))
    if (e.def.boss) {
      const [bx, by] = P(-rx * 0.75, 0)
      g.circle(bx, by, 0.05).fill(hex(C.red))
    }
    // shield ring, arc length = remaining shield
    if (e.maxShield > 0 && e.shield > 0) {
      const f = e.shield / e.maxShield
      strokeArc(g, e.x, e.y, r + 0.12, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * f)
      g.stroke({ width: px * 1.5, color: hex(C.text2) })
    }
    // health bar only once damaged
    if (e.hp < e.maxHp) {
      const w = Math.max(0.5, r * 1.6)
      const y = e.y - r - 0.16
      g.rect(e.x - w / 2, y, w, 0.06).fill(hex(MAT.enemy.shadow))
      g.rect(e.x - w / 2, y, (w * Math.max(0, e.hp)) / e.maxHp, 0.06).fill(hex(C.metal))
    }
  }

  private drawUnit(g: Graphics, u: Unit, px: number, selected: boolean) {
    const recoil = u.fired < 7 ? (7 - u.fired) * 0.006 : 0
    this.drawUnitShape(g, u.def.id, u.x, u.y, u.angle, px, recoil, 1, u.levels)
    if (selected) {
      // corner brackets, not a full coloured border (2-5)
      const k = 0.18
      const x0 = u.cx + 0.02
      const y0 = u.cy + 0.02
      const x1 = u.cx + 0.98
      const y1 = u.cy + 0.98
      g.moveTo(x0, y0 + k).lineTo(x0, y0).lineTo(x0 + k, y0)
      g.moveTo(x1 - k, y0).lineTo(x1, y0).lineTo(x1, y0 + k)
      g.moveTo(x1, y1 - k).lineTo(x1, y1).lineTo(x1 - k, y1)
      g.moveTo(x0 + k, y1).lineTo(x0, y1).lineTo(x0, y1 - k)
      g.stroke({ width: px * 2, color: hex(C.cyan) })
    }
  }

  /** Simple-shape stand-ins (Phase 2). Base fixed, top rotates toward the target. */
  drawUnitShape(g: Graphics, id: string, x: number, y: number, angle: number, px: number, recoil: number, alpha: number, lv: readonly number[] = [0, 0, 0]) {
    const ca = Math.cos(angle)
    const sa = Math.sin(angle)
    const R = (pts: number[]) => {
      const out: number[] = []
      for (let i = 0; i < pts.length; i += 2) out.push(x + pts[i] * ca - pts[i + 1] * sa, y + pts[i] * sa + pts[i + 1] * ca)
      return out
    }
    const ch = (x0: number, y0: number, x1: number, y1: number, c: number) => [
      x0 + c, y0, x1 - c, y0, x1, y0 + c, x1, y1 - c, x1 - c, y1, x0 + c, y1, x0, y1 - c, x0, y0 + c,
    ]
    const fill = (pts: number[], color: string) => g.poly(pts).fill({ color: hex(color), alpha }).stroke({ width: px, color: hex(MAT.frame.seam), alpha })
    // fixed base
    const base = ch(x - 0.38, y - 0.3, x + 0.38, y + 0.3, 0.08)
    fill(base, MAT.frame.base)
    g.rect(x - 0.38 + 0.08, y - 0.3, 0.6, px * 1.5).fill({ color: hex(MAT.frame.light), alpha })
    const b = -recoil
    if (id === 'sentinel') {
      // silhouette changes by path and tier (2-2): A3 twin, A5 rotary + drum, B3 mast, C3 antennas
      if (lv[0] >= 5) {
        for (const yy of [-0.05, 0, 0.05]) fill(R(ch(0.14 + b, yy - 0.016, 0.58 + b, yy + 0.016, 0)), MAT.gun.base)
        g.circle(x + (-0.06 * ca - -0.26 * sa), y + (-0.06 * sa + -0.26 * ca), 0.12).fill({ color: hex(MAT.frame.base), alpha }).stroke({ width: px, color: hex(MAT.frame.seam), alpha })
      } else if (lv[0] >= 3) {
        for (const yy of [-0.085, 0.085]) fill(R(ch(0.18 + b, yy - 0.03, 0.54 + b, yy + 0.03, 0)), MAT.gun.base)
        fill(R(ch(-0.17, -0.36, 0.06, -0.19, 0.03)), MAT.frame.base)
      } else fill(R(ch(0.18 + b, -0.035, 0.52 + b, 0.035, 0)), MAT.gun.base)
      fill(R(ch(-0.22, lv[0] >= 3 ? -0.2 : -0.16, 0.18, lv[0] >= 3 ? 0.2 : 0.16, 0.06)), MAT.hull.base)
      if (lv[1] >= 3) {
        fill(R(ch(-0.12, -0.06, 0.0, 0.06, 0.02)), MAT.frame.light)
        g.poly(R([0, -0.012, 0.42, -0.012, 0.42, 0.012, 0, 0.012])).fill({ color: hex(MAT.gun.light), alpha })
      }
      if (lv[2] >= 3) {
        g.poly(R([-0.1, -0.16, -0.08, -0.16, -0.08, -0.42, -0.1, -0.42])).fill({ color: hex(MAT.gun.light), alpha })
        g.poly(R([-0.1, 0.16, -0.08, 0.16, -0.08, 0.42, -0.1, 0.42])).fill({ color: hex(MAT.gun.light), alpha })
        fill(R(ch(-0.15, -0.46, -0.03, -0.4, 0)), MAT.frame.light)
        fill(R(ch(-0.15, 0.4, -0.03, 0.46, 0)), MAT.frame.light)
      }
    } else if (id === 'railx') {
      if (lv[0] >= 3) for (const yy of [-0.09, 0.09]) fill(R(ch(0.1 + b, yy - 0.035, 0.6 + b, yy + 0.035, 0)), MAT.gun.base)
      else fill(R(ch(0.1 + b, -0.04, 0.6 + b, 0.04, 0)), MAT.gun.base)
      if (lv[1] >= 3) fill(R(ch(0.56 + b, -0.09, 0.66 + b, 0.09, 0.03)), MAT.frame.light)
      if (lv[2] >= 3) fill(R(ch(-0.3, -0.05, -0.18, 0.05, 0)), MAT.hull.light)
      fill(R(ch(-0.26, -0.13, 0.14, 0.13, 0.04)), MAT.hull.base)
      fill(R(ch(-0.08, -0.17, 0.02, 0.17, 0)), MAT.frame.base)
    } else if (id === 'arc') {
      fill(ch(x - 0.24, y - 0.24, x + 0.24, y + 0.24, 0.08), MAT.frame.light)
      fill(ch(x - 0.16, y - 0.16, x + 0.16, y + 0.16, 0.05), MAT.hull.base)
      if (lv[0] >= 3) for (const yy of [-0.1, 0.1]) fill(R(ch(0.04, yy - 0.04, 0.32, yy + 0.04, 0.02)), MAT.gun.base)
      else fill(R(ch(0.04, -0.05, 0.34, 0.05, 0.02)), MAT.gun.base)
      if (lv[1] >= 3) fill(R(ch(-0.36, -0.02, -0.2, 0.02, 0)), MAT.gun.light)
      if (lv[2] >= 3) for (const yy of [-0.3, 0.3]) fill(ch(x - 0.06, y + yy - 0.04, x + 0.06, y + yy + 0.04, 0.02), MAT.hull.light)
    } else if (id === 'cryo') {
      fill(ch(x - 0.3, y - 0.2, x + 0.3, y + 0.2, 0.04), MAT.hull.base)
      g.circle(x, y, 0.15).fill({ color: hex(MAT.gun.base), alpha }).stroke({ width: px, color: hex(MAT.gun.seam), alpha })
      g.moveTo(x - 0.13, y).lineTo(x + 0.13, y).moveTo(x, y - 0.13).lineTo(x, y + 0.13).stroke({ width: px, color: hex(MAT.gun.light), alpha })
    }
    // the single energy core
    const cx = id === 'cryo' ? x + 0.22 : x - 0.1 * ca
    const cy = id === 'cryo' ? y - 0.12 : y - 0.1 * sa
    g.rect(cx - 0.04, cy - 0.04, 0.08, 0.08).fill({ color: hex(C.cyan), alpha })
  }

  private drawFx(dt: number, px: number) {
    const g = this.fxG
    g.clear()
    for (const f of this.fx) {
      f.ttl -= dt
      const t = Math.max(0, f.ttl / f.life)
      switch (f.kind) {
        case 'rail':
          g.moveTo(f.a[0], f.a[1]).lineTo(f.a[2], f.a[3]).stroke({ width: px * 2.5, color: hex(C.text), alpha: t })
          break
        case 'chain': {
          // 45°-kinked bolt between each pair
          const p = f.a
          for (let i = 0; i + 3 < p.length; i += 2) {
            const [x1, y1, x2, y2] = [p[i], p[i + 1], p[i + 2], p[i + 3]]
            const mx = (x1 + x2) / 2 + (y2 - y1) * 0.15
            const my = (y1 + y2) / 2 - (x2 - x1) * 0.15
            g.moveTo(x1, y1).lineTo(mx, my).lineTo(x2, y2)
          }
          g.stroke({ width: px * 3, color: hex(C.cyan), alpha: t * 0.6 })
          for (let i = 0; i + 3 < p.length; i += 2) {
            const [x1, y1, x2, y2] = [p[i], p[i + 1], p[i + 2], p[i + 3]]
            const mx = (x1 + x2) / 2 + (y2 - y1) * 0.15
            const my = (y1 + y2) / 2 - (x2 - x1) * 0.15
            g.moveTo(x1, y1).lineTo(mx, my).lineTo(x2, y2)
          }
          g.stroke({ width: px, color: hex(C.text), alpha: t })
          break
        }
        case 'pulse':
          strokeArc(g, f.a[0], f.a[1], f.a[2] * (1 - t * 0.6), 0, Math.PI * 2)
          g.stroke({ width: px * 1.5, color: hex(C.cyan), alpha: t * 0.5 })
          break
        case 'muzzle':
          g.circle(f.a[0], f.a[1], 0.06).fill({ color: hex(C.text), alpha: t })
          break
        case 'spark': {
          const c = f.a[2] ? C.text2 : C.metal
          for (let k = 0; k < 3; k++) {
            const a = k * 2.1 + f.a[0] * 7
            const d = 0.08 + (1 - t) * 0.18
            g.rect(f.a[0] + Math.cos(a) * d, f.a[1] + Math.sin(a) * d, 0.04, 0.04)
          }
          g.fill({ color: hex(c), alpha: t })
          break
        }
        case 'debris':
          for (let k = 0; k < 4; k++) {
            const a = k * 1.7 + f.a[1] * 5
            const d = (1 - t) * 0.35
            g.rect(f.a[0] + Math.cos(a) * d, f.a[1] + Math.sin(a) * d, 0.06, 0.06)
          }
          g.fill({ color: hex(C.textDim), alpha: t * 0.6 })
          break
        case 'leak':
          g.rect(f.a[0] - 1, f.a[1] - 1, 2, 2).stroke({ width: px * 2, color: hex(C.red), alpha: t })
          break
      }
    }
    this.fx = this.fx.filter((f) => f.ttl > 0)
  }
}
