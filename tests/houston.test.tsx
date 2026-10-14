import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
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

let clock: MockClock

const world = (on: On, panes: Record<string, unknown>[] = [], agents: Record<string, string> = {}) => {
  const calls = { opens: 0, closes: 0 }
  clock = mock.clock(on)
  mock.store(on)
  on('ui.open', () => ((calls.opens += 1), { value: { isPlaced: true } }) as never)
  on('ui.close', () => ((calls.closes += 1), { value: undefined }) as never)
  on('ui.panes', () => ({ value: panes }) as never)
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('agent.list', () => ({ value: Object.entries(agents).map(([id, status]) => ({ id, status, type: 'general-purpose', description: `Agent ${id}` })) }) as never)
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

const typed = async ($: Engine, text: string, turnId: string) => {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
  return $.turn.start({ text, turnId })
}

const startJob = ($: Engine) => typed($, 'Build my landing page', 't1')

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
  const agents: Record<string, string> = { a1: 'running' }
  const calls = world(on, PLACED, agents)
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
  agents.a1 = 'completed'
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
  world(on, [], { a1: 'running' })
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
  await typed($, 'Fix my footer', 't2')
  expect(calls).toEqual({ opens: 2, closes: 0 })
  await $.command.run({ command: 'houston', args: 'off' } as never)
  await typed($, 'Fix my header', 't3')
  expect(calls).toEqual({ opens: 2, closes: 1 })
  await $.command.run({ command: 'houston', args: 'on' } as never)
  await typed($, 'Fix my menu', 't4')
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

type Surface = 'terminal' | 'desktop'

const seen = async ($: Engine, props: object, surface: Surface, key: string, name: string) => {
  const ui = (await $.ui.mount({ ...props, surface } as never)) as never as Drawing & { unmount: () => Promise<void> }
  const text = await row(ui, key, name)
  await ui.unmount()
  return text
}

const inBand = ($: Engine, surface: Surface, key: string, name = '') => seen($, BAND, surface, key, name)

const inPane = ($: Engine, surface: Surface, key: string, name = '') => seen($, PANE_ROWS as object, surface, key, name)

const finishTurn = ($: Engine, reason: 'answer' | 'aborted' | 'error') =>
  $.turn.complete({ reason, answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId: 't1' } as never)

const paneKeys = async ($: Engine) => {
  const ui = await $.ui.mount({ ...(PANE_ROWS as object), surface: 'terminal' } as never)
  const tree = (await ui.drawn()) as unknown as { children: { props: { key: string } }[] }
  await ui.unmount()
  return tree.children.map(child => child.props.key)
}

test('an aborted or errored turn leaves no step running and moves the live card to the Agents group', async ($, on) => {
  world(on, [], { a1: 'running' })
  spawned(on)
  on('turn.complete', () => ({ text: 'done' }))
  for (const reason of ['aborted', 'error'] as const) {
    await startJob($)
    await call($, PLAN, { steps: ['Read your brand notes', 'Build the pricing section', 'Add the contact form'] })
    await call($, PROGRESS, { task: 'Read your brand notes', percent: 100 })
    await spawn($, 'a1', 'Port the bars')
    expect(await inPane($, 'terminal', 'card-a1')).toContain('Port the bars')
    await finishTurn($, reason)
    expect(await inBand($, 'terminal', 'row-0')).toContain('✓')
    expect(await inBand($, 'terminal', 'row-1')).toContain('○')
    for (const key of ['row-1', 'row-2']) {
      expect(await inBand($, 'terminal', key)).not.toContain('▶')
      expect(await inPane($, 'terminal', key)).not.toContain('▶')
    }
    expect(await inBand($, 'terminal', 'agent-a1')).toContain('Port the bars')
    expect(await inPane($, 'terminal', 'card-a1')).toContain('Port the bars')
    expect(await paneKeys($)).toEqual(['header', 'row-0', 'row-1', 'row-2', 'agents', 'card-a1'])
  }
})

test('an answer with steps left says Needs you only when none of its subagents is working', async ($, on) => {
  const agents: Record<string, string> = { a1: 'running' }
  world(on, [], agents)
  spawned(on)
  on('turn.complete', () => ({ text: 'done' }))
  await startJob($)
  await call($, PLAN, { steps: ['Read the code', 'Build the view'] })
  await spawn($, 'a1', 'Port the bars')
  await finishTurn($, 'answer')
  expect(await inBand($, 'terminal', 'header')).not.toContain('Needs you')
  expect(await inBand($, 'terminal', 'row-0')).toContain('▶')
  agents.a1 = 'completed'
  await finishTurn($, 'answer')
  expect(await inBand($, 'terminal', 'header')).toContain('Needs you')
  expect(await inBand($, 'terminal', 'header')).toContain('Claude is waiting for your reply')
})

test('an agent the engine no longer lists draws no card, and the next turn drops what was tracked about it', async ($, on) => {
  const agents: Record<string, string> = { a1: 'running' }
  world(on, [], agents)
  spawned(on)
  await startJob($)
  await call($, PLAN, { steps: ['Read the code', 'Build the view'] })
  await spawn($, 'a1', 'Port the bars')
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await inBand($, surface, 'agent-a1', 'Port the bars')).toContain('Port the bars')
    expect(await inPane($, surface, 'card-a1', 'Port the bars')).toContain('Port the bars')
  }
  delete agents.a1
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await inBand($, surface, 'agent-a1', 'Port the bars')).toBeUndefined()
    expect(await inPane($, surface, 'card-a1', 'Port the bars')).toBeUndefined()
  }
  await typed($, 'Fix my footer', 't2')
  await call($, PLAN, { steps: ['Read the code', 'Build the view'] })
  agents.a1 = 'running'
  expect(await inBand($, 'terminal', 'agent-a1')).toContain('Agent a1')
  expect(await inBand($, 'terminal', 'agent-a1')).not.toContain('Port the bars')
})

