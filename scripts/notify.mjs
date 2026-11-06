// Node transports for Codex. Claude's hook engine keeps its secure-storage
// transport; both hosts share preferences and delivery.mjs receipts.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { delivery } from './delivery.mjs'

const execute = promisify(execFile)
export const cacheDirectory = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'agent-watch')
export const configFile = join(homedir(), '.config', 'agent-watch', 'config.json')

export function readConfig(path = configFile) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

export function desktopCommand(title, body, platform = process.platform) {
  if (platform === 'darwin') return ['osascript', '-e', 'on run argv', '-e',
    'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body]
  if (platform !== 'win32') return ['notify-send', '--app-name=Codex', '--icon=codex', title, body]
  const quote = value => `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    `$t = [Security.SecurityElement]::Escape(${quote(title)})`,
    `$b = [Security.SecurityElement]::Escape(${quote(body)})`,
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$x.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual></toast>")`,
    "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))',
  ].join('; ')
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script]
}

export async function notify(alert, {
  cache = cacheDirectory, config = readConfig(), env = process.env,
  run = execute, request = globalThis.fetch, platform = process.platform,
} = {}) {
  const off = Array.isArray(config.off) ? config.off : []
  if (off.includes(alert.kind)) return false
  async function once(channel, destination, send) {
    if (off.includes(channel)) return false
    const key = `${alert.id}:${channel}:${destination}`
    const directory = join(cache, 'deliveries')
    let lease
    try {
      const reserved = delivery('acquire', key, undefined, directory)
      if (!reserved.startsWith('lease:')) return false
      lease = reserved.slice(6)
      let sent = false
      try { sent = await send() } catch { /* retry later; errors may contain credentials */ }
      delivery(sent ? 'commit' : 'release', key, lease, directory)
      return sent
    } catch {
      if (lease) { try { delivery('release', key, lease, directory) } catch { /* cache unavailable */ } }
      return false
    }
  }
  const pending = [once('desktop', 'local', async () => {
    const [command, ...args] = desktopCommand(alert.title, alert.body, platform)
    await run(command, args, { timeout: 10_000, windowsHide: true })
    return true
  })]
  if (typeof config.ntfyUrl === 'string' && /^https?:\/\/[^\s]+\/[\w-]{1,64}$/.test(config.ntfyUrl)) {
    pending.push(once('ntfy', config.ntfyUrl, async () => {
      const headers = { Title: alert.title.replace(/[^\x20-\x7e]/g, '').trim() || 'agent-watch', Tags: 'robot' }
      if (env.AGENT_WATCH_NTFY_TOKEN) headers.Authorization = `Bearer ${env.AGENT_WATCH_NTFY_TOKEN}`
      const response = await request(config.ntfyUrl, {
        method: 'POST', headers, body: alert.body, redirect: 'error', signal: AbortSignal.timeout(10_000),
      })
      return response.ok
    }))
  }
  if (/^-?\d{1,20}$/.test(String(config.telegramChatId)) && env.AGENT_WATCH_TELEGRAM_BOT_TOKEN) {
    pending.push(once('telegram', config.telegramChatId, async () => {
      const response = await request(`https://api.telegram.org/bot${env.AGENT_WATCH_TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
        body: JSON.stringify({ chat_id: config.telegramChatId, text: `${alert.title}\n${alert.body}`, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      })
      return response.ok && (await response.json()).ok === true
    }))
  }
  return (await Promise.all(pending)).some(Boolean)
}
