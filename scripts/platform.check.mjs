// Checks the process parsers against Linux, macOS and Windows output:
// node scripts/platform.check.mjs
import assert from 'node:assert/strict'

import { parseEtime, parsePs, parseRelay, parseWindows } from './platform.mjs'

const NOW = 1_800_000_000_000

assert.equal(parseEtime('05:07'), 307_000)
assert.equal(parseEtime('02:05:07'), 7_507_000)
assert.equal(parseEtime('3-02:05:07'), 266_707_000)
assert.equal(parseEtime('junk'), undefined)

// Linux and macOS ps print the same columns; macOS paths live under /Users.
const ps = [
  '  4242     12:30 node /home/me/.claude/skills/codex-delegate/scripts/relay.mjs --brief /tmp/b1.txt --cd /home/me/shop',
  '  4243  01:02:03 /opt/homebrew/bin/node /Users/me/.claude/skills/agy-delegate/scripts/relay.mjs --cd /Users/me/api --model claude-sonnet --read-only',
  '  4244     00:05 /bin/bash -c node /home/me/.claude/skills/grok-delegate/scripts/relay.mjs --cd /x',
].join('\n')
const rows = parsePs(ps, NOW)
assert.equal(rows.length, 3)
assert.deepEqual(rows[0], {
  pid: 4242,
  startedAt: NOW - 750_000,
  command: 'node /home/me/.claude/skills/codex-delegate/scripts/relay.mjs --brief /tmp/b1.txt --cd /home/me/shop',
})
assert.deepEqual(parseRelay(rows[0].command), {
  agent: 'codex',
  cwd: '/home/me/shop',
  brief: '/tmp/b1.txt',
  outDir: undefined,
  model: undefined,
  isReadOnly: false,
})
const mac = parseRelay(rows[1].command)
assert.equal(mac.agent, 'agy')
assert.equal(mac.cwd, '/Users/me/api')
assert.equal(mac.model, 'claude-sonnet')
assert.equal(mac.isReadOnly, true)
assert.equal(parseRelay(rows[2].command), undefined, 'a shell that mentions a relay is no relay')

// Windows: PowerShell 5.1 gives one object for one process; paths keep quotes and spaces.
const windows = parseWindows(
  JSON.stringify([
    {
      ProcessId: 77,
      Started: NOW - 60_000,
      CommandLine:
        '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\Me Too\\.claude\\skills\\grok-delegate\\scripts\\relay.mjs --brief "C:\\Users\\Me Too\\b2.txt" --cd "C:\\work\\my shop" --out-dir C:\\tmp\\out',
    },
    { ProcessId: 78, Started: NOW, CommandLine: null },
  ]),
)
assert.equal(windows.length, 2)
assert.equal(windows[0].startedAt, NOW - 60_000)
const win = parseRelay(windows[0].command)
assert.equal(win.agent, 'grok')
assert.equal(win.cwd, 'C:\\work\\my shop')
assert.equal(win.brief, 'C:\\Users\\Me Too\\b2.txt')
assert.equal(win.outDir, 'C:\\tmp\\out')
assert.equal(parseRelay(windows[1].command), undefined)
assert.equal(parseWindows(JSON.stringify({ ProcessId: 5, Started: NOW, CommandLine: 'node x.js' })).length, 1)
assert.deepEqual(parseWindows(''), [])

console.log('platform parsers: all checks pass')
