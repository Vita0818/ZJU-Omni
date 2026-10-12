import type { PlatformId } from '../core/config.ts';
import type { AppContext } from '../core/context.ts';
import type { SessionClient } from '../core/session.ts';
import type { FullTool } from '../core/tools.ts';
import { createXzzd, type XzzdServices } from './xzzd/index.ts';
import { xzzdTools } from './xzzd/tools.ts';
import { createZdbk, type ZdbkServices } from './zdbk/index.ts';
import { zdbkTools } from './zdbk/tools.ts';
import { createCc98, type Cc98Services } from './cc98/index.ts';
import { cc98Tools } from './cc98/tools.ts';
import { createPta, type PtaServices } from './pta/index.ts';
import { ptaTools } from './pta/tools.ts';
import { createZhiyun, type ZhiyunServices } from './zhiyun/index.ts';
import { zhiyunTools } from './zhiyun/tools.ts';

export const PLATFORM_LABELS: Record<PlatformId, string> = {
  xzzd: '学在浙大',
  zdbk: '教务（本科生院）',
  zhiyun: '智云课堂',
  pta: '拼题A',
  cc98: 'CC98',
  xxt: '学习通',
};

export const IMPLEMENTED_PLATFORMS: ReadonlySet<PlatformId> = new Set(['xzzd', 'zdbk', 'zhiyun', 'pta', 'cc98']);

export interface Runtime {
  ctx: AppContext;
  xzzd?: XzzdServices;
  zdbk?: ZdbkServices;
  zhiyun?: ZhiyunServices;
  pta?: PtaServices;
  cc98?: Cc98Services;
  clients: Map<PlatformId, SessionClient>;
  tools: FullTool[];
}

export function createRuntime(ctx: AppContext): Runtime {
  const runtime: Runtime = { ctx, clients: new Map(), tools: [] };
  if (ctx.cfg.platforms.has('xzzd')) {
    runtime.xzzd = createXzzd(ctx);
    runtime.clients.set('xzzd', runtime.xzzd.client);
    runtime.tools.push(...xzzdTools(runtime.xzzd));
  }
  if (ctx.cfg.platforms.has('zdbk')) {
    runtime.zdbk = createZdbk(ctx);
    runtime.clients.set('zdbk', runtime.zdbk.client);
    runtime.tools.push(...zdbkTools(runtime.zdbk));
  }
  if (ctx.cfg.platforms.has('zhiyun')) {
    runtime.zhiyun = createZhiyun(ctx);
    runtime.clients.set('zhiyun', runtime.zhiyun.client);
    runtime.tools.push(...zhiyunTools(runtime.zhiyun));
  }
  if (ctx.cfg.platforms.has('pta')) {
    runtime.pta = createPta(ctx);
    runtime.tools.push(...ptaTools(runtime.pta));
  }
  if (ctx.cfg.platforms.has('cc98')) {
    runtime.cc98 = createCc98(ctx);
    runtime.tools.push(...cc98Tools(runtime.cc98));
  }
  return runtime;
}
