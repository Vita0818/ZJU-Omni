import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { ToolError } from './errors.ts';
import { hash } from './util.ts';
import type { StoredCookie } from './cookies.ts';

export async function privateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function writePrivate(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
}

export async function readJson<T = any>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw new ToolError('LOCAL_STATE_INVALID', '本地状态文件无法解析，请重新登录或重新生成操作预览。');
  }
}

export async function removeFile(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (e: any) {
    if (e?.code === 'ENOENT') return false;
    throw e;
  }
}

export async function withLock<T>(path: string, fn: () => Promise<T>, busyMessage = '该操作正在执行或上次结果未知。请先查询平台状态，勿重复执行。'): Promise<T> {
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (e: any) {
    if (e?.code === 'EEXIST') throw new ToolError('ACTION_BUSY', busyMessage);
    throw e;
  }
  try {
    return await fn();
  } finally {
    await handle.close();
    await unlink(path).catch(() => {});
  }
}

export type TransportMode = 'direct' | 'webvpn';

export interface StoredSession {
  platform: string;
  mode: TransportMode;
  saved_at: string;
  cookies: StoredCookie[];
  data?: Record<string, unknown>;
}

export class SessionStore {
  readonly dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, 'sessions');
  }
  path(name: string): string {
    if (!/^[a-z0-9-]+$/.test(name)) throw new ToolError('INVALID_SESSION_NAME', '会话名称无效。');
    return join(this.dir, `${name}.json`);
  }
  async read(name: string): Promise<StoredSession | null> {
    const value = await readJson<StoredSession>(this.path(name));
    if (!value) return null;
    if (value.platform !== name || !Array.isArray(value.cookies) || (value.mode !== 'direct' && value.mode !== 'webvpn')) {
      throw new ToolError('LOCAL_STATE_INVALID', `本地 ${name} 会话格式无法识别，请重新登录。`);
    }
    return value;
  }
  async write(session: StoredSession): Promise<void> {
    await privateDir(this.dir);
    await writePrivate(this.path(session.platform), session);
  }
  async remove(name: string): Promise<boolean> {
    return removeFile(this.path(name));
  }
  static fingerprint(session: Pick<StoredSession, 'mode' | 'cookies'>): string {
    return hash(JSON.stringify({ mode: session.mode, cookies: session.cookies.map(c => [c.domain, c.path, c.name, c.value]) }));
  }
}
