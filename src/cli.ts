#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, SERVER_NAME, SERVER_VERSION } from './app.ts';
import { authForget, authLogin, authStatus } from './auth/tools.ts';
import { ALL_PLATFORMS, loadConfig, type PlatformId } from './core/config.ts';
import { createContext } from './core/context.ts';
import { safeError } from './core/errors.ts';
import { ACCOUNT_KINDS, accountLabel, storePasswordInteractively, type AccountKind } from './core/keychain.ts';
import { catalogSize } from './core/tools.ts';
import { createRuntime } from './platforms/index.ts';
import { PtaClient } from './platforms/pta/client.ts';

const USAGE = `用法: zju-omni-cli <命令>

  configure [zju|cc98|xxt]       把账号存入 macOS 钥匙串（默认 zju，浙大统一认证）
  login [平台]                   立即登录指定平台（默认 xzzd）
  status [--check]               查看凭据、会话；--check 对已有会话做只读验证
  forget [平台] [--credentials]  删除会话；--credentials 同时删除钥匙串账号
  pta-cookie                     从标准输入导入拼题A Cookie（如 pbpaste | … pta-cookie）
  tools [full|lite]              输出工具目录与体积

平台: ${ALL_PLATFORMS.join(', ')}`;

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function platformArg(value: string | undefined, fallback?: PlatformId): PlatformId | undefined {
  if (!value || value.startsWith('--')) return fallback;
  if (!(ALL_PLATFORMS as readonly string[]).includes(value)) throw new Error(`未知平台：${value}`);
  return value as PlatformId;
}

async function configure(kindArg: string | undefined) {
  const kind = (kindArg ?? 'zju') as AccountKind;
  if (!(ACCOUNT_KINDS as readonly string[]).includes(kind)) throw new Error(`未知账号类型：${kind}。可选：${ACCOUNT_KINDS.join(', ')}`);
  if (process.platform !== 'darwin') throw new Error('此命令使用 macOS 钥匙串。其他系统请通过受保护的启动环境提供账号变量。');
  if (!process.stdin.isTTY) throw new Error('请在你自己的终端里运行此命令。不要把密码粘贴到 AI 对话中。');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const username = (await rl.question(`${accountLabel(kind)}账号：`)).trim();
  rl.close();
  if (!username || username.length > 200 || /[\x00-\x1f]/.test(username)) throw new Error('账号格式无效。');
  process.stdout.write('下面由 macOS security 工具读取密码（输入时不显示字符），并保存到钥匙串。\n');
  if (!(await storePasswordInteractively(kind, username))) throw new Error('钥匙串写入未完成，账号配置未改变。');
  const cfg = loadConfig();
  const ctx = createContext(cfg);
  await ctx.accounts.record(kind, username);
  const stale: string[] = kind === 'zju' ? ['xzzd', 'zdbk', 'zhiyun', 'webvpn'] : [kind];
  for (const name of stale) await ctx.sessions.remove(name);
  process.stdout.write(`已配置${accountLabel(kind)}账号。回到客户端即可自动登录；也可以运行 npm run login 验证。\n`);
}

async function catalog(profileArg: string | undefined) {
  const profile = profileArg === 'lite' ? 'lite' : 'full';
  const cfg = loadConfig({ ...process.env, MCP_TOOL_PROFILE: profile });
  const { server } = buildServer(cfg);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'zju-omni-cli', version: SERVER_VERSION });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  print({ server: SERVER_NAME, version: SERVER_VERSION, profile, platforms: [...cfg.platforms], tool_count: tools.length, catalog_characters: catalogSize(tools), tools });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'configure':
      return configure(args[0]);
    case 'login': {
      const runtime = createRuntime(createContext(loadConfig()));
      return print(await authLogin(runtime, platformArg(args[0], 'xzzd')!));
    }
    case 'status': {
      const runtime = createRuntime(createContext(loadConfig()));
      return print(await authStatus(runtime, { check: args.includes('--check') }));
    }
    case 'forget': {
      const runtime = createRuntime(createContext(loadConfig()));
      return print(await authForget(runtime, { platform: platformArg(args[0]), remove_credentials: args.includes('--credentials') }));
    }
    case 'tools':
      return catalog(args[0]);
    case 'pta-cookie': {
      if (process.stdin.isTTY) throw new Error('请通过管道传入，例如：pbpaste | npm run cli -- pta-cookie');
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      const ctx = createContext(loadConfig());
      const pta = new PtaClient(ctx);
      const saved = await pta.importCookie(Buffer.concat(chunks).toString('utf8'));
      const check = await pta.check().catch(e => ({ authenticated: false, reason: safeError(e).code }));
      return print({ imported_from: saved.source, cookie_names: saved.cookie_names, ...check });
    }
    default:
      process.stdout.write(`${USAGE}\n`);
      if (command && command !== 'help' && command !== '--help') process.exitCode = 2;
  }
}

try {
  await main();
} catch (e) {
  const error = safeError(e);
  process.stderr.write(`${error.code === 'INTERNAL_ERROR' && e instanceof Error ? e.message : JSON.stringify(error, null, 2)}\n`);
  process.exitCode = 1;
}
