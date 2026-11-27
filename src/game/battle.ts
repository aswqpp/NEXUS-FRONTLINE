// Battle screen controller: owns the sim, the fixed-step loop, the DOM HUD/rail/
// selection panel and all touch input (03장 gesture table).

import { BattleView } from '../render/battleView.ts'
import { C, MAT } from '../render/palette.ts'
import type { GameData, PathId, UnitDef } from '../sim/data.ts'
import { DT, PRIORITIES, Sim, type Command, type Priority, type Unit } from '../sim/sim.ts'

const PRIO_LABEL: Record<Priority, string> = { first: '선두', last: '마지막', strong: '강한 적', close: '가까운 적' }
const ROLE_LABEL = { attack: '공격', control: '제어', support: '지원' } as const
const DTYPE_LABEL = { kinetic: '운동', energy: '에너지', electric: '전기', explosive: '폭발' } as const
const TIER_NAME = ['PROTOTYPE', 'ENHANCED', 'ADVANCED', 'MK-II EVOLUTION', 'SPECIALIZED', 'APEX EVOLUTION', 'SINGULARITY']
const PATH_LABEL: Record<PathId, string> = { A: '화력', B: '제어', C: '유틸리티' }
const STACK_NTH: Record<number, string> = { 0.6: '2번째', 0.3: '3번째' }
// 24pt grid, 1.5pt stroke, straight lines and 45° only (2-5)
const LOCK_SVG = '<svg class="ico" viewBox="0 0 24 24"><path d="M7 11V7l2-2h6l2 2v4M5 11h14v9H5zM12 14v3"/></svg>'

const ICON = {
  pause: '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 5l7 7-7 7"/></svg>',
}

const DRAG_START = 16 // pt of horizontal travel before a rail press becomes a placement drag
const LIFT = 64 // drag preview floats this far above the finger
const LONG_TAP = 8 // pt of travel that still counts as a tap

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  if (html) e.innerHTML = html
  return e
}

type Placement = { unit: string; mode: 'drag' | 'tap'; cx: number; cy: number; has: boolean; pointer?: number }

export class Battle {
  readonly data: GameData
  sim: Sim
  readonly view = new BattleView()
  speed = 1
  paused = false
  private placement: Placement | null = null
  private selected: number | null = null
  private sellArmed: { id: number; until: number } | null = null
  private filters = new Set(['attack', 'control', 'support'])
  private last = 0
  private acc = 0
  private ended = false

  // DOM
  private root!: HTMLElement
  private mapEl!: HTMLElement
  private mapui!: HTMLElement
  private hud: Record<string, HTMLElement> = {}
  private railBtns = new Map<string, HTMLButtonElement>()
  private sel!: HTMLElement
  private overlay!: HTMLElement
  private banner: HTMLElement | null = null
  private reasonEl: HTMLElement | null = null
  private confirmEl: HTMLButtonElement | null = null
  private hudCache: Record<string, string> = {}
  /** wall-clock ms (since the battle started) for each accepted command: think time for playtests */
  private cmdMs: number[] = []
  private startMs = performance.now()
  private pausedMs = 0
  private pauseStart = 0
  dataHash = ''

  constructor(data: GameData) {
    this.data = data
    this.sim = new Sim(data, 'neon_district', 'normal')
  }

