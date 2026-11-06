import assert from 'node:assert/strict'
import { execFileSync, execSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { handleHook, poll, render, sessionDirectory, sessions } from '../scripts/codex.mjs'
import { delivery } from '../scripts/delivery.mjs'
import { desktopCommand, notify } from '../scripts/notify.mjs'
import { routeCheck } from '../scripts/routing.mjs'

const NOW = 1_793_562_512_000
const root = fileURLToPath(new URL('../', import.meta.url))
const snapshot = () => ({ at: NOW, agents: [
  { id: 'codex', name: 'Codex', windows: [{ label: '5h', percentUsed: 93, resetsAt: NOW + 3_600_000 }] },
  { id: 'grok', name: 'Grok', windows: [{ label: 'week', percentUsed: 30 }] },
], runs: [], alerts: [{ id: 'shared', kind: 'limit', title: 'Usage limit close', body: 'Codex at 93%' }] })

function fixture(t) {
  const cache = mkdtempSync(join(tmpdir(), 'agent-watch-test-'))
  t.after(() => rmSync(cache, { recursive: true, force: true }))
  const alerts = []
  const send = async alert => { alerts.push(alert); return true }
  const hook = (kind, extra = {}, at = NOW) => handleHook({ session_id: 'thread-1', turn_id: 'turn-1',
    cwd: '/repo/shop', hook_event_name: kind, ...extra }, { cache, now: at, send })
  return { cache, alerts, send, hook }
}

test('shared routing preserves quota, age, model-group and explicit-override behavior', () => {
  const command = 'node /skills/codex-delegate/scripts/relay.mjs --brief b'
  const snap = snapshot()
  assert.match(routeCheck(command, snap, NOW), /Grok \(30% used\)/)
  assert.equal(routeCheck(`AGENT_WATCH_ALLOW=1 ${command}`, snap, NOW), undefined)
  assert.equal(routeCheck(`${command} --help`, snap, NOW), undefined)
  assert.equal(routeCheck(command, snap, NOW + 600_001), undefined)
  assert.equal(routeCheck(command, null, NOW), undefined)
  assert.equal(routeCheck('node /skills/grok-delegate/scripts/relay.mjs', snap, NOW), undefined)
  assert.equal(routeCheck('echo ordinary', snap, NOW), undefined)
  snap.agents.push({ id: 'agy', name: 'Antigravity', windows: [
    { label: 'Gemini 5h', percentUsed: 20 }, { label: 'Claude/GPT 5h', percentUsed: 95 },
    { label: 'Argon 5h', percentUsed: 100 },
  ] })
  const agy = 'node /skills/agy-delegate/scripts/relay.mjs'
  assert.equal(routeCheck(`${agy} --model gemini`, snap, NOW), undefined)
  assert.match(routeCheck(`${agy} --model 'claude-sonnet'`, snap, NOW), /Claude\/GPT/)
  assert.match(routeCheck(`${agy} --model argon`, snap, NOW), /Argon/)
})

test('Codex hook denies only a spent relay; permission requests notify without deciding', async t => {
  const { cache, hook, alerts } = fixture(t)
  writeFileSync(join(cache, 'snapshot.json'), JSON.stringify(snapshot()))
  const verdict = await hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'node /codex-delegate/scripts/relay.mjs' } })
  assert.equal(verdict.hookSpecificOutput.permissionDecision, 'deny')
  assert.deepEqual(await hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo test' } }), {})
  assert.deepEqual(await hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'SECRET-COMMAND' } }), {})
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].kind, 'ask')
  assert.doesNotMatch(JSON.stringify(alerts), /SECRET-COMMAND/)
  writeFileSync(join(cache, 'snapshot.json'), '{bad')
  assert.deepEqual(await hook('PreToolUse', { tool_name: 'Bash', tool_input: { cmd: 'node /codex-delegate/scripts/relay.mjs' } }), {})
})

