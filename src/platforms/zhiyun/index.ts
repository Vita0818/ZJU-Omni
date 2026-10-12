import type { AppContext } from '../../core/context.ts';
import type { SessionClientOptions } from '../../core/session.ts';
import { ZhiyunClient } from './client.ts';
import { ZhiyunReader } from './reads.ts';

export interface ZhiyunServices {
  client: ZhiyunClient;
  reader: ZhiyunReader;
}

export function createZhiyun(ctx: AppContext, options: SessionClientOptions = {}): ZhiyunServices {
  const client = new ZhiyunClient(ctx, options);
  return { client, reader: new ZhiyunReader(client) };
}
