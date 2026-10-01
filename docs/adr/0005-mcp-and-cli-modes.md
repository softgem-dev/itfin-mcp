# One tool, two modes: each app reaches ITFin either as an MCP server or as a CLI

Each app the installer sets up gets exactly one mode. In MCP mode the app runs the tool as an MCP server, as before. In CLI mode the app's agent runs `itfin <command>` in its shell. CLI mode exists for composition: an agent can pipe ITFin output into `jq`, loop over days in one shell call, or mix it with `git` and `curl`, which separate MCP tool calls can't do. Claude Desktop has no shell, so it is always in MCP mode.

The CLI is an MCP client of the same server, run in the same process over an in-memory transport. Its commands, flags, help, the agent skill and the read-only permission rules are all generated from the server's tool list (names, schemas, descriptions, `readOnlyHint`). So the two modes can't drift apart, and a new tool appears in both at once.

## Considered Options

- CLI only: rejected, because Claude Desktop would lose ITFin.
- Both modes in the same app: rejected. The agent would get two ways to do the same thing and could file an entry or a request twice.
- Two independent installers: rejected. Most of the installer (Node checks, the npm install, migrating old installs, stopping stale servers, asking for the company) is shared and would drift.
- A separate operations layer that MCP and the CLI both call: rejected for now. It means refactoring `server.ts` for no gain while the CLI does nothing the MCP tools don't.

## Consequences

- Settings move from per-app env in the MCP registrations to one file, `~/.itfin-mcp/config.json`, which both modes read. It also stores each app's mode and everything the installer added (skill, permission rules), so switching modes removes exactly what the old one installed. Env still overrides the file.
- CLI mode installs a skill named `itfin`. It holds only what MCP mode gives the agent through the server instructions and tool descriptions, never reporting habits (see [0001](0001-mcp-is-a-thin-itfin-client.md)), so reporting skills work on top of either mode.
- Read-only commands and `auth-status` are allowed without prompting (Claude Code settings, Codex rules). `login` and every write still need the user's approval. Commands file one request each; there is no batch command for reopen or leave requests.
- `itfin login` starts a background waiter and returns at once, because shell tools time out long before a person finishes signing in.
