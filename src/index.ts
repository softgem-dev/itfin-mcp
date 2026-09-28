#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { systemClock } from "./clock.js";
import { loadConfig } from "./config.js";
import { createItfinServer } from "./server.js";
import { KeychainTokenStore } from "./tokenStore.js";

// `npx itfin-mcp install [flags]` runs the installer shipped in the package. Without arguments this
// is the MCP server itself.
if (process.argv[2] === "install") {
  const script = fileURLToPath(new URL("../scripts/install.sh", import.meta.url));
  const result = spawnSync("bash", [script, ...process.argv.slice(3)], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

const config = loadConfig();
const server = createItfinServer({
  config,
  clock: systemClock,
  tokenStore: new KeychainTokenStore("itfin-mcp", config.workspaceUrl),
});
await server.connect(new StdioServerTransport());
