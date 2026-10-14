import type { ModelUsage } from 'claude-code'

export const ACCENT = '#8f8cf4'
export const DONE = '#5fbf8f'
export const WAIT = '#e0a43a'
export const IDLE = '#9a9a96'
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"
export const CLAY = '#D97757'
const INK = '#1F1E1D'
const CELL = 3

const COSTUME_COLOR: Record<string, string> = {
  astronaut: '#7F77DD',
  detective: '#D85A30',
  engineer: '#BA7517',
  chef: '#378ADD',
  racer: '#1D9E75',
  plain: '#888780',
}

const LANE_COSTUME: Record<string, string> = {
  architect: 'astronaut',
  researcher: 'detective',
  implementer: 'engineer',
  operator: 'chef',
  clerk: 'racer',
  fetcher: 'racer',
  Explore: 'pirate',
}

export const laneOf = (type: string): string => type.replace(/^[^:]*:/, '')

export const costumeOf = (type: string): string => LANE_COSTUME[laneOf(type)] ?? 'plain'

export const colorOf = (type: string): string => COSTUME_COLOR[costumeOf(type)] ?? COSTUME_COLOR.plain!

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

const charEm = (ch: string): number => (/[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-Z@%]/.test(ch) ? 0.72 : 0.56)

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

const BASE_CSS = `<style>
.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tile{fill:#f4f3f0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tile{fill:#262625}}
.t0,.t1,.t2,.t3{animation:tw 2.2s ease-in-out infinite}
.t1{animation-duration:2.8s;animation-delay:-.7s}.t2{animation-duration:1.9s;animation-delay:-1.3s}.t3{animation-duration:3.3s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:.3}}
.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.t0,.t1,.t2,.t3,.live{animation:none}}
</style>`

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${BASE_CSS}${CRAB_CSS}${body}</svg>`

// `fill` null draws the faint layer across the whole bar: working, no percent yet.
const ditherBar = (id: string, W: number, H: number, fill: number | null, color: string): string => {
  const rows = Math.floor(H / CELL)
  const solid = Math.floor((W * (fill ?? 0)) / CELL)
  const faint = fill === null ? Math.floor(W / CELL) : 0
  const dots: string[] = []
  for (let c = 0; c < solid; c++) {
    const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, solid), 1.2)
    for (let r = 0; r < rows; r++) {
      if (noise(c, r) < density) dots.push(`<rect class="t${Math.floor(noise(r, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="2" height="2"/>`)
    }
  }
  for (let c = 0; c < faint; c++) {
    for (let r = 0; r < rows; r++) {
      if (noise(c + 7, r + 3) < 0.3) dots.push(`<rect class="t${Math.floor(noise(r + 5, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="1.7" height="1.7" opacity="0.5"/>`)
    }
  }
  return `<defs><clipPath id="${id}"><rect width="${W}" height="${H}" rx="${H / 2}"/></clipPath></defs>
<rect class="k" width="${W}" height="${H}" rx="${H / 2}"/>
<g clip-path="url(#${id})" fill="${color}">${dots.join('')}</g>`
}

const mark = (x: number, y: number, icon: string, color: string): string => {
  if (icon === '✓') return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  if (icon === '▶') return `<circle class="live" cx="${x}" cy="${y}" r="4" fill="${color}"/>`
  if (icon === '‖') return `<rect x="${x - 4}" y="${y - 4}" width="3" height="8" fill="${color}"/><rect x="${x + 1}" y="${y - 4}" width="3" height="8" fill="${color}"/>`
  return `<circle cx="${x}" cy="${y}" r="4" fill="none" stroke="${color}" stroke-width="1.4"/>`
}

export type StepRow = { key: string; icon: string; name: string; fill: number | null; label: string; color: string; isUpcoming: boolean; isActive: boolean }

export const STEP_H = 24

