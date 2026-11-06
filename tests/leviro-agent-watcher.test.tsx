import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Snapshot } from '../types'

const NOW = 1_793_562_512_000
const HOUR = 3_600_000
const MINUTE = 60_000
const NTFY = 'https://ntfy.sh/leviro-agent-watcher-test'
const TOKEN = '123456:TEST-token-never-shown'

const PANE = {
  plugin: 'leviro-agent-watcher',
  component: 'Pane',
  requestId: 'leviro-agent-watcher',
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
type HostOptions = {
  ntfyUrl?: string
  telegramChatId?: string
  os?: 'linux' | 'darwin' | 'win32'
  /** What the ntfy server answers a publish without the right token. */
  ntfyLocked?: boolean
  ntfyFailures?: number
  off?: string[]
}

function host(on: On, outputs: Snapshot[], { os = 'linux', ntfyLocked = false, ntfyFailures = 0, ...stored }: HostOptions = {}) {
  const clock = mock.clock(on, { now: NOW })
  const alerts: string[] = []
  const phones: string[] = []
  const collects: string[] = []
  const writes: string[] = []
  const telegrams: string[] = []
  const natives: (readonly string[])[] = []
  const delivered = new Set<string>()
  const leased = new Map<string, string>()
  let ntfyFailuresLeft = ntfyFailures
  let config = Object.keys(stored).length === 0 ? undefined : JSON.stringify(stored)
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  const env: Record<string, string> =
    os === 'win32' ? { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\me' } : { HOME: '/home/me' }
  on('env.get', (_, e) => ({ value: env[e.name] }))
  on('fs.read', () => (config === undefined ? { deny: 'no such file' } : { value: config }))
  on('fs.write', (_, e) => {
    writes.push(`${e.path} ${e.text}`)
    config = e.text
    return { value: undefined }
  })
  on('http.fetch', (_, e) => {
    const telegram = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(e.url)
    if (telegram === null) {
      const auth = e.init?.headers?.Authorization
      phones.push(`${e.url} | ${e.init?.headers?.Title} | ${e.init?.body}${auth === undefined ? '' : ` | ${auth}`}`)
      const isRefused = ntfyLocked && auth !== 'Bearer tk_test'
      const temporaryFailure = !isRefused && ntfyFailuresLeft-- > 0
      return {
        value: isRefused
          ? { status: 403, ok: false, headers: {}, text: '{"http":403,"error":"forbidden"}' }
          : temporaryFailure
            ? { status: 503, ok: false, headers: {}, text: '{"http":503,"error":"unavailable"}' }
            : { status: 200, ok: true, headers: {}, text: '{}' },
      }
    }
    expect(telegram[1]).toBe(TOKEN)
    telegrams.push(`${telegram[2]} ${e.init?.body}`)
    const answers: Record<string, object> = {
      getMe: { ok: true, result: { username: 'watch_bot' } },
      getUpdates: {
        ok: true,
        result: [{ update_id: 1, message: { chat: { id: 42, type: 'private', first_name: 'Me' } } }],
      },
      sendMessage: { ok: true, result: {} },
    }
    return {
      value: { status: 200, ok: true, headers: {}, text: JSON.stringify(answers[telegram[2] ?? ''] ?? { ok: false }) },
    }
  })
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: new Date(NOW + HOUR).toISOString() }],
    },
  }))
  on('process.run', (_, e) => {
    if (e.argv[1]?.endsWith('/delivery.mjs')) {
      const [action, key, owner] = e.argv.slice(2)
      if (action === 'acquire') {
        if (delivered.has(key)) return ok('sent')
        if (leased.has(key)) return ok('busy')
        leased.set(key, 'test-lease')
        return ok('lease:test-lease')
      }
      if (leased.get(key) === owner) {
        if (action === 'commit') delivered.add(key)
        leased.delete(key)
      }
      return ok()
    }
    if (e.argv[0] === 'notify-send') {
      expect(e.argv).toContain('--icon=claude-desktop')
      alerts.push(
        e.argv
          .filter(arg => !arg.startsWith('--'))
          .slice(1)
          .join(' | '),
      )
      return ok()
    }
    if (e.argv[0] === 'uname') return ok(os === 'darwin' ? 'Darwin\n' : 'Linux\n')
    if (e.argv[0] === 'osascript' || e.argv[0] === 'powershell.exe') {
      natives.push(e.argv)
      return ok()
    }
    if (e.argv[0] === 'claude') {
      return ok(JSON.stringify([{ id: 'leviro-agent-watcher@test-market', readFromFolder: '/elsewhere' }]))
    }
    collects.push(e.argv[e.argv.indexOf('--claude') + 1] ?? '')
    const next = outputs.length > 1 ? outputs.shift() : outputs[0]
    return ok(JSON.stringify(next ?? snapshot()))
  })
  on('tool.call', () => ({ result: {} }))
  return { clock, alerts, phones, collects, writes, telegrams, natives }
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
        {
          agent: 'grok',
          repo: 'api',
          brief: 'brief-1.txt',
          status: 'completed',
          files: 4,
          startedAt: NOW - HOUR,
          endedAt: NOW - 5 * MINUTE,
        },
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
    expect(await text(/⚠/)).toBe('  ⚠ out 1h30m')
    expect(await text(/shop · brief-2\.txt/)).toBe('shop · brief-2.txt')
    expect(await text(/idle/)).toBe('  idle 25m')
    expect(await text(/✓ grok/)).toContain('✓ grok')
    expect(await text(/api · brief-1\.txt/)).toBe('api · brief-1.txt · 4f')
    expect(await text(/Plan · 1\/3 done/)).toBe('Plan · 1/3 done')
    expect(await text(/▶/)).toBe('  ▶ Building pane')
    await ui.unmount()
  }
})

