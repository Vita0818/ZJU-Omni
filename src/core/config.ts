import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ToolError } from './errors.ts';

export const PROFILES = ['full', 'lite'] as const;
export type Profile = (typeof PROFILES)[number];

export const ALL_PLATFORMS = ['xzzd', 'zdbk', 'zhiyun', 'pta', 'cc98', 'xxt'] as const;
export type PlatformId = (typeof ALL_PLATFORMS)[number];
export const DEFAULT_PLATFORMS: PlatformId[] = ['xzzd', 'zdbk', 'zhiyun', 'pta', 'cc98'];

export const NETWORK_MODES = ['auto', 'direct', 'webvpn'] as const;
export type NetworkMode = (typeof NETWORK_MODES)[number];

export interface Config {
  profile: Profile;
  platforms: ReadonlySet<PlatformId>;
  network: NetworkMode;
  dataDir: string;
  timeoutMs: number;
  maxFileBytes: number;
  minIntervalMs: number;
  storageHosts: string[];
}

type Env = Record<string, string | undefined>;

export function toolProfile(env: Env = process.env): Profile {
  const value = String(env.MCP_TOOL_PROFILE ?? 'full').trim().toLowerCase() || 'full';
  if (!(PROFILES as readonly string[]).includes(value)) {
    throw new ToolError('CONFIG_ERROR', `MCP_TOOL_PROFILE 只能是 ${PROFILES.join(' 或 ')}，收到：${value}`);
  }
  return value as Profile;
}

export function enabledPlatforms(env: Env = process.env): Set<PlatformId> {
  const raw = (env.ZJU_PLATFORMS ?? '').trim();
  if (!raw) return new Set(DEFAULT_PLATFORMS);
  const out = new Set<PlatformId>();
  for (const item of raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
    if (!(ALL_PLATFORMS as readonly string[]).includes(item)) {
      throw new ToolError('CONFIG_ERROR', `ZJU_PLATFORMS 含未知平台：${item}。可选：${ALL_PLATFORMS.join(', ')}`);
    }
    out.add(item as PlatformId);
  }
  if (!out.size) throw new ToolError('CONFIG_ERROR', 'ZJU_PLATFORMS 至少要启用一个平台。');
  return out;
}

export function networkMode(env: Env = process.env): NetworkMode {
  const value = String(env.ZJU_NETWORK ?? 'auto').trim().toLowerCase() || 'auto';
  if (!(NETWORK_MODES as readonly string[]).includes(value)) {
    throw new ToolError('CONFIG_ERROR', `ZJU_NETWORK 只能是 ${NETWORK_MODES.join('、')}，收到：${value}`);
  }
  return value as NetworkMode;
}

function nonNegativeInt(value: string | undefined, fallback: number, name: string): number {
  if (value == null || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new ToolError('CONFIG_ERROR', `${name} 必须是非负整数。`);
  return n;
}

export function loadConfig(env: Env = process.env): Config {
  return {
    profile: toolProfile(env),
    platforms: enabledPlatforms(env),
    network: networkMode(env),
    dataDir: resolve(env.ZJU_OMNI_DATA_DIR || join(homedir(), '.local', 'share', 'zju-omni')),
    timeoutMs: 25000,
    maxFileBytes: 100 * 1024 * 1024,
    minIntervalMs: nonNegativeInt(env.ZJU_MIN_INTERVAL_MS, 200, 'ZJU_MIN_INTERVAL_MS'),
    storageHosts: (env.ZJU_XZZD_STORAGE_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean),
  };
}
