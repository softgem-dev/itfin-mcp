// JSON edits for install.sh. Usage: node install-helpers.mjs <command> ...
//   read-config <config>                     prints url, browser, workStart, timezone, permissions and apps as KEY=value
//   write-config <config> <url> <browser> <workStart> <timezone> <permissions yes|no> <id=mode>...
//                                            saves settings, app modes and the permissions choice; keeps what the installer added
//   claude-permissions <settings> <config> [command...]
//                                            replaces the Bash(itfin <command>:*) allow rules this installer
//                                            added before with rules for the given commands; prints the new ones
//   desktop-register <desktop config> <node> <entry> [KEY=value...]
//                                            sets mcpServers.itfin and keeps the rest of the file (old one as .bak)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [command, ...args] = process.argv.slice(2);

function readJson(file) {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  return { text, json: text.trim() ? JSON.parse(text) : {} };
}

function writeJson(file, json) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
}

switch (command) {
  case "read-config": {
    const { json } = readJson(args[0]);
    for (const key of ["url", "browser", "workStart", "timezone"]) if (json[key]) console.log(`${key}=${json[key]}`);
    if (typeof json.allowReadOnlyCommands === "boolean") console.log(`permissions=${json.allowReadOnlyCommands ? "yes" : "no"}`);
    console.log(`apps=${Object.entries(json.apps ?? {}).map(([app, mode]) => `${app}=${mode}`).join(" ")}`);
    break;
  }
  case "write-config": {
    const [file, url, browser, workStart, timezone, permissions, ...apps] = args;
    const { json } = readJson(file);
    const settings = Object.fromEntries(Object.entries({ url, browser, workStart, timezone }).filter(([, v]) => v));
    writeJson(file, { ...settings, apps: Object.fromEntries(apps.map((a) => a.split("="))), allowReadOnlyCommands: permissions !== "no", added: json.added ?? {} });
    break;
  }
  case "claude-permissions": {
    const [settingsFile, configFile, ...commands] = args;
    const config = readJson(configFile).json;
    const previous = new Set(config.added?.claudePermissions ?? []);
    const wanted = commands.map((c) => `Bash(itfin ${c}:*)`);
    if (previous.size || wanted.length) {
      const { text, json: settings } = readJson(settingsFile);
      if (text) writeFileSync(settingsFile + ".bak", text);
      const allow = (settings.permissions?.allow ?? []).filter((rule) => !previous.has(rule));
      const added = wanted.filter((rule) => !allow.includes(rule));
      settings.permissions = { ...settings.permissions, allow: [...allow, ...added] };
      writeJson(settingsFile, settings);
      config.added = { ...config.added, claudePermissions: added };
      writeJson(configFile, config);
      for (const rule of added) console.log(rule);
    }
    break;
  }
  case "desktop-register": {
    const [file, node, entry, ...pairs] = args;
    const { text, json } = readJson(file);
    if (text) writeFileSync(file + ".bak", text);
    const env = Object.fromEntries(pairs.map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
    json.mcpServers = { ...json.mcpServers, itfin: { command: node, args: [entry], env } };
    writeJson(file, json);
    break;
  }
  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}