test('questions and completed turns send generic alerts; quick, interrupted and continuing turns stay quiet', async t => {
  const { hook, alerts } = fixture(t)
  await hook('PreToolUse', { tool_name: 'request_user_input', tool_use_id: 'q1', tool_input: { questions: ['PRIVATE-QUESTION'] } })
  await hook('UserPromptSubmit', { prompt: 'PRIVATE-PROMPT' })
  await hook('Stop', { last_assistant_message: 'PRIVATE-ANSWER' }, NOW + 14_999)
  assert.equal(alerts.length, 1)
  await hook('Stop', { stop_hook_active: true }, NOW + 20_000)
  assert.equal(alerts.length, 1)
  await hook('Stop', { last_assistant_message: 'PRIVATE-ANSWER' }, NOW + 20_000)
  assert.equal(alerts.length, 2)
  assert.equal(alerts[1].kind, 'done')
  await hook('Interrupt', {}, NOW + 21_000)
  await hook('Stop', {}, NOW + 22_000)
  assert.equal(alerts.length, 2)
  assert.doesNotMatch(JSON.stringify(alerts), /PRIVATE-/)
})

test('session state is bounded, isolated, cleaned up, and never includes prompt or response payloads', async t => {
  const { cache, hook } = fixture(t)
  const unsafe = '../../outside'
  await hook('SessionStart', { session_id: unsafe })
  await hook('SessionStart')
  await hook('UserPromptSubmit', { prompt: 'PRIVATE-PROMPT', transcript_path: '/PRIVATE-TRANSCRIPT' })
  await hook('PostToolUse', { tool_name: 'update_plan', tool_input: { plan: Array.from({ length: 120 }, () => ({
    step: `Build\x1b[2J${'a'.repeat(500)}`, status: 'in_progress', hidden: 'PRIVATE-EXTRA',
  })) }, tool_response: { output: 'PRIVATE-RESULT' } })
  const rows = sessions(cache, 'thread-1')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].plan.length, 100)
  assert.equal(rows[0].plan[0].text.length, 300)
  assert.doesNotMatch(rows[0].plan[0].text, /\x1b/)
  assert.equal(sessions(cache).length, 2)
  assert.equal(dirname(sessionDirectory(cache, unsafe)), join(cache, 'codex'))
  const stored = readdirSync(sessionDirectory(cache, 'thread-1')).map(name => readFileSync(join(sessionDirectory(cache, 'thread-1'), name), 'utf8')).join('')
  assert.doesNotMatch(stored, /PRIVATE-/)
  await hook('SessionEnd')
  assert.equal(sessions(cache, 'thread-1').length, 0)
  assert.equal(sessions(cache).length, 1)
})

test('subagent start and stop are order-independent and a stopped agent never reappears', async t => {
  const { cache, hook } = fixture(t)
  await hook('SessionStart')
  await hook('SubagentStart', { agent_id: 'a', agent_type: 'reviewer' })
  assert.equal(sessions(cache)[0].agents.length, 1)
  await hook('SubagentStop', { agent_id: 'a', last_assistant_message: 'PRIVATE-ANSWER' })
  await hook('SubagentStart', { agent_id: 'a', agent_type: 'reviewer' })
  assert.equal(sessions(cache)[0].agents.length, 0)
  await hook('SubagentStop', { agent_id: 'b' })
  await hook('SubagentStart', { agent_id: 'b', agent_type: 'worker' })
  assert.equal(sessions(cache)[0].agents.length, 0)
})

