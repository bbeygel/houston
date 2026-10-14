import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { costOf, costumeOf } from '../hooks/drawing'
import { cleanName } from '../hooks/houston'

const PLAN = 'mcp__houston__plan_steps'
const PROGRESS = 'mcp__houston__report_progress'
const STEP = 'mcp__houston__step'
const BAND = {
  plugin: 'houston',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const PLACED = [{ id: 'houston', title: 'Houston', isShown: true, isFocused: false, isPlaced: true }]
const USAGE = { input_tokens: 9000, output_tokens: 2000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 400, model: 'claude-opus-5-5' }

const world = (on: On, panes: Record<string, unknown>[] = []) => {
  const calls = { opens: 0, closes: 0 }
  mock.clock(on)
  mock.store(on)
  on('ui.open', () => ((calls.opens += 1), { value: { isPlaced: true } }) as never)
  on('ui.close', () => ((calls.closes += 1), { value: undefined }) as never)
  on('ui.panes', () => ({ value: panes }) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('tool.call', (_$, e) => (e.tool === 'TodoWrite' ? { result: { oldTodos: [], newTodos: e.todos } } : { result: 'ok' }) as never)
  on('classic.Notification', () => ({}))
  return calls
}

type Drawing = {
  surface: string
  find: (q: { key: string }) => Promise<{ text: string } | undefined>
  findAll: (q: { type: string }) => Promise<{ props: Record<string, unknown> }[]>
}

// The desktop draws each row as one Svg, which keeps no key: find it by its alt text instead.
const row = async (ui: Drawing, key: string, name: string) =>
  ui.surface === 'terminal'
    ? (await ui.find({ key }))?.text
    : (await ui.findAll({ type: 'Svg' })).map(svg => String(svg.props.alt)).find(alt => alt.includes(name))

const startJob = ($: Engine) => $.turn.start({ text: 'Build my landing page', turnId: 't1' })

const call = ($: Engine, tool: string, input: Record<string, unknown>) => $.tool.call({ tool, ...input } as never)

test('names are cleaned to plain words', () => {
  expect(cleanName('Build the pricing section in `src/Pricing.tsx`')).toBe('Build the pricing section in')
  expect(cleanName('fix the header in src/components/Header.tsx today')).toBe('Fix the header in today')
  const long = cleanName('Rewrite the whole onboarding flow so new customers understand every single step')
  expect(long.length <= 40).toBe(true)
  expect(long.endsWith('…')).toBe(true)
  expect(cleanName('`npm test`')).toBe('Working on it')
})

test('agent lanes map to costumes', () => {
  expect(costumeOf('implementer')).toBe('engineer')
  expect(costumeOf('x:fetcher')).toBe('racer')
  expect(costumeOf('Explore')).toBe('pirate')
  expect(costumeOf('general-purpose')).toBe('plain')
})

test('cost is priced per million tokens by model', () => {
  const usage = { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  expect(costOf('claude-opus-5-5', usage)).toBe(24)
  expect(costOf('claude-opus-4-1', usage)).toBe(30)
  expect(costOf('unknown-model', usage)).toBe(24)
})

test('a to-do list plus a 60% report draws done, active, next and up next', async ($, on) => {
  world(on)
  await startJob($)
  await call($, 'TodoWrite', {
    todos: [
      { content: 'Read your brand notes', status: 'completed', activeForm: 'Reading' },
      { content: 'Build the pricing section', status: 'in_progress', activeForm: 'Building' },
      { content: 'Add the contact form', status: 'pending', activeForm: 'Adding' },
      { content: 'Polish the footer', status: 'pending', activeForm: 'Polishing' },
    ],
  })
  await call($, PROGRESS, { task: 'Build the pricing section', percent: 60 })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await row(ui, 'row-0', 'Read your brand notes')).toContain('✓')
    expect(await row(ui, 'row-0', 'Read your brand notes')).toContain('Done')
    expect(await row(ui, 'row-1', 'Build the pricing section')).toContain('▶')
    expect(await row(ui, 'row-1', 'Build the pricing section')).toContain('60%')
    expect(await row(ui, 'row-2', 'Add the contact form')).toContain('Next')
    expect(await row(ui, 'row-3', 'Polish the footer')).toContain('Up next')
    if (surface === 'terminal') expect((await ui.find({ key: 'row-1-meter' }))?.text).toBe('██████░░░░')
    await ui.unmount()
  }
})

const spawn = ($: Engine, agentId: string, description: string) =>
  $.agent.spawn({ subagentType: 'implementer', description, prompt: 'go', tool_use_id: `tu-${agentId}` } as never)

const PANE_ROWS = { plugin: 'houston', component: 'Pane', requestId: 'houston', props: { bodyColumns: 60 } } as never

const spawned = (on: On) =>
  on('agent.spawn', (_$, e) => ({ agentId: `a${e.tool_use_id.slice(-1)}`, model: 'claude-opus-5-5' }) as never)

const stepped = (on: On) =>
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE } as never
  })

