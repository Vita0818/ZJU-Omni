import type { AppContext } from '../../core/context.ts';
import type { SessionClientOptions } from '../../core/session.ts';
import { ZdbkClient } from './client.ts';
import { ZdbkReader } from './reads.ts';

export interface ZdbkServices {
  client: ZdbkClient;
  reader: ZdbkReader;
}

export function createZdbk(ctx: AppContext, options: SessionClientOptions = {}): ZdbkServices {
  const client = new ZdbkClient(ctx, options);
  return { client, reader: new ZdbkReader(client) };
}
