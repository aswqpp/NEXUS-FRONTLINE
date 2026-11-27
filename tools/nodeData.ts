// Node-side data loader for headless tools.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { loadGameData, type GameData } from '../src/sim/data.ts'

export const ROOT = join(import.meta.dirname, '..')

export function readDataFiles(dir = join(ROOT, 'data')): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (f.endsWith('.json')) out[relative(ROOT, p)] = readFileSync(p, 'utf8')
    }
  }
  walk(dir)
  return out
}

export function loadData(): GameData {
  return loadGameData(readDataFiles())
}
