// Checkbox list for install.sh: which apps to install for, and in which mode.
// Usage: node pick-clients.mjs id=Label=modes=current ... (modes: comma-separated, e.g. mcp,cli)
// Prints the chosen apps as id=mode, one per line.
// Talks to /dev/tty, because install.sh itself usually comes from a pipe (curl | bash).
import { openSync } from "node:fs";
import { ReadStream, WriteStream } from "node:tty";
import checkbox from "@inquirer/checkbox";

const MODE_LABELS = { mcp: "MCP", cli: "CLI" };

const input = new ReadStream(openSync("/dev/tty", "r"));
const output = new WriteStream(openSync("/dev/tty", "w"));

const choices = process.argv.slice(2).flatMap((arg) => {
  const [id, name, modes, current] = arg.split("=");
  const list = modes.split(",");
  return list.map((mode) => ({
    value: `${id}=${mode}`,
    name: list.length > 1 ? `${name} (${MODE_LABELS[mode]})` : name,
    checked: mode === (current || "mcp"),
  }));
});

try {
  const chosen = await checkbox(
    {
      message: "Install for (MCP: the app runs ITFin tools; CLI: the agent runs the itfin command in its shell)",
      choices,
      required: true,
      validate: (picked) => {
        const apps = picked.map((c) => c.value.split("=")[0]);
        return new Set(apps).size === apps.length || "Pick one mode per app.";
      },
    },
    { input, output },
  );
  console.log(chosen.join("\n"));
} catch {
  // Ctrl+C: print nothing, install.sh stops.
  process.exitCode = 1;
} finally {
  input.destroy();
  output.destroy();
}
