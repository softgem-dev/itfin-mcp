# itfin-mcp

A local MCP server that gives an agent (Claude Code, Claude Desktop) access to your ITFin workspace. It can read the projects you can report to, read your time entries, and create, update and delete them. It also looks after your ITFin token.

Deciding what to report is up to the agent's instructions, for example a daily scheduled task. The server only talks to ITFin. See `docs/adr/0001-mcp-is-a-thin-itfin-client.md`.

## Requirements

- macOS (the token lives in the Keychain; relogin reminders use launchd and notifications)
- Node.js 22+
- A Chromium-based browser for login: Chrome, Edge, Brave, Arc or Chromium

## Quick install

```bash
curl -fsSL https://raw.githubusercontent.com/softgem-dev/itfin-mcp/main/scripts/install.sh | bash
```

The script:
1. clones or updates the repo in `~/.itfin-mcp`;
2. builds it;
3. asks for your workspace address, browser, start of the working day and timezone;
4. registers the server with Claude Code. For Claude Desktop, it prints the config snippet to paste.

Run it again to update. To skip the questions:

```bash
curl -fsSL https://raw.githubusercontent.com/softgem-dev/itfin-mcp/main/scripts/install.sh | bash -s -- --url https://acme.itfin.io --browser chrome --work-start 10:00 --timezone Europe/Kyiv
```

## Manual setup

```bash
npm install
npm run build
```

Register the server with Claude Code:

```bash
claude mcp add itfin --scope user -e ITFIN_URL=https://<workspace>.itfin.io -- node /absolute/path/to/itfin-mcp/dist/index.js
```

| Variable | Default | Meaning |
|---|---|---|
| `ITFIN_URL` | required | Workspace address, e.g. `https://acme.itfin.io` |
| `ITFIN_BROWSER` | `chrome` | `chrome`, `edge`, `brave`, `arc`, `chromium` or a path to the browser binary |
| `ITFIN_WORK_START` | `10:00` | Start of working time; relogin reminders fire then |
| `ITFIN_TIMEZONE` | system timezone | IANA timezone for working time and "today" |

## Logging in

Ask Claude to log in to ITFin. A browser window opens on your workspace, and you sign in with Google. The server picks up the new ITFin token, stores it in the Keychain and schedules a macOS notification for the next relogin. ITFin tokens are valid for exactly 7 days and can't be refreshed.

The login browser uses its own profile (`~/Library/Application Support/itfin-mcp/browser-profile`), so next time you only pick your Google account. The server only watches for the ITFin token cookie. It never clicks or types anything in the browser.

## Tools

| Tool | What it does |
|---|---|
| `itfin_login` | Opens the login window and stores the new ITFin token |
| `itfin_auth_status` | Whether the token is valid, when it expires, and when the next relogin reminder is due |
| `itfin_list_projects(date)` | Projects you can report to on a date, with `clientAgreementId` and tasks |
| `itfin_get_entries(from, to)` | Days with time entries and status `open`, `closed` or `future` |
| `itfin_create_entry` | Creates a time entry |
| `itfin_update_entry` | Changes only the fields you pass |
| `itfin_delete_entry` | Deletes a time entry |
| `itfin_get_workspace_settings` | Minimum comment length, and whether reopen requests are enabled |
| `itfin_request_reopen` | Asks a manager to reopen closed days. The server asks you to confirm every time |
| `itfin_list_reopen_requests` | Your reopen requests and their status |

Errors come back as `{ "error": { "code": ... } }`. The codes are:

- `AUTH_REQUIRED`: log in again.
- `DAY_CLOSED`: the reporting period is closed. The error includes the matching reopen requests and a hint.
- `DAY_IN_FUTURE`: the day can't be reported yet.
- `VALIDATION`: the input was rejected before sending.
- `NOT_FOUND`: the entry doesn't exist.
- `CONFIRMATION_DECLINED` / `CONFIRMATION_UNAVAILABLE`: no reopen request was filed.
- `ITFIN_ERROR`: any other error, with ITFin's message.

## Development

```bash
npm run typecheck
npm test
```

Tests run against a fake ITFin and a fixed clock, and use the real Keychain under the `itfin-mcp-test` service. A read-only smoke test against a live workspace is opt-in:

```bash
ITFIN_LIVE=1 ITFIN_URL=https://<workspace>.itfin.io npx vitest run test/live.test.ts
```

Checked by hand, not in automated tests: the real Google login in the browser, and the launchd reminder firing.
