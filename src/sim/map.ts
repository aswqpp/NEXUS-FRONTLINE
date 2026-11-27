// Map geometry: path polyline, distance <-> position, cell classes, elevated spans.

import type { MapDef } from './data.ts'

export const CELL_GROUND = 0
export const CELL_PATH = 1
export const CELL_BUILDING = 2
export const CELL_CORE = 3

interface Seg {
  ax: number
  ay: number
  bx: number
  by: number
  len: number
  start: number
  dx: number
  dy: number
}

export class MapGeom {
  readonly def: MapDef
  readonly cols: number
  readonly rows: number
  readonly segs: Seg[] = []
  readonly length: number
  readonly cells: Uint8Array
  /** path-distance spans of the elevated (overpass) section */
  readonly elevated: [number, number][] = []
  readonly coreCenter: [number, number]

  constructor(def: MapDef) {
    this.def = def
    this.cols = def.cols
    this.rows = def.rows
    let start = 0
    for (let i = 1; i < def.path.length; i++) {
      const [ax, ay] = def.path[i - 1]
      const [bx, by] = def.path[i]
      const len = Math.hypot(bx - ax, by - ay)
      this.segs.push({ ax, ay, bx, by, len, start, dx: (bx - ax) / len, dy: (by - ay) / len })
      start += len
    }
    this.length = start
    this.cells = new Uint8Array(def.cols * def.rows)
    for (let y = 0; y < def.rows; y++)
      for (let x = 0; x < def.cols; x++) if (this.distToPath(x + 0.5, y + 0.5) < 0.51) this.cells[y * def.cols + x] = CELL_PATH
    for (const [bx, by, bw, bh] of def.buildings)
      for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) this.cells[y * def.cols + x] = CELL_BUILDING
    const c = def.core
    for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) this.cells[y * def.cols + x] = CELL_CORE
    this.coreCenter = [c.x + c.w / 2, c.y + c.h / 2]
    for (const [x0, y0, x1, y1] of def.elevated) {
      const a = this.project(x0, y0)
      const b = this.project(x1, y1)
      this.elevated.push([Math.min(a, b), Math.max(a, b)])
    }
  }

  cell(cx: number, cy: number): number {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return -1
    return this.cells[cy * this.cols + cx]
  }

  /** Position on the path at distance d. Writes into out to avoid allocation. */
  posAt(d: number, out: { x: number; y: number; angle: number }) {
    let s = this.segs[this.segs.length - 1]
    for (const g of this.segs)
      if (d < g.start + g.len) {
        s = g
        break
      }
    const t = Math.max(0, Math.min(s.len, d - s.start))
    out.x = s.ax + s.dx * t
    out.y = s.ay + s.dy * t
    out.angle = Math.atan2(s.dy, s.dx)
    return out
  }

  isElevated(d: number): boolean {
    for (const [a, b] of this.elevated) if (d >= a && d <= b) return true
    return false
  }

  distToPath(x: number, y: number): number {
    let best = Infinity
    for (const s of this.segs) {
      const t = Math.max(0, Math.min(s.len, (x - s.ax) * s.dx + (y - s.ay) * s.dy))
      best = Math.min(best, Math.hypot(s.ax + s.dx * t - x, s.ay + s.dy * t - y))
    }
    return best
  }

  /** Path distance of the closest point on the path. */
  project(x: number, y: number): number {
    let best = Infinity
    let bestD = 0
    for (const s of this.segs) {
      const t = Math.max(0, Math.min(s.len, (x - s.ax) * s.dx + (y - s.ay) * s.dy))
      const e = Math.hypot(s.ax + s.dx * t - x, s.ay + s.dy * t - y)
      if (e < best) {
        best = e
        bestD = s.start + t
      }
    }
    return bestD
  }

  /** Length of path inside a circle (sampled every 0.25 cells). Used by bots and placement hints. */
  coverage(x: number, y: number, r: number, groundOnly: boolean): number {
    let n = 0
    const p = { x: 0, y: 0, angle: 0 }
    for (let d = 0; d < this.length; d += 0.25) {
      if (groundOnly && this.isElevated(d)) continue
      this.posAt(d, p)
      if ((p.x - x) ** 2 + (p.y - y) ** 2 <= r * r) n++
    }
    return n * 0.25
  }
}
