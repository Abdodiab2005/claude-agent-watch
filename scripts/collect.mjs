// Reads the usage records the delegate agents keep on this machine and the
// relay processes running now, and prints one JSON snapshot on stdout.
// Every reader is read-only and fails soft: a missing CLI gives a note.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'

import { listProcesses, parseRelay } from './platform.mjs'

const HOME = homedir()
const NOW = Date.now()
const HOUR = 3_600_000
const TAIL_BYTES = 1_048_576
const eventId = key => createHash('sha256').update(key).digest('hex').slice(0, 32)

function tail(path, bytes = TAIL_BYTES) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const buffer = Buffer.alloc(size - start)
    readSync(fd, buffer, 0, buffer.length, start)
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function list(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function mtime(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function windowLabel(minutes) {
  if (minutes === 300) return '5h'
  if (minutes === 10080) return 'week'
  return minutes % 1440 === 0 ? `${minutes / 1440}d` : `${Math.round(minutes / 60)}h`
}

// Codex writes a token_count event with `rate_limits` after each model call:
// primary is the 5-hour window, secondary the weekly one.
function codex() {
  const row = { id: 'codex', name: 'Codex', windows: [] }
  const root = join(HOME, '.codex', 'sessions')
  if (!existsSync(root)) return { ...row, note: 'no ~/.codex/sessions' }

  const files = []
  for (let back = 0; back < 8; back += 1) {
    const day = new Date(NOW - back * 24 * HOUR)
    const dir = join(
      root,
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'),
      String(day.getDate()).padStart(2, '0'),
    )
    for (const entry of list(dir)) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const path = join(dir, entry.name)
        files.push({ path, mtimeMs: mtime(path) })
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (files.length > 0) row.lastActiveAt = files[0].mtimeMs

  for (const file of files.slice(0, 6)) {
    const lines = tail(file.path).split('\n')
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].includes('"rate_limits":{')) continue
      try {
        const limits = JSON.parse(lines[i]).payload?.rate_limits
        if (!limits) continue
        for (const one of [limits.primary, limits.secondary]) {
          if (!one) continue
          const resetsAt = one.resets_at ? one.resets_at * 1000 : undefined
          const hasReset = resetsAt !== undefined && resetsAt < NOW
          row.windows.push({
            label: windowLabel(one.window_minutes),
            percentUsed: hasReset ? 0 : one.used_percent,
            resetsAt: hasReset ? undefined : resetsAt,
            windowMs: one.window_minutes * 60_000,
          })
        }
        return row
      } catch {
        // A line cut by the tail read: try the one before it.
      }
    }
  }
  return { ...row, note: 'no rate-limit reading in the last 8 days' }
}

// `agy -p /usage --output-format json` prints agy's own quota summary: per
// model group, a 5-hour and a weekly bucket with the fraction left. It takes
// about 4 s, so its answer is cached; a running agy relay shortens the cache.
const CACHE = join(process.env.XDG_CACHE_HOME || join(HOME, '.cache'), 'agent-watch')
const GROUP_LABELS = { 'Gemini Models': 'Gemini', 'Claude and GPT models': 'Claude/GPT', 'Gemini 4 Argon': 'Argon' }

function agyUsage(isBusy) {
  const cachePath = join(CACHE, 'agy-usage.json')
  const maxAgeMs = isBusy ? 60_000 : 5 * 60_000
  if (NOW - mtime(cachePath) < maxAgeMs) return JSON.parse(readFileSync(cachePath, 'utf8'))

  mkdirSync(CACHE, { recursive: true })
  const logPath = join(CACHE, 'agy-usage.log')
  try {
    const out = execFileSync('agy', ['-p', '/usage', '--output-format', 'json', '--log-file', logPath], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PATH: `${process.env.PATH ?? ''}${delimiter}${join(HOME, '.local', 'bin')}` },
      windowsHide: true,
    })
    const groups = JSON.parse(out).command?.data?.groups
    if (!Array.isArray(groups)) throw new Error('agy /usage answered no quota groups')
    writeFileSync(cachePath, JSON.stringify(groups))
    return groups
  } finally {
    rmSync(logPath, { force: true })
  }
}

