#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { systemClock } from "./clock.js";
import { loadConfig } from "./config.js";
import { createItfinServer } from "./server.js";
import { KeychainTokenStore } from "./tokenStore.js";

const config = loadConfig();
const server = createItfinServer({
  config,
  clock: systemClock,
  tokenStore: new KeychainTokenStore("itfin-mcp", config.workspaceUrl),
});
await server.connect(new StdioServerTransport());