test(
  'each candidate alert reaches the desktop, ntfy and Telegram once across polls',
  { options: { telegramBotToken: TOKEN } },
  async ($, on) => {
    const claimed = snapshot({ alerts: [{ id: 'relay-completed', title: 'codex completed', body: 'shop · brief-2.txt · 4 files · 12m' }] })
    const { clock, alerts, phones, collects, telegrams } = host(on, [claimed], {
      ntfyUrl: NTFY,
      telegramChatId: '42',
    })

    await $.session.start(SESSION)
    await clock.settle()
    expect(alerts).toEqual(['codex completed | shop · brief-2.txt · 4 files · 12m'])
    expect(phones).toEqual([`${NTFY} | codex completed | shop · brief-2.txt · 4 files · 12m`])
    expect(telegrams).toEqual([
      'sendMessage {"chat_id":"42","text":"codex completed\\nshop · brief-2.txt · 4 files · 12m","disable_web_page_preview":true}',
    ])
    expect(collects[0]).toContain('"label":"5h","percentUsed":42')

    await clock.advance(30_000)
    await clock.settle()
    expect(alerts).toHaveLength(1)
    expect(phones).toHaveLength(1)
    expect(telegrams).toHaveLength(1)
  },
)


test('a disabled destination does not consume a shared alert', async ($, on) => {
  const pending = snapshot({ alerts: [{ id: 'relay-stuck', kind: 'relay', title: 'codex stuck', body: 'shop idle' }] })
  const { clock, alerts, phones } = host(on, [pending], { ntfyUrl: NTFY, off: ['desktop', 'ntfy'] })
  await $.session.start(SESSION)
  await clock.settle()
  expect(alerts).toHaveLength(0)
  expect(phones).toHaveLength(0)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'alert-ntfy' })
  await clock.advance(30_000)
  await clock.settle()
  expect(phones).toHaveLength(1)
  expect(alerts).toHaveLength(0)
  await clock.advance(30_000)
  await clock.settle()
  expect(phones).toHaveLength(1)
  await ui.unmount()
})