function antigravity(runs) {
  const row = { id: 'agy', name: 'Antigravity', windows: [] }
  const root = join(HOME, '.gemini', 'antigravity-cli')
  if (!existsSync(root)) return { ...row, note: 'no ~/.gemini/antigravity-cli' }
  row.lastActiveAt = Math.max(mtime(join(root, 'history.jsonl')), mtime(join(root, 'conversations'))) || undefined

  const groups = agyUsage(runs.some(run => run.agent === 'agy'))
  for (const group of groups) {
    const name = GROUP_LABELS[group.name] ?? group.name
    const buckets = [...(group.buckets ?? [])].sort((a, b) => (a.window === '5h' ? 0 : 1) - (b.window === '5h' ? 0 : 1))
    for (const bucket of buckets) {
      if (bucket.disabled || typeof bucket.remaining_fraction !== 'number') continue
      const resetsAt = bucket.reset_time ? Date.parse(bucket.reset_time) : undefined
      row.windows.push({
        label: `${name} ${bucket.window === 'weekly' ? 'week' : bucket.window}`,
        percentUsed: Math.round((1 - bucket.remaining_fraction) * 1000) / 10,
        resetsAt: resetsAt !== undefined && resetsAt > NOW ? resetsAt : undefined,
      })
    }
  }
  return row
}

// Grok keeps its weekly allowance on xAI's server. The billing endpoint the
// Grok CLI calls answers it for the login token in ~/.grok/auth.json. The
// token stays in this process: it is sent only to xAI and never printed. An
// expired token is reported; refreshing it is left to the grok CLI, which
// owns the refresh token.
const GROK_BILLING = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
const PERIOD_LABELS = { USAGE_PERIOD_TYPE_WEEKLY: 'week', USAGE_PERIOD_TYPE_MONTHLY: 'month' }

async function grokBilling(isBusy) {
  const cachePath = join(CACHE, 'grok-billing.json')
  const maxAgeMs = isBusy ? 2 * 60_000 : 5 * 60_000
  if (NOW - mtime(cachePath) < maxAgeMs) return { config: JSON.parse(readFileSync(cachePath, 'utf8')) }

  const auth = JSON.parse(readFileSync(join(HOME, '.grok', 'auth.json'), 'utf8'))
  const entry = Object.values(auth).find(one => typeof one?.key === 'string')
  if (entry === undefined) return { note: 'not logged in; run grok login' }
  if (Date.parse(entry.expires_at) < NOW) return { note: 'login expired; run grok once to refresh it' }

  const response = await fetch(GROK_BILLING, {
    headers: { authorization: `Bearer ${entry.key}`, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  })
  if (response.status === 401 || response.status === 403) return { note: 'login refused; run grok once to refresh it' }
  if (!response.ok) return { note: `billing answered HTTP ${response.status}` }
  const config = (await response.json()).config
  if (typeof config?.creditUsagePercent !== 'number') return { note: 'billing answered no usage figure' }
  mkdirSync(CACHE, { recursive: true })
  writeFileSync(cachePath, JSON.stringify(config))
  return { config }
}

async function grok(runs) {
  const row = { id: 'grok', name: 'Grok', windows: [] }
  const root = join(HOME, '.grok', 'sessions')
  let last = 0
  for (const project of list(root)) {
    if (!project.isDirectory()) continue
    for (const session of list(join(root, project.name))) {
      if (session.isDirectory()) last = Math.max(last, mtime(join(root, project.name, session.name, 'summary.json')))
    }
  }
  row.lastActiveAt = last || undefined
  if (!existsSync(join(HOME, '.grok', 'auth.json'))) return { ...row, note: 'no ~/.grok/auth.json' }

  const { config, note } = await grokBilling(runs.some(run => run.agent === 'grok'))
  if (config === undefined) return { ...row, note }
  const end = Date.parse(config.currentPeriod?.end ?? config.billingPeriodEnd)
  const start = Date.parse(config.currentPeriod?.start ?? config.billingPeriodStart)
  row.windows.push({
    label: PERIOD_LABELS[config.currentPeriod?.type] ?? 'period',
    percentUsed: config.creditUsagePercent,
    resetsAt: end > NOW ? end : undefined,
    windowMs: end > start ? end - start : undefined,
  })
  return row
}

// Each delegate skill runs `<agent>-delegate/scripts/relay.mjs` until its
// implementer ends, so a live relay process is a running task. Its
// `--out-dir` (by default a fresh folder under <tmp>/delegate-relay) gets
// the run's files and, at the end, result.json.
const RELAY_TMP = join(tmpdir(), 'delegate-relay')

function defaultOutDir(cwd, startedAt) {
  const prefix = `${basename(cwd)}-`
  return list(RELAY_TMP)
    .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix))
    .map(entry => join(RELAY_TMP, entry.name))
    .filter(path => mtime(path) >= startedAt - 10_000)
    .sort((a, b) => mtime(b) - mtime(a))[0]
}

