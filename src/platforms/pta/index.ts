import type { AppContext } from '../../core/context.ts';
import { PtaClient } from './client.ts';
import { PtaReader } from './reads.ts';

export interface PtaServices {
  client: PtaClient;
  reader: PtaReader;
}

export function createPta(ctx: AppContext): PtaServices {
  const client = new PtaClient(ctx);
  return { client, reader: new PtaReader(client) };
}
