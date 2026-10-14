import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, On, Timer } from 'claude-code'

import type { Checklist, ChecklistTask, RunningAgent, TaskStatus } from '../types'
import { ACCENT, AGENT_H, CARD_H, CLAY, DONE, IDLE, STEP_H, WAIT, agentSvg, cardSvg, colorOf, costOf, fmtCost, fmtTokens, laneOf, modelName, stepSvg } from './drawing'

type $ = EngineInterface

const PLUGIN = 'houston'
const PLAN_TOOL = `mcp__${PLUGIN}__plan_steps`
const PROGRESS_TOOL = `mcp__${PLUGIN}__report_progress`
const STEP_TOOL = `mcp__${PLUGIN}__step`
const ALWAYS_ALLOWED = new Set(['ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'AskUserQuestion'])
const METER = 10
const MAX_NAME = 40
const FALLBACK_ID = 'fallback'
const PLACEHOLDER_PREFIX = 'placeholder:'
const LIVE_STATUSES = new Set(['pending', 'running', 'waiting'])
const WAKE_ORIGINS = new Set(['task-notification', 'auto-continuation'])

const enabled = atom({ plugin: 'houston', key: 'enabled' } as const, true)
const checklist = atom({ plugin: 'houston', key: 'checklist' } as const, null)
const tick = atom({ plugin: 'houston', key: 'tick' } as const, 0)
const isPaneDismissed = atom({ plugin: 'houston', key: 'isPaneDismissed' } as const, false)
const running = atom({ plugin: 'houston', key: 'running' } as const, [])
const PANE = 'houston'

const CODE_FILE = /[\w.-]+\.(tsx?|jsx?|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|json|ya?ml|toml|md|sh|sql|css|scss|html|lock|txt|env)\b/gi

export const cleanName = (raw: string): string => {
  const text = raw
    .replace(/`[^`]*`/g, ' ')
    .replace(/\S*\/\S*/g, ' ')
    .replace(CODE_FILE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return 'Working on it'
  const name = text[0]!.toUpperCase() + text.slice(1)
  if (name.length <= MAX_NAME) return name
  const cut = name.slice(0, MAX_NAME - 1)
  const space = cut.lastIndexOf(' ')
  return (space > 0 ? cut.slice(0, space) : cut).trimEnd() + '…'
}

const makeTask = (id: string, name: string, status: TaskStatus): ChecklistTask => ({
  id,
  name: cleanName(name),
  status,
  percent: status === 'done' ? 100 : 0,
  hasReported: false,
})

const finish = (task: ChecklistTask): ChecklistTask => ({ ...task, status: 'done', percent: 100 })

const isReal = (task: ChecklistTask) => task.id !== FALLBACK_ID && !task.id.startsWith(PLACEHOLDER_PREFIX)

const hasPlan = (c: Checklist) => c.tasks.some(isReal)

const rested = (tasks: ChecklistTask[]): ChecklistTask[] => tasks.map(t => (t.status === 'active' ? { ...t, status: 'upcoming' } : t))

const withOneActive = (tasks: ChecklistTask[]): ChecklistTask[] => {
  if (tasks.some(t => t.status === 'active')) return tasks
  const next = tasks.findIndex(t => t.status !== 'done')
  return tasks.map((t, i) => (i === next ? { ...t, status: 'active' } : t))
}

const planned = (steps: readonly string[]): ChecklistTask[] =>
  withOneActive(steps.slice(0, 8).map((step, i) => makeTask(`plan:${i}`, step, 'upcoming')))

const reported = (tasks: ChecklistTask[], rawName: string, percent: number): ChecklistTask[] => {
  const name = cleanName(rawName)
  const real = tasks.filter(isReal)
  const found = real.findIndex(t => t.name.toLowerCase() === name.toLowerCase())
  const at = found >= 0 ? found : (i => (i < 0 ? real.length : i))(real.findIndex(t => t.status !== 'done'))
  const list = found >= 0 ? real : [...real.slice(0, at), makeTask(`report:${name}`, name, 'upcoming'), ...real.slice(at)]
  const moved = list.map((t, i): ChecklistTask => {
    if (i < at) return finish(t)
    if (i === at) return percent >= 100 ? finish(t) : { ...t, status: 'active', percent, hasReported: true }
    return t.status === 'active' ? { ...t, status: 'upcoming' } : t
  })
  return withOneActive(moved)
}

const fromTodos = (todos: readonly { content: string; status: string }[]): ChecklistTask[] =>
  withOneActive(
    todos.map((todo, i) =>
      makeTask(`todo:${i}`, todo.content, todo.status === 'completed' ? 'done' : todo.status === 'in_progress' ? 'active' : 'upcoming'),
    ),
  )

const newJob = (prompt: string, now: number): Checklist => ({
  title: shortTitle(prompt),
  phase: 'working',
  tasks: [
    { ...makeTask(`${PLACEHOLDER_PREFIX}0`, 'Understand your request', 'active') },
    makeTask(`${PLACEHOLDER_PREFIX}1`, 'Plan the steps', 'upcoming'),
  ],
  needsYouReason: null,
  stuckReason: null,
  startedAt: now,
  finishedAt: null,
  isCollapsed: false,
})

const shortTitle = (text: string) => cleanName(text.split(/\s+/).slice(0, 6).join(' '))

const API_ERRORS: [RegExp, string][] = [
  [/rate_limit|billing_error/, 'you hit your usage limit, try again a little later'],
  [/overloaded|server_error/, "Claude's servers are busy, try again in a minute"],
  [/too long|context/i, 'type /compact and try again'],
  [/network|connect|socket|fetch failed|timed? ?out/i, 'the internet connection dropped'],
  [/authentication_failed|oauth_org_not_allowed|cloud_credential_error/, 'type /login'],
]

const calmError = (kind: string, details = '') =>
  API_ERRORS.find(([pattern]) => pattern.test(`${kind} ${details}`))?.[1] ?? 'something went wrong, try again'

const formatDuration = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const meterFor = (task: ChecklistTask, frame: number) => {
  if (task.status === 'done') return '█'.repeat(METER)
  if (task.status === 'upcoming') return '░'.repeat(METER)
  if (task.hasReported) {
    const filled = Math.round(task.percent / 10)
    return '█'.repeat(filled) + '░'.repeat(METER - filled)
  }
  const head = frame % METER
  return Array.from({ length: METER }, (_, i) => ((i - head + METER) % METER < 3 ? '█' : '░')).join('')
}

const fit = (name: string, width: number) =>
  name.length > width ? name.slice(0, Math.max(1, width - 1)) + '…' : name.padEnd(width)

let ticker: Timer | undefined
let remindedFor: number | undefined
let failStreak = 0
let lastWasCommand = false
let lastWasTyped = false
let apiError: string | undefined

const syncTicker = async ($: $, c: Checklist | null) => {
  const isLive = (c !== null && (c.phase === 'working' || c.phase === 'needsYou')) || (await listedLive($)).length > 0
  if (isLive && !ticker) ticker = $.clock.every(250, () => void pulse($))
  if (!isLive && ticker) {
    ticker.cancel()
    ticker = undefined
  }
}

const resync = async ($: $) => syncTicker($, await read($, checklist))

const pulse = async ($: $) => {
  await update($, tick, n => n + 1)
  await resync($)
}

const setChecklist = async ($: $, change: (c: Checklist) => Checklist) =>
  syncTicker($, await update($, checklist, c => c && change(c)))

const startJob = async ($: $, prompt: string) => {
  const startedAt = await $.clock.now()
  failStreak = 0
  apiError = undefined
  await syncTicker($, await update($, checklist, () => newJob(prompt, startedAt)))
  if ((await read($, enabled)) && !(await read($, isPaneDismissed))) void $.ui.open({ id: PANE, title: 'Houston' })
  $.clock.after(0, () => void nameJob($, prompt, startedAt))
}

const nameJob = async ($: $, prompt: string, startedAt: number) => {
  const reply = await $.model.complete({
    model: 'haiku',
    effort: 'low',
    maxTokens: 20,
    prompt: `Name this job in 2 to 6 plain words a non-technical person understands, starting with a verb. Reply with the name only.\n\nJob: ${prompt.slice(0, 2000)}`,
  })
  if (!reply.isAnswered) return
  await setChecklist($, c => (c.startedAt === startedAt ? { ...c, title: cleanName(reply.text.replace(/["'.]/g, '')) } : c))
}

const needsYou = ($: $, reason: string) =>
  setChecklist($, c => (c.finishedAt === null ? { ...c, phase: 'needsYou', needsYouReason: reason } : c))

const backToWork = ($: $) =>
  setChecklist($, c =>
    c.phase === 'needsYou' || c.phase === 'stuck' ? { ...c, phase: 'working', needsYouReason: null, stuckReason: null } : c,
  )

const stuck = ($: $, reason: string) =>
  setChecklist($, c => ({ ...c, phase: 'stuck', stuckReason: reason, needsYouReason: null }))

const end = async ($: $, change: (c: Checklist) => Checklist) => {
  const finishedAt = await $.clock.now()
  await setChecklist($, c => change({ ...c, finishedAt }))
}

const seenAt = new Map<string, number>()

const firstSeen = (id: string, now: number) => seenAt.get(id) ?? (seenAt.set(id, now), now)

const fromInfo = (info: Pick<AgentInfo, 'id' | 'type' | 'description'>, startedAt: number): RunningAgent => ({
  id: info.id,
  type: info.type,
  description: info.description,
  startedAt,
  model: '',
  tokens: 0,
  costUsd: 0,
})

const track = async ($: $, id: string, change: (a: RunningAgent) => RunningAgent) => {
  const info = (await $.agent.list()).find(a => a.id === id) ?? { id, type: '', description: '' }
  const entry = fromInfo(info, firstSeen(id, await $.clock.now()))
  await update($, running, list => (list.some(a => a.id === id) ? list : [...list, entry]).map(a => (a.id === id ? change(a) : a)))
  await resync($)
}

const listedLive = async ($: $) => (await $.agent.list()).filter(a => LIVE_STATUSES.has(a.status))

const liveAgents = async ($: $) => {
  const tracked = new Map((await read($, running)).map(a => [a.id, a] as const))
  const now = await $.clock.now()
  return [...(await listedLive($)).map(info => tracked.get(info.id) ?? fromInfo(info, firstSeen(info.id, now))), ...simulated]
}

const TEST_STEPS = ['Plan the work', 'Send out three workers', 'Check the results', 'Wrap up']
const TEST_SPANS = [3000, 9000, 4000, 2000]
const TEST_WORKERS = [
  { type: 'fetcher', description: 'Look up the facts', model: 'claude-haiku-5-5', effort: 'low', finishesAt: 0.6, usdPerToken: 0.000001 },
  { type: 'researcher', description: 'Dig into the details', model: 'claude-opus-5-5', effort: 'high', finishesAt: 0.8, usdPerToken: 0.000015 },
  { type: 'implementer', description: 'Draft the change', model: 'claude-sonnet-5-5', effort: 'medium', finishesAt: 1, usdPerToken: 0.000003 },
]
const TEST_WORKER_STEPS = 3

export const testFrame = (elapsed: number, startedAt: number) => {
  const starts = TEST_SPANS.map((_, i) => TEST_SPANS.slice(0, i).reduce((a, b) => a + b, 0))
  const at = starts.findLastIndex(s => elapsed >= s)
  const within = elapsed - starts[at]!
  const isDone = elapsed >= starts.at(-1)! + TEST_SPANS.at(-1)!
  const tasks = TEST_STEPS.map((name, i): ChecklistTask => {
    if (isDone || i < at) return finish(makeTask(`plan:${i}`, name, 'done'))
    if (i > at) return makeTask(`plan:${i}`, name, 'upcoming')
    return { ...makeTask(`plan:${i}`, name, 'active'), percent: Math.round((100 * within) / TEST_SPANS[i]!), hasReported: true }
  })
  const agents = at !== 1 || isDone ? [] : TEST_WORKERS.flatMap((w, j): RunningAgent[] => {
    const stepDone = Math.min(TEST_WORKER_STEPS, Math.floor((TEST_WORKER_STEPS * within) / (TEST_SPANS[1]! * w.finishesAt)))
    const tokens = Math.round(within * (j + 1) * 4)
    return stepDone >= TEST_WORKER_STEPS ? [] : [{
      id: `test:${w.type}`,
      type: w.type,
      description: w.description,
      startedAt: startedAt + starts[1]!,
      model: w.model,
      effort: w.effort,
      tokens,
      costUsd: tokens * w.usdPerToken,
      stepDone,
      stepTotal: TEST_WORKER_STEPS,
    }]
  })
  return { tasks, agents, isDone }
}

let simulated: RunningAgent[] = []
let testTimer: Timer | undefined

const stopTest = () => {
  testTimer?.cancel()
  testTimer = undefined
  simulated = []
}

const runTest = async ($: $) => {
  stopTest()
  const startedAt = await $.clock.now()
  await syncTicker($, await update($, checklist, () => ({ ...newJob('Houston test run', startedAt), tasks: testFrame(0, startedAt).tasks })))
  if ((await read($, enabled)) && !(await read($, isPaneDismissed))) void $.ui.open({ id: PANE, title: 'Houston' })
  testTimer = $.clock.every(250, () => void playTest($, startedAt))
}

const playTest = async ($: $, startedAt: number) => {
  if ((await read($, checklist))?.startedAt !== startedAt) return stopTest()
  const frame = testFrame((await $.clock.now()) - startedAt, startedAt)
  simulated = frame.agents
  if (!frame.isDone) return setChecklist($, c => ({ ...c, tasks: frame.tasks }))
  stopTest()
  await end($, c => ({ ...c, phase: 'done', tasks: frame.tasks }))
  $.clock.after(5000, () => void setChecklist($, x => (x.startedAt === startedAt && x.phase === 'done' ? { ...x, isCollapsed: true } : x)))
}

const setEnabled = async ($: $, value: boolean) => {
  await update($, enabled, () => value)
  await $.store.set('enabled', value)
  if (value) await update($, isPaneDismissed, () => false)
  else void $.ui.close({ id: PANE })
  $.ui.toast(value ? 'Houston is on: technical details are hidden' : 'Houston is off: showing everything')
}

export const registerHouston = (on: On) => {
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('enabled')
    if (typeof saved === 'boolean') await update($, enabled, () => saved)
    await $.tool.register({
      name: 'plan_steps',
      description:
        'Lay out every step of the job up front: 2 to 8 short plain-English step names, in order, each starting with a verb. The first step starts right away.',
      inputSchema: {
        type: 'object',
        properties: { steps: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 8 } },
        required: ['steps'],
      },
    })
    await $.tool.register({
      name: 'report_progress',
      description:
        'Report progress on the current step by its plain-English name. Send 100 the moment a step finishes; the next one then starts.',
      inputSchema: {
        type: 'object',
        properties: { task: { type: 'string' }, percent: { type: 'number', minimum: 0, maximum: 100 } },
        required: ['task', 'percent'],
      },
    })
    await $.tool.register({
      name: 'step',
      description:
        'For subagents: report progress on your own task to the Houston pane. Right after reading the brief, call it with `total` (your plan in 3-8 steps) and `done: 0`; call it again as each step finishes.',
      inputSchema: {
        type: 'object',
        properties: { done: { type: 'integer' }, total: { type: 'integer', minimum: 1 }, note: { type: 'string' } },
        required: ['done'],
      },
    })
    await $.command.register({
      name: 'houston',
      description: 'Turn Houston on or off, or play a test run',
      argumentHint: '[on|off|test]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'houston' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'test') {
      await runTest($)
      return { text: 'Houston test run: 4 steps and 3 pretend workers, about 18 seconds. No model calls.' }
    }
    const value = arg === 'on' ? true : arg === 'off' ? false : !(await read($, enabled))
    await setEnabled($, value)
    return { text: `Houston is ${value ? 'on' : 'off'}.` }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await read($, enabled))) return composed
    const text = [
      '# Houston',
      'The person sees a short checklist of your work instead of tool calls.',
      `- For every request, even a quick question, call \`${PLAN_TOOL}\` first with 2 to 8 steps (load it with ToolSearch if it is deferred). If this session has TodoWrite or TaskCreate, your to-do list can be the plan instead.`,
      `- Call \`${PROGRESS_TOOL}\` as real progress happens, and with 100 the moment a step finishes.`,
      '- Write every step name in plain English a non-technical person understands, under 40 characters, starting with a verb, like "Build the pricing section".',
      '- Never put file paths, file names, commands, code or tool names in a step name.',
    ].join('\n')
    return { ...composed, sections: [...composed.sections, { id: 'houston:checklist', text, scope: 'session' }] }
  })

  on('prompt.submit', ($, e, next) => {
    lastWasCommand = e.text.trimStart().startsWith('/')
    lastWasTyped = e.isMeta !== true && !WAKE_ORIGINS.has(e.origin.kind)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const alive = new Set((await listedLive($)).map(a => a.id))
    await update($, running, list => list.filter(a => alive.has(a.id)))
    const isCommand = lastWasCommand
    const isTyped = lastWasTyped
    lastWasCommand = false
    lastWasTyped = false
    if (e.text === '' || isCommand) return next(e)
    const current = await read($, checklist)
    const isOpen = current?.tasks.some(t => isReal(t) && t.status !== 'done') === true
    if (isOpen && (!isTyped || current?.phase === 'needsYou')) await setChecklist($, c => ({ ...c, phase: 'working', needsYouReason: null, finishedAt: null }))
    else if (isTyped) await startJob($, e.text)
    return next(e)
  })

  on('tool.call', { tool: PLAN_TOOL }, async ($, e) => {
    const steps = Array.isArray(e.steps) ? e.steps.filter((s): s is string => typeof s === 'string') : []
    if (steps.length === 0) return { deny: 'plan_steps needs 2 to 8 step names.' }
    await setChecklist($, c => ({ ...c, tasks: planned(steps) }))
    return { result: `Planned ${Math.min(steps.length, 8)} steps. The first one has started.` }
  })

  on('tool.call', { tool: PROGRESS_TOOL }, async ($, e) => {
    const percent = Math.min(100, Math.max(0, Math.round(Number(e.percent) || 0)))
    await setChecklist($, c => ({ ...c, tasks: reported(c.tasks, String(e.task ?? ''), percent) }))
    return { result: `Progress noted: ${percent}%.` }
  })

  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    if (e.agentId === undefined) return { result: 'ignored: only subagents report steps' }
    const total = Math.round(Number(e.total))
    await track($, e.agentId, a => ({
      ...a,
      stepDone: Math.max(0, Math.round(Number(e.done) || 0)),
      stepTotal: total >= 1 ? total : a.stepTotal,
      stepNote: typeof e.note === 'string' ? e.note : undefined,
    }))
    return { result: 'ok' }
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || String(e.tool).startsWith(`mcp__${PLUGIN}__`)) return next(e)
    const c = await read($, checklist)
    const isGated = (await read($, enabled)) && c !== null && c.finishedAt === null && !hasPlan(c)
    if (isGated && !ALWAYS_ALLOWED.has(e.tool) && remindedFor !== c.startedAt) {
      remindedFor = c.startedAt
      return { deny: `Call ${PLAN_TOOL} first to lay out the steps of this job (load it with ToolSearch if it is deferred), then continue.` }
    }
    if (isGated && !ALWAYS_ALLOWED.has(e.tool)) {
      await setChecklist($, x => (hasPlan(x) ? x : { ...x, tasks: [makeTask(FALLBACK_ID, 'Working on it', 'active')] }))
    }
    if (e.tool === 'AskUserQuestion') await needsYou($, 'Claude has a question for you')
    else await backToWork($)

    const ran = await next(e)

    if (ran.deny === undefined && ran.isError !== true) {
      if (e.tool === 'TodoWrite') await setChecklist($, x => ({ ...x, tasks: fromTodos(e.todos) }))
      const created = ran.result as { task?: { id?: string } } | undefined
      if (e.tool === 'TaskCreate' && created?.task?.id) {
        const id = `task:${created.task.id}`
        await setChecklist($, x => ({ ...x, tasks: withOneActive([...x.tasks.filter(isReal), makeTask(id, e.subject, 'upcoming')]) }))
      }
      if (e.tool === 'TaskUpdate' && e.status) {
        const id = `task:${e.taskId}`
        const status = e.status
        await setChecklist($, x => ({
          ...x,
          tasks: withOneActive(
            x.tasks.flatMap(t => {
              if (t.id !== id) return [t]
              if (status === 'deleted') return []
              return [status === 'completed' ? finish(t) : { ...t, status: status === 'in_progress' ? 'active' : 'upcoming' }]
            }),
          ),
        }))
      }
    }

    const isRefused = ran.isError === true && /doesn't want to proceed|rejected|denied by the user|user (said|declined)/i.test(ran.text ?? '')
    if (isRefused) {
      await stuck($, 'you said no to a step, so Claude paused')
    } else if (ran.isError === true) {
      failStreak += 1
      if (failStreak >= 3) await stuck($, 'a step keeps failing, Claude is trying another way')
      else await backToWork($)
    } else if (ran.deny === undefined) {
      failStreak = 0
      await backToWork($)
    }
    return ran
  })

  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type === 'permission_prompt') await needsYou($, 'Claude needs your OK to continue')
    if (e.notification_type === 'elicitation_dialog') await needsYou($, 'Claude has a question for you')
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    apiError = calmError(e.error, e.error_details)
    await setChecklist($, c => (c.phase === 'stuck' && c.finishedAt !== null ? { ...c, stuckReason: apiError ?? null } : c))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      await update($, running, list => list.filter(a => a.id !== e.agentId))
      return next(e)
    }
    switch (e.reason) {
      case 'error':
        await end($, c => ({ ...c, phase: 'stuck', tasks: rested(c.tasks), stuckReason: apiError ?? 'something went wrong, try again', needsYouReason: null }))
        break
      case 'refusal':
        await end($, c => ({ ...c, phase: 'stuck', tasks: rested(c.tasks), stuckReason: "Claude couldn't help with that request", needsYouReason: null }))
        break
      case 'aborted':
        await end($, c => ({ ...c, phase: 'stopped', tasks: rested(c.tasks), needsYouReason: null }))
        break
      case 'answer': {
        const c = await read($, checklist)
        if (c?.tasks.some(t => isReal(t) && t.status !== 'done')) {
          const isDelegating = (await listedLive($)).length > 0
          await setChecklist($, x =>
            isDelegating
              ? { ...x, phase: 'working', needsYouReason: null }
              : { ...x, phase: 'needsYou', needsYouReason: 'Claude is waiting for your reply' },
          )
          break
        }
        await end($, x => ({ ...x, phase: 'done', tasks: x.tasks.map(finish), needsYouReason: null, stuckReason: null }))
        const startedAt = c?.startedAt
        $.clock.after(5000, () => void setChecklist($, x => (x.startedAt === startedAt && x.phase === 'done' ? { ...x, isCollapsed: true } : x)))
      }
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined || started.agentId === undefined) return started
    const agent = {
      id: started.agentId,
      type: e.subagentType,
      description: e.description,
      startedAt: await $.clock.now(),
      model: started.model,
      tokens: 0,
      costUsd: 0,
    }
    await update($, running, list => [...list.filter(a => a.id !== agent.id), agent])
    await resync($)
    return started
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (!e.agentId || !usage) return result
    const tokens = usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
    const model = usage.model || e.model
    await track($, e.agentId, a => ({
      ...a,
      model,
      effort: typeof e.effort === 'string' ? e.effort : a.effort,
      tokens: a.tokens + tokens,
      costUsd: a.costUsd + costOf(model, usage),
    }))
    return result
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    if (e.origin.kind === 'person') await update($, isPaneDismissed, () => true)
    return closed
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const c = await read($, checklist)
    const cards = await workerCards($, ui, e.surface, e.props.bodyColumns, await liveAgents($))
    if (c === null) return cards.length === 0 ? <ui.Text dimColor>Nothing running</ui.Text> : <ui.Box flexDirection="column">{agentGroup(ui, cards)}</ui.Box>
    return (
      <ui.Box flexDirection="column">
        <ui.Box key="header">{headerFor(ui.Text, c, await $.clock.now())}</ui.Box>
        {stepRows(ui, e.surface, e.props.bodyColumns, c, await read($, tick), cards)}
      </ui.Box>
    )
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => ((await read($, enabled)) ? hidden($, e) : next(e)))
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => ((await read($, enabled)) ? hidden($, e) : next(e)))
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => ((await read($, enabled)) ? hidden($, e) : next(e)))
  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) =>
    (await read($, enabled)) ? next({ ...e, props: { ...e.props, hint: '' } }) : next(e),
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const isOn = await read($, enabled)
    const c = isOn ? await read($, checklist) : null
    const frame = await read($, tick)
    const now = await $.clock.now()

    const button = (
      <Button
        key="toggle"
        plain
        label={isOn ? '● Houston: ON' : '○ Houston: OFF'}
        onPress={() => setEnabled($, !isOn)}
      />
    )
    const header = <Box key="header">{c === null ? <Text> </Text> : headerFor(Text, c, now)}</Box>

    const pane = (await $.ui.panes()).find(p => p.id === PANE)
    const inPane = pane?.isPlaced === true && pane.isShown

    const below = isOn && !inPane ? await agentRows($, ui, e.surface, e.props.bodyColumns, await liveAgents($), 2) : []
    const top = (
      <Box flexDirection="row" justifyContent="space-between">
        {header}
        {button}
      </Box>
    )
    const rows = c === null || c.isCollapsed || inPane ? agentGroup(ui, below) : stepRows(ui, e.surface, e.props.bodyColumns, c, frame, below)
    return rows.length === 0 ? top : (
      <Box flexDirection="column">
        {top}
        {rows}
      </Box>
    )
  })
}