test('an ntfy transport failure retries without repeating a successful desktop alert', async ($, on) => {
  const pending = snapshot({ alerts: [{ id: 'limit-week', kind: 'limit', title: 'Usage limit close', body: 'week 90%' }] })
  const { clock, alerts, phones } = host(on, [pending], { ntfyUrl: NTFY, ntfyFailures: 1 })
  await $.session.start(SESSION)
  await clock.settle()
  expect(alerts).toHaveLength(1)
  expect(phones).toHaveLength(1)
  await clock.advance(30_000)
  await clock.settle()
  expect(alerts).toHaveLength(1)
  expect(phones).toHaveLength(2)
  await clock.advance(30_000)
  await clock.settle()
  expect(alerts).toHaveLength(1)
  expect(phones).toHaveLength(2)
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

test('/leviro-agent-watcher-phone sets up a private topic, sends a test, and turns off', async ($, on) => {
  const { clock, phones, writes } = host(on, [snapshot()])
  await $.session.start(SESSION)
  await clock.settle()

  const setUp = await $.command.run(typed('leviro-agent-watcher-phone', ''))
  expect(setUp.text).toContain('a test alert was sent')
  expect(writes[0]).toMatch(
    /^\/home\/me\/\.config\/agent-watch\/config\.json .*https:\/\/ntfy\.sh\/leviro-agent-watcher-[0-9a-f]{20}/s,
  )
  expect(phones[0]).toMatch(/^https:\/\/ntfy\.sh\/leviro-agent-watcher-[0-9a-f]{20} \| leviro-agent-watcher \| Phone alerts work/)

  const off = await $.command.run(typed('leviro-agent-watcher-phone', 'off'))
  expect(off.text).toBe('Phone alerts are off.')
  expect(writes[1]).not.toContain('ntfy')
})

test('the alerts button turns desktop and phone alerts off', async ($, on) => {
  const { clock, alerts, phones } = host(on, [snapshot()], { ntfyUrl: NTFY })
  await $.session.start(SESSION)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'alert-ntfy' }))?.text).toContain('ntfy')
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

test('/leviro-agent-watcher-telegram explains the secure setup when no bot token is saved', async ($, on) => {
  const { clock, telegrams } = host(on, [snapshot()])
  await $.session.start(SESSION)
  await clock.settle()

  const answer = await $.command.run(typed('leviro-agent-watcher-telegram', ''))
  expect(answer.text).toContain('@BotFather')
  expect(answer.text).toContain('claude plugin configure leviro-agent-watcher@test-market --values-stdin')
  expect(telegrams).toHaveLength(0)
})

test(
  '/leviro-agent-watcher-telegram finds the chat, sends a test, and never shows the token',
  { options: { telegramBotToken: TOKEN } },
  async ($, on) => {
    const { clock, writes, telegrams } = host(on, [snapshot()])
    await $.session.start(SESSION)
    await clock.settle()

    const answer = await $.command.run(typed('leviro-agent-watcher-telegram', ''))
    expect(answer.text).toContain('Telegram alerts go to chat 42 through @watch_bot: a test message was sent.')
    expect(answer.text).not.toContain(TOKEN)
    expect(writes.join('\n')).not.toContain(TOKEN)
    expect(writes[0]).toContain('"telegramChatId": "42"')
    expect(telegrams.map(one => one.split(' ')[0])).toEqual(['getMe', 'getUpdates', 'sendMessage'])

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: 'alert-telegram' }))?.text).toContain('telegram')
    await ui.unmount()

    const off = await $.command.run(typed('leviro-agent-watcher-telegram', 'off'))
    expect(off.text).toContain('Telegram alerts are off.')
    expect(writes[1]).not.toContain('telegramChatId')
  },
)

const ask = (question: string) => ({
  tool: 'AskUserQuestion' as const,
  questions: [
    {
      question,
      header: 'Repo',
      options: [
        { label: 'a', description: 'a' },
        { label: 'b', description: 'b' },
      ],
      multiSelect: false,
    },
  ],
})
const ASK = ask('Which repo?')

