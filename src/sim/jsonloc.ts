// Minimal JSON parser that remembers the line of every value, so data errors can
// say "data/units/sentinel.json:12 base.range: ..." (지시서 16장).

export type JPath = (string | number)[]

export interface Located {
  value: unknown
  /** "a.b[2].c" -> 1-based line number */
  lines: Map<string, number>
}

export class JsonSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message)
  }
}

export function pathKey(p: JPath): string {
  let s = ''
  for (const k of p) s += typeof k === 'number' ? `[${k}]` : s ? `.${k}` : k
  return s
}

export function parseLocated(text: string): Located {
  let i = 0
  let line = 1
  const lines = new Map<string, number>()

  const ws = () => {
    while (i < text.length) {
      const c = text[i]
      if (c === '\n') line++
      else if (c !== ' ' && c !== '\t' && c !== '\r') break
      i++
    }
  }
  const fail = (msg: string): never => {
    throw new JsonSyntaxError(msg, line)
  }

  const str = (): string => {
    i++ // opening quote
    let out = ''
    while (i < text.length) {
      const c = text[i++]
      if (c === '"') return out
      if (c === '\n') fail('문자열 안에 줄바꿈')
      if (c === '\\') {
        const e = text[i++]
        if (e === 'u') {
          out += String.fromCharCode(parseInt(text.slice(i, i + 4), 16))
          i += 4
        } else out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[e] ?? e
      } else out += c
    }
    return fail('닫히지 않은 문자열')
  }

  const val = (p: JPath): unknown => {
    ws()
    lines.set(pathKey(p), line)
    const c = text[i]
    if (c === '{') {
      i++
      const o: Record<string, unknown> = {}
      ws()
      if (text[i] === '}') {
        i++
        return o
      }
      for (;;) {
        ws()
        if (text[i] !== '"') fail('객체 키가 와야 함')
        const k = str()
        ws()
        if (text[i++] !== ':') fail(`"${k}" 뒤에 ':'가 없음`)
        o[k] = val([...p, k])
        ws()
        const d = text[i++]
        if (d === '}') return o
        if (d !== ',') fail("',' 또는 '}'가 와야 함")
      }
    }
    if (c === '[') {
      i++
      const a: unknown[] = []
      ws()
      if (text[i] === ']') {
        i++
        return a
      }
      for (;;) {
        a.push(val([...p, a.length]))
        ws()
        const d = text[i++]
        if (d === ']') return a
        if (d !== ',') fail("',' 또는 ']'가 와야 함")
      }
    }
    if (c === '"') return str()
    const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 40))
    if (!m) return fail('알 수 없는 값')
    i += m[0].length
    if (m[0] === 'true') return true
    if (m[0] === 'false') return false
    if (m[0] === 'null') return null
    return Number(m[0])
  }

  const value = val([])
  ws()
  if (i < text.length) fail('값 뒤에 남는 내용')
  return { value, lines }
}
