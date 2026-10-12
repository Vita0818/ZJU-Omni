import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ToolError, safeError } from './errors.ts';
import { privateDir, readJson, withLock, writePrivate } from './store.ts';

const PLAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Plan<T = Record<string, unknown>> {
  schema_version: 1;
  id: string;
  kind: string;
  status: 'prepared' | 'executing' | 'verified' | 'unverified' | 'failed_or_unknown';
  created_at: string;
  expires_at: string;
  session: string;
  payload: T;
  result?: unknown;
  error?: unknown;
}

/**
 * Two-step write plans: prepare stores the exact parameters; execute runs
 * at most once, under a lock, before expiry, on the same login session.
 */
export class PlanStore {
  readonly dir: string;
  readonly ttlMs: number;
  constructor(dataDir: string, platform: string, ttlMs = 15 * 60000) {
    this.dir = join(dataDir, 'plans', platform);
    this.ttlMs = ttlMs;
  }

  async create<T>(kind: string, session: string, payload: T): Promise<Plan<T>> {
    await privateDir(this.dir);
    const plan: Plan<T> = { schema_version: 1, id: randomUUID(), kind, status: 'prepared', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + this.ttlMs).toISOString(), session, payload };
    await writePrivate(join(this.dir, `${plan.id}.json`), plan);
    return plan;
  }

  async execute<T, R extends { verified: boolean }>(id: string, kind: string, currentSession: () => Promise<string>, fn: (plan: Plan<T>) => Promise<R>): Promise<R> {
    if (!PLAN_ID.test(id)) throw new ToolError('INVALID_PLAN', '无效操作预览编号。');
    await privateDir(this.dir);
    const path = join(this.dir, `${id}.json`);
    return withLock(`${path}.lock`, async () => {
      const plan = await readJson<Plan<T>>(path);
      if (!plan || plan.kind !== kind || plan.schema_version !== 1) throw new ToolError('INVALID_PLAN', '该预览不存在或操作类型不匹配。');
      if (plan.status !== 'prepared') throw new ToolError('PLAN_CONSUMED', '该预览已经执行过。请先读回平台状态，不能重复执行。', { previous_status: plan.status });
      if (Date.parse(plan.expires_at) < Date.now()) throw new ToolError('PLAN_EXPIRED', '操作预览已过期，请重新生成。');
      if (plan.session !== (await currentSession())) throw new ToolError('SESSION_CHANGED', '登录账号已更换，请重新预览。');
      plan.status = 'executing';
      await writePrivate(path, plan);
      try {
        const result = await fn(plan);
        plan.status = result.verified ? 'verified' : 'unverified';
        plan.result = result;
        await writePrivate(path, plan);
        return result;
      } catch (e) {
        plan.status = 'failed_or_unknown';
        plan.error = safeError(e);
        await writePrivate(path, plan);
        throw e;
      }
    }, '该操作正在执行或上次结果未知。请先读回平台状态，勿重复执行。');
  }
}