function runs() {
  const found = []
  for (const proc of listProcesses(NOW)) {
    const relay = parseRelay(proc.command)
    if (relay === undefined) continue
    found.push({
      pid: proc.pid,
      agent: relay.agent,
      repo: basename(relay.cwd) || '?',
      brief: basename(relay.brief),
      startedAt: proc.startedAt,
      isReadOnly: relay.isReadOnly,
      cwd: relay.cwd,
      outDir: relay.outDir ?? defaultOutDir(relay.cwd, proc.startedAt),
      model: relay.model,
    })
  }
  return found.sort((a, b) => a.startedAt - b.startedAt)
}

// The newest change a run made: a file in its out-dir (the implementer's
// event log grows there) or a file git reports changed in its repository.
function progressAt(run) {
  let last = run.startedAt
  if (run.outDir) for (const entry of list(run.outDir)) last = Math.max(last, mtime(join(run.outDir, entry.name)))
  if (run.cwd) {
    try {
      const out = execFileSync('git', ['-C', run.cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'], {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 8 << 20,
        // Never take the index lock the implementer's own git calls need.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        windowsHide: true,
      })
      for (const entry of out.split('\0').slice(0, 300)) {
        if (entry.length > 3) last = Math.max(last, mtime(join(run.cwd, entry.slice(3))))
      }
    } catch {
      // Not a repository, or git is busy: the out-dir alone speaks.
    }
  }
  return last
}

async function safe(id, name, read) {
  try {
    return await read()
  } catch (error) {
    return { id, name, windows: [], note: `read failed: ${String(error?.message ?? error).slice(0, 80)}` }
  }
}

// Alerts for what the whole machine shares (a relay that ended or stalled,
// a limit past WARN_PERCENT or on course to run out) are decided here, so
// that with several sessions open each one is sent once: the session whose
// collector first creates the claim file (an exclusive create, atomic across
// processes) sends it.
const WARN_PERCENT = 90
const STALL_MS = 20 * 60_000
const CLAIMS = join(CACHE, 'claims')
const RUNS_SEEN = join(CACHE, 'runs-seen.json')
const FINISHED = join(CACHE, 'finished.json')
const DAY = 24 * HOUR

