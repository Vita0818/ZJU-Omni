// Builds thin client wrappers under build/<client>/.
// Usage: node scripts/package.ts <codex|claude|dsh|all>
// Codex and Claude Code copy plugins into their own caches, so those bundles
// are self-contained (dist + production node_modules). DSH runs the server in
// place, so its patch only references absolute paths in this checkout.
import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build');
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

async function bundleBase(target: string, skill: 'zju' | 'zju-lite') {
  if (!existsSync(join(ROOT, 'dist/server.js'))) throw new Error('dist/ 不存在，请先运行 npm run build。');
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(join(ROOT, 'dist'), join(target, 'dist'), { recursive: true });
  await cp(join(ROOT, 'skills', skill), join(target, 'skills', skill), { recursive: true });
  for (const file of ['LICENSE', 'README.md', 'package-lock.json']) await cp(join(ROOT, file), join(target, file));
  const runtimePkg = { name: pkg.name, version: pkg.version, private: true, type: 'module', license: pkg.license, engines: pkg.engines, dependencies: pkg.dependencies };
  await writeFile(join(target, 'package.json'), `${JSON.stringify(runtimePkg, null, 2)}\n`);
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: target, stdio: 'inherit' });
}

async function codex() {
  const target = join(BUILD, 'codex', 'zju-omni');
  await bundleBase(target, 'zju');
  await mkdir(join(target, '.codex-plugin'), { recursive: true });
  const manifest = JSON.parse(await readFile(join(ROOT, 'packaging/codex/plugin.json'), 'utf8'));
  manifest.version = `${pkg.version}+codex.${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
  await writeFile(join(target, '.codex-plugin', 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await cp(join(ROOT, 'packaging/codex/mcp.json'), join(target, '.mcp.json'));
  await mkdir(join(target, 'scripts'), { recursive: true });
  await cp(join(ROOT, 'packaging/start.sh'), join(target, 'scripts/start.sh'));
  await chmod(join(target, 'scripts/start.sh'), 0o755);
  console.log(`Codex 插件已生成：${target}
安装：在 ~/.agents/plugins/marketplace.json 的 plugins 中加入
  { "name": "zju-omni", "source": { "source": "local", "path": "./${target.replace(`${process.env.HOME}/`, '')}" }, "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" }, "category": "Productivity" }
然后运行：codex plugin add zju-omni@personal`);
}

async function claude() {
  const market = join(BUILD, 'claude');
  const target = join(market, 'zju-omni');
  await bundleBase(target, 'zju');
  await mkdir(join(target, '.claude-plugin'), { recursive: true });
  await mkdir(join(market, '.claude-plugin'), { recursive: true });
  const manifest = JSON.parse(await readFile(join(ROOT, 'packaging/claude/plugin.json'), 'utf8'));
  manifest.version = pkg.version;
  await writeFile(join(target, '.claude-plugin', 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await cp(join(ROOT, 'packaging/claude/mcp.json'), join(target, '.mcp.json'));
  await cp(join(ROOT, 'packaging/claude/marketplace.json'), join(market, '.claude-plugin', 'marketplace.json'));
  console.log(`Claude Code 插件市场已生成：${market}
安装：claude plugin marketplace add ${market}
      claude plugin install zju-omni@zju-omni`);
}

// A stable node path (e.g. /opt/homebrew/bin/node) survives upgrades better than the versioned execPath.
function nodePath(): string {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const candidate = join(dir, 'node');
    if (dir && existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

async function dsh() {
  const target = join(BUILD, 'dsh');
  if (!existsSync(join(ROOT, 'dist/server.js'))) throw new Error('dist/ 不存在，请先运行 npm run build。');
  await rm(target, { recursive: true, force: true });
  await cp(join(ROOT, 'skills', 'zju-lite'), join(target, 'skills', 'zju-lite'), { recursive: true });
  const template = await readFile(join(ROOT, 'packaging/dsh/zju-omni.cordis.patch.yml'), 'utf8');
  const quote = (value: string) => value.replace(/'/g, "''");
  const patch = template.replaceAll('__NODE__', `'${quote(nodePath())}'`).replaceAll('__ROOT__', quote(ROOT)).replaceAll('__SKILLS__', quote(join(target, 'skills')));
  await writeFile(join(target, 'zju-omni.cordis.patch.yml'), patch);
  console.log(`DSH 配置片段已生成：${join(target, 'zju-omni.cordis.patch.yml')}
安装：把其中的条目追加到 ~/.dsh/profiles/<profile>/cordis.patch.yml（例如 desktop），重启 DSH。`);
}

const which = process.argv[2] ?? 'all';
const jobs: Record<string, () => Promise<void>> = { codex, claude, dsh };
if (which === 'all') for (const job of Object.values(jobs)) await job();
else if (jobs[which]) await jobs[which]();
else {
  console.error('用法：node scripts/package.ts <codex|claude|dsh|all>');
  process.exitCode = 2;
}
