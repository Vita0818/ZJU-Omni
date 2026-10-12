import type { AppContext } from '../../core/context.ts';
import { XxtClient } from './client.ts';
import { XxtReader } from './reads.ts';

export interface XxtServices {
  client: XxtClient;
  reader: XxtReader;
}

export function createXxt(ctx: AppContext): XxtServices {
  const client = new XxtClient(ctx);
  return { client, reader: new XxtReader(client) };
}
