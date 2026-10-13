// Runs the fixed questions through the real DeepSeek Harness (`dsh headless`)
// with the lite MCP server and zju-lite skill, against a local LM Studio model.
// Uses an isolated DSH_HOME under build/dsh-eval so ~/.dsh is never modified.
// Usage: node tests/lite-eval/dsh.ts --model=<lmstudio id> [--only=a,b] [--verbose]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DSH = process.env.DSH_BIN ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const arg = (name: string, fallback?: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const MODEL = arg('model', 'ornith-1.5-9b')!;
const RUN_NAME = process.argv.includes('--lean') ? `${MODEL}-lean` : MODEL;
const ONLY = arg('only')?.split(',');
const VERBOSE = process.argv.includes('--verbose');
const TIMEOUT_MS = Number(arg('timeout', '420000'));
const EVAL = join(ROOT, 'build', 'dsh-eval');
const ZJU_PATCH = join(ROOT, 'build', 'dsh', 'zju-omni.cordis.patch.yml');
const LEAN = process.argv.includes('--lean');
const PRESET = join(ROOT, 'packaging', 'dsh', 'preset.patch.yml');
// Run outside the repository, as a real user would, so the model cannot browse this source tree.
const WORK = join(tmpdir(), 'zju-omni-dsh-eval-work');

interface Question { id: string; prompt: string; expect_first?: string[]; expect_any?: string[]; forbid?: string[] }

if (!existsSync(DSH)) throw new Error(`找不到 dsh：${DSH}`);
if (!existsSync(ZJU_PATCH)) throw new Error('缺少 build/dsh/zju-omni.cordis.patch.yml，请先运行 npm run package -- dsh');
await mkdir(join(EVAL, 'home'), { recursive: true });
await mkdir(WORK, { recursive: true });
const modelPatch = join(EVAL, `model-${MODEL.replace(/[^\w.-]/g, '_')}.yml`);
await writeFile(modelPatch, `- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      lmstudio:
        displayName: LM Studio (local)
        api: openai-completions
        baseURL: http://localhost:1234/v1
        headers:
          Authorization: Bearer lm-studio
        compat:
          supportsDeveloperRole: false
          supportsReasoningEffort: true
          maxTokensField: max_tokens
        models:
          - id: ${MODEL}
            name: ${MODEL}
            contextWindow: 32768
            maxTokens: 8192
            input: [ text ]
            reasoningEfforts:
              'off': 'none'
              high: high
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: lmstudio
    model: ${MODEL}
`);

function runDsh(prompt: string): Promise<{ events: any[]; stderr: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const child = spawn(DSH, ['--profile', 'headless', '--patch', LEAN ? PRESET : ZJU_PATCH, '--patch', modelPatch, '--json', prompt], {
      cwd: WORK,
      env: { ...process.env, DSH_HOME: join(EVAL, 'home'), ZJU_OMNI_SERVER: join(ROOT, 'dist', 'server.js') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, TIMEOUT_MS);
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('close', () => {
      clearTimeout(timer);
      const events = out.split('\n').filter(Boolean).flatMap(line => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      resolve({ events, stderr: err, timedOut });
    });
  });
}

const questions: Question[] = JSON.parse(await readFile(join(ROOT, 'tests/lite-eval/questions.json'), 'utf8'));
const rows: any[] = [];
for (const q of questions.filter(q => !ONLY || ONLY.includes(q.id))) {
  const started = Date.now();
  const { events, stderr, timedOut } = await runDsh(q.prompt);
  await mkdir(join(EVAL, 'runs', RUN_NAME), { recursive: true });
  await writeFile(join(EVAL, 'runs', RUN_NAME, `${q.id}.ndjson`), events.map(e => JSON.stringify(e)).join('\n'));
  const calls: { name: string; ok: boolean; error?: string; zju: boolean; input: unknown }[] = [];
  const pending = new Map<string, number>();
  for (const e of events) {
    if (e.type === 'tool_call') {
      pending.set(e.callId, calls.length);
      calls.push({ name: String(e.tool).replace(/^mcp__zju__/, ''), ok: true, zju: String(e.tool).startsWith('mcp__zju__'), input: e.input });
    } else if (e.type === 'tool_result' && pending.has(e.callId)) {
      const call = calls[pending.get(e.callId)!];
      call.ok = e.status === 'completed';
      if (!call.ok) call.error = String(e.result).match(/"code":"([A-Z_]+)"/)?.[1] ?? 'ERROR';
    }
  }
  const final = String(events.find(e => e.type === 'final')?.text ?? '');
  const steps = events.filter(e => e.type === 'status' && e.phase === 'step_end');
  const lastUsage = steps.at(-1)?.usage;
  const zjuCalls = calls.filter(c => c.zju);
  const names = zjuCalls.map(c => c.name);
  const repeats = zjuCalls.length - new Set(zjuCalls.map(c => `${c.name}:${JSON.stringify(c.input ?? {})}`)).size;
  const otherTools = calls.filter(c => !c.zju && c.name !== 'skill').map(c => c.name);
  const checks = {
    first: !q.expect_first || q.expect_first.includes(names[0]),
    any: !q.expect_any || q.expect_any.some(n => names.includes(n)),
    forbid: !q.forbid || !q.forbid.some(n => names.includes(n)),
    // Domain refusals (file missing, homework not open) are correct platform answers, not tool failures.
    tools_ok: !zjuCalls.some(c => !c.ok && !/^(FILE_|INVALID_PATH|HOMEWORK_|SUBMISSION_LIMIT|NOT_A_DRAFT|EMPTY_SUBMISSION)/.test(c.error ?? '')),
    no_loop: repeats <= 1,
    answered: final.length > 0 && !timedOut,
  };
  const pass = Object.values(checks).every(Boolean);
  const row = {
    id: q.id,
    pass,
    seconds: Math.round((Date.now() - started) / 1000),
    steps: steps.length,
    tokens: lastUsage?.inputTokens ?? null,
    calls: calls.map(c => (c.ok ? c.name : `${c.name}!${c.error}`)).join(' → ') || '(none)',
    failed: Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(','),
    chinese: /[\u4e00-\u9fa5]/.test(final.slice(0, 200)),
    other_tools: otherTools.join(','),
  };
  rows.push(row);
  process.stdout.write(`${pass ? '✔' : '✖'} ${q.id} (${row.seconds}s, ${row.steps} 步, 末步输入 ${row.tokens ?? '?'} tok) ${row.calls}${row.other_tools ? `  (其他工具: ${row.other_tools})` : ''}${pass ? '' : `  [失败: ${row.failed}]`}${timedOut ? ' [超时]' : ''}\n`);
  if (VERBOSE) process.stdout.write(`   ${final.slice(0, 600).replace(/\n/g, '\n   ')}\n`);
  if (!events.length) process.stdout.write(`   stderr: ${stderr.slice(-400)}\n`);
}
const passed = rows.filter(r => r.pass).length;
process.stdout.write(`\nDSH + ${MODEL}：${passed}/${rows.length} 通过，中文回答 ${rows.filter(r => r.chinese).length}/${rows.length}\n`);
await writeFile(join(EVAL, `result-${RUN_NAME.replace(/[^\w.-]/g, '_')}.json`), JSON.stringify(rows, null, 2));
process.exitCode = passed === rows.length ? 0 : 1;
