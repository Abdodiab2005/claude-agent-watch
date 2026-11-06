// Codex JSON hooks and a terminal view. No Claude runtime or model calls.
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { delivery } from './delivery.mjs'
import { cacheDirectory, configFile, notify, readConfig } from './notify.mjs'
import { routeCheck } from './routing.mjs'

const execute = promisify(execFile)
const collector = fileURLToPath(new URL('./collect.mjs', import.meta.url))
const hash = value => createHash('sha256').update(value).digest('hex')
const text = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 300) : ''
const read = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback } }
const entries = path => { try { return readdirSync(path) } catch { return [] } }

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const draft = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(draft, JSON.stringify(value), { mode: 0o600 })
    renameSync(draft, path)
  } finally { rmSync(draft, { force: true }) }
}

export function sessionDirectory(cache, id) { return join(cache, 'codex', hash(id)) }

// Keep bounded display metadata. Never persist prompts, commands/results,
// approval reasons, transcript paths or assistant answers.
export async function handleHook(event, { cache = cacheDirectory, now = Date.now(), send = notify } = {}) {
  if (!event || typeof event.session_id !== 'string' || !event.session_id) return {}
  const directory = sessionDirectory(cache, event.session_id)
  const path = name => join(directory, `${name}.json`)
  const turn = typeof event.turn_id === 'string' ? hash(event.turn_id) : undefined
  const turnPath = turn ? path(`turn-${turn}`) : undefined
  const kind = event.hook_event_name
  const alert = (name, title, body, id) => send({ kind: name, title, body, id: hash(`codex:${event.session_id}:${id}`) }, { cache })

  if (kind === 'SessionStart') {
    write(path('session'), { cwd: text(event.cwd), at: now })
    // Hash ids before using them as paths. Expire orphaned metadata after 8d.
    const root = join(cache, 'codex')
    for (const name of entries(root)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue
      const stale = read(join(root, name, 'session.json'), {})
      if (now - stale.at > 8 * 86_400_000) rmSync(join(root, name), { recursive: true, force: true })
    }
  } else if (kind === 'UserPromptSubmit' && turnPath) {
    // Keep the first start time when a turn is resubmitted by another hook.
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      writeFileSync(turnPath, JSON.stringify({ at: now }), { flag: 'wx', mode: 0o600 })
    } catch (error) { if (error.code !== 'EEXIST') throw error }
  } else if (kind === 'PreToolUse') {
    const command = event.tool_input?.command ?? event.tool_input?.cmd
    if (event.tool_name === 'Bash' && typeof command === 'string') {
      const reason = routeCheck(command, read(join(cache, 'snapshot.json'), null), now)
      if (reason) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
    }
    if (['request_user_input', 'request_user_input_async', 'AskUserQuestion'].includes(event.tool_name)) {
      await alert('ask', 'Codex asks', 'A question waits for you. Open Codex to reply.', `ask:${event.tool_use_id ?? turn}`)
    }
  } else if (kind === 'PermissionRequest') {
    await alert('ask', 'Codex needs approval', 'A permission request waits for you. Open Codex to review it.', `permission:${turn}:${hash(JSON.stringify(event.tool_input ?? {}))}`)
    // Notification only: do not approve, deny, or rewrite the permission.
  } else if (kind === 'PostToolUse' && event.tool_name === 'update_plan') {
    if (Array.isArray(event.tool_input?.plan) && event.tool_response?.isError !== true) {
      write(path('plan'), event.tool_input.plan.filter(one => one && typeof one.step === 'string').slice(0, 100).map(one => ({
        text: text(one.step), status: ['pending', 'in_progress', 'completed'].includes(one.status) ? one.status : 'pending',
      })))
    }
  } else if (['SubagentStart', 'SubagentStop'].includes(kind) && typeof event.agent_id === 'string') {
    // Separate start/stop files make a late concurrent start harmless.
    const prefix = kind === 'SubagentStart' ? 'agent' : 'ended'
    write(path(`${prefix}-${hash(event.agent_id)}`), { type: text(event.agent_type), at: now })
  } else if (kind === 'Stop' && turnPath && !event.stop_hook_active) {
    const started = read(turnPath, {})
    if (now - started.at >= 15_000 && !read(path(`interrupt-${turn}`), false)) {
      await alert('done', 'Codex finished', 'The turn ended. Open Codex to review the response.', `done:${turn}`)
    }
  } else if (kind === 'Interrupt' && turn) {
    write(path(`interrupt-${turn}`), true)
  } else if (kind === 'SessionEnd') {
    rmSync(directory, { recursive: true, force: true })
  }
  return {}
}

