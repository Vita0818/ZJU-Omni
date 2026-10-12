import type { AppContext } from '../../core/context.ts';
import type { SessionClientOptions } from '../../core/session.ts';
import { CourseActions } from './actions.ts';
import { XzzdClient } from './client.ts';
import { CourseReader } from './reads.ts';
import { MaterialSync } from './sync.ts';
import { CourseWorkflows } from './workflows.ts';

export interface XzzdServices {
  client: XzzdClient;
  reader: CourseReader;
  actions: CourseActions;
  workflows: CourseWorkflows;
  materials: MaterialSync;
}

export function createXzzd(ctx: AppContext, options: SessionClientOptions = {}): XzzdServices {
  const client = new XzzdClient(ctx, options);
  const reader = new CourseReader(client);
  return {
    client,
    reader,
    actions: new CourseActions(reader),
    workflows: new CourseWorkflows(reader),
    materials: new MaterialSync(reader),
  };
}