export const stepSvg = (W: number, s: StepRow): string => {
  const BAR_H = 16
  const BAR_X = Math.round(Math.max(140, W * 0.45))
  const BAR_W = Math.max(60, W - BAR_X)
  const name = fitText(s.name, 13, BAR_X - 28)
  const fillW = Math.round(BAR_W * (s.fill ?? 0))
  const pillW = Math.round(18 + s.label.length * 6.6)
  const pillX = Math.max(0, Math.min(BAR_W - pillW, fillW - pillW))
  const pill = s.isUpcoming ? IDLE : s.color
  return svg(
    W,
    STEP_H,
    `${mark(6, STEP_H / 2, s.icon, s.color)}
<text class="${s.isUpcoming ? 'm' : 't'}" x="20" y="${STEP_H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="${s.isActive ? 600 : 400}">${xml(name)}</text>
<g transform="translate(${BAR_X},${(STEP_H - BAR_H) / 2})">
${ditherBar(s.key, BAR_W, BAR_H, s.fill, s.color)}
<rect x="${pillX}" width="${pillW}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${pill}"/>
<text x="${pillX + pillW / 2}" y="${BAR_H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#ffffff">${xml(s.label)}</text>
</g>`,
  )
}

export type AgentRow = { id: string; type: string; description: string; fill: number | null; label: string }

export const AGENT_H = 28

export const agentSvg = (W: number, a: AgentRow): string => {
  const color = colorOf(a.type)
  const BAR_X = Math.round(Math.max(140, W * 0.45))
  const BAR_W = Math.max(60, W - BAR_X - 70)
  return svg(
    W,
    AGENT_H,
    `${crab(18, 2, costumeOf(a.type), true, 0.8)}
<text class="t" x="48" y="${AGENT_H / 2 + 4}" font-family="${FONT}" font-size="12">${xml(fitText(a.description, 12, BAR_X - 56))}</text>
<g transform="translate(${BAR_X},${AGENT_H / 2 - 3})">${ditherBar(`a-${a.id.replace(/\W/g, '')}`, BAR_W, 6, a.fill, color)}</g>
<text class="m" x="${W}" y="${AGENT_H / 2 + 4}" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(a.label)}</text>`,
  )
}

export const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

export const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

export const fmtCost = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

type Price = readonly [input: number, output: number, cacheRead: number, cacheWrite: number]

const PRICES: readonly (readonly [RegExp, Price])[] = [
  [/fable|mythos/, [10, 50, 0.25, 12.5]],
  [/opus-5-5/, [4, 20, 0.2, 5]],
  [/opus/, [5, 25, 0.5, 6.25]],
  [/sonnet/, [2, 10, 0.2, 2.5]],
  [/haiku/, [1, 5, 0.1, 1.25]],
]

const DEFAULT_PRICE: Price = [4, 20, 0.2, 5]

export const costOf = (model: string, u: ModelUsage): number => {
  const [input, output, cacheRead, cacheWrite] = PRICES.find(([pattern]) => pattern.test(model))?.[1] ?? DEFAULT_PRICE
  return (u.input_tokens * input + u.output_tokens * output + u.cache_read_input_tokens * cacheRead + u.cache_creation_input_tokens * cacheWrite) / 1e6
}

export type Card = { id: string; type: string; title: string; lane: string; meta: string; fill: number | null; steps: string; stats: string }

export const CARD_H = 82

export const cardSvg = (W: number, c: Card): string => {
  const color = colorOf(c.type)
  const textW = W - 64 - 12
  const statsW = textWidth(c.stats, 11)
  return svg(
    W,
    CARD_H,
    `<rect class="tile" x="0.5" y="0.5" width="${W - 1}" height="${CARD_H - 5}" rx="10" stroke="${color}" stroke-opacity="0.45"/>
${crab(12, 22, costumeOf(c.type), true, 1.25)}
<text class="t" x="64" y="22" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(c.title, 13, textW))}</text>
<text x="64" y="38" font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(c.lane)}</tspan><tspan class="m">  ${xml(c.meta)}</tspan></text>
<g transform="translate(64,46)">${ditherBar(`c-${c.id.replace(/\W/g, '')}`, textW, 6, c.fill, color)}</g>
<text class="t" x="64" y="68" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(fitText(c.steps, 11, Math.max(20, textW - statsW - 12)))}</text>
<text class="m" x="${64 + textW}" y="68" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(c.stats)}</text>`,
  )
}