type Ui = ReturnType<$['ui']['resolve']>

const stepRows = (ui: Ui, surface: string, cols: number, c: Checklist, frame: number, below: Awaited<ReturnType<typeof agentRows>>) => {
  const { Box, Text } = ui
  const Svg = surface === 'desktop' && 'Svg' in ui ? ui.Svg : undefined
  const W = Math.max(180, Math.min(1600, cols * 8 - 16))
  const nameWidth = Math.max(8, cols - (2 + 1 + METER + 2 + 7))
  const firstUpcoming = c.tasks.findIndex(t => t.status === 'upcoming')
  const rows = c.tasks.flatMap((task, i) => {
    const icon = task.status === 'done' ? '✓' : task.status === 'active' ? (c.phase === 'needsYou' ? '‖' : '▶') : '○'
    const label =
      task.status === 'done'
        ? 'Done'
        : task.status === 'active'
          ? task.hasReported
            ? `${task.percent}%`
            : 'Working'
          : i === firstUpcoming
            ? 'Next'
            : 'Up next'
    const tone = toneFor(task.status, c.phase)
    const under = task.status === 'active' ? below : []
    if (Svg) {
      const fill = task.status === 'done' ? 1 : task.status === 'upcoming' ? 0 : task.hasReported ? task.percent / 100 : null
      const step = { key: `s${i}`, icon, name: task.name, fill, label, color: tone, isUpcoming: task.status === 'upcoming', isActive: task.status === 'active' }
      return [<Svg key={`row-${i}`} source={stepSvg(W, step)} alt={`${icon} ${task.name}: ${label}`} width={W} height={STEP_H} />, ...under]
    }
    const meter = <Text color={tone}>{meterFor(task, frame)}</Text>
    return [
      <Box key={`row-${i}`} flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text color={tone}>{icon}</Text>
        </Box>
        <Box width={nameWidth} flexShrink={0}>
          <Text bold={task.status === 'active'} dimColor={task.status === 'upcoming'} color={task.status === 'active' ? tone : undefined} wrap="truncate-end">
            {fit(task.name, nameWidth)}
          </Text>
        </Box>
        <Box key={`row-${i}-meter`} width={METER} height={1} flexShrink={0} flexDirection="row" marginX={1}>
          {meter}
        </Box>
        <Box key={`row-${i}-label`}>
          <Text bold={task.status === 'active'} dimColor={label === 'Up next'} color={tone}>{label}</Text>
        </Box>
      </Box>,
      ...under,
    ]
  })
  return c.tasks.some(t => t.status === 'active') ? rows : [...rows, ...agentGroup(ui, below)]
}