async function collect() {
  const { stdout } = await execute(process.execPath, ['--no-warnings', collector], { timeout: 70_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
  return JSON.parse(stdout)
}

export async function poll({ cache = cacheDirectory, now = Date.now(), collectSnapshot = collect, send = notify, alerts = true } = {}) {
  const path = join(cache, 'snapshot.json')
  let snapshot = read(path, null)
  if (!snapshot || now - snapshot.at >= 30_000) {
    const directory = join(cache, 'deliveries')
    const reserved = delivery('acquire', 'codex-collector', undefined, directory)
    if (reserved.startsWith('lease:')) {
      try {
        // Recheck after acquiring: a concurrent poll may have refreshed it.
        snapshot = read(path, null)
        if (!snapshot || now - snapshot.at >= 30_000) {
          snapshot = await collectSnapshot()
          write(path, snapshot)
        }
      } finally { delivery('release', 'codex-collector', reserved.slice(6), directory) }
    }
  }
  if (alerts && snapshot && now - snapshot.at < 60_000) {
    for (const one of snapshot.alerts ?? []) await send(one, { cache })
  }
  return snapshot
}

export function sessions(cache = cacheDirectory, sessionId) {
  const root = join(cache, 'codex')
  const names = sessionId ? [hash(sessionId)] : entries(root).filter(name => /^[a-f0-9]{64}$/.test(name))
  return names.flatMap(name => {
    const directory = join(root, name)
    const session = read(join(directory, 'session.json'), null)
    if (!session) return []
    return [{ ...session, id: name.slice(0, 8), plan: read(join(directory, 'plan.json'), []),
      agents: entries(directory).filter(name => /^agent-[a-f0-9]{64}\.json$/.test(name))
        .filter(name => !read(join(directory, name.replace('agent-', 'ended-')), false))
        .map(name => read(join(directory, name), {})),
    }]
  }).sort((a, b) => b.at - a.at)
}

function duration(ms) {
  const minutes = Math.max(0, Math.ceil(ms / 60_000))
  return minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${Math.floor(minutes / 1440)}d${Math.floor(minutes / 60) % 24}h`
}

export function render(snapshot, active = [], now = Date.now()) {
  if (!snapshot) return 'Agents: collecting the first reading; try again shortly.\n'
  const lines = [`Agents · ${new Date(snapshot.at).toISOString()}${now - snapshot.at > 60_000 ? ' (stale)' : ''}`, '', 'Limits']
  const rows = [...(snapshot.claude ? [snapshot.claude] : []), ...snapshot.agents]
  for (const row of rows) {
    if (!row.windows.length) lines.push(`  ${row.name}: ${text(row.note) || 'no current reading'}`)
    for (const window of row.windows) {
      const percent = Math.max(0, Math.min(100, Math.round(window.percentUsed)))
      const filled = Math.round(percent / 10)
      const reset = window.resetsAt ? ` · resets ${duration(window.resetsAt - now)}` : ''
      const forecast = snapshot.forecasts?.[`${row.id}|${window.label}`]
      lines.push(`  ${row.name} ${text(window.label)} [${'#'.repeat(filled)}${'-'.repeat(10 - filled)}] ${percent}%${reset}${forecast ? ` · out ~${duration(forecast - now)}` : ''}`)
    }
  }
  lines.push('', 'Running')
  for (const run of snapshot.runs) lines.push(`  ${text(run.agent)} · ${text(run.repo)} · ${text(run.brief)} · ${duration(now - run.startedAt)}${run.progressAt ? ` · idle ${duration(now - run.progressAt)}` : ''}`)
  for (const session of active) {
    for (const agent of session.agents) lines.push(`  Codex ${text(agent.type)} · ${session.id} · ${duration(now - agent.at)}`)
  }
  if (!snapshot.runs.length && !active.some(session => session.agents.length)) lines.push('  none')
  for (const run of snapshot.finished ?? []) lines.push(`  ${text(run.agent)} ${text(run.status)} · ${text(run.repo)} · ${run.files ?? '?'} files`)
  lines.push('', 'Plan')
  for (const session of active.filter(session => session.plan.length)) {
    lines.push(`  ${text(basename(session.cwd))} · ${session.id}`)
    for (const item of session.plan) lines.push(`  ${item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[>]' : '[ ]'} ${text(item.text)}`)
  }
  if (!active.some(session => session.plan.length)) lines.push('  no plan recorded')
  if (snapshot.error) lines.push('', `Collector: ${text(snapshot.error)}`)
  return `${lines.join('\n')}\n`
}

async function input() {
  let body = ''
  for await (const chunk of process.stdin) {
    body += chunk
    if (body.length > 1024 * 1024) throw new Error('hook input too large')
  }
  return JSON.parse(body || '{}')
}

async function main() {
  const [mode = 'status', ...args] = process.argv.slice(2)
  if (mode === 'hook') {
    try { process.stdout.write(JSON.stringify(await handleHook(await input()))) }
    catch { process.stderr.write('agent-watch: hook unavailable; normal Codex flow continues.\n'); process.stdout.write('{}') }
  } else if (mode === 'poll') {
    await input()
    await poll()
  } else if (mode === 'status' || mode === 'watch') {
    const sessionId = args[1]
    if (args.length && (args[0] !== '--session' || args.length !== 2 || !sessionId)) throw new Error('usage')
    do {
      const snapshot = await poll({ alerts: mode === 'watch' })
      if (mode === 'watch' && process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H')
      process.stdout.write(render(snapshot, sessions(cacheDirectory, sessionId)))
      if (mode === 'status') break
      await new Promise(resolve => setTimeout(resolve, 30_000))
    } while (true)
  } else if (mode === 'alerts') {
    const [setting, target = 'all'] = args
    const kinds = ['ask', 'done', 'relay', 'limit']
    if (!['on', 'off'].includes(setting) || !['all', 'desktop', 'ntfy', 'telegram', ...kinds].includes(target) || args.length > 2) throw new Error('usage')
    const config = readConfig()
    const off = new Set(Array.isArray(config.off) ? config.off : [])
    for (const one of target === 'all' ? kinds : [target]) setting === 'off' ? off.add(one) : off.delete(one)
    write(configFile, { ...config, off: [...off] })
    process.stdout.write(`Alerts ${target}: ${setting}\n`)
  } else throw new Error('usage')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // HTTP/subprocess errors can contain credentials; never echo them.
    process.stderr.write('agent-watch: unable to run. Usage: codex.mjs status|watch [--session ID], alerts on|off [channel|kind], hook, poll\n')
    process.exitCode = 1
  })
}