type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

const stamp = (f: Fill, x: number, y: number, rows: string[], map: Record<string, string>, cls?: string): void =>
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => map[ch] && f(x + dx, y + dy, 1, 1, map[ch] ?? '', cls)))

const crabBody = (f: Fill, armFront = 0, armCls?: string): void => {
  f(7, 10, 16, 12, CLAY)
  f(3, 14, 4, 4, CLAY)
  f(23, 14 + armFront, 4, 4, CLAY, armCls)
  f(9, 12, 2, 2, INK)
  f(19, 12, 2, 2, INK)
  f(7, 22, 2, 4, CLAY, 'la')
  f(17, 22, 2, 4, CLAY, 'la')
  f(11, 22, 2, 4, CLAY, 'lb')
  f(21, 22, 2, 4, CLAY, 'lb')
}

const CRAB_CSS = `<style>
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
.run g{transform-box:fill-box}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
.c-astronaut.run{animation:float 1s ease-in-out infinite}
.c-astronaut.run .la,.c-astronaut.run .lb,.c-astronaut.run .bd{animation:none}
.c-astronaut.run .ant{animation:blink 1s steps(1) infinite}
.c-astronaut.run .star{animation:blink .5s steps(1) infinite -.25s}
@keyframes float{50%{transform:translateY(-2px)}}@keyframes blink{50%{opacity:.15}}
.c-detective.run .it{animation:scan 1s steps(1) infinite}
.c-detective.run .gl{animation:blink 1s steps(1) infinite -.5s}
@keyframes scan{25%{transform:translate(-1px,1px)}50%{transform:translate(-2px,2px)}75%{transform:translate(-1px,1px)}}
.c-engineer.run .it{transform-origin:100% 100%;animation:twist .5s ease-in-out infinite}
@keyframes twist{50%{transform:rotate(-35deg)}}
.c-chef.run .pan{transform-origin:0 50%;animation:tilt 1s ease-in-out infinite}
.c-chef.run .egg{animation:flip 1s ease-in-out infinite}
@keyframes tilt{20%,40%{transform:rotate(-12deg)}}@keyframes flip{30%{transform:translateY(-5px) scaleY(-1)}60%{transform:translateY(0)}}
.c-racer.run .la{animation-duration:.25s}.c-racer.run .lb{animation-duration:.25s;animation-delay:-.125s}
.c-racer.run .flag{transform-origin:0 50%;animation:wave .25s steps(1) infinite}
@keyframes wave{50%{transform:skewY(-12deg) scaleX(.85)}}
.c-pirate.run .it{transform-origin:50% 100%;animation:fence .5s ease-in-out infinite}
@keyframes fence{50%{transform:rotate(25deg)}}
@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}
</style>`

