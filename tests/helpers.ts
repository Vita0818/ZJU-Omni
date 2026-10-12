import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig, type Config } from '../src/core/config.ts';
import { createContext, type AppContext } from '../src/core/context.ts';
import type { FetchImpl } from '../src/core/http.ts';
import type { SecurityRunner } from '../src/core/keychain.ts';
import { SessionStore, type StoredSession } from '../src/core/store.ts';
import { XZZD_BASE_URL, type XzzdConfig } from '../src/platforms/xzzd/client.ts';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export async function tempDir(t: TestContext, prefix = 'zju-omni-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export function baseEnv(dataDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return { ZJU_OMNI_DATA_DIR: dataDir, ZJU_OMNI_LEGACY_DIR: '', ZJU_MIN_INTERVAL_MS: '0', ...extra };
}

export interface TestCtxOptions {
  env?: Record<string, string>;
  fetchImpl?: FetchImpl;
  securityRunner?: SecurityRunner;
}

export async function testContext(t: TestContext, options: TestCtxOptions = {}): Promise<{ root: string; cfg: Config; ctx: AppContext }> {
  const root = await tempDir(t);
  const env = baseEnv(join(root, 'state'), options.env);
  const cfg = loadConfig(env);
  const ctx = createContext(cfg, { env, fetchImpl: options.fetchImpl, securityRunner: options.securityRunner });
  return { root, cfg, ctx };
}

export function xzzdCfg(dataDir: string): XzzdConfig {
  return { baseUrl: XZZD_BASE_URL, dataDir, maxFileBytes: 100 * 1024 * 1024, storageHosts: [] };
}

export function xzzdSession(value = 'test-secret-not-real'): StoredSession {
  return {
    platform: 'xzzd',
    mode: 'direct',
    saved_at: new Date().toISOString(),
    cookies: [{ name: 'session', value, domain: 'courses.zju.edu.cn', path: '/', expires: -1, secure: true, httpOnly: true, hostOnly: true }],
  };
}

export function fingerprintFrom(store: SessionStore, platform = 'xzzd') {
  return async () => {
    const stored = await store.read(platform);
    if (!stored) throw new Error('no session');
    return SessionStore.fingerprint(stored);
  };
}

export async function connectServer(t: TestContext, env: Record<string, string>): Promise<Client> {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(ZJU_|CC98_|XXT_|MCP_TOOL_PROFILE)/.test(k)) childEnv[k] = v;
  Object.assign(childEnv, env);
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'src/server.ts')], cwd: ROOT, env: childEnv, stderr: 'pipe' });
  const client = new Client({ name: 'zju-omni-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  return client;
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

export function mockFetch(handler: Handler): FetchImpl & { calls: { url: URL; init: RequestInit }[] } {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, init });
    return handler(parsed, init);
  }) as FetchImpl & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

export function respond(status: number, body: unknown = '', headers: Record<string, string> | [string, string][] = {}): Response {
  const h = new Headers(headers as any);
  let payload: string | null;
  if (typeof body === 'string') payload = body;
  else {
    payload = JSON.stringify(body);
    if (!h.has('content-type')) h.set('content-type', 'application/json');
  }
  if (status === 204 || status === 304) payload = null;
  return new Response(payload, { status, headers: h });
}
