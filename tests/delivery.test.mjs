import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/delivery.mjs', import.meta.url))
test('only one lease per event/channel; failed sends retry and successful sends stay deduplicated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-watch-delivery-'))
  const run = (...args) => execFileSync(process.execPath, [script, ...args], {
    env: { ...process.env, XDG_CACHE_HOME: dir }, encoding: 'utf8',
  })
  try {
    const first = run('acquire', 'event:ntfy:topic')
    assert.match(first, /^lease:/)
    assert.equal(run('acquire', 'event:ntfy:topic'), 'busy')
    assert.equal(run('release', 'event:ntfy:topic', first.slice(6)), 'released')
    const retry = run('acquire', 'event:ntfy:topic')
    assert.match(retry, /^lease:/)
    assert.equal(run('commit', 'event:ntfy:topic', retry.slice(6)), 'sent')
    assert.equal(run('acquire', 'event:ntfy:topic'), 'sent')
    // Independent delivery receipts for other destinations.
    assert.match(run('acquire', 'event:telegram:42'), /^lease:/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
