import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import { ToolError, safeError } from './errors.ts';

export interface ToolBehavior {
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
}

export interface FullTool extends ToolBehavior {
  name: string;
  title: string;
  description: string;
  input: ZodRawShape;
  platform: string;
  run: (args: any) => Promise<unknown>;
}

export interface LiteTool extends ToolBehavior {
  name: string;
  title: string;
  description: string;
  input: ZodRawShape;
  strict: ZodRawShape;
  defaults?: Record<string, unknown>;
  run: (args: any) => Promise<unknown>;
}

function annotations(tool: ToolBehavior) {
  const readOnly = tool.readOnly ?? true;
  return { readOnlyHint: readOnly, destructiveHint: tool.destructive ?? false, idempotentHint: tool.idempotent ?? readOnly, openWorldHint: false };
}

const DROPPED_KEYS = new Set(['url', 'source_url', 'meta']);

// Top-level empty lists are kept: a bare "{}" reads like a failure to small models.
export function compactValue(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.map(item => compactValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined || DROPPED_KEYS.has(key)) continue;
    if (Array.isArray(item) && item.length === 0 && depth > 0) continue;
    out[key] = compactValue(item, depth + 1);
  }
  return out;
}

export function strictArgs<T extends ZodRawShape>(shape: T, args: unknown): z.infer<z.ZodObject<T>> {
  const parsed = z.object(shape).safeParse(args);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map(issue => `${issue.path.join('.') || '参数'}: ${issue.message}`).join('；');
  throw new ToolError('INVALID_ARGUMENT', `参数不合法：${issues}`);
}

/**
 * The schema shown to the model: same fields, types, enums and defaults, but
 * without numeric bounds, string patterns/lengths and array sizes. Those
 * constraints are still enforced on the server by `strictArgs` against the
 * original shape, so publishing them only costs context.
 */
export function looseSchema(schema: z.ZodType): z.ZodType {
  const def: any = (schema as any)._zod.def;
  let out: z.ZodType;
  switch (def.type) {
    case 'optional':
      out = looseSchema(def.innerType).optional();
      break;
    case 'nullable':
      out = looseSchema(def.innerType).nullable();
      break;
    case 'default':
      out = looseSchema(def.innerType).default(def.defaultValue);
      break;
    case 'number':
      out = z.number();
      break;
    case 'string':
      out = z.string();
      break;
    case 'array':
      out = z.array(looseSchema(def.element));
      break;
    case 'union':
      out = z.union(def.options.map((option: z.ZodType) => looseSchema(option)));
      break;
    case 'object':
      out = z.object(looseShape(def.shape));
      break;
    default:
      return schema;
  }
  return schema.description ? out.describe(schema.description) : out;
}

export function looseShape(shape: ZodRawShape): ZodRawShape {
  return Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, looseSchema(value as z.ZodType)]));
}

const outputSchema = {
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.record(z.string(), z.unknown()).optional(),
  meta: z.object({ platform: z.string(), fetched_at: z.string() }),
};

export function registerFull(server: McpServer, tools: FullTool[]): void {
  for (const tool of tools) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: looseShape(tool.input), outputSchema, annotations: annotations(tool) }, async (args: any) => {
      const meta = { platform: tool.platform, fetched_at: new Date().toISOString() };
      try {
        const data = await tool.run(strictArgs(tool.input, stripUndefined(args)));
        const payload = { ok: true, data, meta };
        return { structuredContent: payload, content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
      } catch (e) {
        const payload = { ok: false, error: safeError(e), meta };
        return { isError: true, structuredContent: payload, content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
      }
    });
  }
}

export const REPEAT_WINDOW_MS = 120000;

/**
 * Small models sometimes loop on an identical call. In the lite profile an
 * exact repeat of the previous successful read within two minutes is answered
 * with a short nudge instead of re-querying the platform.
 */
export function registerLite(server: McpServer, tools: LiteTool[], now: () => number = Date.now): void {
  let last: { signature: string; at: number; tool: string; result: string } | null = null;
  for (const tool of tools) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: annotations(tool) }, async (args: any) => {
      try {
        const parsed = strictArgs(tool.strict, { ...(tool.defaults ?? {}), ...stripUndefined(args) });
        const signature = `${tool.name}:${JSON.stringify(parsed)}`;
        const readOnly = tool.readOnly ?? true;
        if (readOnly && last && last.signature === signature && now() - last.at < REPEAT_WINDOW_MS) {
          last.at = now();
          return { content: [{ type: 'text' as const, text: JSON.stringify({ repeated_call: true, note: '这次调用与上一次完全相同，结果不会变化，见上一次返回。请直接根据上一次结果回答用户，不要再调用。' }) }] };
        }
        const text = JSON.stringify(compactValue(await tool.run(parsed)));
        const sameResult = readOnly && last && last.tool === tool.name && last.result === text && now() - last.at < REPEAT_WINDOW_MS;
        last = readOnly ? { signature, at: now(), tool: tool.name, result: text } : null;
        if (sameResult) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ same_result_as_previous: true, note: '参数变了但结果与上一次完全相同，说明这个参数对该操作不起作用。请直接根据上一次结果回答用户。' }) }] };
        }
        return { content: [{ type: 'text' as const, text }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: compactValue(safeError(e)) }) }] };
      }
    });
  }
}

function stripUndefined(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object') return {};
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
}

/**
 * The SDK stamps every tool schema with a JSON Schema dialect URL ("$schema"),
 * about 50 characters per tool that no model needs. Wrap the registered
 * tools/list handler (SDK 1.32 keeps it in `_requestHandlers`) and drop it.
 * tests/profile.test.ts asserts the result, so an SDK change is caught.
 */
export function dropSchemaDialect(server: McpServer): void {
  const handlers: Map<string, (request: unknown, extra: unknown) => Promise<any>> | undefined = (server.server as any)._requestHandlers;
  const original = handlers?.get('tools/list');
  if (!handlers || !original) return;
  handlers.set('tools/list', async (request, extra) => {
    const result = await original(request, extra);
    for (const tool of result?.tools ?? []) {
      if (tool.inputSchema) delete tool.inputSchema.$schema;
      if (tool.outputSchema) delete tool.outputSchema.$schema;
    }
    return result;
  });
}

export interface CatalogEntry {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export function catalogSize(tools: CatalogEntry[]): number {
  return JSON.stringify(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))).length;
}