test('a channel switch and a kind switch each turn their alerts off, for every session', async ($, on) => {
  const { clock, alerts, phones, writes } = host(on, [snapshot()], { ntfyUrl: NTFY })
  await $.session.start(SESSION)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const key of ['alert-desktop', 'alert-ntfy', 'alert-ask', 'alert-done', 'alert-relay', 'alert-limit']) {
    expect((await ui.find({ key }))?.text).toContain('✓')
  }

  await ui.press({ key: 'alert-ntfy' })
  expect(writes.at(-1)).toContain('"off": [\n    "ntfy"\n  ]')
  expect((await ui.find({ key: 'alert-ntfy' }))?.text).toContain('✗')
  await $.tool.call(ASK)
  await clock.settle()
  expect(alerts).toEqual(['Claude asks | Which repo?'])
  expect(phones).toHaveLength(0)

  await ui.press({ key: 'alert-ask' })
  await $.tool.call(ASK)
  await clock.settle()
  expect(alerts).toHaveLength(1)

  await ui.press({ key: 'alert-ask' })
  expect((await ui.find({ key: 'alert-ask' }))?.text).toContain('✓')
  await ui.unmount()
})

test('macOS alerts go through osascript, with the texts as arguments', async ($, on) => {
  const { clock, alerts, natives } = host(on, [snapshot()], { os: 'darwin' })
  await $.session.start(SESSION)
  await clock.settle()
  await $.tool.call(ASK)
  await clock.settle()

  expect(alerts).toHaveLength(0)
  expect(natives[0]?.[0]).toBe('osascript')
  expect(natives[0]?.slice(-2)).toEqual(['Claude asks', 'Which repo?'])
})

test('Windows alerts are a PowerShell toast with the texts quoted, and the config under USERPROFILE', async ($, on) => {
  const { clock, natives, writes } = host(on, [snapshot()], { os: 'win32' })
  await $.session.start(SESSION)
  await clock.settle()
  await $.tool.call(ask("It's <b> & $x"))
  await clock.settle()

  const script = natives[0]?.at(-1) ?? ''
  expect(natives[0]?.[0]).toBe('powershell.exe')
  expect(script).toContain("[Security.SecurityElement]::Escape('It''s <b> & $x')")
  expect(script).toContain('ToastNotificationManager')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'alert-done' })
  expect(writes[0]).toContain('C:\\Users\\me/.config/agent-watch/config.json ')
  await ui.unmount()
})

test('a server that asks for a login gets the token steps, and the saved token goes in a Bearer header', async ($, on) => {
  const own = 'https://notify.example.net/alerts'
  const { clock, phones } = host(on, [snapshot()], { ntfyLocked: true })
  await $.session.start(SESSION)
  await clock.settle()

  const refused = await $.command.run(typed('leviro-agent-watcher-phone', own))
  expect(refused.text).toContain('the test alert was refused (HTTP 403)')
  expect(refused.text).toContain('ntfy access <user> alerts rw')
  expect(refused.text).toContain('ntfy token add --label=leviro-agent-watcher <user>')
  expect(refused.text).toContain(`printf '{"ntfyToken":"%s"}'`)
  expect(phones[0]).toBe(
    `${own} | leviro-agent-watcher | Phone alerts work: questions, finished turns, relays and limits arrive here.`,
  )
})

test(
  'with ntfyToken saved, the test alert and every alert carry it, and no output shows it',
  { options: { ntfyToken: 'tk_test' } },
  async ($, on) => {
    const own = 'https://notify.example.net/alerts'
    const { clock, phones, writes } = host(on, [snapshot()], { ntfyLocked: true, ntfyUrl: own })
    await $.session.start(SESSION)
    await clock.settle()

    const sent = await $.command.run(typed('leviro-agent-watcher-phone', 'test'))
    expect(sent.text).toContain(`Phone alerts go to ${own}: a test alert was sent.`)
    expect(sent.text).not.toContain('tk_test')
    expect(writes.join('\n')).not.toContain('tk_test')

    await $.tool.call(ask('Ship it?'))
    await clock.settle()
    expect(phones.at(-1)).toBe(`${own} | Claude asks | Ship it? | Bearer tk_test`)
  },
)
