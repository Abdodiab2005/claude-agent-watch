import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Snapshot } from '../types'

const NOW = 1_793_562_512_000
const HOUR = 3_600_000
const MINUTE = 60_000
const NTFY = 'https://ntfy.sh/agent-watch-test'

const PANE = {
  plugin: 'agent-watch',
  component: 'Pane',
  requestId: 'agent-watch',
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 56,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const RELAY = {
  pid: 7,
  agent: 'codex',
  repo: 'shop',
  brief: 'brief-2.txt',
  startedAt: NOW - 40 * MINUTE,
  isReadOnly: false,
  progressAt: NOW - 25 * MINUTE,
}

function snapshot(extra: Partial<Snapshot> = {}): Snapshot {
  return {
    at: NOW,
    agents: [
      {
        id: 'codex',
        name: 'Codex',
        windows: [
          { label: '5h', percentUsed: 21, resetsAt: NOW + 2 * HOUR },
          { label: 'week', percentUsed: 93, resetsAt: NOW + 72 * HOUR },
        ],
      },
      { id: 'grok', name: 'Grok', windows: [{ label: 'week', percentUsed: 36, resetsAt: NOW + 70 * HOUR }] },
    ],
    runs: [],
    ...extra,
  }
}

const ok = (stdout = '') => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// Stands for the engine and the host under the mod: the collector's output
// comes from `outputs`, one per run; desktop alerts, phone posts and config
// writes are recorded.
function host(on: On, outputs: Snapshot[], options: { ntfyUrl?: string } = {}) {
  const clock = mock.clock(on, { now: NOW })
  const alerts: string[] = []
  const phones: string[] = []
  const collects: string[] = []
  const writes: string[] = []
  let config = options.ntfyUrl === undefined ? undefined : JSON.stringify({ ntfyUrl: options.ntfyUrl })
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.read', () => (config === undefined ? { deny: 'no such file' } : { value: config }))
  on('fs.write', (_, e) => {
    writes.push(`${e.path} ${e.text}`)
    config = e.text
    return { value: undefined }
  })
  on('http.fetch', (_, e) => {
    phones.push(`${e.url} | ${e.init?.headers?.Title} | ${e.init?.body}`)
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: new Date(NOW + HOUR).toISOString() }],
    },
  }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'notify-send') {
      expect(e.argv).toContain('--icon=claude-desktop')
      alerts.push(e.argv.filter(arg => !arg.startsWith('--')).slice(1).join(' | '))
      return ok()
    }
    collects.push(e.argv[e.argv.indexOf('--claude') + 1] ?? '')
    const next = outputs.length > 1 ? outputs.shift() : outputs[0]
    return ok(JSON.stringify(next ?? snapshot()))
  })
  on('tool.call', () => ({ result: {} }))
  return { clock, alerts, phones, collects, writes }
}

const SESSION = { cwd: '/', surface: 'terminal', isInteractive: true } as const

// The person typing a command in a fullscreen terminal.
const typed = (command: string, args: string) => ({
  command,
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: true, columns: 160 },
})

test('the pane draws limits, a forecast, a stalled relay, a finished one and the plan, on every surface', async ($, on) => {
  const { clock } = host(on, [
    snapshot({
      runs: [RELAY],
      forecasts: { 'codex|5h': NOW + 90 * MINUTE },
      finished: [
        { agent: 'grok', repo: 'api', brief: 'brief-1.txt', status: 'completed', files: 4, startedAt: NOW - HOUR, endedAt: NOW - 5 * MINUTE },
      ],
    }),
  ])
  await $.session.start(SESSION)
  await clock.settle()
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Write collector', activeForm: 'Writing collector', status: 'completed' },
      { content: 'Build pane', activeForm: 'Building pane', status: 'in_progress' },
      { content: 'Add alerts', activeForm: 'Adding alerts', status: 'pending' },
    ],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const text = async (pattern: RegExp) => (await ui.find({ type: 'Text', text: pattern }))?.text

    expect(await text(/42%/)).toContain('42%')
    expect(await text(/93%/)).toContain('93%')
    expect(await text(/36%/)).toContain('36%')
    expect(await text(/⚠/)).toBe('  ⚠ 1h30m')
    expect(await text(/shop · brief-2\.txt/)).toBe('shop · brief-2.txt')
    expect(await text(/idle/)).toBe('  idle 25m')
    expect(await text(/✓ grok/)).toContain('✓ grok')
    expect(await text(/api · brief-1\.txt/)).toBe('api · brief-1.txt · 4f')
    expect(await text(/Plan · 1\/3 done/)).toBe('Plan · 1/3 done')
    expect(await text(/▶/)).toBe('  ▶ Building pane')
    await ui.unmount()
  }
})