function span(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(path, value) {
  mkdirSync(CACHE, { recursive: true })
  const draft = `${path}.${process.pid}`
  writeFileSync(draft, JSON.stringify(value))
  try {
    renameSync(draft, path)
  } catch {
    // Windows refuses to replace a file another process has open: write in place.
    writeFileSync(path, JSON.stringify(value))
    rmSync(draft, { force: true })
  }
}

function claim(key) {
  mkdirSync(CLAIMS, { recursive: true })
  try {
    closeSync(openSync(join(CLAIMS, key.replace(/[^\w.-]/g, '_')), 'wx'))
    return true
  } catch {
    return false
  }
}

function pruneClaims() {
  for (const dir of [CLAIMS, join(CACHE, 'deliveries')]) {
    for (const entry of list(dir)) {
      const path = join(dir, entry.name)
      // Keep in-flight leases until delivery.mjs expires them after 2m.
      if (NOW - mtime(path) > 8 * DAY) rmSync(path, { force: true })
    }
  }
}

const runKey = run => `${run.pid}-${run.agent}-${run.brief}`

function summarize(run) {
  const result = run.outDir ? readJson(join(run.outDir, 'result.json'), {}) : {}
  return {
    agent: run.agent,
    repo: run.repo,
    brief: run.brief,
    status: typeof result.status === 'string' ? result.status : 'ended',
    files: Array.isArray(result.touchedFiles) ? result.touchedFiles.length : undefined,
    startedAt: run.startedAt,
    endedAt: NOW,
  }
}

// Runs another session saw that are gone now, each claimed by one session.
function endedRuns(running) {
  const seen = readJson(RUNS_SEEN, undefined)
  writeJson(RUNS_SEEN, { at: NOW, runs: running })
  // A list no session wrote for 3 minutes is too old to time an end by.
  if (seen === undefined || NOW - seen.at > 3 * 60_000) return []
  const live = new Set(running.map(runKey))
  const ended = seen.runs.filter(run => !live.has(runKey(run)) && claim(`ended-${runKey(run)}`)).map(summarize)
  if (ended.length > 0) writeJson(FINISHED, [...ended, ...readJson(FINISHED, [])].slice(0, 10))
  return ended
}

// When a window reaches 100% at the average pace since it opened (idle
// hours included), kept only where that is before it resets. The pace of the
// last hour or two overstates a week: it assumes the burst never stops.
// A window under a fifth gone has too little history to judge. Only fixed
// windows carry `windowMs`: Antigravity's buckets refill as they go, their
// reset time moving with use, so they get no forecast.

function forecasts(rows) {
  const found = {}
  for (const row of rows) {
    for (const window of row.windows) {
      const windowMs = window.windowMs
      if (window.resetsAt === undefined || windowMs === undefined) continue
      const elapsed = NOW - (window.resetsAt - windowMs)
      if (elapsed < windowMs / 5 || window.percentUsed <= 0 || window.percentUsed >= 100) continue
      const outAt = Math.round(NOW + ((100 - window.percentUsed) * elapsed) / window.percentUsed)
      if (outAt < window.resetsAt) found[`${row.id}|${window.label}`] = outAt
    }
  }
  return found
}

function limitAlerts(rows, outAts) {
  const alerts = []
  for (const row of rows) {
    for (const window of row.windows) {
      const period = window.resetsAt ?? `day-${Math.floor(NOW / DAY)}`
      const reset = window.resetsAt === undefined ? '' : `, resets in ${span(window.resetsAt - NOW)}`
      if (window.percentUsed >= WARN_PERCENT) {
        alerts.push({
          id: eventId(`warn:${row.id}:${window.label}:${period}`),
          kind: 'limit', title: 'Usage limit close',
          body: `${row.name} ${window.label} limit at ${Math.round(window.percentUsed)}%${reset}`,
        })
      }
      const outAt = outAts[`${row.id}|${window.label}`]
      if (outAt !== undefined && window.percentUsed >= 50) {
        alerts.push({
          id: eventId(`forecast:${row.id}:${window.label}:${period}`),
          kind: 'limit', title: 'Usage limit forecast',
          body: `${row.name} ${window.label} runs out in ~${span(outAt - NOW)} at this pace${reset}`,
        })
      }
    }
  }
  return alerts
}

// The session passes Claude's own windows, which only it can read.
function claudeWindows() {
  const at = process.argv.indexOf('--claude')
  try {
    return at < 0 ? [] : JSON.parse(process.argv[at + 1] ?? '[]')
  } catch {
    return []
  }
}

let running = []
let error
try {
  running = runs()
} catch (failure) {
  error = `process list failed: ${String(failure?.message ?? failure).slice(0, 80)}`
}
for (const run of running) run.progressAt = progressAt(run)
const agents = [
  await safe('codex', 'Codex', codex),
  await safe('agy', 'Antigravity', () => antigravity(running)),
  await safe('grok', 'Grok', () => grok(running)),
]

const alerts = []
let outAts = {}
try {
  pruneClaims()
  if (error === undefined) endedRuns(running)
  // Re-offer recent completions instead of claiming a notification before
  // sending it. Per-channel receipts suppress repeat delivery.
  for (const done of readJson(FINISHED, []).filter(one => NOW - one.endedAt < HOUR).slice(0, 10)) {
    const files = done.files === undefined ? '' : ` · ${done.files} file${done.files === 1 ? '' : 's'}`
    alerts.push({
      id: eventId(`ended:${done.agent}:${done.repo}:${done.brief}:${done.startedAt}`),
      kind: 'relay',
      title: `${done.agent} ${done.status}`,
      body: `${done.repo} · ${done.brief}${files} · ${span(done.endedAt - done.startedAt)}`,
    })
  }
  for (const run of running) {
    const idleMs = NOW - run.progressAt
    if (NOW - run.startedAt >= STALL_MS && idleMs >= STALL_MS) {
      alerts.push({
        id: eventId(`stuck:${runKey(run)}:${run.startedAt}:${run.progressAt}`),
        kind: 'relay', title: `${run.agent} may be stuck`,
        body: `${run.repo} · ${run.brief}: no file change for ${span(idleMs)}`,
      })
    }
  }
  const rows = [{ id: 'claude', name: 'Claude', windows: claudeWindows() }, ...agents]
  outAts = forecasts(rows)
  alerts.push(...limitAlerts(rows, outAts))
} catch (failure) {
  error = `alerts failed: ${String(failure?.message ?? failure).slice(0, 80)}`
}
const finished = readJson(FINISHED, []).filter(done => NOW - done.endedAt < HOUR).slice(0, 3)
process.stdout.write(JSON.stringify({ at: NOW, agents, runs: running, finished, forecasts: outAts, alerts, error }))
