import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * CLI mode: `itfin <command> [--flag value]`. The CLI is an MCP client of the same server, so its
 * commands, flags, help, the agent skill and the read-only list all come from the server's tools.
 */

export interface CliDeps {
  client: Client;
  out(text: string): void;
  err(text: string): void;
  /** Starts the login window in a background process and returns at once. */
  startLogin(): Promise<unknown>;
}

interface JsonSchema {
  type?: string | string[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  description?: string;
  pattern?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

/** `itfin_get_entries` → `get-entries`. */
export function commandName(tool: string): string {
  return tool.replace(/^itfin_/, "").replaceAll("_", "-");
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function schemaTypes(s: JsonSchema): string[] {
  const own = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
  return [...own, ...(s.anyOf ?? []).flatMap(schemaTypes), ...(s.oneOf ?? []).flatMap(schemaTypes)];
}

/** Turns a flag's text into the JSON value its schema expects; the server still validates it. */
function coerce(raw: string, s: JsonSchema): unknown {
  const types = schemaTypes(s);
  if (raw === "null" && types.includes("null")) return null;
  if (types.includes("boolean") && (raw === "true" || raw === "false")) return raw === "true";
  if (types.includes("string")) return raw;
  if ((types.includes("integer") || types.includes("number")) && raw.trim() !== "" && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

class UsageError extends Error {}

/** Parses `--flag value`, `--flag=value` and `--json '{...}'` against a tool's input schema. */
function parseArgs(tool: Tool, argv: string[]): Record<string, unknown> {
  const schema = tool.inputSchema as JsonSchema;
  const props = schema.properties ?? {};
  const byFlag = new Map(Object.keys(props).flatMap((p) => [[kebab(p), p] as const, [p, p] as const]));
  const args: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) throw new UsageError(`Unexpected argument: ${arg}`);
    const eq = arg.indexOf("=");
    const flag = arg.slice(2, eq === -1 ? undefined : eq);
    let raw = eq === -1 ? undefined : arg.slice(eq + 1);
    if (flag === "json") {
      raw ??= argv[++i];
      if (raw === undefined) throw new UsageError("--json needs a JSON object.");
      try {
        Object.assign(args, JSON.parse(raw));
      } catch {
        throw new UsageError("--json is not valid JSON.");
      }
      continue;
    }
    const prop = byFlag.get(flag);
    if (!prop) throw new UsageError(`Unknown flag --${flag} for ${commandName(tool.name)}. See itfin ${commandName(tool.name)} --help.`);
    const propSchema = props[prop]!;
    if (raw === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        if (!schemaTypes(propSchema).includes("boolean")) throw new UsageError(`--${flag} needs a value.`);
        raw = "true";
      } else {
        raw = next;
        i++;
      }
    }
    args[prop] = coerce(raw, propSchema);
  }
  return args;
}

function flagLines(tool: Tool): string[] {
  const schema = tool.inputSchema as JsonSchema;
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, s]) => {
    const types = schemaTypes(s).filter((t) => t !== "null");
    const type = s.pattern === "^\\d{4}-\\d{2}-\\d{2}$" ? "YYYY-MM-DD" : [...new Set(types)].join(" | ");
    const notes = [type, required.has(name) ? "required" : "optional"].filter(Boolean).join(", ");
    return `--${kebab(name)} (${notes})${s.description ? `: ${s.description}` : ""}`;
  });
}

function commandHelp(tool: Tool): string {
  const flags = flagLines(tool);
  return [`itfin ${commandName(tool.name)}`, "", tool.description ?? "", "", ...(flags.length ? ["Flags:", ...flags.map((f) => `  ${f}`)] : ["No flags."])].join("\n");
}

function overview(tools: Tool[]): string {
  const width = Math.max(...tools.map((t) => commandName(t.name).length));
  return [
    "Usage: itfin <command> [--flag value ...]",
    "",
    "Commands:",
    ...tools.map((t) => `  ${commandName(t.name).padEnd(width)}  ${t.annotations?.title ?? t.title ?? ""}`),
    "",
    "itfin <command> --help shows a command's flags. Output is JSON on stdout; errors are JSON on stderr with exit code 1.",
  ].join("\n");
}

/** Read-only commands, which installers may allow without asking. */
export function readOnlyCommands(tools: Tool[]): string[] {
  return tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => commandName(t.name));
}

/** The agent skill for CLI mode: the server instructions, how to call the CLI, and every command. */
export function skillMarkdown(tools: Tool[], instructions: string): string {
  return [
    "---",
    "name: itfin",
    "description: Read and change the user's ITFin data with the `itfin` command (time entries, reportable projects, reopen requests for closed days, leave requests, ITFin login). Use it for any ITFin work, including instructions that name itfin_* tools.",
    "---",
    "",
    "# ITFin",
    "",
    "<!-- Generated by itfin-mcp install. Changes are overwritten on the next update. -->",
    "",
    instructions,
    "",
    "## Calling it",
    "",
    "- Run `itfin <command> --flag value`. Flags are the parameters below; `--json '{...}'` passes them all at once.",
    "- Success prints JSON on stdout with exit code 0, so pipe it into `jq`, loop over days or save it to a file as needed. Failure prints `{\"error\":{\"code\":...,\"message\":...}}` on stderr with exit code 1.",
    "- Instructions that name an ITFin MCP tool mean the matching command: `itfin_get_entries` is `itfin get-entries`.",
    "- Read commands can be combined and looped freely. Time entry writes can be looped too, but only for changes the user asked for.",
    "- `request-leave` and `request-reopen` go to the user's manager: one request per command, never in a loop or script, and only when the user asked for that request.",
    "- `login` opens the sign-in window and returns at once. The user gets a notification after signing in; check with `itfin auth-status`.",
    "",
    "## Commands",
    "",
    ...tools.flatMap((t) => {
      const flags = flagLines(t);
      return [`### itfin ${commandName(t.name)}`, "", t.description ?? "", "", ...(flags.length ? [...flags.map((f) => `- \`${f.slice(0, f.indexOf(" "))}\`${f.slice(f.indexOf(" "))}`), ""] : [])];
    }),
  ].join("\n");
}

function errorJson(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } });
}

/** Runs one CLI invocation and returns its exit code. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const { tools } = await deps.client.listTools();
  const [command, ...rest] = argv;

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    deps.out(overview(tools));
    return 0;
  }
  if (command === "__skill") {
    deps.out(skillMarkdown(tools, deps.client.getInstructions() ?? ""));
    return 0;
  }
  if (command === "__read-only") {
    deps.out(readOnlyCommands(tools).join("\n"));
    return 0;
  }

  const tool = tools.find((t) => commandName(t.name) === command || t.name === command);
  if (!tool) {
    deps.err(errorJson("USAGE", `Unknown command: ${command}. Run itfin --help.`));
    return 1;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    deps.out(commandHelp(tool));
    return 0;
  }

  let args: Record<string, unknown>;
  try {
    args = parseArgs(tool, rest);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    deps.err(errorJson("USAGE", err.message));
    return 1;
  }

  if (tool.name === "itfin_login") {
    deps.out(JSON.stringify(await deps.startLogin()));
    return 0;
  }

  const res = (await deps.client.callTool({ name: tool.name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string }[] };
  const text = res.content.find((c) => c.type === "text")?.text ?? "";
  if (!res.isError) {
    deps.out(text);
    return 0;
  }
  // Tool errors are already JSON; argument validation errors from the SDK are plain text.
  let isJson = true;
  try {
    JSON.parse(text);
  } catch {
    isJson = false;
  }
  deps.err(isJson ? text : errorJson("VALIDATION", text));
  return 1;
}
