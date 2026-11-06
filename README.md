# leviro-agent-watcher

A local plugin for **Claude Code and Codex**, for people who orchestrate work
and hand implementation to other coding agents through the `*-delegate`
skills. Claude Code gets a pane beside the chat. Codex gets a `leviro-agent-watcher`
skill and a live monitor you can run in an adjacent terminal. They show:

- **Limits**: the 5-hour and weekly usage of each agent, with a bar, the time
  until the window resets, and a forecast (`⚠ out 2d7h`) when the average
  pace since the window opened, idle hours included, would use it up before it
  resets. A window less than a fifth gone gets no forecast yet, and
  Antigravity's buckets, which refill as they go, get none.
- **Running**: every delegate relay running on the machine (from any Claude
  session), how long it has run, and `idle 25m` when it has changed no file for
  a while; the session's own subagents; relays that finished in the last hour,
  with their status and the number of files they touched.
- **Plan**: Claude's todo/task list or Codex's `update_plan`, with the current
  step marked. Codex's view also shows its native subagents from lifecycle hooks.

It also sends alerts, to the desktop and optionally to your phone through
[ntfy](https://ntfy.sh), a Telegram bot, or both, when:

- Claude or Codex asks you a question or needs a permission;
- Claude or Codex finishes a turn that took 15 seconds or more (the notification does not include the answer);
- a relay finishes, or seems stuck (no file change for 20 minutes);
- any limit passes 90%, or is forecast to run out before it resets.

With several Claude sessions open, machine-wide alerts (relays and limits)
are delivered once **per enabled channel**. If a channel is disabled or a
delivery fails, that channel can retry on a later poll without resending to
channels that succeeded. Delivery receipts and short-lived leases live in
`~/.cache/agent-watch/deliveries/`. A crash between a successful network
send and writing its receipt can rarely produce a duplicate.

Finally, it routes delegated work by limits: when either host starts a relay for an
agent whose limit is past 90%, the call is refused with a message naming the
agents that still have room. Prefix the command with `AGENT_WATCH_ALLOW=1` to
dispatch anyway.

## Install

### Claude Code

At the prompt of a terminal Claude Code session:

```
/plugin install leviro-agent-watcher --marketplace Abdodiab2005/leviro-agent-watcher
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in
every session).

From a shell:

```
claude plugin install leviro-agent-watcher --marketplace Abdodiab2005/leviro-agent-watcher
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `Abdodiab2005/leviro-agent-watcher`, then
Add plugin.

The pane opens by itself in a fullscreen terminal 144 columns wide or more.
Anywhere else, run `/leviro-agent-watcher`.

### Codex

Use a Codex build with plugins and lifecycle hooks (installation verified with
Codex CLI 0.166.0):

```bash
codex plugin marketplace add Abdodiab2005/leviro-agent-watcher
codex plugin add leviro-agent-watcher@leviro-agent-watcher
```

Start a new session, open `/hooks`, and review/trust Leviro Agent Watcher's hooks.
Installing a plugin does not trust its hooks automatically. The hooks notify
you about approvals; they never approve or deny a permission request.

Invoke `$leviro-agent-watcher` for a status reading, or ask it for the live monitor
command. The monitor is `node /path/to/leviro-agent-watcher/scripts/codex.mjs watch`:
run it in another terminal and stop it with Ctrl-C. `status` prints one
reading. Add `--session <Codex thread id>` to either for a single session;
without it, all locally tracked Codex sessions appear.

Codex does not expose Claude's TSX pane API. Its view is text, with a separate
terminal for continuous monitoring. Hooks refresh the shared collector after
tools and at session/turn boundaries, at most once every 30 seconds. The live
monitor also polls while Codex is idle. No background daemon is installed.
Claude's own usage is visible in Codex while a Claude session publishes it;
that cached reading expires after 10 minutes. Codex's plan/subagent view
requires trusted hooks; it does not parse conversation transcripts.

Use the same repository/marketplace in both hosts. The Codex manifest selects
`hooks/codex.json` and `codex-skills/`; Claude continues to load
`hooks/register.tsx` with the same pane and secure-storage API.

#### Upgrading from agent-watch

The public repository, marketplace, plugin and commands are now named
`leviro-agent-watcher`. Existing preferences and delivery receipts stay in the
legacy `~/.config/agent-watch/` and `~/.cache/agent-watch/` directories, so
destinations and per-channel switches carry over without moving your data.
The existing `AGENT_WATCH_*` environment variable names also continue to work.

Disable the old plugin before enabling the renamed one to avoid duplicate
session alerts. Claude secure-storage options belong to the old plugin id;
keep that installation until you have configured any needed phone tokens on
the renamed plugin through `/plugin`. The rename does not read, export, or
delete its saved credentials. Codex users review the renamed hooks in `/hooks`.

#### Codex phone alerts

Both hosts read `~/.config/agent-watch/config.json`. If Claude already set up
ntfy or Telegram, those destinations and per-channel/kind switches are reused.
For a Codex-only installation, create that file with the channels you want:

```json
{
  "ntfyUrl": "https://ntfy.sh/your-private-topic",
  "telegramChatId": "123456789",
  "off": []
}
```

Omit unused channels. Choose an unguessable ntfy topic; anyone who knows an
open topic can read its alerts. Send `/start` to your Telegram bot first and
use your own chat id. Codex does not read Claude's secure storage. If needed,
provide `AGENT_WATCH_NTFY_TOKEN` and/or `AGENT_WATCH_TELEGRAM_BOT_TOKEN` in the
environment of the Codex process and the live monitor. For example, in your
own Bash terminal, this keeps the token out of chat, output and shell history:

```bash
read -rs -p 'Telegram token: ' AGENT_WATCH_TELEGRAM_BOT_TOKEN
export AGENT_WATCH_TELEGRAM_BOT_TOKEN
codex
unset AGENT_WATCH_TELEGRAM_BOT_TOKEN
```

Use the same pattern for `AGENT_WATCH_NTFY_TOKEN`. Tokens are held in memory,
sent only to the configured service, and never written to plugin state.
HTTP redirects are refused. A disabled or failed channel does not consume an
event; successful channels share delivery receipts across Claude and Codex.

Ask the skill to switch alerts, or run:

```bash
node /path/to/leviro-agent-watcher/scripts/codex.mjs alerts off
node /path/to/leviro-agent-watcher/scripts/codex.mjs alerts on
node /path/to/leviro-agent-watcher/scripts/codex.mjs alerts off done
node /path/to/leviro-agent-watcher/scripts/codex.mjs alerts on ntfy
```

With no target, `on`/`off` changes all four alert kinds. Individual targets are
`desktop`, `ntfy`, `telegram`, `ask`, `done`, `relay`, and `limit`. These shared
switches also apply in Claude's pane; its main on/off button is session-local.

## Requirements

- Node.js 22.5 or newer on `PATH` (the collector script runs with it).
- Linux, macOS or Windows:

  | | Desktop alerts | Relay detection |
  | --- | --- | --- |
  | Linux | `notify-send`, with the Claude desktop app's icon when it is installed | `ps` |
  | macOS | `osascript` (macOS may ask once to allow Script Editor's notifications) | `ps` |
  | Windows | a toast from Windows PowerShell | `Get-CimInstance Win32_Process` |

  Where the desktop tool fails, alerts go through Claude Code's own
  notification channel.
- Whichever agent CLIs you use: `codex`, `agy`, `grok`. An agent that is not
  installed shows a short note instead of limits.

## Where the numbers come from

| Agent | Source |
| --- | --- |
| Claude | Claude Code's own rate-limit readings for the session (subscription accounts); shared locally with Codex for up to 10 minutes |
| Codex | the `rate_limits` the Codex CLI writes into `~/.codex/sessions/**/rollout-*.jsonl` |
| Antigravity | `agy -p "/usage" --output-format json`, cached for 5 minutes (1 minute while an agy relay runs) |
| Grok | the billing endpoint the Grok CLI itself calls, `https://cli-chat-proxy.grok.com/v1/billing?format=credits`, cached for 5 minutes |

The Grok reading uses the login token in `~/.grok/auth.json`. The token is read
inside the collector process, sent only to xAI, and never printed or cached.
The collector never refreshes it: when it has expired, the pane asks you to run
`grok` once. The Grok endpoint is undocumented and may change without notice.

Relays are found by their process (`<agent>-delegate/scripts/relay.mjs`), and a
finished relay's status and touched files come from the `result.json` in its
`--out-dir`.

## Phone alerts

ntfy and Telegram can be used one at a time or together.

### ntfy

```
/leviro-agent-watcher-phone            set up a new random topic and send a test alert
/leviro-agent-watcher-phone test       send a test alert
/leviro-agent-watcher-phone <topic>    use a topic on ntfy.sh
/leviro-agent-watcher-phone <url>      use a topic on your own ntfy server
/leviro-agent-watcher-phone off        stop phone alerts
```

Then install the ntfy app on your phone and subscribe to the topic. Anyone who
knows the topic name can read the alerts, so keep it private.

A self-hosted server that asks for a login to publish (`auth-default-access:
deny-all`, or a locked topic) answers the test alert with HTTP 403, and
`/leviro-agent-watcher-phone` then prints these steps:

1. On the server, give a user write access and create a token:
   `ntfy access <user> <topic> rw`, then `ntfy token add --label=leviro-agent-watcher <user>`.
2. Save the token in Claude Code's secure storage, from your own terminal:

   ```
   read -rs T && printf '{"ntfyToken":"%s"}' "$T" | claude plugin configure leviro-agent-watcher@leviro-agent-watcher --values-stdin; unset T
   ```

3. Run `/reload-plugins`, then `/leviro-agent-watcher-phone test`.

The token is the sensitive option `ntfyToken`, kept like the Telegram token and
sent only to the ntfy server set up, as `Authorization: Bearer`. In the ntfy
app, add the same user under Settings, Manage users, so the app can read the
topic. On an iPhone, the server also needs `upstream-base-url:
"https://ntfy.sh"` in `server.yml` for alerts to arrive while the app is
closed. Alerts carry
repository and brief file names and limit figures, never code or tokens. The
setting is kept in `~/.config/agent-watch/config.json`.

### Telegram

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and
   copy the token it gives you.
2. Save the token in Claude Code's secure storage. In your own terminal (not in
   a Claude prompt), run this and paste the token at the silent prompt:

   ```
   read -rs T && printf '{"telegramBotToken":"%s"}' "$T" | claude plugin configure leviro-agent-watcher@leviro-agent-watcher --values-stdin; unset T
   ```

   In Windows PowerShell:

   ```
   $s = Read-Host -AsSecureString 'Token'; $t = [Net.NetworkCredential]::new('', $s).Password; '{"telegramBotToken":"' + $t + '"}' | claude plugin configure leviro-agent-watcher@leviro-agent-watcher --values-stdin; Remove-Variable s, t
   ```

   `leviro-agent-watcher@leviro-agent-watcher` is the id of an install from GitHub;
   `claude plugin list` shows yours, and `/leviro-agent-watcher-telegram` prints this
   line with it filled in.

   Or open `/plugin`, then leviro-agent-watcher, then Configure.
3. Run `/reload-plugins`, send `/start` to your bot, then run
   `/leviro-agent-watcher-telegram`. It finds your chat, saves its id, and sends a test
   message.

```
/leviro-agent-watcher-telegram             find your chat and send a test message
/leviro-agent-watcher-telegram test        send a test message
/leviro-agent-watcher-telegram <chat id>   send to this chat (a group's id starts with -)
/leviro-agent-watcher-telegram off         stop Telegram alerts
```

The token is the manifest's `sensitive` option `telegramBotToken`: Claude Code
keeps it in its secure storage, not in `settings.json`, and hands it only to the
mod when it loads. The mod keeps it in memory, sends it only to
`api.telegram.org` (the Bot API puts it in the request URL), and never stores,
draws or prints it. The read above keeps it out of your shell history and off
the screen. The chat id is kept in `~/.config/agent-watch/config.json`.

### Switching alerts on and off

The **Alerts** row at the bottom of the pane has an `on`/`off` button for all
alerts, then a switch for each channel and each kind of alert:

```
Alerts [ on ] [ Refresh ]
[ ✓ desktop ] [ ✓ ntfy ] [ ✓ telegram ]
[ ✓ asks ] [ ✗ done ] [ ✓ relays ] [ ✓ limits ]
```

`asks` covers questions and permission prompts, `done` finished turns,
`relays` finished and stuck relays, `limits` the 90% and forecast alerts. The
switches are kept in `~/.config/agent-watch/config.json`, so every open
session follows a change at once.

## Files it writes

Preferences go in `~/.config/agent-watch/config.json`. Cache/state goes under
`~/.cache/agent-watch/` (`$XDG_CACHE_HOME/agent-watch` when set): the cached Antigravity and Grok
readings, the relays seen last, the relays that finished, and the claim
files that keep an alert from being sent twice. Claim files older than 8 days are deleted.
The latest collector snapshot and Claude's recent limit windows are shared
there too. Codex stores session directory names as hashes, plus local cwd,
turn-start times, up to 100 plan steps of 300 characters, and subagent
type/timing. Session end removes that session's state; session start prunes
orphaned state older than 8 days. Prompts, assistant answers, approval reasons,
tool commands/results and transcript paths are not stored by the adapter.

## Development

```
claude plugin validate .
claude plugin test .
node --test tests/*.test.mjs
node scripts/platform.check.mjs
```

The last one checks the process parsers against Linux, macOS and Windows
output.
The Node tests exercise Codex's real hook entry point with isolated state and
fake collector/notification transports; they make no billing, model or phone
requests. Claude's suite exercises the existing pane and commands.

Codex plugin and hook format: [plugin packaging](https://developers.openai.com/plugins/build/plugins)
and [hook events/trust](https://learn.chatgpt.com/docs/hooks).

`claude --plugin-dir <this folder>` loads the mod for one session.

## License

MIT