const COSTUMES: Record<string, (f: Fill, t: string) => void> = {
  astronaut: (f, t) => {
    crabBody(f)
    f(6, 7, 18, 1, '#E6E8EE'); f(5, 8, 1, 14, '#E6E8EE'); f(24, 8, 1, 14, '#E6E8EE'); f(6, 22, 18, 1, '#C9CCD2')
    f(6, 8, 18, 14, 'rgba(169,214,245,.32)'); f(8, 9, 2, 1, '#fff'); f(8, 10, 1, 2, '#fff')
    f(14, 4, 2, 3, '#C9CCD2'); f(14, 2, 2, 2, t, 'ant'); f(13, 18, 4, 2, t)
    f(27, 3, 1, 3, '#F5C542', 'star'); f(26, 4, 3, 1, '#F5C542', 'star')
  },
  detective: (f, t) => {
    crabBody(f, -4, 'it')
    stamp(f, 6, 3, ['......bbbbbb......', '....bbcbbcbbbb....', '...bbbbbbbbbbbb...', '..bcbbcbbcbbcbbb..', '.bbbbbbbbbbbbbbbb.', 'dddddddddddddddddd'], { b: '#7A4A26', c: '#A0703F', d: '#5A3519' })
    f(6, 9, 18, 1, t)
    stamp(f, 23, 1, ['.kkk.', 'k...k', 'k...k', 'k...k', '.kkk.'], { k: '#3A3A3C' }, 'it')
    f(24, 2, 3, 3, 'rgba(169,214,245,.7)', 'it'); f(25, 6, 1, 4, '#7A4A26', 'it'); f(24, 2, 1, 1, '#fff', 'gl')
  },
  engineer: (f, t) => {
    crabBody(f)
    stamp(f, 6, 4, ['.....yyyyyyyy.....', '...yyyyyhhyyyyy...', '..yyyyyyhhyyyyyy..', '..yyyyyyhhyyyyyy..', '.yyyyyyyhhyyyyyyy.', 'dddddddddddddddddd'], { y: '#F5C542', h: '#FBE08A', d: '#C99A1E' })
    f(13, 5, 4, 2, t)
    stamp(f, 0, 10, ['.s.s', 'sss.', '.s..', '.s..'], { s: '#8E929A' }, 'it')
  },
  chef: (f, t) => {
    crabBody(f, -4, 'pan')
    stamp(f, 6, 0, ['........lll.......', '.......lllll......', '.wwwwgwwwwwwgwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwgwwwwwggwwwww', '.wwwwgwwwwwggwwwww', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.'], { w: '#F4F3EE', l: '#F7F6F2', g: '#D2D1C8', b: t, d: '#B45F43' })
    f(22, 8, 7, 2, '#4A4A48', 'pan'); f(26, 10, 1, 1, '#4A4A48', 'pan'); f(24, 7, 3, 1, '#F5B731', 'egg')
  },
  racer: (f, t) => {
    crabBody(f, -4)
    stamp(f, 6, 5, ['....rrrrrrrrrr....', '..rrrrrrwwrrrrrr..', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.kkkkkkkkkkkkkkkkr'], { r: t, w: '#F8F6F1', k: INK })
    f(25, 1, 1, 9, '#8E929A')
    stamp(f, 26, 1, ['wkwk', 'kwkw', 'wkwk'], { w: '#F8F6F1', k: INK }, 'flag')
  },
  pirate: f => {
    crabBody(f)
    stamp(f, 5, 3, ['.kk..............kk.', '.kkk....kkkk....kkk.', '..kkkkkkkwwkkkkkkk..', '..kkkkkkkkkkkkkkkk..', '.gggggggggggggggggg.'], { k: '#55514C', w: '#F8F6F1', g: '#F5C542' })
    f(7, 11, 11, 1, INK); f(18, 11, 4, 3, INK)
    f(27, 6, 1, 9, '#C9CCD2', 'it'); f(26, 15, 3, 1, '#7A4A26', 'it')
  },
  plain: f => crabBody(f),
}

const crab = (x: number, y: number, costume: string, isWalking: boolean, scale: number): string => {
  const groups = new Map<string, string[]>([['bd', []]])
  const f: Fill = (cx, cy, w, h, c, cls = 'bd') => {
    if (!groups.has(cls)) groups.set(cls, [])
    groups.get(cls)?.push(`<rect x="${cx}" y="${cy}" width="${w}" height="${h}" fill="${c}"/>`)
  }
  ;(COSTUMES[costume] ?? COSTUMES.plain!)(f, COSTUME_COLOR[costume] ?? COSTUME_COLOR.plain!)
  const group = (cls: string) => `<g class="${cls}">${(groups.get(cls) ?? []).join('')}</g>`
  const props = [...groups.keys()].filter(k => k !== 'bd' && k !== 'la' && k !== 'lb')
  const body = `<g class="bd">${(groups.get('bd') ?? []).join('')}${props.map(group).join('')}</g>`
  return `<g transform="translate(${x},${y}) scale(${scale})" shape-rendering="crispEdges"><g class="c-${costume}${isWalking ? ' run' : ''}">${body}${group('la')}${group('lb')}</g></g>`
}
