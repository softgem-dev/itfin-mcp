# itfin-mcp

Report time and request leave in ITFin by chatting with Claude Code, Codex or Claude Desktop.

An unofficial tool. It is not made, endorsed or supported by ITFin.

## Install (about 2 minutes)

You need macOS, Node.js 22+ and Chrome, Edge, Brave, Arc or Chromium.

1. Run:
   ```bash
   npx itfin-mcp@latest install
   ```
2. Pick the apps and, for Claude Code and Codex, the [mode](#mcp-or-cli-mode). Space ticks or unticks one, Enter confirms.
3. Type your company name: `acme` for `https://acme.itfin.io`.
4. Claude Desktop only: restart it (Cmd+Q, then open it).
5. Start a new session and say **"log in to ITFin"**.

## Update

Run the same command again. It installs the latest version from npm, keeps your apps, modes and settings and asks nothing.

Installs from before the npm package (a git clone in `~/.itfin-mcp`) are replaced on the first update.

If the update changed anything, it stops the ITFin servers that are still running the old version. Then start a new session (in Claude Code, `/mcp` → reconnect itfin also works) and restart Claude Desktop (Cmd+Q, then open it).

## MCP or CLI mode

Each app uses ITFin in one of two modes:

- **MCP** (default): the app runs ITFin as an MCP server and the agent calls its tools.
- **CLI**: the agent runs the `itfin` command in its shell, guided by an `itfin` skill. It can pipe the JSON output into `jq`, loop over days or combine it with `git` in one command.

Claude Desktop has no shell, so it is always MCP. To switch an app, run the install with `--mode`, e.g. `npx itfin-mcp@latest install --mode claude=cli`. Switching removes what the old mode installed.

CLI mode installs:

- `~/.local/bin/itfin`, the command (`itfin --help` lists the commands, `itfin <command> --help` their flags);
- the `itfin` skill in `~/.claude/skills` (Claude Code) or `~/.agents/skills` (Codex);
- permission to run read-only commands without asking: allow rules in `~/.claude/settings.json`, or `~/.codex/rules/itfin.rules` for Codex, which also lets them reach ITFin from the Codex sandbox. Writes, leave and reopen requests and `itfin login` still ask. `--no-permissions` skips this, and updates remember it until you pass `--permissions`.

## Log in (once a week)

1. Say **"log in to ITFin"**.
2. Pick your Google account in the window that opens.

ITFin tokens last 7 days and can't be extended. A macOS notification reminds you at the start of your working day before yours expires.

## Settings

Settings live in `~/.itfin-mcp/config.json`. Add flags to the install command to change a setting:

```bash
npx itfin-mcp@latest install --browser brave --work-start 09:00
```

| Flag | Default | Sets |
|---|---|---|
| `--clients claude,codex,desktop` | asked | Apps to install for |
| `--mode claude=cli,codex=mcp` | `mcp` | Mode per app: `mcp` or `cli` |
| `--no-permissions` / `--permissions` | `--permissions` | Whether CLI mode allows read-only `itfin` commands without asking |
| `--company acme` | asked | Workspace `https://acme.itfin.io` |
| `--url <address>` | | Workspace not on `itfin.io` |
| `--browser` | `chrome` | `chrome`, `edge`, `brave`, `arc`, `chromium` or a path to the browser |
| `--work-start` | `10:00` | When relogin reminders fire |
| `--timezone` | system | IANA timezone, e.g. `Europe/Kyiv` |
| `--dir` | `~/.itfin-mcp` | Install folder |

## Tools

In CLI mode each tool is a command without the `itfin_` prefix: `itfin_get_entries` is `itfin get-entries`.

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

## License

The code is [MIT](LICENSE), copyright Steven Tailor.

The license covers this project's code only. ITFin, its name, service, API and data belong to their owners and are not licensed here. The tool talks to ITFin only through the API your own account can already use, after you log in yourself. Use it within your company's ITFin terms.
