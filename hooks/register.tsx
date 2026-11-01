import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { AgentRow, FinishedRun, LimitWindow, PlanItem, RelayRun, Snapshot, SubagentRun } from '../types'

const PANE = 'agent-watch'
const TITLE = 'Agents'
const POLL_MS = 30_000
// A main turn shorter than this ends while the person still watches.
const FINISH_ALERT_MS = 15_000
const WARN_PERCENT = 90
// The Claude desktop app's icon, found by name in the icon theme where it is installed.
const ICON = 'claude-desktop'
const BUSY: readonly string[] = ['pending', 'running', 'waiting']
const RELAY = /\b([a-z]+)-delegate\/scripts\/relay\.mjs\b/
const STALL_MS = 20 * 60_000

// Each shape tag declines what an earlier version of the mod stored.
const snapshot = atom({ plugin: 'agent-watch', key: 'snapshot' } as const, null, { shape: 'snapshot-1' })
const claude = atom({ plugin: 'agent-watch', key: 'claude' } as const, [], { shape: 'claude-1' })
const plan = atom({ plugin: 'agent-watch', key: 'plan' } as const, [], { shape: 'plan-1' })
const subagents = atom({ plugin: 'agent-watch', key: 'subagents' } as const, [], { shape: 'subagents-1' })
const isNotifying = atom({ plugin: 'agent-watch', key: 'isNotifying' } as const, true)
const phoneUrl = atom({ plugin: 'agent-watch', key: 'phoneUrl' } as const, null)

const CLAUDE_LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'week' }

function toWindows(limits: readonly SessionRateLimit[]): LimitWindow[] {
  return limits.map(limit => ({
    label: CLAUDE_LABELS[limit.kind] ?? limit.kind.replace(/_/g, ' '),
    percentUsed: limit.percentUsed,
    resetsAt: limit.resetsAt === undefined ? undefined : Date.parse(limit.resetsAt),
  }))
}

function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

function tone(percent: number): 'error' | 'warning' | 'success' {
  if (percent >= WARN_PERCENT) return 'error'
  if (percent >= 70) return 'warning'
  return 'success'
}

function firstLine(text: string): string {
  const line = text.split('\n').find(one => one.trim() !== '') ?? ''
  return line.length > 140 ? `${line.slice(0, 139)}…` : line
}

// Module state: a reload starts these over.
let isCollecting = false
let lastQuestionAt = 0

// notify-send reaches the Linux desktop whatever the terminal; elsewhere
// the person's own Claude Code notification channel takes it.
async function desktop($: EngineInterface, title: string, body: string): Promise<void> {
  try {
    const sent = await $.process.run(['notify-send', '--app-name=Claude Code', `--icon=${ICON}`, title, body], {
      timeoutMs: 5_000,
    })
    if (sent.exitCode === 0) return
  } catch {
    // No notify-send on this host: fall through to the engine's channel.
  }
  await $.ui.notify(body, { title }).catch(() => undefined)
}

// Phone alerts go to an ntfy topic URL, set by /agent-watch-phone and kept in
// ~/.config/agent-watch/config.json so every session and copy reads it.
type Config = { ntfyUrl?: string }

async function configPath($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get('HOME').catch(() => undefined)
  return home ? `${home}/.config/agent-watch/config.json` : undefined
}

async function readConfig($: EngineInterface): Promise<Config> {
  try {
    const path = await configPath($)
    return path === undefined ? {} : (JSON.parse(String(await $.fs.read(path))) as Config)
  } catch {
    return {}
  }
}

async function writeConfig($: EngineInterface, config: Config): Promise<void> {
  const path = await configPath($)
  if (path === undefined) throw new Error('HOME is not set')
  await $.fs.write(path, `${JSON.stringify(config, null, 2)}\n`)
}

