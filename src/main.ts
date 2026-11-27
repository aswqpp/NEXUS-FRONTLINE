import '@fontsource/ibm-plex-sans-kr/400.css'
import '@fontsource/ibm-plex-sans-kr/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-sans-condensed/500.css'
import '@fontsource/ibm-plex-sans-condensed/600.css'
import './ui/tokens.css'
import './ui/battle.css'

import { Battle } from './game/battle.ts'
import { DataError, loadGameData } from './sim/data.ts'

// All game data, as raw text so schema errors can point at file:line.
const raw = import.meta.glob('../data/**/*.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

/** FNV-1a over all data files, so a playtest record can tell which numbers it was played on. */
export function dataHash(files: Record<string, string>): string {
  let h = 0x811c9dc5
  for (const k of Object.keys(files).sort()) for (const ch of k + files[k]) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}

async function main() {
  const root = document.getElementById('app')!
  const files: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) files[k.replace(/^\.\.\//, '')] = v
  let data
  try {
    data = loadGameData(files)
  } catch (e) {
    const msg = e instanceof DataError ? e.issues.join('\n') : String(e)
    root.innerHTML = `<pre class="err panel">데이터 오류\n\n${msg.replace(/</g, '&lt;')}</pre>`
    throw e
  }
  await Promise.all(
    ['400 13px "IBM Plex Sans KR"', '600 13px "IBM Plex Sans KR"', '500 15px "IBM Plex Mono"', '600 11px "IBM Plex Sans Condensed"'].map((f) =>
      document.fonts.load(f),
    ),
  )
  const battle = new Battle(data)
  battle.dataHash = dataHash(files)
  await battle.mount(root)
  // read-only handle for automated checks (19장); not part of the UI
  ;(window as unknown as { __nf: Battle }).__nf = battle
  document.body.dataset.ready = '1'
}

void main()