test('Codex delivery retries only failed channels and shares receipts with the Claude CLI', async t => {
  const { cache } = fixture(t)
  const calls = []
  let ntfyFailures = 1
  const alert = snapshot().alerts[0]
  const options = { cache: join(cache, 'agent-watch'), config: { ntfyUrl: 'https://ntfy.test/private', telegramChatId: '42' },
    env: { AGENT_WATCH_NTFY_TOKEN: 'NTFY-SECRET', AGENT_WATCH_TELEGRAM_BOT_TOKEN: 'TELEGRAM-SECRET' },
    run: async (command, args) => { calls.push(command); assert.doesNotMatch(JSON.stringify(args), /SECRET/) },
    request: async (url, init) => {
      calls.push(url.includes('ntfy.test') ? 'ntfy' : 'telegram')
      assert.equal(init.redirect, 'error')
      if (url.includes('ntfy.test')) {
        assert.equal(init.headers.Authorization, 'Bearer NTFY-SECRET')
        return { ok: ntfyFailures-- <= 0 }
      }
      assert.equal(url, 'https://api.telegram.org/botTELEGRAM-SECRET/sendMessage')
      assert.equal(JSON.parse(init.body).chat_id, '42')
      return { ok: true, json: async () => ({ ok: true }) }
    },
  }
  await notify(alert, options)
  await notify(alert, options)
  await notify(alert, options)
  assert.deepEqual(calls.sort(), ['notify-send', 'ntfy', 'ntfy', 'telegram'].sort())
  // Claude's existing process-based transport sees the receipt made in Node.
  const cli = join(root, 'scripts', 'delivery.mjs')
  assert.equal(execFileSync(process.execPath, [cli, 'acquire', 'shared:desktop:local'], {
    encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: cache },
  }).trim(), 'sent')
  assert.equal(delivery('acquire', 'shared:desktop:local', undefined, join(cache, 'agent-watch', 'deliveries')), 'sent')
})

test('disabled channels and missing phone credentials do not consume delivery receipts', async t => {
  const { cache } = fixture(t)
  let sends = 0
  const alert = snapshot().alerts[0]
  const config = { ntfyUrl: 'https://ntfy.test/private', telegramChatId: '42', off: ['desktop', 'ntfy'] }
  const options = { cache, config, env: {}, run: async () => { throw new Error('unexpected desktop') },
    request: async () => { sends++; return { ok: true, json: async () => ({ ok: true }) } } }
  assert.equal(await notify(alert, options), false)
  config.off = ['desktop']
  await notify(alert, { ...options, env: { AGENT_WATCH_TELEGRAM_BOT_TOKEN: 'fake' } })
  assert.equal(sends, 2)
  config.off = ['limit']
  await notify({ ...alert, id: 'muted' }, options)
  assert.equal(sends, 2)
})