async function phone($: EngineInterface, url: string, title: string, body: string): Promise<boolean> {
  // An HTTP header carries ASCII only; the body takes any text.
  const headers = { Title: title.replace(/[^\x20-\x7e]/g, '').trim() || 'agent-watch', Tags: 'robot' }
  return $.http
    .fetch(url, { method: 'POST', headers, body })
    .then(response => response.ok)
    .catch(() => false)
}

async function alert($: EngineInterface, title: string, body: string): Promise<void> {
  if (!(await read($, isNotifying))) return
  const { ntfyUrl } = await readConfig($)
  await Promise.all([desktop($, title, body), ntfyUrl === undefined ? undefined : phone($, ntfyUrl, title, body)])
}

// The windows a relay of this agent spends: an agy model draws on its group.
function spentBy(row: AgentRow, model?: string): LimitWindow[] {
  if (row.id !== 'agy') return row.windows
  const group =
    model === undefined
      ? undefined
      : /claude|gpt/i.test(model)
        ? 'Claude/GPT'
        : /argon/i.test(model)
          ? 'Argon'
          : /gemini/i.test(model)
            ? 'Gemini'
            : undefined
  return row.windows.filter(window =>
    group === undefined ? !window.label.startsWith('Argon') : window.label.startsWith(`${group} `),
  )
}

