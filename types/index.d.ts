/** One usage window: `5h`, `week`, or `quota` for a spent Antigravity quota. */
export type LimitWindow = { label: string; percentUsed: number; resetsAt?: number }

/** One agent's row: its windows, or a note where the CLI keeps none. */
export type AgentRow = {
  id: string
  name: string
  windows: LimitWindow[]
  note?: string
  lastActiveAt?: number
  isBlocked?: boolean
}

/** A delegate relay process running now, from `ps`. */
export type RelayRun = {
  pid: number
  agent: string
  repo: string
  brief: string
  startedAt: number
  isReadOnly: boolean
  cwd?: string
  outDir?: string
  model?: string
  /** The newest file change in its out-dir or repository. */
  progressAt?: number
}

/** A relay that ended, with what its result.json says. */
export type FinishedRun = {
  agent: string
  repo: string
  brief: string
  status: string
  files?: number
  startedAt: number
  endedAt: number
}

/** A desktop alert the collector claimed for this session to send. */
export type Alert = { title: string; body: string }

/** What scripts/collect.mjs prints; `alerts` is sent, never stored. */
export type Snapshot = {
  at: number
  agents: AgentRow[]
  runs: RelayRun[]
  /** Relays that ended in the last hour, newest first, 3 at most. */
  finished?: FinishedRun[]
  /** When a window reaches 100% at its recent pace, by `<agent id>|<label>`; only where that is before it resets. */
  forecasts?: Record<string, number>
  alerts?: Alert[]
  error?: string
}

/** One item of Claude's todo or task list. */
export type PlanItem = {
  id: string
  text: string
  activeText?: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** A Claude subagent of this session still at work. */
export type SubagentRun = { id: string; description: string; type: string; status: string }

declare module 'claude-code' {
  interface PluginState {
    'agent-watch': {
      snapshot: Shaped<Snapshot | null>
      claude: Shaped<LimitWindow[]>
      plan: Shaped<PlanItem[]>
      subagents: Shaped<SubagentRun[]>
      isNotifying: boolean
      phoneUrl: string | null
    }
  }
}