test('a spawn that started no agent is not tracked', async ($, on) => {
  world(on, [], { 'tu-a1': 'running' })
  on('agent.spawn', () => ({ model: 'claude-opus-5-5' }) as never)
  await startJob($)
  await call($, PLAN, { steps: ['Read the code', 'Build the view'] })
  await spawn($, 'a1', 'Port the bars')
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(String(await inBand($, surface, 'agent-tu-a1', 'Port the bars'))).not.toContain('Port the bars')
    expect(String(await inPane($, surface, 'card-tu-a1', 'Port the bars'))).not.toContain('Port the bars')
  }
})

test('a subagent turn start leaves the checklist alone', async ($, on) => {
  world(on)
  await startJob($)
  await call($, PLAN, { steps: ['Read the code', 'Build the view'] })
  await $.turn.start({ text: 'brief', turnId: 'a1-turn', agentId: 'a1' })
  expect(await inBand($, 'terminal', 'row-0')).toContain('Read the code')
  expect(await inBand($, 'terminal', 'row-0')).toContain('▶')
  expect(await inBand($, 'terminal', 'row-1')).toContain('Build the view')
  expect(await inBand($, 'terminal', 'header')).toContain('Build my landing page')
})

test('a wake-up turn continues the open job instead of starting a new one', async ($, on) => {
  world(on)
  on('turn.complete', () => ({ text: 'done' }))
  await startJob($)
  await call($, PLAN, { steps: ['Read the code', 'Build the view'] })
  await $.turn.start({ text: 'a background task finished', turnId: 't2' })
  expect(await inBand($, 'terminal', 'row-0')).toContain('Read the code')
  expect(await inBand($, 'terminal', 'header')).toContain('Build my landing page')
  await finishTurn($, 'answer')
  expect(await inBand($, 'terminal', 'header')).toContain('Needs you')
  const notice = { text: '<task-notification>', wait: false, isMeta: true, origin: { kind: 'task-notification' } }
  await $.prompt.submit(notice as never)
  await $.turn.start({ text: notice.text, turnId: 't3' })
  expect(await inBand($, 'terminal', 'row-0')).toContain('Read the code')
  expect(await inBand($, 'terminal', 'header')).not.toContain('Needs you')
  expect(await inBand($, 'terminal', 'header')).toContain('Build my landing page')
})

test('a typed prompt after a finished job starts a new job, and a wake-up then leaves a finished one alone', async ($, on) => {
  world(on)
  on('turn.complete', () => ({ text: 'done' }))
  await startJob($)
  await call($, PLAN, { steps: ['Read the code', 'Build the view'] })
  await call($, PROGRESS, { task: 'Read the code', percent: 100 })
  await call($, PROGRESS, { task: 'Build the view', percent: 100 })
  await finishTurn($, 'answer')
  expect(await inBand($, 'terminal', 'header')).toContain('All done')
  await $.turn.start({ text: 'a background task finished', turnId: 't2' })
  expect(await inBand($, 'terminal', 'header')).toContain('All done')
  await typed($, 'Fix my footer', 't3')
  expect(await inBand($, 'terminal', 'header')).toContain('Fix my footer')
  expect(await inBand($, 'terminal', 'row-0')).toContain('Understand your request')
})

test('a live agent that never went through agent.spawn shows a card and its usage accrues', async ($, on) => {
  world(on, [], { bg1: 'running' })
  stepped(on)
  await startJob($)
  await call($, PLAN, { steps: ['Read the code', 'Build the view'] })
  expect(await inPane($, 'terminal', 'card-bg1')).toContain('general-purpose · —')
  expect(await inPane($, 'terminal', 'card-bg1')).toContain('0 tokens')
  await modelStep($, 'bg1')
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await inBand($, surface, 'agent-bg1', 'Agent bg1')).toContain('Agent bg1')
    for (const shows of ['Agent bg1', 'general-purpose', '12k tokens · ≈$0.08']) {
      expect(await inPane($, surface, 'card-bg1', 'Agent bg1')).toContain(shows)
    }
  }
})

