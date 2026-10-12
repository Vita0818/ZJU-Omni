#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './app.ts';
import { loadConfig, type Config } from './core/config.ts';

let cfg: Config;
try {
  cfg = loadConfig();
} catch (e: any) {
  process.stderr.write(`zju-omni: ${e?.message ?? e}\n`);
  process.exit(2);
}
const { server } = buildServer(cfg);
await server.connect(new StdioServerTransport());