test('all native desktop transports pass messages as data and safely quote PowerShell literals', () => {
  const title = "user's $(touch /tmp/unsafe)"
  assert.deepEqual(desktopCommand(title, 'body', 'linux').slice(-2), [title, 'body'])
  assert.deepEqual(desktopCommand(title, 'body', 'darwin').slice(-2), [title, 'body'])
  const windows = desktopCommand(title, 'body', 'win32')
  assert.equal(windows[0], 'powershell.exe')
  assert.match(windows.at(-1), /user''s \$\(touch/)
  assert.match(windows.at(-1), /New-Object Windows.Data.Xml.Dom.XmlDocument/)
})

test('concurrent polls collect once, throttle for 30s, retry after failure, and status does not notify', async t => {
  const { cache, send, alerts } = fixture(t)
  let count = 0
  const collectSnapshot = async () => { count++; await new Promise(resolve => setTimeout(resolve, 5)); return snapshot() }
  await Promise.all(Array.from({ length: 5 }, () => poll({ cache, now: NOW, collectSnapshot, send, alerts: false })))
  assert.equal(count, 1)
  assert.equal(alerts.length, 0)
  await poll({ cache, now: NOW + 10_000, collectSnapshot, send })
  assert.equal(count, 1)
  assert.equal(alerts.length, 1)
  await assert.rejects(poll({ cache, now: NOW + 30_000, collectSnapshot: async () => { throw new Error('offline') }, send }))
  await poll({ cache, now: NOW + 30_000, collectSnapshot, send })
  assert.equal(count, 2)
})

test('terminal view shows limits, forecasts, relay progress, subagents and the plan without terminal escapes', () => {
  const snap = snapshot()
  snap.forecasts = { 'codex|5h': NOW + 120_000 }
  snap.runs = [{ agent: 'grok', repo: 'shop', brief: '\x1b[2Jbrief', startedAt: NOW - 30_000, progressAt: NOW - 25_000 }]
  snap.finished = [{ agent: 'grok', status: 'completed', repo: 'shop', files: 2 }]
  const output = render(snap, [{ cwd: '/repo/shop', id: 'session', agents: [{ type: 'worker', at: NOW }],
    plan: [{ text: 'Implement', status: 'in_progress' }] }], NOW)
  for (const expected of ['93%', 'out ~2m', 'idle 1m', 'worker', '[>] Implement', '2 files']) assert.ok(output.includes(expected))
  assert.doesNotMatch(output, /\x1b/)
  assert.match(render(snap, [], NOW + 61_000), /stale/)
})

test('packaged Codex hook commands handle paths with spaces, malformed input and unsupported events', t => {
  const { cache } = fixture(t)
  const plugin = join(cache, 'plugin with spaces')
  cpSync(join(root, 'scripts'), join(plugin, 'scripts'), { recursive: true })
  const manifest = JSON.parse(readFileSync(join(root, '.codex-plugin', 'plugin.json'), 'utf8'))
  assert.equal(manifest.hooks, './hooks/codex.json')
  const hooks = JSON.parse(readFileSync(join(root, 'hooks', 'codex.json'), 'utf8')).hooks
  const command = hooks.SessionStart[0].hooks[0].command
  const env = { ...process.env, PLUGIN_ROOT: plugin, XDG_CACHE_HOME: cache }
  for (const input of ['{bad', '{}', JSON.stringify({ hook_event_name: 'unknown', session_id: 'x' })]) {
    assert.deepEqual(JSON.parse(execSync(command, { env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })), {})
  }
  const start = { hook_event_name: 'SessionStart', session_id: 'cli', cwd: '/fixture' }
  assert.deepEqual(JSON.parse(execSync(command, { env, input: JSON.stringify(start), encoding: 'utf8' })), {})
  assert.equal(sessions(join(cache, 'agent-watch'), 'cli').length, 1)
})

test('real collector shares snapshots and expires Claude windows using fake local usage with no external calls', t => {
  const { cache } = fixture(t)
  const fakeHome = join(cache, 'home')
  const date = new Date(NOW)
  const day = join(fakeHome, '.codex', 'sessions', String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'))
  mkdirSync(day, { recursive: true })
  writeFileSync(join(day, 'rollout-fixture.jsonl'), JSON.stringify({ payload: { rate_limits: {
    primary: { window_minutes: 300, used_percent: 72, resets_at: (NOW + 3_600_000) / 1000 },
  } } }) + '\n')
  // Mock only the host boundary in the child; production collector code runs
  // unchanged, and no real agent directory or endpoint can be reached.
  const loader = join(cache, 'fake-host.mjs')
  writeFileSync(loader, `import os from 'node:os';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
os.homedir = () => ${JSON.stringify(fakeHome)};
cp.execFileSync = () => '';
Date.now = () => Number(process.env.AGENT_WATCH_TEST_NOW);
globalThis.fetch = () => { throw new Error('test forbids network'); };
syncBuiltinESMExports();\n`)
  const run = (at, args = []) => JSON.parse(execFileSync(process.execPath, ['--import', loader, join(root, 'scripts', 'collect.mjs'), ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, XDG_CACHE_HOME: cache, AGENT_WATCH_TEST_NOW: String(at) },
  }))
  const windows = [{ label: '5h', percentUsed: 40, resetsAt: NOW + 3_600_000, windowMs: 18_000_000 }]
  const first = run(NOW, ['--claude', JSON.stringify(windows)])
  assert.equal(first.agents.find(row => row.id === 'codex').windows[0].percentUsed, 72)
  assert.deepEqual(first.claude.windows, windows)
  assert.deepEqual(run(NOW + 60_000).claude.windows, windows)
  assert.deepEqual(run(NOW + 600_001).claude.windows, [])
  assert.equal(JSON.parse(readFileSync(join(cache, 'agent-watch', 'snapshot.json'))).at, NOW + 600_001)
  if (process.platform !== 'win32') assert.equal(statSync(join(cache, 'agent-watch', 'snapshot.json')).mode & 0o777, 0o600)
})
