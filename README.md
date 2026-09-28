# itfin-mcp

Report time and request leave in ITFin by chatting with Claude Code, Codex or Claude Desktop.

## Install (about 2 minutes)

You need macOS, Node.js 22+ and Chrome, Edge, Brave, Arc or Chromium.

1. Run:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/softgem-dev/itfin-mcp/main/scripts/install.sh | bash
   ```
2. Type your company name: `acme` for `https://acme.itfin.io`.
3. Claude Desktop only: restart it (Cmd+Q, then open it).
4. Start a new session and say **"log in to ITFin"**.

The script sets up Claude Code, Codex and Claude Desktop, whichever you have.

## Update

Run the same command again. It keeps your settings and asks nothing.

## Log in (once a week)

1. Say **"log in to ITFin"**.
2. Pick your Google account in the window that opens.

ITFin tokens last 7 days and can't be extended. A macOS notification reminds you at the start of your working day before yours expires.

## Settings

Add flags to the install command to change a setting:

```bash
curl -fsSL https://raw.githubusercontent.com/softgem-dev/itfin-mcp/main/scripts/install.sh | bash -s -- --browser brave --work-start 09:00
```

| Flag | Variable | Default | Sets |
|---|---|---|---|
| `--company acme` | `ITFIN_URL` | asked | Workspace `https://acme.itfin.io` |
| `--url <address>` | `ITFIN_URL` | | Workspace not on `itfin.io` |
| `--browser` | `ITFIN_BROWSER` | `chrome` | `chrome`, `edge`, `brave`, `arc`, `chromium` or a path to the browser |
| `--work-start` | `ITFIN_WORK_START` | `10:00` | When relogin reminders fire |
| `--timezone` | `ITFIN_TIMEZONE` | system | IANA timezone, e.g. `Europe/Kyiv` |
| `--dir` | | `~/.itfin-mcp` | Install folder |

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

You confirm every reopen and leave request before it's sent.

## Other MCP clients (Cursor, OpenAI Agents SDK, …)

1. Run the install above.
2. Add this to the client's config:
   ```json
   {
     "mcpServers": {
       "itfin": {
         "command": "/absolute/path/to/node",
         "args": ["/Users/<you>/.itfin-mcp/dist/index.js"],
         "env": { "ITFIN_URL": "https://<company>.itfin.io" }
       }
     }
   }
   ```
3. Set the tool timeout to 240 seconds or more. Login waits up to 3 minutes.

The client must run on your Mac. Hosted agents, such as ChatGPT connectors, can't use it.

## Development

```bash
npm test
npm run typecheck
```

Tests use a fake ITFin and the real Keychain (service `itfin-mcp-test`). To smoke-test against a real workspace (read-only):

```bash
ITFIN_LIVE=1 ITFIN_URL=https://<company>.itfin.io npx vitest run test/live.test.ts
```
