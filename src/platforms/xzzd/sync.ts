import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { ToolError, safeError } from '../../core/errors.ts';
import { withLock, writePrivate } from '../../core/store.ts';
import { hash, id, type Raw } from '../../core/util.ts';
import type { XzzdApi } from './reads.ts';
import { filesOf, publicFile } from './shared.ts';
import { collectPages } from './workflows.ts';
import type { XzzdConfig } from './client.ts';

async function exists(path: string) {
  try {
    return await lstat(path);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

async function safeDirectory(path: string, create: boolean): Promise<void> {
  const info = await exists(path);
  if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new ToolError('UNSAFE_SYNC_PATH', '同步目录不能是符号链接或普通文件。');
  if (!info && create) await mkdir(path, { mode: 0o700 });
}

async function localHash(path: string, maxBytes: number): Promise<{ sha256?: string; bytes?: number; conflict?: boolean } | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return { conflict: true };
    return { sha256: hash(await handle.readFile()), bytes: info.size };
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    if (['ELOOP', 'EISDIR', 'EACCES'].includes(e?.code)) return { conflict: true };
    throw e;
  } finally {
    if (handle) await handle.close();
  }
}

const filenameOf = (file: Raw) =>
  basename(file.name || file.file_name || 'material')
    .replace(/[\x00-\x1f\\/:]/g, '_')
    .slice(-150) || 'material';

export interface SyncReader {
  cfg: XzzdConfig;
  client: Pick<XzzdApi, 'downloadBytes'>;
  course(courseId: unknown): Promise<Raw>;
  currentUserId(courseId: unknown): Promise<string>;
  materials(args: Raw): Promise<Raw>;
  assignments(args: Raw): Promise<Raw>;
  rawActivity(activityId: unknown): Promise<Raw>;
  activityUrl(courseId: unknown, activityId: unknown): string;
}

export interface SyncArgs {
  course_id: unknown;
  output_dir: string;
  activity_ids?: unknown[];
  include_assignments?: boolean;
  dry_run?: boolean;
  force?: boolean;
  max_files?: number;
  max_pages?: number;
}

interface RunArgs extends SyncArgs {
  course: Raw;
  userId: string;
  directory: string;
  manifestPath: string;
}

export class MaterialSync {
  readonly reader: SyncReader;
  constructor(reader: SyncReader) {
    this.reader = reader;
  }

  private get cfg() {
    return this.reader.cfg;
  }

  async sync(args: SyncArgs) {
    const { course_id, output_dir, dry_run = false } = args;
    if (!isAbsolute(output_dir)) throw new ToolError('INVALID_PATH', 'output_dir 必须是本地绝对路径。');
    const course = await this.reader.course(course_id);
    const userId = await this.reader.currentUserId(course_id);
    if (!dry_run) await mkdir(output_dir, { recursive: true, mode: 0o700 });
    const root = (await exists(output_dir)) ? await realpath(output_dir) : resolve(output_dir);
    const directory = join(root, `course-${id(course_id)}`);
    await safeDirectory(directory, !dry_run);
    const manifestPath = join(directory, '.zju-sync.json');
    const run = () => this.run({ ...args, course, userId, directory, manifestPath });
    return dry_run ? run() : withLock(join(directory, '.zju-sync.lock'), run, '该课程正在同步，请稍后再试。');
  }

