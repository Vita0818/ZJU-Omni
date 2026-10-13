// Builds thin client wrappers under build/<client>/.
// Usage: node scripts/package.ts <codex|claude|dsh|bundles|all>
// Every client gets two editions of the same server: ZJU-Omni (full) and
// ZJU-Omni Lite. `dsh` writes a development snippet with absolute paths;
// `bundles` writes the distributable DSH bundle tarballs to build/release/.
import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build');
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

interface Edition {
  name: string;
  display: string;
  profile: 'full' | 'lite';
  skill: 'zju' | 'zju-lite';
  summary: string;
}

// Two editions of the same server: full for capable models, lite for small local models.
const EDITIONS: Edition[] = [
  { name: 'zju-omni', display: 'ZJU-Omni', profile: 'full', skill: 'zju', summary: '浙大校园平台统一连接器（标准版，完整工具）' },
  { name: 'zju-omni-lite', display: 'ZJU-Omni Lite', profile: 'lite', skill: 'zju-lite', summary: '浙大校园平台统一连接器（Lite 版：少量任务型工具，适合本地小模型）' },
];

function requireDist() {
  if (!existsSync(join(ROOT, 'dist/server.js'))) throw new Error('dist/ 不存在，请先运行 npm run build。');
}

async function stage(target: string, edition: Edition, extra: Record<string, unknown> = {}) {
  requireDist();
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(join(ROOT, 'dist'), join(target, 'dist'), { recursive: true });
  await cp(join(ROOT, 'skills', edition.skill), join(target, 'skills', edition.skill), { recursive: true });
  for (const file of ['LICENSE', 'README.md']) await cp(join(ROOT, file), join(target, file));
  const runtimePkg = { name: edition.name, version: pkg.version, description: `${edition.summary}。`, type: 'module', license: pkg.license, author: pkg.author, repository: pkg.repository, homepage: pkg.homepage, engines: pkg.engines, dependencies: pkg.dependencies, ...extra };
  await writeFile(join(target, 'package.json'), `${JSON.stringify(runtimePkg, null, 2)}\n`);
}

// Codex and Claude Code copy plugins into their own caches: include production node_modules.
async function selfContained(target: string, edition: Edition) {
  await stage(target, edition, { private: true });
  await cp(join(ROOT, 'package-lock.json'), join(target, 'package-lock.json'));
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: target, stdio: 'inherit' });
  await rm(join(target, 'package-lock.json'));
}

const mcpEntry = (edition: Edition, server: Record<string, unknown>) => ({ mcpServers: { [edition.name]: { ...server, env: { MCP_TOOL_PROFILE: edition.profile } } } });

