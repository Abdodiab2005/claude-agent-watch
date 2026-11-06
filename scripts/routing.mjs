// The same advisory quota guard in Claude Code and Codex. This module is pure:
// it can run in Claude's hook engine as well as Node.
const RELAY = /\b([a-z]+)-delegate[\\/]scripts[\\/]relay\.mjs\b/

function spentBy(row, model) {
  if (row.id !== 'agy') return row.windows
  const group = model === undefined ? undefined
    : /claude|gpt/i.test(model) ? 'Claude/GPT'
      : /argon/i.test(model) ? 'Argon'
        : /gemini/i.test(model) ? 'Gemini' : undefined
  return row.windows.filter(window =>
    group === undefined ? !window.label.startsWith('Argon') : window.label.startsWith(`${group} `),
  )
}

function span(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

export function routeCheck(command, snapshot, now = Date.now()) {
  const match = RELAY.exec(command)
  if (match === null || /\bAGENT_WATCH_ALLOW=1\b/.test(command) || /\s--help\b/.test(command)) return undefined
  if (snapshot == null || now - snapshot.at > 10 * 60_000) return undefined
  const row = snapshot.agents.find(one => one.id === match[1])
  if (row === undefined) return undefined
  const model = /--model\s+(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(command)
  const worst = spentBy(row, model?.[1] ?? model?.[2] ?? model?.[3])
    .filter(one => one.percentUsed >= 90)
    .sort((a, b) => b.percentUsed - a.percentUsed)[0]
  if (worst === undefined) return undefined
  const room = snapshot.agents
    .filter(one => one.id !== row.id)
    .map(one => ({ name: one.name, top: Math.max(-1, ...spentBy(one).map(window => window.percentUsed)) }))
    .filter(one => one.top >= 0 && one.top < 90)
    .sort((a, b) => a.top - b.top)
    .map(one => `${one.name} (${Math.round(one.top)}% used)`)
  const reset = worst.resetsAt === undefined ? '' : `, resets in ${span(worst.resetsAt - now)}`
  return [
    `leviro-agent-watcher stopped this dispatch: ${row.name} ${worst.label} limit is at ${Math.round(worst.percentUsed)}%${reset}.`,
    room.length > 0
      ? `Agents with room: ${room.join(', ')}. Dispatch to one of them, or ask the user.`
      : 'No other agent has room; ask the user.',
    `To dispatch to ${row.name} anyway, prefix the command with AGENT_WATCH_ALLOW=1.`,
  ].join(' ')
}