const reportStep = ($: Engine, agentId: string, done: number, total: number) =>
  $.tool.call({ tool: STEP, agentId, done, total } as never)

const modelStep = async ($: Engine, agentId: string) => {
  const stream = $.turn.step({ turnId: `${agentId}-step`, index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1, agentId })
  while (!(await stream.next()).done);
}

test('a placed pane holds the whole checklist and the cards, and the band is one line', async ($, on) => {
  const calls = world(on, PLACED)
  spawned(on)
  stepped(on)
  on('turn.complete', () => ({ text: 'done' }))
  await startJob($)
  await call($, PLAN, { steps: ['Read the code', 'Build the view'] })
  await spawn($, 'a1', 'Port the bars')
  await reportStep($, 'a1', 3, 5)
  await modelStep($, 'a1')
  expect(calls.opens).toBe(1)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ key: 'header' }))?.text).toContain('Build my landing page')
  expect(await band.find({ key: 'row-0' })).toBeUndefined()
  expect(await row(band, 'agent-a1', 'Port the bars')).toBeUndefined()
  expect((await band.find({ key: 'toggle' }))?.text).toContain('ON')
  const desktopBand = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await desktopBand.findAll({ type: 'Svg' })).toHaveLength(0)
  const pane = await $.ui.mount({ ...(PANE_ROWS as object), surface: 'terminal' } as never)
  expect((await (pane as never as Drawing).find({ key: 'header' }))?.text).toContain('Build my landing page')
  expect(await row(pane as never, 'row-0', 'Read the code')).toContain('▶')
  expect(await row(pane as never, 'row-1', 'Build the view')).toContain('Next')
  const tree = (await pane.drawn()) as unknown as { children: { props: { key: string } }[] }
  expect(tree.children.map(child => child.props.key)).toEqual(['header', 'row-0', 'card-a1', 'row-1'])
  for (const shows of ['Port the bars', 'implementer · Opus 5.5 · high', '3/5', '12k tokens · ≈$0.08', '▐▛███▜▌']) {
    expect(await row(pane as never, 'card-a1', 'Port the bars')).toContain(shows)
  }
  const desktopPane = await $.ui.mount({ ...(PANE_ROWS as object), surface: 'desktop' } as never)
  expect(await row(desktopPane as never, 'row-0', 'Read the code')).toContain('▶')
  expect(await row(desktopPane as never, 'card-a1', 'Port the bars')).toContain('12k tokens · ≈$0.08')
  await $.turn.complete({ agentId: 'a1', reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 'a1-turn' })
  expect(await row(pane as never, 'card-a1', 'Port the bars')).toBeUndefined()
  expect(calls.closes).toBe(0)
})

test('the pane says Nothing running before any job', async ($, on) => {
  world(on, PLACED)
  const pane = await $.ui.mount({ ...(PANE_ROWS as object), surface: 'terminal' } as never)
  expect((await pane.find({ type: 'Text' }))?.text).toBe('Nothing running')
})

