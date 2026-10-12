import type { Raw } from '../../core/util.ts';

export interface PublicFile {
  id: unknown;
  name: string;
  size: number | null;
  mime_type: string | null;
  allow_download: boolean | null;
  updated_at: string | null;
}

export function publicFile(file: Raw): PublicFile {
  return {
    id: file.id ?? file.upload_id ?? null,
    name: file.name ?? file.file_name ?? '',
    size: file.size ?? null,
    mime_type: file.mime_type ?? file.content_type ?? null,
    allow_download: file.allow_download ?? null,
    updated_at: file.updated_at ?? null,
  };
}

export function filesOf(activity: Raw): Raw[] {
  const candidates = [activity.uploads, activity.data?.uploads, activity.data?.files];
  const files = new Map<string, Raw>();
  for (const source of candidates.filter(Array.isArray)) {
    for (const file of source as Raw[]) {
      if (!file || (file.id ?? file.upload_id) == null) continue;
      const key = String(file.id ?? file.upload_id);
      const previous = files.get(key);
      // A denied download must never become allowed through a duplicate reference.
      const denied = previous?.allow_download === false || file.allow_download === false;
      files.set(key, { ...previous, ...file, ...(denied ? { allow_download: false } : {}) });
    }
  }
  return [...files.values()];
}

export function isGroupHomework(activity: Raw): boolean {
  return activity.submit_by_group === true || activity.data?.is_group === true || activity.data?.is_group_submission === true;
}

export type SubmissionStatus = 'submitted' | 'draft' | 'unsubmitted' | 'unknown';

export function submissionState(list: Raw[], reported: unknown = null): SubmissionStatus {
  const latest = list.find(s => s.is_latest_version === true);
  const current = latest ? [latest] : list;
  if (current.some(s => s.is_draft === false && s.is_redo !== true && (s.submit_by_instructor !== true || s.marked_submitted === true))) return 'submitted';
  if (list.some(s => s.is_draft === true || s.is_redo === true)) return 'draft';
  if (list.length === 0) return reported === true ? 'unknown' : 'unsubmitted';
  return 'unknown';
}
