# The MCP server is a thin ITFin client; reporting logic lives in agent instructions

The server only exposes ITFin: projects, time entries, closed-day reopen requests, and its own token lifecycle. Deciding what to report, where the data comes from (git, Linear, meetings), how sources map to projects, comment style, hours, retries after missed runs and scheduling all belong to the calling agent's instructions (e.g. a Claude Desktop scheduled task). This keeps the server reusable by colleagues with different reporting habits and keeps ITFin rules in one place.

## Consequences

- The server holds no drafts or queues. When the token is missing it returns `AUTH_REQUIRED`, and the agent decides what to do (normally: fill all unreported working days of the open week on the next successful run).
- The server enforces only rules ITFin itself publishes (closed day, minimum comment length). It adds no business rules such as daily hour norms or rounding.
- The server may change any of the user's time entries and does not tag the ones it creates. The ITFin web UI hides edit and delete for entries whose `ExternalTool` is anything but `"extension"`, so a custom tag would lock the user out of editing them by hand. Posing as ITFin's own extension was rejected as misleading.
