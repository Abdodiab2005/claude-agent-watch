# agent-watch

A Claude Code mod for people who run Claude Code as an orchestrator and hand
implementation work to other coding agents (Codex, Antigravity, Grok) through
the `*-delegate` skills. It keeps a pane beside the chat that shows:

- **Limits**: the 5-hour and weekly usage of each agent, with a bar, the time
  until the window resets, and a forecast (`⚠ 1h30m`) when the recent pace
  would use the window up before it resets.
- **Running**: every delegate relay running on the machine (from any Claude
  session), how long it has run, and `idle 25m` when it has changed no file for
  a while; the session's own subagents; relays that finished in the last hour,
  with their status and the number of files they touched.
- **Plan**: the session's todo or task list, with the current step in bold.

It also sends alerts, to the Linux desktop (`notify-send`, with the Claude
desktop app's icon when it is installed) and optionally to your phone through
[ntfy](https://ntfy.sh), when:

- Claude asks you a question or needs a permission;
- Claude finishes a turn that took 15 seconds or more;
- a relay finishes, or seems stuck (no file change for 20 minutes);
- any limit passes 90%, or is forecast to run out before it resets.

With several Claude sessions open, each machine-wide alert (a relay, a limit)
is sent once, not once per session.

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
- Linux for desktop alerts through `notify-send`; elsewhere alerts go through
  Claude Code's own notification channel.
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

```
/agent-watch-phone            set up a new random topic and send a test alert
/agent-watch-phone test       send a test alert
/agent-watch-phone <topic>    use a topic on ntfy.sh
/agent-watch-phone <url>      use a topic on your own ntfy server
/agent-watch-phone off        stop phone alerts
```

Then install the ntfy app on your phone and subscribe to the topic. Anyone who
knows the topic name can read the alerts, so keep it private. Alerts carry
repository and brief file names and limit figures, never code or tokens. The
setting is kept in `~/.config/agent-watch/config.json`.

The **Alerts on** button at the bottom of the pane turns desktop and phone
alerts off and on.

## Files it writes

Everything goes under `~/.cache/agent-watch/`: the cached Antigravity and Grok
readings, the relays seen last, the relays that finished, 3 hours of limit
samples for the forecast, and the claim files that keep an alert from being
sent twice. Claim files older than 8 days are deleted.

## Development

```
claude plugin validate .
claude plugin test .
```

`claude --plugin-dir <this folder>` loads the mod for one session.

## License

MIT