test('with no pane placed the step rows and the compact agent row stay in the band', async ($, on) => {
  world(on)
  spawned(on)
  await startJob($)
  await call($, PLAN, { steps: ['Read the code', 'Build the view'] })
  await spawn($, 'a1', 'Port the bars')
  await reportStep($, 'a1', 3, 5)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await row(ui, 'row-0', 'Read the code')).toContain('▶')
    expect(await row(ui, 'agent-a1', 'Port the bars')).toContain('Port the bars')
    expect(await row(ui, 'agent-a1', 'Port the bars')).toContain('3/5')
    expect(await row(ui, 'card-a1', '12k tokens')).toBeUndefined()
    await ui.unmount()
  }
})

test('each job opens the pane, Houston off closes it and a job while off leaves it shut', async ($, on) => {
  const calls = world(on, PLACED)
  await startJob($)
  await $.turn.start({ text: 'Fix my footer', turnId: 't2' })
  expect(calls).toEqual({ opens: 2, closes: 0 })
  await $.command.run({ command: 'houston', args: 'off' } as never)
  await $.turn.start({ text: 'Fix my header', turnId: 't3' })
  expect(calls).toEqual({ opens: 2, closes: 1 })
  await $.command.run({ command: 'houston', args: 'on' } as never)
  await $.turn.start({ text: 'Fix my menu', turnId: 't4' })
  expect(calls).toEqual({ opens: 3, closes: 1 })
})

test('a permission prompt shows Needs you', async ($, on) => {
  world(on)
  await startJob($)
  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ key: 'header' }))?.text).toContain('Needs you')
  expect((await ui.find({ key: 'row-0' }))?.text).toContain('‖')
})

test('/houston off hides the checklist and keeps the button', async ($, on) => {
  world(on)
  await startJob($)
  await $.command.run({ command: 'houston', args: 'off' } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'row-0' })).toBeUndefined()
  expect((await ui.find({ key: 'toggle' }))?.text).toContain('OFF')
  await ui.press({ key: 'toggle' })
  expect((await ui.find({ key: 'row-0' }))?.text).toContain('▶')
})

test('the step tool is ignored outside a subagent', async ($, on) => {
  world(on)
  await startJob($)
  expect((await call($, STEP, { done: 1, total: 2 })).result).toBe('ignored: only subagents report steps')
})

test('reporting 100 checks off step one and starts step two', async ($, on) => {
  world(on)
  await startJob($)
  const planned = await call($, PLAN, { steps: ['Read your brand notes', 'Build the pricing section', 'Add the contact form'] })
  expect(planned.result).toBe('Planned 3 steps. The first one has started.')
  const noted = await call($, PROGRESS, { task: 'Read your brand notes', percent: 100 })
  expect(noted.result).toBe('Progress noted: 100%.')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ key: 'row-0-label' }))?.text).toBe('Done')
  expect((await ui.find({ key: 'row-1' }))?.text).toContain('▶')
  expect((await ui.find({ key: 'row-2-label' }))?.text).toBe('Next')
})

test('a tool is denied once before a plan exists and allowed after', async ($, on) => {
  world(on)
  await startJob($)
  expect((await call($, 'Bash', { command: 'ls', description: 'list' })).deny).toBeDefined()
  expect((await call($, 'ToolSearch', { query: 'select:x', max_results: 1 })).deny).toBeUndefined()
  await call($, PLAN, { steps: ['Read your brand notes', 'Build the pricing section'] })
  expect((await call($, 'Bash', { command: 'ls', description: 'list' })).deny).toBeUndefined()
})

test('the reminder is given once, then work goes on with a fallback row', async ($, on) => {
  world(on)
  await startJob($)
  expect((await call($, 'Bash', { command: 'ls', description: 'list' })).deny).toBeDefined()
  expect((await call($, 'Bash', { command: 'ls', description: 'list' })).deny).toBeUndefined()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ key: 'row-0' }))?.text).toContain('Working on it')
  expect(await ui.find({ key: 'row-1' })).toBeUndefined()
})
