---
name: leviro-agent-watcher
description: Show local coding-agent usage limits, delegate relays, Codex plans and subagents, or manage Leviro Agent Watcher alerts and its live terminal monitor.
---

Resolve `../../scripts/codex.mjs` relative to this file's directory and run it
with Node. Quote the absolute script path. This is a local plugin, not an MCP
service.

- For status, run `node <script> status` and present its reading. Pass
  `--session "$CODEX_THREAD_ID"` when that environment variable is available
  and the user wants only this session; otherwise the view includes all local
  Codex sessions. Report unavailable or stale readings as such.
- For a live view, give the user `node <script> watch` with the resolved
  absolute path to run in an adjacent terminal. It refreshes every 30 seconds;
  Ctrl-C stops it. Do not start an endless monitor in an agent tool call.
- For alert switches, run `node <script> alerts on|off [target]` as requested.
  Targets: `all`, `desktop`, `ntfy`, `telegram`, `ask`, `done`, `relay`, `limit`.
  The shared preferences also apply to Claude Code's per-kind/channel switches.
- For phone setup, follow [the README](../../README.md#codex-phone-alerts).
  Never ask the user to paste a token into chat or print a token from their
  environment. Claude secure-storage credentials are not available to Codex.

Codex uses hooks for automatic alerts, plan/subagent tracking and relay quota
routing. If these are inactive, direct the user to `/hooks` to review/trust the
plugin hooks and restart the session. Do not bypass hook trust or change
approval decisions. `/leviro-agent-watcher` in Claude opens its native pane; Codex's
skill gives a text view and a separate live terminal monitor.