// A relay dispatch to an agent past WARN_PERCENT is refused with the agents
// that have room; AGENT_WATCH_ALLOW=1 in the command lets it through.
async function routeCheck($: EngineInterface, command: string): Promise<string | undefined> {
  const match = RELAY.exec(command)
  if (match === null || /\bAGENT_WATCH_ALLOW=1\b/.test(command) || /\s--help\b/.test(command)) return undefined
  const snap = await read($, snapshot)
  const now = await $.clock.now()
  if (snap === null || now - snap.at > 10 * 60_000) return undefined
  const row = snap.agents.find(one => one.id === match[1])
  if (row === undefined) return undefined
  const model = /--model\s+(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(command)
  const full = spentBy(row, model?.[1] ?? model?.[2] ?? model?.[3]).filter(one => one.percentUsed >= WARN_PERCENT)
  const worst = full.sort((a, b) => b.percentUsed - a.percentUsed)[0]
  if (worst === undefined) return undefined

  const room = snap.agents
    .filter(one => one.id !== row.id)
    .map(one => ({ name: one.name, top: Math.max(-1, ...spentBy(one).map(window => window.percentUsed)) }))
    .filter(one => one.top >= 0 && one.top < WARN_PERCENT)
    .sort((a, b) => a.top - b.top)
    .map(one => `${one.name} (${Math.round(one.top)}% used)`)
  const reset = worst.resetsAt === undefined ? '' : `, resets in ${span(worst.resetsAt - now)}`
  return [
    `agent-watch stopped this dispatch: ${row.name} ${worst.label} limit is at ${Math.round(worst.percentUsed)}%${reset}.`,
    room.length > 0
      ? `Agents with room: ${room.join(', ')}. Dispatch to one of them, or ask the user.`
      : 'No other agent has room; ask the user.',
    `To dispatch to ${row.name} anyway, prefix the command with AGENT_WATCH_ALLOW=1.`,
  ].join(' ')
}

async function collect($: EngineInterface): Promise<void> {
  if (isCollecting) return
  isCollecting = true
  try {
    const before = await read($, snapshot)
    const now = await $.clock.now()
    let after: Snapshot
    try {
      const claudeWindows = JSON.stringify(await read($, claude))
      const script = `${$.plugin.root}/scripts/collect.mjs`
      const ran = await $.process.run(['node', '--no-warnings', script, '--claude', claudeWindows], {
        timeoutMs: 20_000,
      })
      after =
        ran.exitCode === 0
          ? (JSON.parse(ran.stdout) as Snapshot)
          : {
              at: now,
              agents: before?.agents ?? [],
              runs: before?.runs ?? [],
              error: firstLine(ran.stderr) || `exit ${ran.exitCode}`,
            }
    } catch (error) {
      after = { at: now, agents: before?.agents ?? [], runs: before?.runs ?? [], error: String(error).slice(0, 120) }
    }
    const { alerts = [], ...kept } = after
    await update($, snapshot, () => kept)
    // The collector claimed these for this session alone: send each once.
    for (const one of alerts) {
      $.ui.toast(one.body)
      await alert($, one.title, one.body)
    }

    const agents = await $.agent.list()
    const busy: SubagentRun[] = agents
      .filter(agent => BUSY.includes(agent.status))
      .map(agent => ({ id: agent.id, description: agent.description, type: agent.type, status: agent.status }))
    await update($, subagents, () => busy)
  } finally {
    isCollecting = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-watch',
      description: 'Open the Agents pane: usage limits, running relays, the plan',
    })
    await $.command.register({
      name: 'agent-watch-phone',
      description: 'Send alerts to your phone through ntfy: no argument sets up a topic; off, test, a topic or a URL',
      argumentHint: '[off | test | <topic> | <url>]',
    })
    const { ntfyUrl } = await readConfig($)
    await update($, phoneUrl, () => ntfyUrl ?? null)
    const stored = await $.store.get('isNotifying')
    if (typeof stored === 'boolean') await update($, isNotifying, () => stored)
    const usage = await $.session.usage()
    await update($, claude, () => toWindows(usage.rateLimits))
    void collect($)
    $.clock.every(POLL_MS, () => void collect($))
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'agent-watch' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    void collect($)

    return { text: opened.isPlaced ? 'Agents pane opened.' : `Agents pane waits: ${opened.reason}` }
  })

  on('command.run', { command: 'agent-watch-phone' }, async ($, e) => {
    const arg = e.args.trim()
    const config = await readConfig($)
    if (arg === 'off') {
      await writeConfig($, { ...config, ntfyUrl: undefined })
      await update($, phoneUrl, () => null)
      return { text: 'Phone alerts are off.' }
    }
    let url = config.ntfyUrl
    if (/^https?:\/\/\S+\/[\w-]{1,64}$/.test(arg)) url = arg
    else if (/^[\w-]{1,64}$/.test(arg) && arg !== 'test') url = `https://ntfy.sh/${arg}`
    else if (arg !== '' && arg !== 'test') return { text: `Not an ntfy topic name or topic URL: ${arg}` }
    url ??= `https://ntfy.sh/agent-watch-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
    const chosen = url
    await writeConfig($, { ...config, ntfyUrl: chosen })
    await update($, phoneUrl, () => chosen)
    const isSent = await phone(
      $,
      chosen,
      'agent-watch',
      'Phone alerts work: questions, finished turns, relays and limits arrive here.',
    )
    const cut = chosen.lastIndexOf('/')
    const server = chosen.slice(0, cut)
    return {
      text: [
        `Phone alerts go to ${chosen}: ${isSent ? 'a test alert was sent' : 'the test alert failed to send'}.`,
        `On your phone, install the ntfy app, tap +, and subscribe to the topic ${chosen.slice(cut + 1)}${server === 'https://ntfy.sh' ? '' : ` on the server ${server}`}.`,
        'Anyone who knows the topic name can read these alerts, so keep it private.',
        'Run /agent-watch-phone off to stop them.',
      ].join('\n'),
    }
  })

  // Route delegated work by limits: see routeCheck.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await routeCheck($, e.command)
    return verdict === undefined ? next(e) : { deny: verdict }
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      const windows = toWindows(e.rateLimits)
      await update($, claude, () => windows)
      if (windows.some(window => window.percentUsed >= WARN_PERCENT)) void collect($)
    }

    return next(e)
  })

  // The plan: the main loop's todo list, or the session's task list.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && ran.isError !== true) {
      const items: PlanItem[] = e.todos.map((todo, index) => ({
        id: String(index),
        text: todo.content,
        activeText: todo.activeForm,
        status: todo.status,
      }))
      await update($, plan, () => items)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const task = ran.result.task
      const item: PlanItem = { id: task.id, text: task.subject, activeText: e.activeForm, status: 'pending' }
      await update($, plan, list => [...list.filter(one => one.id !== task.id), item])
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && ran.result.success) {
      const status = e.status === 'deleted' ? undefined : e.status
      await update($, plan, list =>
        e.status === 'deleted'
          ? list.filter(one => one.id !== e.taskId)
          : list.map(one =>
              one.id === e.taskId
                ? {
                    ...one,
                    text: e.subject ?? one.text,
                    activeText: e.activeForm ?? one.activeText,
                    status: status ?? one.status,
                  }
                : one,
            ),
      )
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskList' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const tasks = ran.result.tasks
      await update($, plan, list =>
        tasks.map(task => ({
          id: task.id,
          text: task.subject,
          activeText: list.find(one => one.id === task.id)?.activeText,
          status: task.status,
        })),
      )
    }

    return ran
  }).catch(($, e, next) => next(e))

  // Attention: a question, a permission prompt, a finished turn.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    lastQuestionAt = await $.clock.now()
    void alert($, 'Claude asks', e.questions[0]?.question ?? 'A question waits for you.')

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    const isAsk = /permission|elicitation/.test(e.notification_type)
    const isFresh = (await $.clock.now()) - lastQuestionAt > 5_000
    if (isAsk && isFresh) void alert($, e.title ?? 'Claude needs you', e.message)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && !e.isAborted && e.durationMs >= FINISH_ALERT_MS) {
      void alert($, `Claude finished (${span(e.durationMs)})`, firstLine(e.answer) || 'The turn ended.')
    }

    return done
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const snap = await read($, snapshot)
    const claudeWindows = await read($, claude)
    const items = await read($, plan)
    const busy = await read($, subagents)
    const notifying = await read($, isNotifying)
    const phoneTo = await read($, phoneUrl)
    const outAts = snap?.forecasts ?? {}

    const rows: AgentRow[] = [
      {
        id: 'claude',
        name: 'Claude',
        windows: claudeWindows,
        note: claudeWindows.length === 0 ? 'no reading until the next reply' : undefined,
      },
      ...(snap?.agents ?? []),
    ]

    const windowLine = (agent: AgentRow, window: LimitWindow, labelWidth: number, hasForecast: boolean) => {
      const barWidth = Math.max(4, Math.min(14, e.props.bodyColumns - labelWidth - 17 - (hasForecast ? 8 : 0)))
      const filled = Math.round((Math.min(100, window.percentUsed) / 100) * barWidth)
      const color = tone(window.percentUsed)
      const outAt = outAts[`${agent.id}|${window.label}`]
      return (
        <Box>
          <Text dimColor>{`  ${window.label.padEnd(labelWidth)} `}</Text>
          <Text color={color}>{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(barWidth - filled)}</Text>
          <Text color={color} bold={window.percentUsed >= WARN_PERCENT}>
            {`${Math.round(window.percentUsed)}%`.padStart(5)}
          </Text>
          <Text dimColor>{window.resetsAt === undefined ? '' : `  ↻ ${span(window.resetsAt - now)}`}</Text>
          <Text color="warning">{outAt === undefined ? '' : `  ⚠ ${span(outAt - now)}`}</Text>
        </Box>
      )
    }

    const agentBlock = (agent: AgentRow) => {
      const labelWidth = Math.max(4, ...agent.windows.map(window => window.label.length))
      const hasForecast = agent.windows.some(window => outAts[`${agent.id}|${window.label}`] !== undefined)
      return (
        <Box flexDirection="column">
          <Box>
            <Text bold color={agent.isBlocked ? 'error' : undefined}>
              {agent.name}
            </Text>
            <Text dimColor>
              {agent.lastActiveAt === undefined ? '' : `  active ${span(now - agent.lastActiveAt)} ago`}
            </Text>
          </Box>
          {agent.windows.map(window => windowLine(agent, window, labelWidth, hasForecast))}
          {agent.note !== undefined && (
            <Text dimColor wrap="truncate-end">
              {`  ${agent.note}`}
            </Text>
          )}
        </Box>
      )
    }

    const runLine = (run: RelayRun) => (
      <Box>
        <Text color="claude">{`  ${run.agent.padEnd(9)}`}</Text>
        <Text wrap="truncate-end">{`${run.repo} · ${run.brief}${run.isReadOnly ? ' (read-only)' : ''}`}</Text>
        <Text dimColor>{`  ${span(now - run.startedAt)}`}</Text>
        {idleLabel(run)}
      </Box>
    )

    // A run with no file change for 5 minutes says so; past STALL_MS in warning color.
    const idleLabel = (run: RelayRun) => {
      const idleMs = now - (run.progressAt ?? now)
      if (idleMs < 5 * 60_000) return null
      return (
        <Text
          color={idleMs >= STALL_MS ? 'warning' : undefined}
          dimColor={idleMs < STALL_MS}
        >{`  idle ${span(idleMs)}`}</Text>
      )
    }

    const finishedLine = (done: FinishedRun) => {
      const isGood = done.status === 'completed'
      const files = done.files === undefined ? '' : ` · ${done.files}f`
      return (
        <Box>
          <Text color={isGood ? 'success' : 'error'}>{`  ${isGood ? '✓' : '✗'} ${done.agent.padEnd(7)}`}</Text>
          <Text dimColor wrap="truncate-end">{`${done.repo} · ${done.brief}${files}`}</Text>
          <Text dimColor>{`  ${isGood ? '' : `${done.status} `}${span(now - done.endedAt)} ago`}</Text>
        </Box>
      )
    }

    const subagentLine = (agent: SubagentRun) => (
      <Box>
        <Text color="claude">{`  ${'subagent'.padEnd(9)}`}</Text>
        <Text wrap="truncate-end">{`${agent.type}: ${agent.description}`}</Text>
        <Text dimColor>{agent.status === 'running' ? '' : `  ${agent.status}`}</Text>
      </Box>
    )

    const planLine = (item: PlanItem) => {
      if (item.status === 'completed') {
        return <Text dimColor wrap="truncate-end">{`  ✓ ${item.text}`}</Text>
      }
      if (item.status === 'in_progress') {
        return (
          <Text bold color="claude" wrap="truncate-end">
            {`  ▶ ${item.activeText ?? item.text}`}
          </Text>
        )
      }
      return <Text wrap="truncate-end">{`  ○ ${item.text}`}</Text>
    }

    const runCount = (snap?.runs.length ?? 0) + busy.length
    const doneCount = items.filter(item => item.status === 'completed').length

    return (
      <Box flexDirection="column">
        <Text bold>Limits</Text>
        {rows.map(agentBlock)}

        <Box marginTop={1}>
          <Text bold>{`Running · ${runCount}`}</Text>
        </Box>
        {runCount === 0 && <Text dimColor> no relay or subagent at work</Text>}
        {(snap?.runs ?? []).map(runLine)}
        {busy.map(subagentLine)}
        {(snap?.finished ?? []).map(finishedLine)}

        <Box marginTop={1}>
          <Text bold>{items.length === 0 ? 'Plan' : `Plan · ${doneCount}/${items.length} done`}</Text>
        </Box>
        {items.length === 0 && <Text dimColor> no todo or task list yet</Text>}
        {items.map(planLine)}

        <Box marginTop={1}>
          <Button
            key="notify"
            label={notifying ? (phoneTo === null ? 'Alerts on' : 'Alerts on + phone') : 'Alerts off'}
            onPress={async () => {
              const next = !notifying
              await update($, isNotifying, () => next)
              await $.store.set('isNotifying', next)
            }}
          />
          <Text> </Text>
          <Button key="refresh" label="Refresh" onPress={() => collect($)} />
        </Box>
        <Text dimColor wrap="truncate-end">
          {snap === null ? 'reading…' : (snap.error ?? `updated ${span(now - snap.at)} ago`)}
        </Text>
      </Box>
    )
  })
}
