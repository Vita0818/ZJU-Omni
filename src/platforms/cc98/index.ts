import type { AppContext } from '../../core/context.ts';
import { Cc98Actions } from './actions.ts';
import { Cc98Client } from './client.ts';
import { Cc98Reader } from './reads.ts';

export interface Cc98Services {
  client: Cc98Client;
  reader: Cc98Reader;
  actions: Cc98Actions;
}

export function createCc98(ctx: AppContext): Cc98Services {
  const client = new Cc98Client(ctx);
  return { client, reader: new Cc98Reader(client), actions: new Cc98Actions(client, ctx.cfg.dataDir) };
}
