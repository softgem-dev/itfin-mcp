export interface Config {
  /** Workspace address, e.g. https://acme.itfin.io */
  workspaceUrl: string;
  /** Chromium-based browser used for login: chrome | edge | brave | arc | chromium, or an absolute path. */
  browser: string;
  /** Start and end of working time, HH:mm. */
  workStart: string;
  workEnd: string;
  /** IANA timezone for working time. */
  timezone: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const workspaceUrl = env.ITFIN_URL?.trim().replace(/\/+$/, "");
  if (!workspaceUrl) throw new Error("ITFIN_URL is required, e.g. https://acme.itfin.io");
  const [workStart = "10:00", workEnd = "19:00"] = (env.ITFIN_WORK_HOURS ?? "10:00-19:00").split("-").map((s) => s.trim());
  return {
    workspaceUrl,
    browser: env.ITFIN_BROWSER?.trim() || "chrome",
    workStart,
    workEnd,
    timezone: env.ITFIN_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