async function codex() {
  const base = JSON.parse(await readFile(join(ROOT, 'packaging/codex/plugin.json'), 'utf8'));
  const passthrough = JSON.parse(await readFile(join(ROOT, 'packaging/codex/mcp.json'), 'utf8')).mcpServers['zju-omni'].env_vars as string[];
  const entries: string[] = [];
  for (const edition of EDITIONS) {
    const target = join(BUILD, 'codex', edition.name);
    await selfContained(target, edition);
    await mkdir(join(target, '.codex-plugin'), { recursive: true });
    const manifest = { ...base, name: edition.name, description: `${edition.summary}：学在浙大、教务、智云课堂、拼题A、CC98。`, interface: { ...base.interface, displayName: edition.display } };
    manifest.version = `${pkg.version}+codex.${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
    await writeFile(join(target, '.codex-plugin', 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(target, '.mcp.json'), `${JSON.stringify(mcpEntry(edition, { command: './scripts/start.sh', args: [], cwd: '.', env_vars: passthrough }), null, 2)}\n`);
    await mkdir(join(target, 'scripts'), { recursive: true });
    await cp(join(ROOT, 'packaging/start.sh'), join(target, 'scripts/start.sh'));
    await chmod(join(target, 'scripts/start.sh'), 0o755);
    entries.push(`  { "name": "${edition.name}", "source": { "source": "local", "path": "./${target.replace(`${process.env.HOME}/`, '')}" }, "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" }, "category": "Productivity" }`);
  }
  console.log(`Codex 插件已生成：${join(BUILD, 'codex')}/{${EDITIONS.map(e => e.name).join(',')}}
安装：在 ~/.agents/plugins/marketplace.json 的 plugins 中加入需要的版本
${entries.join('\n')}
然后运行：codex plugin add zju-omni@personal（或 zju-omni-lite@personal）`);
}

async function claude() {
  const market = join(BUILD, 'claude');
  const base = JSON.parse(await readFile(join(ROOT, 'packaging/claude/plugin.json'), 'utf8'));
  const marketplace = JSON.parse(await readFile(join(ROOT, 'packaging/claude/marketplace.json'), 'utf8'));
  marketplace.plugins = [];
  for (const edition of EDITIONS) {
    const target = join(market, edition.name);
    await selfContained(target, edition);
    await mkdir(join(target, '.claude-plugin'), { recursive: true });
    const manifest = { ...base, name: edition.name, version: pkg.version, description: `${edition.summary}：学在浙大、教务、智云课堂、拼题A、CC98。` };
    await writeFile(join(target, '.claude-plugin', 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(target, '.mcp.json'), `${JSON.stringify(mcpEntry(edition, { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/server.js'] }), null, 2)}\n`);
    marketplace.plugins.push({ name: edition.name, source: `./${edition.name}`, description: `${edition.summary}。` });
  }
  await mkdir(join(market, '.claude-plugin'), { recursive: true });
  await writeFile(join(market, '.claude-plugin', 'marketplace.json'), `${JSON.stringify(marketplace, null, 2)}\n`);
  console.log(`Claude Code 插件市场已生成：${market}
安装：claude plugin marketplace add ${market}
      claude plugin install zju-omni@zju-omni（或 zju-omni-lite@zju-omni）`);
}

// DSH installs bundles with pnpm into the profile, which resolves dependencies itself.
async function bundles() {
  const release = join(BUILD, 'release');
  await mkdir(release, { recursive: true });
  for (const edition of EDITIONS) {
    const target = join(release, 'stage', edition.name);
    await stage(target, edition, { files: ['dist', 'skills', 'dsh.patch.yml', 'README.md', 'LICENSE'], dsh: { bundle: { patch: './dsh.patch.yml' } } });
    await cp(join(ROOT, 'packaging/dsh', `${edition.profile}.patch.yml`), join(target, 'dsh.patch.yml'));
    execFileSync('npm', ['pack', '--pack-destination', release, '--silent'], { cwd: target, stdio: ['ignore', 'inherit', 'inherit'] });
  }
  await rm(join(release, 'stage'), { recursive: true, force: true });
  console.log(`DSH 组合包已生成：${release}/{${EDITIONS.map(e => `${e.name}-${pkg.version}.tgz`).join(',')}}
安装：dsh plugin --profile <name> add <tgz 路径或下载地址>
  zju-omni      标准版，只加工具，可装进日常 profile（含 desktop）
  zju-omni-lite Lite 版，把整个 profile 精简成校园助手，请装在单独的 profile`);
}

// A stable node path (e.g. /opt/homebrew/bin/node) survives upgrades better than the versioned execPath.
function nodePath(): string {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const candidate = join(dir, 'node');
    if (dir && existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

// Development snippet: runs the server in place from this checkout (absolute paths).
async function dsh() {
  const target = join(BUILD, 'dsh');
  requireDist();
  await rm(target, { recursive: true, force: true });
  await cp(join(ROOT, 'skills', 'zju-lite'), join(target, 'skills', 'zju-lite'), { recursive: true });
  const template = await readFile(join(ROOT, 'packaging/dsh/zju-omni.cordis.patch.yml'), 'utf8');
  const quote = (value: string) => value.replace(/'/g, "''");
  const patch = template.replaceAll('__NODE__', `'${quote(nodePath())}'`).replaceAll('__ROOT__', quote(ROOT)).replaceAll('__SKILLS__', quote(join(target, 'skills')));
  await writeFile(join(target, 'zju-omni.cordis.patch.yml'), patch);

  console.log(`DSH 配置片段已生成：${join(target, 'zju-omni.cordis.patch.yml')}
安装：把其中的条目追加到 ~/.dsh/profiles/<profile>/cordis.patch.yml（例如 desktop），重启 DSH。
可分发的 DSH 组合包请用 npm run pack:dsh。`);
}

const which = process.argv[2] ?? 'all';
const jobs: Record<string, () => Promise<void>> = { codex, claude, dsh, bundles };
if (which === 'all') for (const job of Object.values(jobs)) await job();
else if (jobs[which]) await jobs[which]();
else {
  console.error('用法：node scripts/package.ts <codex|claude|dsh|bundles|all>');
  process.exitCode = 2;
}
