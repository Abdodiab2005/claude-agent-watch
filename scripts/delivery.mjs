// Atomic, per-channel delivery leases shared by all watcher sessions.
// An event is marked sent only after its transport confirms success.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
const LEASE_MS = 120_000

export function delivery(action, key, owner, directory = join(cache, 'agent-watch', 'deliveries')) {
  if (!['acquire', 'commit', 'release'].includes(action) || !key || (action !== 'acquire' && !owner)) {
    throw new Error('usage: delivery.mjs <acquire|commit|release> <event:channel:destination> [lease]')
  }
  const hash = createHash('sha256').update(key).digest('hex')
  const sent = join(directory, `${hash}.sent`)
  const lock = join(directory, `${hash}.lock`)
  mkdirSync(directory, { recursive: true, mode: 0o700 })

  if (action === 'acquire') {
    if (existsSync(sent)) {
      return 'sent'
    } else {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LEASE_MS) rmSync(lock, { force: true })
      } catch { /* no active lease */ }
      const token = randomUUID()
      try {
        writeFileSync(lock, token, { flag: 'wx', mode: 0o600 })
        if (existsSync(sent)) {
          rmSync(lock, { force: true })
          return 'sent'
        } else {
          return `lease:${token}`
        }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        return 'busy'
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
      return action === 'commit' ? 'sent' : 'released'
    } else {
      return 'stale'
    }
  }
}

// Keep the original CLI contract for the Claude hook engine.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(delivery(...process.argv.slice(2, 5))) }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2 }
}
