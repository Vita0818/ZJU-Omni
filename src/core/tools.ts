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

export function compactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactValue);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined || DROPPED_KEYS.has(key)) continue;
    if (Array.isArray(item) && item.length === 0) continue;
    out[key] = compactValue(item);
  }
  return out;
}

export function strictArgs<T extends ZodRawShape>(shape: T, args: unknown): z.infer<z.ZodObject<T>> {
  const parsed = z.object(shape).safeParse(args);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map(issue => `${issue.path.join('.') || '参数'}: ${issue.message}`).join('；');
  throw new ToolError('INVALID_ARGUMENT', `参数不合法：${issues}`);
}

const outputSchema = {
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.record(z.string(), z.unknown()).optional(),
  meta: z.object({ platform: z.string(), fetched_at: z.string() }),
};

export function registerFull(server: McpServer, tools: FullTool[]): void {
  for (const tool of tools) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.input, outputSchema, annotations: annotations(tool) }, async (args: any) => {
      const meta = { platform: tool.platform, fetched_at: new Date().toISOString() };
      try {
        const data = await tool.run(args);
        const payload = { ok: true, data, meta };
        return { structuredContent: payload, content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
      } catch (e) {
        const payload = { ok: false, error: safeError(e), meta };
        return { isError: true, structuredContent: payload, content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
      }
    });
  }
}

export function registerLite(server: McpServer, tools: LiteTool[]): void {
  for (const tool of tools) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: annotations(tool) }, async (args: any) => {
      try {
        const parsed = strictArgs(tool.strict, { ...(tool.defaults ?? {}), ...stripUndefined(args) });
        const data = await tool.run(parsed);
        return { content: [{ type: 'text' as const, text: JSON.stringify(compactValue(data)) }] };
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

export interface CatalogEntry {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export function catalogSize(tools: CatalogEntry[]): number {
  return JSON.stringify(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))).length;
}