test('an agent still live after every step is done sits in a trailing Agents group', async ($, on) => {
  world(on, [], { bg1: 'running' })
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'api-error', status: 500, error: 'server_error' } }) as never)
  on('turn.complete', () => ({ text: 'done' }))
  await startJob($)
  await call($, PLAN, { steps: ['Read the code', 'Build the view'] })
  await call($, PROGRESS, { task: 'Read the code', percent: 100 })
  await call($, PROGRESS, { task: 'Build the view', percent: 100 })
  await finishTurn($, 'answer')
  expect(await paneKeys($)).toEqual(['header', 'row-0', 'row-1', 'agents', 'card-bg1'])
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await inBand($, surface, 'agent-bg1', 'Agent bg1')).toContain('Agent bg1')
    expect(await inPane($, surface, 'card-bg1', 'Agent bg1')).toContain('Agent bg1')
  }
  expect(await inBand($, 'terminal', 'header')).toContain('All done')
  expect(await inBand($, 'terminal', 'agents')).toBe('Agents')
  await clock.advance(5000)
  expect(await inBand($, 'terminal', 'row-0')).toBeUndefined()
  expect(await inBand($, 'terminal', 'agents')).toBe('Agents')
  expect(await inBand($, 'terminal', 'agent-bg1')).toContain('Agent bg1')
})

test('with no checklist the pane shows the live agent, and nothing when none is live', async ($, on) => {
  const agents: Record<string, string> = { bg1: 'running' }
  world(on, [], agents)
  expect(await inPane($, 'terminal', 'agents')).toBe('Agents')
  expect(await inPane($, 'terminal', 'card-bg1')).toContain('Agent bg1')
  expect(await inBand($, 'terminal', 'agent-bg1')).toContain('Agent bg1')
  agents.bg1 = 'completed'
  const empty = await $.ui.mount({ ...(PANE_ROWS as object), surface: 'terminal' } as never)
  expect((await empty.find({ type: 'Text' }))?.text).toBe('Nothing running')
})

test('the pane keeps redrawing while an agent is live after the job ended', async ($, on) => {
  const agents: Record<string, string> = { bg1: 'running' }
  world(on, [], agents)
  on('turn.complete', () => ({ text: 'done' }))
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'api-error', status: 500, error: 'server_error' } }) as never)
  await startJob($)
  await call($, PLAN, { steps: ['Read the code', 'Build the view'] })
  await call($, PROGRESS, { task: 'Read the code', percent: 100 })
  await call($, PROGRESS, { task: 'Build the view', percent: 100 })
  await finishTurn($, 'answer')
  const ui = await $.ui.mount({ ...(PANE_ROWS as object), surface: 'terminal' } as never)
  expect((await ui.find({ key: 'card-bg1' }))?.text).toContain('· 0s')
  await clock.advance(1000)
  expect((await ui.find({ key: 'card-bg1' }))?.text).toContain('· 1s')
  agents.bg1 = 'completed'
  await clock.advance(250)
  expect(await ui.find({ key: 'card-bg1' })).toBeUndefined()
})

test('/houston test plays four steps with three pretend workers, then finishes', async ($, on) => {
  world(on, PLACED)
  expect((await $.command.run({ command: 'houston', args: 'test' } as never)).text).toContain('test run')
  expect(await inPane($, 'terminal', 'row-0')).toContain('Plan the work')
  await clock.advance(4000)
  expect(await inPane($, 'terminal', 'row-0')).toContain('Done')
  expect(await inPane($, 'terminal', 'row-1')).toContain('%')
  for (const lane of ['fetcher', 'researcher', 'implementer']) expect(await inPane($, 'terminal', `card-test:${lane}`)).toContain(lane)
  await clock.advance(5000)
  expect(await inPane($, 'terminal', 'card-test:fetcher')).toBeUndefined()
  await clock.advance(10000)
  expect(await inPane($, 'terminal', 'header')).toContain('All done')
  expect(await inPane($, 'terminal', 'card-test:implementer')).toBeUndefined()
})

test('a typed prompt during a test run stops it', async ($, on) => {
  world(on, PLACED)
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'api-error', status: 500, error: 'server_error' } }) as never)
  await $.command.run({ command: 'houston', args: 'test' } as never)
  await clock.advance(4000)
  await startJob($)
  await clock.advance(1000)
  expect(await inPane($, 'terminal', 'card-test:fetcher')).toBeUndefined()
  expect(await inPane($, 'terminal', 'row-0')).toContain('Understand your request')
})
