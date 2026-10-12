import { z } from 'zod';
import { ALL_PLATFORMS, type PlatformId } from '../core/config.ts';
import { ToolError } from '../core/errors.ts';
import { ACCOUNT_KINDS } from '../core/keychain.ts';
import type { FullTool } from '../core/tools.ts';
import { IMPLEMENTED_PLATFORMS, PLATFORM_LABELS, type Runtime } from '../platforms/index.ts';

const platformEnum = z.enum(ALL_PLATFORMS);

export async function authStatus(runtime: Runtime, { platform, check = false }: { platform?: PlatformId; check?: boolean } = {}) {
  const { ctx } = runtime;
  const targets = platform ? [platform] : [...ctx.cfg.platforms];
  const credentials = await Promise.all(ACCOUNT_KINDS.map(kind => ctx.accounts.status(kind)));
  const platforms = [];
  for (const id of targets) {
    const enabled = ctx.cfg.platforms.has(id);
    const implemented = IMPLEMENTED_PLATFORMS.has(id);
    const stored = await ctx.sessions.read(id).catch(() => null);
    const row: Record<string, unknown> = {
      platform: id,
      name: PLATFORM_LABELS[id],
      enabled,
      implemented,
      session: stored ? { mode: stored.mode, saved_at: stored.saved_at } : null,
    };
    const client = runtime.clients.get(id);
    if (check && client) row.live = await client.check();
    platforms.push(row);
  }
  const webvpn = await ctx.sessions.read('webvpn').catch(() => null);
  return {
    network: ctx.cfg.network,
    profile: ctx.cfg.profile,
    credentials: credentials.map(({ kind, configured, backend }) => ({ kind, configured, backend })),
    webvpn_session: webvpn ? { saved_at: webvpn.saved_at } : null,
    platforms,
    note: '凭据只保存在本机钥匙串；未配置时让用户在本机终端运行 npm run configure -- zju。本工具不返回密码或 Cookie。',
  };
}

export async function authLogin(runtime: Runtime, platform: PlatformId) {
  if (!runtime.ctx.cfg.platforms.has(platform)) throw new ToolError('PLATFORM_DISABLED', `${PLATFORM_LABELS[platform]} 未启用。请在 ZJU_PLATFORMS 中加入 ${platform}。`);
  const client = runtime.clients.get(platform);
  if (!client) throw new ToolError('PLATFORM_NOT_IMPLEMENTED', `${PLATFORM_LABELS[platform]} 尚未实现登录。`);
  const session = await client.refreshSession();
  return { platform, authenticated: true, mode: session.mode, saved_at: session.stored.saved_at, message: `已连接${PLATFORM_LABELS[platform]}（${session.mode === 'webvpn' ? '经 WebVPN' : '直连'}）。` };
}

export async function authForget(runtime: Runtime, { platform, remove_credentials = false }: { platform?: PlatformId; remove_credentials?: boolean }) {
  const { ctx } = runtime;
  const removed: string[] = [];
  const targets = platform ? [platform] : [...ALL_PLATFORMS];
  for (const id of targets) if (await ctx.sessions.remove(id)) removed.push(id);
  if (!platform) {
    if (await ctx.sessions.remove('webvpn')) removed.push('webvpn');
    ctx.network.clearSso();
  }
  const credentials: string[] = [];
  if (remove_credentials) {
    const kinds = platform === 'cc98' ? (['cc98'] as const) : platform === 'xxt' ? (['xxt'] as const) : platform ? (['zju'] as const) : ACCOUNT_KINDS;
    for (const kind of kinds) if (await ctx.accounts.remove(kind)) credentials.push(kind);
  }
  return {
    removed_sessions: removed,
    removed_credentials: credentials,
    message: remove_credentials ? '已删除会话和对应的钥匙串账号。若凭据通过环境变量提供，请同时移除启动环境变量。' : '已删除会话；钥匙串中的账号保留，下次调用会自动重新登录。',
  };
}

export function authTools(runtime: Runtime): FullTool[] {
  return [
    {
      name: 'zju_auth_status',
      title: '检查各平台登录状态',
      description: '列出凭据配置、各平台会话和网络模式；check=true 时对已有会话做一次只读验证（不会自动登录）。不返回密码或 Cookie。',
      input: { platform: platformEnum.optional(), check: z.boolean().default(false) },
      platform: 'zju',
      run: args => authStatus(runtime, args),
    },
    {
      name: 'zju_auth_login',
      title: '登录指定平台',
      description: '使用本机钥匙串凭据，通过浙大统一认证 HTTP 链路登录指定平台（不开浏览器）。auto 网络模式下直连不通时改走 WebVPN。遇到验证码或二次验证会停止并说明。',
      input: { platform: platformEnum.default('xzzd') },
      platform: 'zju',
      readOnly: false,
      idempotent: true,
      run: args => authLogin(runtime, args.platform),
    },
    {
      name: 'zju_auth_forget',
      title: '断开平台会话',
      description: '删除指定平台（省略则全部）的本地会话。remove_credentials=true 时一并删除钥匙串中对应账号，仅在用户明确要求断开账号时使用。',
      input: { platform: platformEnum.optional(), remove_credentials: z.boolean().default(false) },
      platform: 'zju',
      readOnly: false,
      destructive: true,
      idempotent: true,
      run: args => authForget(runtime, args),
    },
  ];
}