const agentGroup = ({ Box, Text }: Ui, rows: Awaited<ReturnType<typeof agentRows>>) =>
  rows.length === 0 ? [] : [<Box key="agents"><Text dimColor>Agents</Text></Box>, ...rows]

const agentRows = async ($: $, ui: Ui, surface: string, cols: number, list: readonly RunningAgent[], indent = 0) => {
  const { Box, Text } = ui
  const Svg = surface === 'desktop' && 'Svg' in ui ? ui.Svg : undefined
  const W = Math.max(180, Math.min(1600, cols * 8 - 16))
  const nameWidth = Math.max(8, cols - (indent + 2 + 1 + METER + 2 + 7))
  const now = await $.clock.now()
  const frame = await read($, tick)
  return list.map(a => {
    const name = cleanName(a.description || a.type)
    const time = formatDuration(now - a.startedAt)
    const label = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal} · ${time}` : time
    const fill = a.stepTotal ? Math.min(1, (a.stepDone ?? 0) / a.stepTotal) : null
    if (Svg) {
      return <Svg key={`agent-${a.id}`} source={agentSvg(W, { id: a.id, type: a.type, description: name, fill, label })} alt={`${name}: ${label}`} width={W} height={AGENT_H} />
    }
    const meter = meterFor({ ...makeTask(a.id, name, 'active'), hasReported: fill !== null, percent: (fill ?? 0) * 100 }, frame)
    return (
      <Box key={`agent-${a.id}`} flexDirection="row">
        <Box width={indent + 2} flexShrink={0}>
          <Text color={colorOf(a.type)}>{' '.repeat(indent) + '●'}</Text>
        </Box>
        <Box width={nameWidth} flexShrink={0}>
          <Text wrap="truncate-end">{fit(name, nameWidth)}</Text>
        </Box>
        <Box width={METER} height={1} flexShrink={0} marginX={1}>
          <Text color={colorOf(a.type)}>{meter}</Text>
        </Box>
        <Text dimColor>{label}</Text>
      </Box>
    )
  })
}

const workerCards = async ($: $, ui: Ui, surface: string, cols: number, list: readonly RunningAgent[]) => {
  const { Box, Text } = ui
  const Svg = surface === 'desktop' && 'Svg' in ui ? ui.Svg : undefined
  const W = Math.max(180, Math.min(1600, cols * 8 - 16))
  const now = await $.clock.now()
  const frame = await read($, tick)
  return list.map(a => {
    const color = colorOf(a.type)
    const title = cleanName(a.description || a.type)
    const lane = laneOf(a.type)
    const meta = [modelName(a.model), a.effort].filter(Boolean).join(' · ')
    const fill = a.stepTotal ? Math.min(1, (a.stepDone ?? 0) / a.stepTotal) : null
    const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' · ' + a.stepNote : ''}` : 'Working'
    const stats = `${fmtTokens(a.tokens)} tokens · ≈${fmtCost(a.costUsd)} · ${formatDuration(now - a.startedAt)}`
    if (Svg) {
      const card = { id: a.id, type: a.type, title, lane, meta, fill, steps, stats }
      return <Svg key={`card-${a.id}`} source={cardSvg(W, card)} alt={`${title}: ${lane} · ${meta} · ${steps} · ${stats}`} width={W} height={CARD_H} />
    }
    const meter = meterFor({ ...makeTask(a.id, title, 'active'), hasReported: fill !== null, percent: (fill ?? 0) * 100 }, frame)
    return (
      <Box key={`card-${a.id}`} borderStyle="round" borderColor={color} flexDirection="row" paddingX={1}>
        <Box flexDirection="column" width={10} flexShrink={0}>
          <Text color={CLAY}>{' ▐▛███▜▌'}</Text>
          <Text color={CLAY}>{'▝▜█████▛▘'}</Text>
          <Text color={CLAY}>{frame % 4 < 2 ? '  ▘▘ ▝▝' : '  ▝▘ ▘▝'}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          <Text bold wrap="truncate-end">{title}</Text>
          <Text wrap="truncate-end">
            <Text color={color}>{lane}</Text>
            <Text dimColor> · {meta}</Text>
          </Text>
          <Text wrap="truncate-end">
            <Text color={color}>{meter}</Text>
            <Text dimColor> {steps}</Text>
          </Text>
          <Text dimColor wrap="truncate-end">{stats}</Text>
        </Box>
      </Box>
    )
  })
}

