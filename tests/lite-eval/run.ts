// Fixed-question evaluation of the lite profile with a local OpenAI-compatible
// model (LM Studio by default). Uses the real account, read-only: write tools
// are intercepted and never reach the platform.
// Usage: npm run eval:lite -- [--model=ornith-1.5-9b] [--base=http://localhost:1234/v1] [--only=id1,id2] [--verbose]
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../../src/app.ts';
import { loadConfig } from '../../src/core/config.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name: string, fallback?: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const MODEL = arg('model', 'ornith-1.5-9b')!;
const BASE = arg('base', 'http://localhost:1234/v1')!;
const ONLY = arg('only')?.split(',');
const VERBOSE = process.argv.includes('--verbose');
const MAX_ROUNDS = 5;
const INTERCEPTED = new Set(['zju_submit', 'zju_prepare_submission', 'zju_sync']);

interface Question {
  id: string;
  prompt: string;
  expect_first?: string[];
  expect_any?: string[];
  forbid?: string[];
}

const questions: Question[] = JSON.parse(await readFile(join(ROOT, 'tests/lite-eval/questions.json'), 'utf8'));
const skill = (await readFile(join(ROOT, 'skills/zju-lite/SKILL.md'), 'utf8')).replace(/^---[\s\S]*?---\s*/, '');

const cfg = loadConfig({ ...process.env, MCP_TOOL_PROFILE: 'lite' });
const { server } = buildServer(cfg);
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await server.connect(serverSide);
const mcp = new Client({ name: 'zju-omni-eval', version: '1.0.0' });
await mcp.connect(clientSide);
const { tools } = await mcp.listTools();
const instructions = mcp.getInstructions() ?? '';
const openaiTools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
const today = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'full' }).format(new Date());
const system = `${instructions}\n\n${skill}\n今天是 ${today}（北京时间）。用中文简洁回答。`;

async function chat(messages: any[]): Promise<any> {
  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer lm-studio' },
    body: JSON.stringify({ model: MODEL, messages, tools: openaiTools, tool_choice: 'auto', temperature: 0, max_tokens: 2048, reasoning_effort: 'none' }),
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) throw new Error(`model HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return (await response.json()).choices?.[0]?.message;
}

async function callTool(name: string, rawArgs: string): Promise<{ text: string; error?: string }> {
  let args: Record<string, unknown>;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { text: JSON.stringify({ error: { code: 'INVALID_JSON', message: '参数不是合法 JSON。' } }), error: 'INVALID_JSON' };
  }
  if (INTERCEPTED.has(name)) {
    const note = name === 'zju_prepare_submission'
      ? { plan_id: '00000000-0000-4000-8000-000000000000', assignment: '（评测模拟）', files: [String((args.file_paths as string[] | undefined)?.[0] ?? '')], note: '尚未提交。用户确认后调用 zju_submit。' }
      : { error: { code: 'EVAL_BLOCKED', message: '评测环境禁止此写操作。' } };
    return { text: JSON.stringify(note) };
  }
  const result: any = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = result.content?.[0]?.text ?? '';
  return { text, error: result.isError ? JSON.parse(text).error?.code : undefined };
}

const rows: any[] = [];
for (const q of questions.filter(q => !ONLY || ONLY.includes(q.id))) {
  const messages: any[] = [{ role: 'system', content: system }, { role: 'user', content: q.prompt }];
  const calls: { name: string; error?: string }[] = [];
  let answer = '';
  const started = Date.now();
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const message = await chat(messages);
      if (!message) throw new Error('empty model response');
      const toolCalls = message.tool_calls ?? [];
      messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: toolCalls.length ? toolCalls : undefined });
      if (!toolCalls.length) {
        answer = String(message.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        break;
      }
      for (const call of toolCalls) {
        const name = call.function?.name;
        const result = await callTool(name, call.function?.arguments ?? '');
        calls.push({ name, error: result.error });
        messages.push({ role: 'tool', tool_call_id: call.id, content: result.text.slice(0, 24000) });
      }
    }
  } catch (e: any) {
    answer = `ERROR ${e?.message ?? e}`;
  }
  const names = calls.map(c => c.name);
  const checks = {
    first: !q.expect_first || q.expect_first.includes(names[0]),
    any: !q.expect_any || q.expect_any.some(n => names.includes(n)),
    forbid: !q.forbid || !q.forbid.some(n => names.includes(n)),
    valid_args: !calls.some(c => c.error === 'INVALID_ARGUMENT' || c.error === 'INVALID_JSON'),
    tools_ok: !calls.some(c => c.error && c.error !== 'INVALID_ARGUMENT' && c.error !== 'INVALID_JSON'),
    answered: answer.length > 0 && !answer.startsWith('ERROR'),
  };
  const pass = Object.values(checks).every(Boolean);
  rows.push({ id: q.id, pass, seconds: Math.round((Date.now() - started) / 1000), calls: calls.map(c => (c.error ? `${c.name}!${c.error}` : c.name)).join(' → ') || '(none)', failed: Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(',') });
  process.stdout.write(`${pass ? '✔' : '✖'} ${q.id} (${rows.at(-1).seconds}s) ${rows.at(-1).calls}${pass ? '' : `  [失败: ${rows.at(-1).failed}]`}\n`);
  if (VERBOSE) process.stdout.write(`   ${answer.replace(/\n/g, '\n   ')}\n`);
}
const passed = rows.filter(r => r.pass).length;
process.stdout.write(`\n模型 ${MODEL}：${passed}/${rows.length} 通过\n`);
await mcp.close();
process.exitCode = passed === rows.length ? 0 : 1;
