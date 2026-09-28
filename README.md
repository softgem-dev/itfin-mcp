# itfin-mcp

Report time and request leave in ITFin by chatting with Claude Code, Codex or Claude Desktop.

## Install (about 2 minutes)

You need macOS, Node.js 22+ and Chrome, Edge, Brave, Arc or Chromium.

1. Run:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/softgem-dev/itfin-mcp/main/scripts/install.sh | bash
   ```
2. Pick the apps: Claude Code, Codex, Claude Desktop. Space ticks or unticks one, Enter confirms.
3. Type your company name: `acme` for `https://acme.itfin.io`.
4. Claude Desktop only: restart it (Cmd+Q, then open it).
5. Start a new session and say **"log in to ITFin"**.

## Update

Run the same command again. It keeps your apps and settings and asks nothing.

If the update changed anything, it stops the ITFin servers that are still running the old version. Then start a new session (in Claude Code, `/mcp` → reconnect itfin also works) and restart Claude Desktop (Cmd+Q, then open it).

## Log in (once a week)

1. Say **"log in to ITFin"**.
2. Pick your Google account in the window that opens.

ITFin tokens last 7 days and can't be extended. A macOS notification reminds you at the start of your working day before yours expires.

## Settings

Add flags to the install command to change a setting:

```bash
curl -fsSL https://raw.githubusercontent.com/softgem-dev/itfin-mcp/main/scripts/install.sh | bash -s -- --browser brave --work-start 09:00
```

| Flag | Default | Sets |
|---|---|---|
| `--clients claude,codex,desktop` | asked | Apps to install for |
| `--company acme` | asked | Workspace `https://acme.itfin.io` |
| `--url <address>` | | Workspace not on `itfin.io` |
| `--browser` | `chrome` | `chrome`, `edge`, `brave`, `arc`, `chromium` or a path to the browser |
| `--work-start` | `10:00` | When relogin reminders fire |
| `--timezone` | system | IANA timezone, e.g. `Europe/Kyiv` |
| `--dir` | `~/.itfin-mcp` | Install folder |

## Tools

| Tool | Does |
|---|---|
| `itfin_login` / `itfin_auth_status` | Log in; check when the token expires |
| `itfin_list_projects` | Projects and tasks you can report to |
| `itfin_get_entries` | Your time entries, and which days are open, closed or in the future |
| `itfin_create_entry` / `itfin_update_entry` / `itfin_delete_entry` | Change time entries |
| `itfin_get_workspace_settings` | Minimum comment length; whether reopen requests are on |
| `itfin_request_reopen` / `itfin_list_reopen_requests` | Ask a manager to reopen closed days; see your requests |
| `itfin_list_leave_types` | Leave types and reasons you can use |
| `itfin_request_leave` | Request full days, or some hours of one day |
| `itfin_list_leave_requests` / `itfin_cancel_leave_request` | See or cancel your leave requests |

Reopen and leave requests are sent as soon as you ask for them. Your manager still approves them.

## Development

```bash
npm test
npm run typecheck
```