  async mount(root: HTMLElement) {
    this.root = root
    root.id = 'app'
    root.innerHTML = ''
    this.buildHud()
    this.mapEl = h('div', { id: 'map' })
    this.mapui = h('div', { id: 'mapui' })
    this.buildRail()
    this.sel = h('section', { id: 'sel', class: 'panel' })
    this.overlay = h('div', { id: 'overlay' })
    root.append(this.mapEl, this.sel, this.overlay)
    await this.view.init(this.mapEl, this.sim)
    this.mapEl.append(this.mapui)
    this.bindMapInput()
    this.bindRailInput()
    window.addEventListener('resize', () => this.view.clampCam())
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && !this.ended) this.setPaused(true)
    })
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.cancelPlacement() || this.setPaused(!this.paused)
    })
    this.last = performance.now()
    requestAnimationFrame(this.frame)
  }

  // ------------------------------------------------------------------ DOM build

  private buildHud() {
    const hud = h('header', { id: 'hud' })
    hud.innerHTML = `
      <div class="hud-group">
        <div class="stat"><span class="lbl">WAVE</span><b id="h-wave" class="big"></b></div>
        <div class="stat"><span class="lbl">CORE</span><b id="h-core"></b><i class="corebar" id="h-corebar"><i></i></i></div>
      </div>
      <div class="hud-group hud-c">
        <div class="stat"><span class="lbl">CREDITS</span><b id="h-cr" class="big"></b></div>
        <div class="stat"><span class="lbl">NEXT</span><b id="h-next" class="dim"></b></div>
      </div>
      <div class="hud-r">
        <button class="btn primary" id="b-wave"></button>
        <button class="btn sq mono" id="b-speed" aria-label="속도"></button>
        <button class="btn sq" id="b-pause" aria-label="일시정지">${ICON.pause}</button>
      </div>`
    this.root.append(hud)
    for (const id of ['h-wave', 'h-core', 'h-corebar', 'h-cr', 'h-next', 'b-wave', 'b-speed', 'b-pause'])
      this.hud[id] = hud.querySelector(`#${id}`)!
    this.hud['b-wave'].addEventListener('click', () => {
      if (this.cmd({ t: 'wave' })) this.update(true)
    })
    this.hud['b-speed'].addEventListener('click', () => {
      this.speed = (this.speed % 3) + 1
      this.view.fxDensity = [1, 0.5, 0.25][this.speed - 1]
      this.update(true)
    })
    this.hud['b-pause'].addEventListener('click', () => this.setPaused(true))
  }

  private buildRail() {
    const rail = h('aside', { id: 'rail' })
    const filters = h('div', { class: 'filters' })
    for (const role of ['attack', 'control', 'support'] as const) {
      const used = [...this.data.units.values()].some((u) => u.role === role)
      if (!used) continue // no button for a category with nothing in it
      const b = h('button', { 'aria-pressed': 'true' }, ROLE_LABEL[role])
      b.addEventListener('click', () => {
        if (this.filters.has(role) && this.filters.size > 1) this.filters.delete(role)
        else this.filters.add(role)
        b.setAttribute('aria-pressed', String(this.filters.has(role)))
        this.update(true)
      })
      filters.append(b)
    }
    rail.append(filters)
    const order = ['attack', 'control', 'support']
    const defs = [...this.data.units.values()].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || a.cost - b.cost)
    for (const def of defs) {
      const b = h('button', { class: 'ubtn', 'data-id': def.id, 'aria-label': def.name })
      const cv = document.createElement('canvas')
      drawUnitIcon(cv, def)
      b.append(cv, h('span', { class: 'code' }, def.name), h('span', { class: 'price' }, String(def.cost)))
      this.railBtns.set(def.id, b)
      rail.append(b)
    }
    this.root.append(rail)
  }

  private cmd(c: Command): boolean {
    const ok = this.sim.command(c)
    if (ok) this.cmdMs.push(Math.round(performance.now() - this.startMs))
    return ok
  }

  /** Playtest record (docs/balance.md §5): replayable command log + think times. */
  record() {
    const s = this.sim
    return {
      format: 'nexus-frontline-playtest',
      version: 1,
      dataHash: this.dataHash,
      map: s.map.def.id,
      difficulty: 'normal',
      endTick: s.tick,
      hash: s.hash(),
      result: { state: s.state, core: s.core, wave: s.wave, evacuation: s.evacuation() },
      log: s.log,
      cmdMs: this.cmdMs,
      pausedMs: Math.round(this.pausedMs),
      speedAtEnd: this.speed,
      viewport: [window.innerWidth, window.innerHeight],
      recordedAt: new Date().toISOString(),
    }
  }

  private download() {
    const blob = new Blob([JSON.stringify(this.record(), null, 1)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `playtest-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  // ------------------------------------------------------------------ loop

  private frame = (now: number) => {
    const dtReal = Math.min(0.1, (now - this.last) / 1000)
    this.last = now
    if (!this.paused && !this.ended) {
      this.acc += dtReal * this.speed
      let steps = 0
      while (this.acc >= DT && steps < 12) {
        this.sim.step()
        this.view.pushEvents(this.sim.events)
        this.sim.events.length = 0
        this.acc -= DT
        steps++
        if (this.sim.state === 'won' || this.sim.state === 'lost') break
      }
      if (steps === 12) this.acc = 0
      if (this.sim.state === 'won' || this.sim.state === 'lost') this.finish()
    }
    if (this.selected !== null && !this.sim.units.some((u) => u.id === this.selected)) this.select(null)
    this.view.render(this.paused ? 0 : dtReal * this.speed)
    this.update(false)
    requestAnimationFrame(this.frame)
  }

  /** Refresh DOM text only where it changed. */
  private update(force: boolean) {
    const s = this.sim
    const set = (id: string, text: string) => {
      if (!force && this.hudCache[id] === text) return
      this.hudCache[id] = text
      this.hud[id].textContent = text
    }
    set('h-wave', `${s.wave} / ${s.totalWaves}`)
    set('h-core', String(Math.ceil(s.core)))
    const hurt = s.core < s.coreMax
    this.hud['h-core'].classList.toggle('hurt', hurt)
    this.hud['h-corebar'].classList.toggle('hurt', hurt)
    ;(this.hud['h-corebar'].firstElementChild as HTMLElement).style.width = `${(100 * s.core) / s.coreMax}%`
    set('h-cr', String(s.credits))
    set('h-next', s.wave < s.totalWaves ? `+${s.expectedIncome()}` : '—')
    const wb = this.hud['b-wave'] as HTMLButtonElement
    wb.disabled = !s.canStartWave
    set('b-wave', s.wave >= s.totalWaves ? '마지막 웨이브' : s.canStartWave ? (s.busy ? '다음 웨이브' : '웨이브 시작') : '진행 중')
    set('b-speed', `${this.speed}×`)
    for (const [id, b] of this.railBtns) {
      const def = this.data.units.get(id)!
      b.hidden = !this.filters.has(def.role)
      const poor = s.credits < def.cost
      b.classList.toggle('poor', poor)
      b.classList.toggle('armed', this.placement?.unit === id)
      const price = poor ? `${def.cost} −${def.cost - s.credits}` : String(def.cost)
      const pe = b.querySelector('.price')!
      if (pe.textContent !== price) pe.textContent = price
    }
    this.updateSelection()
    if (this.sellArmed && performance.now() > this.sellArmed.until) {
      this.sellArmed = null
      this.renderSelection()
    }
    this.placeUi()
  }

  // ------------------------------------------------------------------ selection panel

  private select(id: number | null) {
    this.selected = id
    this.view.selected = id
    this.sellArmed = null
    this.renderSelection()
    this.sel.classList.toggle('open', id !== null)
  }

  private selectedUnit(): Unit | undefined {
    return this.selected === null ? undefined : this.sim.units.find((u) => u.id === this.selected)
  }

  private upGuard: Record<string, number> = {}
  private rowSig: Record<string, string> = {}

  private renderSelection() {
    const u = this.selectedUnit()
    if (!u) return
    const b = u.stats
    const sim = this.sim
    const stats: [string, string][] = []
    if (b.kind === 'pulse') {
      stats.push(['둔화', `${Math.round(b.slow * 100)}% · ${b.slowDuration}s`], ['펄스', `${sim.interval(u).toFixed(2)}s`], ['반경', `${sim.range(u).toFixed(1)}칸`])
    } else {
      const shots = b.multishot > 1 ? ` ×${b.multishot}` : ''
      stats.push(['피해', `${+b.damage.toFixed(1)}${shots} ${DTYPE_LABEL[b.damageType]}`], ['연사', `${sim.interval(u).toFixed(2)}s`], ['사거리', `${sim.range(u).toFixed(1)}칸`])
      if (b.kind === 'rail') stats.push(['관통', `${b.pierce}`])
      if (b.kind === 'chain') stats.push(['연쇄', `${b.chain}회`])
    }
    const tags: string[] = [b.elevated ? '높이 있음' : '높이 없음']
    if (b.armorPen > 0) tags.push(`장갑 관통 ${Math.round(b.armorPen * 100)}%`)
    if (sim.detects(u)) tags.push(b.detect ? '은폐 탐지' : '은폐 탐지(공유)')
    const tier = sim.tier(u)
    const armed = this.sellArmed?.id === u.id
    const value = sim.sellValue(u)
    const hasPaths = u.def.paths.A.length + u.def.paths.B.length + u.def.paths.C.length > 0
    const BUFF_LABEL: Record<string, string> = { range: '사거리', attackSpeed: '공격 속도', damage: '피해', cooldown: '재사용' }
    const buffs = u.buffs.list
      .filter((e) => e.type !== 'detect')
      .map((e) => {
        const src = sim.units.find((x) => x.id === e.src)
        const who = src ? `${src.def.code}-${String(src.id).padStart(2, '0')}` : ''
        const part = e.weight === 1 ? '' : e.weight === 0 ? ', 4번째 이후 무시' : `, ${STACK_NTH[e.weight] ?? ''} ${Math.round(e.weight * 100)}% 적용`
        return `${BUFF_LABEL[e.type]} +${Math.round(e.value * e.weight * 100)}% (${who}${part})`
      })
    this.sel.innerHTML = `<div class="body">
      <div class="sel-l">
        <div class="sel-name"><h2>${u.def.name}</h2><span class="lbl">TIER ${tier} · ${TIER_NAME[tier]}</span></div>
        <div class="kv">${stats.map(([k, v]) => `<div><span class="lbl">${k}</span><b>${v}</b></div>`).join('')}</div>
        <div class="buffs">${tags.join(' · ')}${buffs.length ? `<br><span class="lbl">받는 강화</span> ${buffs.join(' · ')}` : ''}</div>
        ${b.kind === 'pulse' ? '' : `<div class="prio">${PRIORITIES.map((p) => `<button data-p="${p}" aria-pressed="${u.priority === p}">${PRIO_LABEL[p]}</button>`).join('')}</div>`}
      </div>
      <div class="sel-m">${hasPaths ? (['A', 'B', 'C'] as PathId[]).map((p) => `<button class="up" data-path="${p}"></button>`).join('') : `<span class="lbl">${u.def.code} · ${ROLE_LABEL[u.def.role]}</span><p>${u.def.summary}</p>`}</div>
      <div class="sel-r">
        <div class="kv"><div><span class="lbl">누적 피해</span><b data-live="dmg"></b></div><div><span class="lbl">처치</span><b data-live="kills"></b></div></div>
        <button class="btn sell${armed ? ' armed' : ''}" data-sell>${armed ? `판매 확정 +${value}` : `판매 +${value}`}</button>
      </div>
    </div>`
    this.rowSig = {}
    this.sel.querySelectorAll<HTMLButtonElement>('.up').forEach((btn) =>
      btn.addEventListener('click', () => {
        const path = btn.dataset.path as PathId
        // 03장: ignore the same button for 300 ms after a purchase
        if (performance.now() < (this.upGuard[path] ?? 0)) return
        if (this.cmd({ t: 'upgrade', id: u.id, path })) {
          this.upGuard[path] = performance.now() + 300
          this.renderSelection()
        }
      }),
    )
    this.sel.querySelectorAll<HTMLButtonElement>('.prio button').forEach((btn) =>
      btn.addEventListener('click', () => {
        this.cmd({ t: 'priority', id: u.id, p: btn.dataset.p as Priority })
        this.renderSelection()
      }),
    )
    this.sel.querySelector('[data-sell]')!.addEventListener('click', () => {
      if (this.sellArmed?.id === u.id && performance.now() <= this.sellArmed.until) {
        this.cmd({ t: 'sell', id: u.id })
        this.select(null)
      } else {
        this.sellArmed = { id: u.id, until: performance.now() + 3000 }
        this.renderSelection()
      }
    })
    this.updateSelection()
  }

  /** Upgrade rows: state = icon/shape + text, never colour alone (2-3). */
  private renderUpgradeRow(btn: HTMLButtonElement, u: Unit) {
    const path = btn.dataset.path as PathId
    const st = this.sim.upgradeStatus(u, path)
    const sig = `${st.state}|${st.level}|${st.reason ?? ''}`
    if (this.rowSig[path] === sig) return
    this.rowSig[path] = sig
    const i = ['A', 'B', 'C'].indexOf(path)
    const total = u.def.paths[path].length
    const pips = Array.from({ length: total }, (_, k) => `<i class="${k < u.levels[i] ? 'on' : ''}${k === 5 ? ' t6' : ''}"></i>`).join('')
    const step = st.step
    const price =
      st.state === 'buy'
        ? `<b class="price ok">${step!.cost.toLocaleString('en-US')}</b>`
        : st.state === 'poor'
          ? `<b class="price poor">${step!.cost.toLocaleString('en-US')} <small>${st.reason!.replace(/^크레딧 부족 /, '')}</small></b>`
          : st.state === 'max'
            ? '<b class="price">최대</b>'
            : `<b class="price">${LOCK_SVG}</b>`
    const line = st.state === 'locked' || st.state === 'nodata' ? st.reason! : step ? step.text : ''
    btn.className = `up s-${st.state}`
    btn.disabled = st.state !== 'buy'
    btn.innerHTML = `<span class="pn"><span class="lbl">${path} ${PATH_LABEL[path]}</span><span class="pips">${pips}</span></span>
      <span class="nm">${step ? `${st.level + 1}. ${step.name}` : '—'}</span>${price}
      <span class="tx">${line}</span>`
  }

  private updateSelection() {
    const u = this.selectedUnit()
    if (!u) return
    const d = this.sel.querySelector('[data-live="dmg"]')
    const k = this.sel.querySelector('[data-live="kills"]')
    if (d) d.textContent = Math.round(u.damage).toLocaleString('en-US')
    if (k) k.textContent = String(u.kills)
    this.sel.querySelectorAll<HTMLButtonElement>('.up').forEach((b) => this.renderUpgradeRow(b, u))
  }

  // ------------------------------------------------------------------ placement

  private startPlacement(unit: string, mode: Placement['mode'], pointer?: number) {
    this.select(null)
    this.placement = { unit, mode, cx: 0, cy: 0, has: false, pointer }
    this.view.showGrid = true
    this.update(true)
  }

  private cancelPlacement(): boolean {
    if (!this.placement) return false
    this.placement = null
    this.view.preview = null
    this.view.showGrid = false
    this.update(true)
    return true
  }

  private setPreviewCell(cx: number, cy: number) {
    const p = this.placement!
    p.cx = cx
    p.cy = cy
    p.has = true
    const def = this.data.units.get(p.unit)!
    const v = this.sim.canPlace(p.unit, cx, cy)
    this.view.preview = { unit: p.unit, cx, cy, ok: v.ok, range: def.base.range, supportRange: def.role !== 'attack' }
  }

  private tryPlace(): boolean {
    const p = this.placement
    if (!p || !p.has) return false
    const ok = this.cmd({ t: 'place', unit: p.unit, cx: p.cx, cy: p.cy })
    if (ok) this.cancelPlacement()
    return ok
  }

  /** Banner, reason label and confirm button that live over the map. */
  private placeUi() {
    const p = this.placement
    if (!p) {
      this.banner?.remove()
      this.reasonEl?.remove()
      this.confirmEl?.remove()
      this.banner = this.reasonEl = this.confirmEl = null
      return
    }
    const def = this.data.units.get(p.unit)!
    if (!this.banner) {
      this.banner = h('div', { class: 'banner panel', 'data-em': 'cyan' })
      const cancel = h('button', { class: 'btn' }, '취소')
      cancel.addEventListener('click', () => this.cancelPlacement())
      this.banner.append(h('span', { class: 'txt' }), cancel)
      this.mapui.append(this.banner)
    }
    const txt = p.mode === 'drag' ? `${def.name} 배치 · 놓을 곳에서 손을 떼세요` : `${def.name} 배치 · 맵을 눌러 위치 지정`
    const t = this.banner.querySelector('.txt')!
    if (t.textContent !== txt) t.textContent = txt
    const v = p.has ? this.sim.canPlace(p.unit, p.cx, p.cy) : null
    // reason (only when invalid)
    if (v && !v.ok) {
      if (!this.reasonEl) {
        this.reasonEl = h('div', { class: 'reason panel', 'data-em': 'red' }, '<span></span>')
        this.mapui.append(this.reasonEl)
      }
      const span = this.reasonEl.firstElementChild!
      if (span.textContent !== v.reason) span.textContent = v.reason!
      const [sx, sy] = this.view.toScreen(p.cx + 0.5, p.cy)
      this.reasonEl.style.left = `${sx}px`
      this.reasonEl.style.top = `${sy - 8}px`
    } else {
      this.reasonEl?.remove()
      this.reasonEl = null
    }
    // confirm button (tap mode, valid cell)
    if (p.mode === 'tap' && v?.ok) {
      if (!this.confirmEl) {
        this.confirmEl = h('button', { class: 'btn primary confirm' })
        this.confirmEl.addEventListener('click', () => this.tryPlace())
        this.mapui.append(this.confirmEl)
      }
      const label = `설치 · ${def.cost}`
      if (this.confirmEl.textContent !== label) this.confirmEl.textContent = label
      const [sx, sy] = this.view.toScreen(p.cx + 0.5, p.cy + 1)
      const below = sy + 8 + 56 < this.view.viewH - 20
      const [, top] = this.view.toScreen(0, p.cy)
      this.confirmEl.style.left = `${Math.max(80, Math.min(this.view.viewW - 80, sx))}px`
      this.confirmEl.style.top = `${below ? sy + 8 : top - 64}px`
    } else {
      this.confirmEl?.remove()
      this.confirmEl = null
    }
  }

  // ------------------------------------------------------------------ input

  private local(e: PointerEvent): [number, number] {
    const r = this.mapEl.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }

  private cellUnder(sx: number, sy: number): [number, number] {
    const [x, y] = this.view.toCell(sx, sy)
    return [Math.floor(x), Math.floor(y)]
  }

  private bindRailInput() {
    let press: { id: string; pointer: number; sx: number; sy: number; dragging: boolean } | null = null
    for (const [id, b] of this.railBtns) {
      b.addEventListener('pointerdown', (e) => {
        if (this.ended) return
        press = { id, pointer: e.pointerId, sx: e.clientX, sy: e.clientY, dragging: false }
      })
    }
    window.addEventListener('pointermove', (e) => {
      if (!press || e.pointerId !== press.pointer) return
      if (!press.dragging) {
        if (Math.abs(e.clientX - press.sx) >= DRAG_START) {
          press.dragging = true
          this.startPlacement(press.id, 'drag', e.pointerId)
        } else return
      }
      const [sx, sy] = this.local(e)
      const [cx, cy] = this.cellUnder(sx, sy - LIFT)
      this.setPreviewCell(cx, cy)
    })
    const end = (e: PointerEvent) => {
      if (!press || e.pointerId !== press.pointer) return
      const p = press
      press = null
      if (p.dragging) {
        // released over the rail, or on an invalid cell -> cancel
        const overRail = e.clientX >= this.mapEl.getBoundingClientRect().right
        if (overRail || e.type === 'pointercancel' || !this.tryPlace()) this.cancelPlacement()
        return
      }
      // a tap toggles tap-placement mode
      if (this.placement?.unit === p.id) this.cancelPlacement()
      else this.startPlacement(p.id, 'tap')
    }
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  private bindMapInput() {
    const pts = new Map<number, { x: number; y: number; sx: number; sy: number }>()
    let mode: 'none' | 'tap' | 'pan' | 'pinch' | 'preview' = 'none'
    let pinch = { d: 1, mx: 0, my: 0, cs: 1, wx: 0, wy: 0 }
    const el = this.mapEl
    const dragActive = () => this.placement?.mode === 'drag'
    const startPinch = () => {
      const [a, b] = [...pts.values()]
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      const [wx, wy] = this.view.toCell(mx, my)
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx, my, cs: this.view.cam.s, wx, wy }
      mode = 'pinch'
    }
    el.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return
      if (dragActive()) return // two-finger gestures are ignored during a placement drag
      const [x, y] = this.local(e)
      pts.set(e.pointerId, { x, y, sx: x, sy: y })
      if (pts.size === 2) startPinch()
      else if (pts.size === 1) mode = 'tap'
    })
    window.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId)
      if (!p) return
      const [x, y] = this.local(e)
      const dx = x - p.x
      const dy = y - p.y
      p.x = x
      p.y = y
      if (mode === 'pinch' && pts.size >= 2) {
        const [a, b] = [...pts.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        const cam = this.view.cam
        cam.s = Math.max(0.75, Math.min(2, (pinch.cs * d) / pinch.d))
        cam.x = mx - pinch.wx * cam.s * 48
        cam.y = my - pinch.wy * cam.s * 48
        this.view.clampCam()
        return
      }
      if (mode === 'tap' && Math.hypot(x - p.sx, y - p.sy) > LONG_TAP) mode = this.placement ? 'preview' : 'pan'
      if (mode === 'pan') {
        this.view.cam.x += dx
        this.view.cam.y += dy
        this.view.clampCam()
      } else if (mode === 'preview' && this.placement) {
        const [cx, cy] = this.cellUnder(x, y - LIFT)
        this.setPreviewCell(cx, cy)
      }
    })
    const up = (e: PointerEvent) => {
      const p = pts.get(e.pointerId)
      if (!p) return
      pts.delete(e.pointerId)
      if (mode === 'tap' && e.type === 'pointerup') this.tap(p.x, p.y)
      if (mode === 'pinch') mode = pts.size ? 'none' : 'none'
      if (!pts.size) mode = 'none'
    }
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    el.addEventListener('wheel', (e) => {
      e.preventDefault()
      const [x, y] = [e.offsetX, e.offsetY]
      this.view.zoomAt(x, y, e.deltaY < 0 ? 1.1 : 1 / 1.1)
    }, { passive: false })
  }

  private tap(sx: number, sy: number) {
    const [cx, cy] = this.cellUnder(sx, sy)
    if (this.placement) {
      if (this.placement.mode === 'tap') this.setPreviewCell(cx, cy)
      return
    }
    const u = this.sim.map.cell(cx, cy) >= 0 ? this.sim.unitAt(cx, cy) : undefined
    if (u) this.select(u.id === this.selected ? null : u.id)
    else if (this.selected !== null) this.select(null)
  }

  // ------------------------------------------------------------------ pause / end

  setPaused(p: boolean) {
    if (this.ended) return
    if (p && !this.paused) this.pauseStart = performance.now()
    if (!p && this.paused) this.pausedMs += performance.now() - this.pauseStart
    this.paused = p
    if (!p) {
      this.overlay.classList.remove('show')
      this.last = performance.now()
      return
    }
    this.overlay.innerHTML = `<div class="sheet panel">
      <div class="lbl">PAUSED · WAVE ${this.sim.wave} / ${this.sim.totalWaves}</div>
      <h2>일시정지</h2>
      <div class="menu">
        <button class="btn primary" data-a="resume">재개</button>
        <button class="btn" data-a="restart">재시작</button>
      </div></div>`
    this.overlay.querySelector('[data-a="resume"]')!.addEventListener('click', () => this.setPaused(false))
    this.overlay.querySelector('[data-a="restart"]')!.addEventListener('click', () => this.restart())
    this.overlay.classList.add('show')
  }

  private finish() {
    if (this.ended) return
    this.ended = true
    this.cancelPlacement()
    this.select(null)
    const s = this.sim
    const won = s.state === 'won'
    const evac = Math.round(s.evacuation() * 100)
    const mins = Math.floor(s.time / 60)
    const secs = Math.floor(s.time % 60)
    let worst = ''
    let worstN = 0
    for (const [id, n] of s.coreHitsBy)
      if (n > worstN) {
        worstN = n
        worst = id
      }
    const worstDef = worst ? this.data.enemies.get(worst) : undefined
    this.overlay.innerHTML = `<div class="sheet panel" data-em="${won ? 'cyan' : 'red'}">
      <div class="lbl">${won ? 'ZONE HELD' : 'ZONE RECLAIMED'} · NEON DISTRICT</div>
      <h2>${won ? '구역 유지. 대피 완료율 100%' : `구역 회수됨. 대피 완료율 ${evac}%`}</h2>
      <table>
        <tr><th>코어 내구도</th><td>${Math.ceil(s.core)} / ${s.coreMax}</td></tr>
        <tr><th>웨이브</th><td>${s.wave} / ${s.totalWaves}</td></tr>
        <tr><th>걸린 시간</th><td>${mins}:${String(secs).padStart(2, '0')}</td></tr>
        ${worstDef ? `<tr><th>코어를 가장 많이 친 적</th><td>${worstDef.code} ×${worstN}</td></tr>` : ''}
      </table>
      <div class="menu">
        <button class="btn primary" data-a="restart">다시 작전</button>
        <button class="btn" data-a="view">전장 보기</button>
        <button class="btn" data-a="export">플레이 기록 저장</button>
      </div></div>`
    this.overlay.querySelector('[data-a="export"]')!.addEventListener('click', () => this.download())
    this.overlay.querySelector('[data-a="restart"]')!.addEventListener('click', () => this.restart())
    this.overlay.querySelector('[data-a="view"]')!.addEventListener('click', () => {
      this.overlay.classList.remove('show')
      this.showReturnButton()
    })
    this.overlay.classList.add('show')
  }

  /** After "전장 보기", a single button brings the result back. */
  private showReturnButton() {
    const b = h('button', { class: 'btn primary', style: 'position:absolute;left:24px;bottom:24px' }, '결과 보기')
    b.addEventListener('click', () => {
      b.remove()
      this.overlay.classList.add('show')
    })
    this.mapui.append(b)
  }

  restart() {
    this.sim = new Sim(this.data, 'neon_district', 'normal')
    this.view.setSim(this.sim)
    this.view.fit()
    this.ended = false
    this.paused = false
    this.speed = 1
    this.acc = 0
    this.placement = null
    this.mapui.innerHTML = ''
    this.banner = this.reasonEl = this.confirmEl = null
    this.select(null)
    this.overlay.classList.remove('show')
    this.last = performance.now()
    this.cmdMs = []
    this.startMs = performance.now()
    this.pausedMs = 0
    this.update(true)
  }
}

/** 36pt rail icon using the same stand-in shapes as the map (no images, no icon library). */
function drawUnitIcon(cv: HTMLCanvasElement, def: UnitDef) {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  cv.width = 36 * dpr
  cv.height = 36 * dpr
  const ctx = cv.getContext('2d')!
  ctx.scale(dpr * 36, dpr * 36)
  ctx.translate(0.5, 0.5)
  ctx.lineWidth = 1 / 36
  const poly = (pts: number[], fill: string) => {
    ctx.beginPath()
    ctx.moveTo(pts[0], pts[1])
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1])
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.fill()
    ctx.strokeStyle = MAT.frame.seam
    ctx.stroke()
  }
  const ch = (x0: number, y0: number, x1: number, y1: number, c: number) => [x0 + c, y0, x1 - c, y0, x1, y0 + c, x1, y1 - c, x1 - c, y1, x0 + c, y1, x0, y1 - c, x0, y0 + c]
  poly(ch(-0.38, -0.3, 0.38, 0.3, 0.08), MAT.frame.base)
  ctx.rotate(-Math.PI / 4)
  if (def.id === 'sentinel') {
    poly(ch(0.18, -0.035, 0.5, 0.035, 0), MAT.gun.base)
    poly(ch(-0.22, -0.16, 0.18, 0.16, 0.06), MAT.hull.base)
  } else if (def.id === 'railx') {
    poly(ch(0.1, -0.04, 0.5, 0.04, 0), MAT.gun.base)
    poly(ch(-0.26, -0.13, 0.14, 0.13, 0.04), MAT.hull.base)
  } else if (def.id === 'arc') {
    ctx.rotate(Math.PI / 4)
    poly(ch(-0.24, -0.24, 0.24, 0.24, 0.08), MAT.frame.light)
    poly(ch(-0.16, -0.16, 0.16, 0.16, 0.05), MAT.hull.base)
  } else {
    ctx.rotate(Math.PI / 4)
    poly(ch(-0.3, -0.2, 0.3, 0.2, 0.04), MAT.hull.base)
    ctx.beginPath()
    ctx.arc(0, 0, 0.15, 0, Math.PI * 2)
    ctx.fillStyle = MAT.gun.base
    ctx.fill()
  }
  ctx.fillStyle = C.cyan
  ctx.fillRect(-0.12, -0.04, 0.08, 0.08)
}