  private async run({ course_id, course, userId, directory, manifestPath, activity_ids, include_assignments = true, dry_run = false, force = false, max_files = 100, max_pages = 20 }: RunArgs) {
    const identity = { base_url: this.cfg.baseUrl, course_id: id(course_id), user_id: id(userId) };
    let manifest: Raw = { version: 1, ...identity, files: {} };
    const manifestInfo = await exists(manifestPath);
    if (manifestInfo) {
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new ToolError('UNSAFE_SYNC_PATH', '同步清单不能是符号链接或目录。');
      try {
        manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      } catch {
        throw new ToolError('SYNC_MANIFEST_INVALID', '同步清单无法解析；请使用新目录，避免丢失已有同步记录。');
      }
      if (manifest.version !== 1 || !manifest.files || Array.isArray(manifest.files) || typeof manifest.files !== 'object') throw new ToolError('SYNC_MANIFEST_INVALID', '同步清单格式无法识别。');
      if (Object.entries(identity).some(([key, value]) => manifest[key] !== value)) throw new ToolError('SYNC_ACCOUNT_MISMATCH', '该目录的同步清单属于其他账号、站点或课程，请使用另一个目录。');
    }
    const catalog = new Map<string, Raw>();
    const errors: Raw[] = [];
    const results: Raw[] = [];
    const continuations: Raw[] = [];
    let complete = true;
    for (const kind of include_assignments ? (['materials', 'assignments'] as const) : (['materials'] as const)) {
      try {
        const scan = await collectPages(paging => this.reader[kind]({ course_id, ...paging }), kind === 'materials' ? 'activities' : 'assignments', { max_pages });
        for (const activity of scan.items) catalog.set(id(activity.id), activity);
        if (!scan.complete) {
          complete = false;
          continuations.push({ kind, next_page: scan.next_page });
        }
      } catch (e) {
        complete = false;
        errors.push({ kind, error: safeError(e) });
      }
    }
    const requested = activity_ids?.length ? new Set(activity_ids.map(id)) : null;
    if (requested) {
      for (const activityId of requested) {
        if (!catalog.has(activityId)) {
          complete = false;
          errors.push({ activity_id: activityId, error: { code: 'ACTIVITY_NOT_IN_CATALOG', message: '指定活动未出现在本次课程资料／作业扫描中。' } });
        }
      }
    }
    let attempts = 0;
    let deferred = 0;
    const seen = new Set<string>();
    const candidates: { activityId: string; summary: Raw; file: Raw }[] = [];
    for (const [activityId, summary] of catalog) {
      if (requested && !requested.has(activityId)) continue;
      let activity: Raw;
      try {
        activity = await this.reader.rawActivity(activityId);
        if (String(activity.course_id) !== String(course_id)) throw new ToolError('COURSE_MISMATCH', '附件活动所属课程与同步目标不一致。');
      } catch (e) {
        complete = false;
        errors.push({ activity_id: activityId, error: safeError(e) });
        continue;
      }
      for (const file of filesOf(activity)) candidates.push({ activityId, summary, file });
    }
    // New files first, then the least recently checked, so repeated limited
    // runs advance even without reliable upstream modification times.
    candidates.sort((a, b) => {
      const first = manifest.files[`${a.activityId}:${a.file.id ?? a.file.upload_id}`];
      const second = manifest.files[`${b.activityId}:${b.file.id ?? b.file.upload_id}`];
      return (first?.synced_at ? Date.parse(first.synced_at) : 0) - (second?.synced_at ? Date.parse(second.synced_at) : 0);
    });
    for (const { activityId, summary, file } of candidates) {
      const uploadId = id(file.id ?? file.upload_id);
      const key = `${activityId}:${uploadId}`;
      seen.add(key);
      const info = {
        activity_id: activityId,
        activity_title: summary.title,
        upload_id: uploadId,
        name: file.name || file.file_name || 'material',
        source_url: this.reader.activityUrl(course_id, activityId),
      };
      if (file.allow_download === false) {
        results.push({ ...info, status: 'restricted' });
        continue;
      }
      try {
        const folder = `activity-${activityId}`;
        const activityDir = join(directory, folder);
        await safeDirectory(activityDir, false);
        const remote = publicFile(file);
        const remoteFingerprint = hash(JSON.stringify(remote));
        const previous = manifest.files[key];
        let previousPath: string | null = null;
        let previousLocal: Awaited<ReturnType<typeof localHash>> = null;
        if (previous) {
          if (typeof previous.relative_path !== 'string' || dirname(previous.relative_path) !== folder || /[\\\x00]/.test(previous.relative_path)) throw new ToolError('SYNC_MANIFEST_INVALID', '同步清单包含无效文件路径。');
          previousPath = join(directory, previous.relative_path);
          previousLocal = await localHash(previousPath, this.cfg.maxFileBytes);
          if (!force && remote.updated_at && previous.remote_fingerprint === remoteFingerprint && previousLocal?.sha256 === previous.sha256) {
            results.push({ ...info, status: 'unchanged', path: previousPath, sha256: previous.sha256 });
            continue;
          }
        }
        if (attempts >= max_files) {
          deferred++;
          complete = false;
          continue;
        }
        attempts++;
        if (dry_run) {
          results.push({ ...info, status: 'would_download', local_modified: Boolean(previousLocal && previousLocal.sha256 !== previous?.sha256) });
          continue;
        }
        if (!this.reader.client.downloadBytes) throw new ToolError('INTERNAL_ERROR', '当前客户端不支持下载。');
        const downloaded = await this.reader.client.downloadBytes(uploadId);
        const digest = hash(downloaded.bytes);
        const name = filenameOf(file);
        if (/text\/html/i.test(downloaded.contentType) && !/\.html?$/i.test(name)) throw new ToolError('UNEXPECTED_RESPONSE', '下载返回了网页，未保存为课件。');
        await safeDirectory(activityDir, true);
        const basePath = join(activityDir, `${uploadId}-${name}`);
        const baseLocal = await localHash(basePath, this.cfg.maxFileBytes);
        let destination = basePath;
        let status = previous ? 'updated' : 'downloaded';
        if (previousLocal?.sha256 === digest) {
          destination = previousPath!;
          status = 'unchanged';
        } else if (baseLocal?.sha256 === digest) status = 'unchanged';
        else if (baseLocal) destination = join(activityDir, `${uploadId}-${digest.slice(0, 16)}-${name}`);
        const destinationLocal = await localHash(destination, this.cfg.maxFileBytes);
        if (destinationLocal && destinationLocal.sha256 !== digest) throw new ToolError('LOCAL_FILE_CONFLICT', '本地同名文件已被修改，已保留；请使用新目录或移走冲突文件后重试。');
        if (!destinationLocal) {
          const handle = await open(destination, 'wx', 0o600);
          try {
            await handle.writeFile(downloaded.bytes);
          } catch (e) {
            await handle.close();
            await unlink(destination);
            throw e;
          }
          await handle.close();
        }
        manifest.files[key] = {
          relative_path: `${folder}/${basename(destination)}`,
          sha256: digest,
          bytes: downloaded.bytes.length,
          remote,
          remote_fingerprint: remoteFingerprint,
          synced_at: new Date().toISOString(),
        };
        await writePrivate(manifestPath, manifest);
        results.push({
          ...info,
          status,
          path: destination,
          sha256: digest,
          bytes: downloaded.bytes.length,
          preserved_local_path: baseLocal && baseLocal.sha256 !== digest ? basePath : null,
          local_modified: Boolean(previousLocal && previousLocal.sha256 !== previous?.sha256),
        });
      } catch (e) {
        complete = false;
        errors.push({ ...info, error: safeError(e) });
      }
    }
    // Remote removals are only meaningful after a full, unfiltered scan.
    const missing = complete && !requested && include_assignments ? Object.keys(manifest.files).filter(key => !seen.has(key)) : [];
    if (!dry_run) {
      manifest.updated_at = new Date().toISOString();
      await writePrivate(manifestPath, manifest);
    }
    const counts: Record<string, number> = {};
    for (const row of results) counts[row.status] = (counts[row.status] || 0) + 1;
    return {
      course_id,
      course_name: course.name,
      directory,
      manifest_path: dry_run && !manifestInfo ? null : manifestPath,
      dry_run,
      complete,
      counts,
      errors,
      deferred_files: deferred,
      continuations,
      missing_from_remote_catalog: missing,
      results: results.slice(0, 300),
      omitted_results: Math.max(0, results.length - 300),
      note: '首次运行批量下载；后续按平台更新时间和本地 SHA-256 跳过未变文件。没有更新时间时重新下载校验。新版本另存，本地修改和平台已移除的文件均保留；达到下载数量限制后可重复运行继续。',
    };
  }
}
