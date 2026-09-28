// Checkbox list for install.sh: which apps to register the MCP server with.
// Usage: node pick-clients.mjs id=Label ... Prints the chosen ids, one per line.
// Talks to /dev/tty, because install.sh itself usually comes from a pipe (curl | bash).
import { openSync } from "node:fs";
import { ReadStream, WriteStream } from "node:tty";
import checkbox from "@inquirer/checkbox";

const input = new ReadStream(openSync("/dev/tty", "r"));
const output = new WriteStream(openSync("/dev/tty", "w"));

try {
  const chosen = await checkbox(
    {
      message: "Install for",
      choices: process.argv.slice(2).map((arg) => {
        const [value, name] = arg.split("=");
        return { value, name, checked: true };
      }),
      required: true,
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
