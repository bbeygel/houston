export type TaskStatus = 'done' | 'active' | 'upcoming'

export type ChecklistTask = {
  id: string
  name: string
  status: TaskStatus
  percent: number
  hasReported: boolean
}

export type Phase = 'working' | 'needsYou' | 'stuck' | 'stopped' | 'done'

export type Checklist = {
  title: string
  phase: Phase
  tasks: ChecklistTask[]
  needsYouReason: string | null
  stuckReason: string | null
  startedAt: number
  finishedAt: number | null
  isCollapsed: boolean
}

export type RunningAgent = {
  id: string
  type: string
  description: string
  startedAt: number
  model: string
  effort?: string
  tokens: number
  costUsd: number
  stepDone?: number
  stepTotal?: number
  stepNote?: string
}

declare module 'claude-code' {
  interface PluginState {
    houston: {
      enabled: boolean
      checklist: Checklist | null
      tick: number
      isPaneDismissed: boolean
      running: RunningAgent[]
    }
  }
}
