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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const workspaceUrl = env.ITFIN_URL?.trim().replace(/\/+$/, "");
  if (!workspaceUrl) throw new Error("ITFIN_URL is required, e.g. https://acme.itfin.io");
  const workStart = env.ITFIN_WORK_START?.trim() || "10:00";
  if (!/^\d{1,2}:\d{2}$/.test(workStart)) throw new Error("ITFIN_WORK_START must be HH:mm, e.g. 10:00");
  return {
    workspaceUrl,
    browser: env.ITFIN_BROWSER?.trim() || "chrome",
    workStart,
    timezone: env.ITFIN_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