test('each alert the collector claimed reaches the desktop and the phone once', async ($, on) => {
  const claimed = snapshot({ alerts: [{ title: 'codex completed', body: 'shop · brief-2.txt · 4 files · 12m' }] })
  const { clock, alerts, phones, collects } = host(on, [claimed, snapshot()], { ntfyUrl: NTFY })

  await $.session.start(SESSION)
  await clock.settle()
  expect(alerts).toEqual(['codex completed | shop · brief-2.txt · 4 files · 12m'])
  expect(phones).toEqual([`${NTFY} | codex completed | shop · brief-2.txt · 4 files · 12m`])
  expect(collects[0]).toContain('"label":"5h","percentUsed":42')

  await clock.advance(30_000)
  await clock.settle()
  expect(alerts).toHaveLength(1)
  expect(phones).toHaveLength(1)
})

test('a dispatch to an agent past 90% is refused with the agents that have room', async ($, on) => {
  const { clock } = host(on, [snapshot()])
  await $.session.start(SESSION)
  await clock.settle()

  const relay = 'node /home/me/.claude/skills/codex-delegate/scripts/relay.mjs --brief b.txt --cd /repo'
  const refused = await $.tool.call({ tool: 'Bash', command: relay })
  expect(refused.deny).toContain('Codex week limit is at 93%')
  expect(refused.deny).toContain('Agents with room: Grok (36% used)')

  const allowed = await $.tool.call({ tool: 'Bash', command: `AGENT_WATCH_ALLOW=1 ${relay}` })
  expect(allowed.deny).toBeUndefined()
  const other = await $.tool.call({ tool: 'Bash', command: relay.replace('codex-delegate', 'grok-delegate') })
  expect(other.deny).toBeUndefined()
})

test('/agent-watch-phone sets up a private topic, sends a test, and turns off', async ($, on) => {
  const { clock, phones, writes } = host(on, [snapshot()])
  await $.session.start(SESSION)
  await clock.settle()

  const setUp = await $.command.run(typed('agent-watch-phone', ''))
  expect(setUp.text).toContain('a test alert was sent')
  expect(writes[0]).toMatch(/^\/home\/me\/\.config\/agent-watch\/config\.json .*https:\/\/ntfy\.sh\/agent-watch-[0-9a-f]{20}/s)
  expect(phones[0]).toMatch(/^https:\/\/ntfy\.sh\/agent-watch-[0-9a-f]{20} \| agent-watch \| Phone alerts work/)

  const off = await $.command.run(typed('agent-watch-phone', 'off'))
  expect(off.text).toBe('Phone alerts are off.')
  expect(writes[1]).not.toContain('ntfy')
})

test('the alerts button turns desktop and phone alerts off', async ($, on) => {
  const { clock, alerts, phones } = host(on, [snapshot()], { ntfyUrl: NTFY })
  await $.session.start(SESSION)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'notify' }))?.text).toContain('Alerts on + phone')
  await ui.press({ key: 'notify' })

  await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [
      {
        question: 'Which repo?',
        header: 'Repo',
        options: [
          { label: 'a', description: 'a' },
          { label: 'b', description: 'b' },
        ],
        multiSelect: false,
      },
    ],
  })
  await clock.settle()
  expect(alerts).toHaveLength(0)
  expect(phones).toHaveLength(0)
  await ui.unmount()
})
