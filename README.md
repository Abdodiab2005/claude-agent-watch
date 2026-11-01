# agent-watch

A Claude Code mod for people who run Claude Code as an orchestrator and hand
implementation work to other coding agents (Codex, Antigravity, Grok) through
the `*-delegate` skills. It keeps a pane beside the chat that shows:

- **Limits**: the 5-hour and weekly usage of each agent, with a bar, the time
  until the window resets, and a forecast (`⚠ out 2d7h`) when the average
  pace since the window opened, idle hours included, would use it up before it
  resets. A window less than a fifth gone gets no forecast yet, and
  Antigravity's buckets, which refill as they go, get none.
- **Running**: every delegate relay running on the machine (from any Claude
  session), how long it has run, and `idle 25m` when it has changed no file for
  a while; the session's own subagents; relays that finished in the last hour,
  with their status and the number of files they touched.
- **Plan**: the session's todo or task list, with the current step in bold.

It also sends alerts, to the desktop and optionally to your phone through
[ntfy](https://ntfy.sh), a Telegram bot, or both, when:

- Claude asks you a question or needs a permission;
- Claude finishes a turn that took 15 seconds or more (the notification does not include Claude's answer);
- a relay finishes, or seems stuck (no file change for 20 minutes);
- any limit passes 90%, or is forecast to run out before it resets.

With several Claude sessions open, machine-wide alerts (relays and limits)
are delivered once **per enabled channel**. If a channel is disabled or a
delivery fails, that channel can retry on a later poll without resending to
channels that succeeded. Delivery receipts and short-lived leases live in
`~/.cache/agent-watch/deliveries/`. A crash between a successful network
send and writing its receipt can rarely produce a duplicate.

Finally, it routes delegated work by limits: when Claude starts a relay for an
agent whose limit is past 90%, the call is refused with a message naming the
agents that still have room. Prefix the command with `AGENT_WATCH_ALLOW=1` to
dispatch anyway.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install agent-watch --marketplace Abdodiab2005/claude-agent-watch
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in
every session).

From a shell:

```
claude plugin install agent-watch --marketplace Abdodiab2005/claude-agent-watch
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `Abdodiab2005/claude-agent-watch`, then
Add plugin.

The pane opens by itself in a fullscreen terminal 144 columns wide or more.
Anywhere else, run `/agent-watch`.

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
| Claude | Claude Code's own rate-limit readings for the session (subscription accounts) |
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
/agent-watch-phone            set up a new random topic and send a test alert
/agent-watch-phone test       send a test alert
/agent-watch-phone <topic>    use a topic on ntfy.sh
/agent-watch-phone <url>      use a topic on your own ntfy server
/agent-watch-phone off        stop phone alerts
```

Then install the ntfy app on your phone and subscribe to the topic. Anyone who
knows the topic name can read the alerts, so keep it private.

A self-hosted server that asks for a login to publish (`auth-default-access:
deny-all`, or a locked topic) answers the test alert with HTTP 403, and
`/agent-watch-phone` then prints these steps:

1. On the server, give a user write access and create a token:
   `ntfy access <user> <topic> rw`, then `ntfy token add --label=agent-watch <user>`.
2. Save the token in Claude Code's secure storage, from your own terminal:

   ```
   read -rs T && printf '{"ntfyToken":"%s"}' "$T" | claude plugin configure agent-watch@claude-agent-watch --values-stdin; unset T
   ```

3. Run `/reload-plugins`, then `/agent-watch-phone test`.

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
   read -rs T && printf '{"telegramBotToken":"%s"}' "$T" | claude plugin configure agent-watch@claude-agent-watch --values-stdin; unset T
   ```

   In Windows PowerShell:

   ```
   $s = Read-Host -AsSecureString 'Token'; $t = [Net.NetworkCredential]::new('', $s).Password; '{"telegramBotToken":"' + $t + '"}' | claude plugin configure agent-watch@claude-agent-watch --values-stdin; Remove-Variable s, t
   ```

   `agent-watch@claude-agent-watch` is the id of an install from GitHub;
   `claude plugin list` shows yours, and `/agent-watch-telegram` prints this
   line with it filled in.

   Or open `/plugin`, then agent-watch, then Configure.
3. Run `/reload-plugins`, send `/start` to your bot, then run
   `/agent-watch-telegram`. It finds your chat, saves its id, and sends a test
   message.

```
/agent-watch-telegram             find your chat and send a test message
/agent-watch-telegram test        send a test message
/agent-watch-telegram <chat id>   send to this chat (a group's id starts with -)
/agent-watch-telegram off         stop Telegram alerts
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

Everything goes under `~/.cache/agent-watch/`: the cached Antigravity and Grok
readings, the relays seen last, the relays that finished, and the claim
files that keep an alert from being sent twice. Claim files older than 8 days are deleted.

## Development

```
claude plugin validate .
claude plugin test .
node scripts/platform.check.mjs
```

The last one checks the process parsers against Linux, macOS and Windows
output.

`claude --plugin-dir <this folder>` loads the mod for one session.

## License

MIT
