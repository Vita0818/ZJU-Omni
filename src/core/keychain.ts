import { execFile, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ToolError } from './errors.ts';
import { readJson, writePrivate } from './store.ts';

const exec = promisify(execFile);
const SECURITY = '/usr/bin/security';

export const ACCOUNT_KINDS = ['zju', 'webvpn', 'cc98', 'xxt'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const KEYCHAIN_SERVICES: Record<AccountKind, string> = {
  zju: 'zju-omni.zjuam',
  webvpn: 'zju-omni.webvpn',
  cc98: 'zju-omni.cc98',
  xxt: 'zju-omni.xxt',
};

const ACCOUNT_LABELS: Record<AccountKind, string> = {
  zju: '浙大统一认证',
  webvpn: 'WebVPN 上网账号',
  cc98: 'CC98',
  xxt: '学习通',
};

const ENV_NAMES: Record<AccountKind, [string, string]> = {
  zju: ['ZJU_USERNAME', 'ZJU_PASSWORD'],
  webvpn: ['WEBVPN_USERNAME', 'WEBVPN_PASSWORD'],
  cc98: ['CC98_USERNAME', 'CC98_PASSWORD'],
  xxt: ['XXT_USERNAME', 'XXT_PASSWORD'],
};

const LEGACY_TRONCLASS = { service: 'org.zju.tronclass.codex', dir: join(homedir(), '.local', 'share', 'zju-tronclass') };

export interface Credentials {
  username: string;
  password: string;
}

export interface AccountRecord {
  username: string;
  backend: 'macos-keychain';
  configured_at?: string;
}

export interface CredentialStatus {
  kind: AccountKind;
  configured: boolean;
  backend: 'environment' | 'macos-keychain' | 'legacy-zju-tronclass' | null;
  username?: string;
}

export type SecurityRunner = (args: string[]) => Promise<string>;

const defaultRunner: SecurityRunner = async args => {
  const { stdout } = await exec(SECURITY, args, { timeout: 15000, maxBuffer: 65536 });
  return stdout;
};

type Env = Record<string, string | undefined>;

export interface AccountsOptions {
  env?: Env;
  runner?: SecurityRunner;
  legacyDir?: string | null;
  platform?: NodeJS.Platform;
}

export class Accounts {
  readonly file: string;
  private env: Env;
  private runner: SecurityRunner;
  private legacyDir: string | null;
  private platform: NodeJS.Platform;

  constructor(dataDir: string, options: AccountsOptions = {}) {
    this.file = join(dataDir, 'accounts.json');
    this.env = options.env ?? process.env;
    this.runner = options.runner ?? defaultRunner;
    this.legacyDir = options.legacyDir === undefined ? LEGACY_TRONCLASS.dir : options.legacyDir;
    this.platform = options.platform ?? process.platform;
  }

  private async records(): Promise<Partial<Record<AccountKind, AccountRecord>>> {
    return (await readJson<Partial<Record<AccountKind, AccountRecord>>>(this.file)) ?? {};
  }

  private async legacy(): Promise<{ username: string } | null> {
    if (!this.legacyDir) return null;
    const account = await readJson<{ username?: string; backend?: string }>(join(this.legacyDir, 'account.json')).catch(() => null);
    return account?.username && account.backend === 'macos-keychain' ? { username: account.username } : null;
  }

  async status(kind: AccountKind): Promise<CredentialStatus> {
    const [userVar, passVar] = ENV_NAMES[kind];
    if (this.env[userVar] && this.env[passVar]) return { kind, configured: true, backend: 'environment', username: this.env[userVar] };
    const record = (await this.records())[kind];
    if (record?.username && record.backend === 'macos-keychain') return { kind, configured: true, backend: 'macos-keychain', username: record.username };
    if (kind === 'zju') {
      const legacy = await this.legacy();
      if (legacy) return { kind, configured: true, backend: 'legacy-zju-tronclass', username: legacy.username };
    }
    return { kind, configured: false, backend: null };
  }

  async load(kind: AccountKind): Promise<Credentials> {
    const [userVar, passVar] = ENV_NAMES[kind];
    if (this.env[userVar] && this.env[passVar]) return { username: this.env[userVar]!, password: this.env[passVar]! };
    const status = await this.status(kind);
    if (!status.configured || !status.username) {
      throw new ToolError('CONFIGURATION_REQUIRED', `请先在本机终端运行 npm run configure -- ${kind}，把${ACCOUNT_LABELS[kind]}账号存入钥匙串。只需配置一次，不要在对话中发送密码。`, {
        account: kind,
        setup_command: `npm run configure -- ${kind}`,
      });
    }
    if (this.platform !== 'darwin') {
      throw new ToolError('CREDENTIAL_BACKEND_UNAVAILABLE', `钥匙串适配仅支持 macOS；其他系统请通过受保护的启动环境提供 ${userVar} 和 ${passVar}。`);
    }
    const service = status.backend === 'legacy-zju-tronclass' ? LEGACY_TRONCLASS.service : KEYCHAIN_SERVICES[kind];
    try {
      const stdout = await this.runner(['find-generic-password', '-s', service, '-a', status.username, '-w']);
      const password = stdout.replace(/\r?\n$/, '');
      if (!password) throw new Error('empty');
      return { username: status.username, password };
    } catch {
      throw new ToolError('CREDENTIALS_UNAVAILABLE', `无法读取${ACCOUNT_LABELS[kind]}的钥匙串凭据。请运行 npm run configure -- ${kind} 重新配置，或检查钥匙串访问权限。`, { account: kind });
    }
  }

  async record(kind: AccountKind, username: string): Promise<void> {
    const records = await this.records();
    records[kind] = { username, backend: 'macos-keychain', configured_at: new Date().toISOString() };
    await writePrivate(this.file, records);
  }

  async remove(kind: AccountKind): Promise<boolean> {
    const records = await this.records();
    const record = records[kind];
    if (!record) return false;
    if (this.platform === 'darwin') {
      try {
        await this.runner(['delete-generic-password', '-s', KEYCHAIN_SERVICES[kind], '-a', record.username]);
      } catch (e: any) {
        if (e?.code !== 44) throw new ToolError('KEYCHAIN_REMOVE_FAILED', '账号记录可以移除，但钥匙串项目未能删除。请在“钥匙串访问”中手动删除。', { service: KEYCHAIN_SERVICES[kind] });
      }
    }
    delete records[kind];
    await writePrivate(this.file, records);
    return true;
  }
}

export function storePasswordInteractively(kind: AccountKind, username: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(SECURITY, ['add-generic-password', '-U', '-a', username, '-s', KEYCHAIN_SERVICES[kind], '-w'], { stdio: 'inherit' });
    child.on('exit', code => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

export function accountLabel(kind: AccountKind): string {
  return ACCOUNT_LABELS[kind];
}
