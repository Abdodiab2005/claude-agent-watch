// Atomic, per-channel delivery leases shared by all agent-watch sessions.
// An event is marked sent only after its transport confirms success.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const [action, key, owner] = process.argv.slice(2)
if (!['acquire', 'commit', 'release'].includes(action) || !key || (action !== 'acquire' && !owner)) {
  process.stderr.write('usage: delivery.mjs <acquire|commit|release> <event:channel:destination> [lease]\\n')
  process.exit(2)
}

const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
const directory = join(cache, 'agent-watch', 'deliveries')
const hash = createHash('sha256').update(key).digest('hex')
const sent = join(directory, `${hash}.sent`)
const lock = join(directory, `${hash}.lock`)
const LEASE_MS = 120_000
mkdirSync(directory, { recursive: true, mode: 0o700 })

if (action === 'acquire') {
  if (existsSync(sent)) {
    process.stdout.write('sent')
  } else {
    try {
      if (Date.now() - statSync(lock).mtimeMs > LEASE_MS) rmSync(lock, { force: true })
    } catch { /* no active lease */ }
    const token = randomUUID()
    try {
      writeFileSync(lock, token, { flag: 'wx', mode: 0o600 })
      if (existsSync(sent)) {
        rmSync(lock, { force: true })
        process.stdout.write('sent')
      } else {
        process.stdout.write(`lease:${token}`)
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      process.stdout.write('busy')
    }
  }
} else {
  let valid = false
  try { valid = readFileSync(lock, 'utf8') === owner } catch { /* expired lease */ }
  if (valid) {
    if (action === 'commit') {
      try { writeFileSync(sent, String(Date.now()), { flag: 'wx', mode: 0o600 }) }
      catch (error) { if (error?.code !== 'EEXIST') throw error }
    }
    rmSync(lock, { force: true })
    process.stdout.write(action === 'commit' ? 'sent' : 'released')
  } else {
    process.stdout.write('stale')
  }
}
