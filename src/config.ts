import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  /** Workspace address, e.g. https://acme.itfin.io */
  workspaceUrl: string;
  /** Chromium-based browser used for login: chrome | edge | brave | arc | chromium, or an absolute path. */
  browser: string;
  /** Start of working time, HH:mm; relogin reminders fire at this time. */
  workStart: string;
  /** IANA timezone for working time. */
  timezone: string;
}

/** Where the installer keeps the settings, unless ITFIN_CONFIG points elsewhere. */
export const DEFAULT_CONFIG_FILE = join(homedir(), ".itfin-mcp", "config.json");

/** The settings part of the installer's config file. It also holds app modes, which only the installer reads. */
interface ConfigFile {
  url?: string;
  browser?: string;
  workStart?: string;
  timezone?: string;
}

function readConfigFile(file: string): ConfigFile {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(text) as ConfigFile;
  } catch {
    throw new Error(`${file} is not valid JSON. Run npx itfin-mcp@latest install to rewrite it.`);
  }
}

/** Settings come from the config file; ITFIN_* env vars override single values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, file = env.ITFIN_CONFIG?.trim() || DEFAULT_CONFIG_FILE): Config {
  const saved = readConfigFile(file);
  const value = (name: string, fromFile?: string) => env[name]?.trim() || fromFile?.trim() || undefined;
  const workspaceUrl = value("ITFIN_URL", saved.url)?.replace(/\/+$/, "");
  if (!workspaceUrl) throw new Error("No ITFin workspace configured. Run npx itfin-mcp@latest install, or set ITFIN_URL, e.g. https://acme.itfin.io");
  const workStart = value("ITFIN_WORK_START", saved.workStart) ?? "10:00";
  if (!/^\d{1,2}:\d{2}$/.test(workStart)) throw new Error("ITFIN_WORK_START must be HH:mm, e.g. 10:00");
  return {
    workspaceUrl,
    browser: value("ITFIN_BROWSER", saved.browser) ?? "chrome",
    workStart,
    timezone: value("ITFIN_TIMEZONE", saved.timezone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
