// Finding relay processes on Linux, macOS and Windows. The parsers are pure
// so scripts/platform.check.mjs can test every platform's output anywhere.
import { execFileSync } from 'node:child_process'

/** `ps` elapsed time, `[[dd-]hh:]mm:ss`, in milliseconds; macOS ps has no `etimes`. */
export function parseEtime(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim())
  if (match === null) return undefined
  const [, days = '0', hours = '0', minutes, seconds] = match
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000
}

/** `ps -eo pid=,etime=,args=` lines as `{ pid, startedAt, command }`. */
export function parsePs(output, now) {
  const found = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    const elapsed = match === null ? undefined : parseEtime(match[2])
    if (elapsed !== undefined) found.push({ pid: Number(match[1]), startedAt: now - elapsed, command: match[3] })
  }
  return found
}

/** PowerShell's JSON for node.exe processes: one object, or a list of them. */
export function parseWindows(output) {
  if (output.trim() === '') return []
  const parsed = JSON.parse(output)
  return (Array.isArray(parsed) ? parsed : [parsed]).map(one => ({
    pid: Number(one.ProcessId),
    startedAt: Number(one.Started),
    command: String(one.CommandLine ?? ''),
  }))
}

// A flag's value, quoted (Windows keeps the quotes in a command line) or not.
function flag(args, name) {
  const match = new RegExp(`(?:^|\\s)--${name}\\s+(?:"([^"]*)"|'([^']*)'|(\\S+))`).exec(args)
  return match === null ? undefined : (match[1] ?? match[2] ?? match[3])
}

/**
 * A relay's details when `command` runs `<agent>-delegate/scripts/relay.mjs`
 * under node; undefined for anything else, a shell that mentions it included.
 */
export function parseRelay(command) {
  const isNode = /^(?:"[^"]*[\\/])?(?:\S*[\\/])?node(?:\.exe)?"?(?:\s|$)/i.test(command)
  const match = /([a-z]+)-delegate[\\/]scripts[\\/]relay\.mjs["']?(.*)$/.exec(command)
  if (!isNode || match === null) return undefined
  const args = match[2]
  return {
    agent: match[1],
    cwd: flag(args, 'cd') ?? '',
    brief: flag(args, 'brief') ?? '?',
    outDir: flag(args, 'out-dir'),
    model: flag(args, 'model'),
    isReadOnly: /(?:^|\s)--read-only(?:\s|$)/.test(args),
  }
}

const WINDOWS_QUERY = [
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" |",
  "Select-Object ProcessId,",
  "@{n='Started';e={[DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds()}},",
  'CommandLine | ConvertTo-Json -Compress',
].join(' ')

/** The node processes running now, on this platform. */
export function listProcesses(now) {
  if (process.platform === 'win32') {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERY], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    })
    return parseWindows(out)
  }
  return parsePs(execFileSync('ps', ['-eo', 'pid=,etime=,args='], { encoding: 'utf8' }), now)
}
