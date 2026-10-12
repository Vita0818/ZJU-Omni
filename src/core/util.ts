import { createHash } from 'node:crypto';
import { ToolError } from './errors.ts';

export type Raw = Record<string, any>;

export const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

export function id(value: unknown): string {
  const s = String(value);
  if (!/^[1-9][0-9]*$/.test(s) || !Number.isSafeInteger(Number(s))) {
    throw new ToolError('INVALID_ID', '课程、活动和文件 ID 必须是可精确表示的正整数。');
  }
  return s;
}

export function requiredArray<T = Raw>(data: unknown, key: string): T[] {
  const value = data && typeof data === 'object' ? (data as Raw)[key] : undefined;
  if (!Array.isArray(value)) throw new ToolError('SCHEMA_CHANGED', `平台响应缺少 ${key} 数组。无法将异常响应当作空列表。`);
  return value as T[];
}

export interface PageInfo {
  page: number;
  page_size: number;
  total: number | null;
  pages: number | null;
  next_page: number | null;
  complete: boolean;
}

export function pageInfo(data: Raw, page: number, pageSize: number, count: number): PageInfo {
  const total = data.total != null && Number.isFinite(Number(data.total)) ? Number(data.total) : null;
  const pages = data.pages != null && Number.isFinite(Number(data.pages)) ? Number(data.pages) : total !== null ? Math.ceil(total / pageSize) : null;
  const hasMore = pages === null ? count >= pageSize : page < pages;
  return { page, page_size: pageSize, total, pages, next_page: hasMore ? page + 1 : null, complete: !hasMore && page === 1 };
}

export interface Deadline {
  raw: string | null;
  iso: string | null;
  shanghai: string | null;
  note?: string;
}

const shanghaiFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' });

export function deadline(value: unknown): Deadline {
  if (value == null || value === '') return { raw: null, iso: null, shanghai: null };
  const raw = String(value);
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(raw) || !Number.isFinite(Date.parse(raw))) {
    return { raw, iso: null, shanghai: null, note: '源时间没有明确时区，保留原值。' };
  }
  const date = new Date(raw);
  return { raw, iso: date.toISOString(), shanghai: `${shanghaiFormat.format(date)} +08:00` };
}

export function plain(value: unknown = ''): string {
  return String(value ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|li|h[1-6])\s*>|<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

export interface BoundedText {
  text: string;
  truncated: boolean;
  total_characters: number;
}

export function boundedText(text: unknown, max = 24000): BoundedText {
  const s = plain(text);
  return { text: s.slice(0, max), truncated: s.length > max, total_characters: s.length };
}

export function sliceText(text: string, offset: number, max: number) {
  return {
    text: text.slice(offset, offset + max),
    next_offset: offset + max < text.length ? offset + max : null,
    total_characters: text.length,
  };
}

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