const toneFor = (status: TaskStatus, phase: Checklist['phase']) =>
  status === 'done' ? DONE : status === 'upcoming' ? IDLE : phase === 'needsYou' ? WAIT : ACCENT

type TextElement = ReturnType<$['ui']['resolve']>['Text']

const headerFor = (Text: TextElement, c: Checklist, now: number) => {
  const elapsed = formatDuration((c.finishedAt ?? now) - c.startedAt)
  switch (c.phase) {
    case 'needsYou':
      return (
        <Text>
          <Text inverse bold color="warning">
            {' Needs you '}
          </Text>{' '}
          {c.needsYouReason ?? ''}
        </Text>
      )
    case 'stuck':
      return (
        <Text color="warning">
          ⚠ Stuck: {c.stuckReason ?? 'something went wrong, try again'}
        </Text>
      )
    case 'stopped':
      return <Text color="error">■ Stopped · {c.title} · you pressed Esc</Text>
    case 'done':
      return (
        <Text color="success">
          ✓ All done · {c.title} · took {elapsed}
        </Text>
      )
    default:
      return (
        <Text>
          <Text bold color="claude">
            {c.title}
          </Text>
          <Text color="subtle"> · </Text>
          <Text color="suggestion">{elapsed}</Text>
        </Text>
      )
  }
}

const hidden = ($: $, e: Parameters<$['ui']['resolve']>[0]) => {
  const { Box } = $.ui.resolve(e)
  return <Box display="none" />
}
