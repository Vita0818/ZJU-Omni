import { mkdir, open, unlink } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';
import { ToolError } from '../../core/errors.ts';
import { hash, id, type Raw } from '../../core/util.ts';
import { CLASSROOM, YJAPI, type ZhiyunApi } from './client.ts';

const shanghai = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });

export function unixToShanghai(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${shanghai.format(new Date(n * 1000))} +08:00`;
}

export function clock(seconds: unknown): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}

function checkDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00+08:00`))) throw new ToolError('INVALID_ARGUMENT', '日期格式应为 YYYY-MM-DD。');
  return value;
}

function shiftDate(day: string, delta: number): string {
  return dateOnly.format(new Date(Date.parse(`${day}T12:00:00+08:00`) + delta * 86400000));
}

const text = (value: unknown) => (value == null ? '' : String(value)).trim();

export interface Lecture {
  course_id: string;
  course_title: string;
  sub_id: string;
  title: string;
  teacher: string | null;
  begins_at: string | null;
  date: string | null;
  room?: string | null;
  upcoming?: boolean;
}

export interface Slide {
  index: number;
  image_url: string;
  offset_sec: number | null;
  offset: string | null;
  captured_at: string | null;
}

/** Collects lecture rows from the nested year → month → week → [lecture] map. */
function flattenSubs(value: unknown, out: Raw[] = []): Raw[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object' && 'sub_title' in item) out.push(item);
      else flattenSubs(item, out);
    }
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) flattenSubs(item, out);
  }
  return out;
}

// created_sec / content.created: seconds into the recording (verified 2026-10-12).
const OFFSET_KEYS = ['created_sec', 'created', 'offset_sec'];
const CREATED_KEYS = ['create_time', 'created_at'];
const MAX_OFFSET_SEC = 12 * 3600;

export class ZhiyunReader {
  readonly api: ZhiyunApi & { image?(url: string, maxBytes: number): Promise<{ bytes: Buffer; contentType: string }> };
  readonly now: () => Date;
  constructor(api: ZhiyunReader['api'], now: () => Date = () => new Date()) {
    this.api = api;
    this.now = now;
  }

  private ok(data: Raw, what: string): Raw {
    if (data.code != null && Number(data.code) !== 0) throw new ToolError('PLATFORM_REJECTED', `智云课堂${what}失败：${text(data.msg) || `code ${data.code}`}`, { platform_code: data.code });
    return data;
  }

  async searchCourses({ keyword = '', teacher = '', page = 1 }: { keyword?: string; teacher?: string; page?: number }) {
    const me = await this.api.profile();
    const perPage = 16;
    const data = this.ok(
      await this.api.get(`${CLASSROOM}/pptnote/v1/searchlist`, { tenant_id: 112, tenant_code: 112, user_id: me.id, user_name: me.account, page, per_page: perPage, title: keyword, realname: teacher, trans: '' }),
      '搜索课程',
    );
    const list = data.total?.list;
    if (!Array.isArray(list)) throw new ToolError('SCHEMA_CHANGED', '智云课堂搜索结果缺少 total.list。');
    const total = Number(data.total.total);
    return {
      courses: list.map((c: Raw) => ({
        course_id: String(c.course_id ?? c.id ?? ''),
        title: text(c.title ?? c.course_title),
        teacher: text(c.realname ?? c.lecturer_name ?? c.teacher_name) || null,
        term: text(c.term_name ?? c.semester ?? c.year) || null,
      })),
      total: Number.isFinite(total) ? total : null,
      next_page: Number.isFinite(total) && page * perPage < total ? page + 1 : null,
    };
  }

  async courseLectures({ course_id }: { course_id: unknown }) {
    const me = await this.api.profile();
    const data = this.ok(await this.api.get(`${YJAPI}/courseapi/v3/multi-search/get-course-detail`, { course_id: id(course_id), student: me.account }), '课程详情');
    if (!data.data || typeof data.data !== 'object') throw new ToolError('SCHEMA_CHANGED', '智云课堂课程详情缺少 data。');
    const courseTitle = text(data.data.title);
    const now = this.now().getTime() / 1000;
    const lectures: Lecture[] = flattenSubs(data.data.sub_list ?? {}).map(s => {
      const begin = Number(s.class_begin);
      return {
        course_id: String(course_id),
        course_title: courseTitle,
        sub_id: String(s.id ?? s.sub_id),
        title: text(s.sub_title),
        teacher: text(s.lecturer_name ?? s.realname) || null,
        room: text(s.room_name) || null,
        begins_at: unixToShanghai(begin),
        date: Number.isFinite(begin) && begin > 0 ? dateOnly.format(new Date(begin * 1000)) : null,
        ...(Number.isFinite(begin) && begin > now ? { upcoming: true } : {}),
      };
    });
    lectures.sort((a, b) => (a.begins_at ?? '').localeCompare(b.begins_at ?? '') || a.title.localeCompare(b.title, 'zh'));
    return { course_id: String(course_id), course_title: courseTitle, lectures, note: '按开课时间排序。sub_id 用于读取转录和 PPT。' };
  }

  async myLectures({ date, days = 1 }: { date?: string; days?: number }) {
    const end = checkDate(date ?? dateOnly.format(this.now()));
    if (!Number.isInteger(days) || days < 1 || days > 14) throw new ToolError('INVALID_ARGUMENT', 'days 取 1–14。');
    const lectures: (Lecture & { date: string })[] = [];
    const seen = new Set<string>();
    const now = this.now().getTime() / 1000;
    for (let i = 0; i < days; i++) {
      const day = shiftDate(end, -i);
      const data = await this.api.get(`${CLASSROOM}/courseapi/v2/course-live/get-my-course-day`, { day });
      this.ok(data, '查询当天课程');
      const groups = data.list && typeof data.list === 'object' ? (Array.isArray(data.list) ? data.list : Object.values(data.list)) : null;
      if (!groups) {
        if (data.list == null) continue;
        throw new ToolError('SCHEMA_CHANGED', '智云课堂当天课程缺少 list。');
      }
      for (const group of groups as Raw[]) {
        const courses = group?.course == null ? [] : Array.isArray(group.course) ? group.course : Object.values(group.course);
        for (const c of courses as Raw[]) {
          const subId = String(c.sub_id ?? '');
          if (!subId || seen.has(subId)) continue;
          seen.add(subId);
          const begin = Number(c.course_begin ?? c.class_begin);
          lectures.push({
            course_id: String(c.id ?? c.course_id),
            course_title: text(c.title),
            sub_id: subId,
            title: text(c.sub_title),
            teacher: text(c.realname ?? c.lecturer_name) || null,
            room: text(c.room_name) || null,
            begins_at: unixToShanghai(c.course_begin ?? c.class_begin),
            date: day,
            ...(Number.isFinite(begin) && begin > now ? { upcoming: true } : {}),
          });
        }
      }
    }
    lectures.sort((a, b) => (b.begins_at ?? b.date).localeCompare(a.begins_at ?? a.date));
    return { from: shiftDate(end, -(days - 1)), to: end, lectures, note: '按开始时间从新到旧排序；upcoming 表示还没开始。只含本人课表中的课；旁听课请用 zhiyun_search_courses + zhiyun_list_lectures。' };
  }

  async transcript({ sub_id, offset = 0, max_characters = 16000, with_timestamps = true, timestamp_every_sec = 0 }: { sub_id: unknown; offset?: number; max_characters?: number; with_timestamps?: boolean; timestamp_every_sec?: number }) {
    const data = await this.api.get(`${YJAPI}/courseapi/v3/web-socket/search-trans-result`, { sub_id: id(sub_id), format: 'json' });
    if (Number(data.code) === 10002) {
      return { sub_id: String(sub_id), available: false, text: '', next_offset: null, total_characters: 0, segments: 0, note: '暂无语音转录（当天课程通常还没转完，或该课未开启转录）。' };
    }
    this.ok(data, '读取转录');
    if (!Array.isArray(data.list)) throw new ToolError('SCHEMA_CHANGED', '智云课堂转录结果缺少 list。');
    const items: Raw[] = data.list[0]?.all_content ?? [];
    if (!Array.isArray(items)) throw new ToolError('SCHEMA_CHANGED', '智云课堂转录缺少 all_content。');
    let full: string;
    if (timestamp_every_sec > 0) {
      // Compact form: one paragraph per time block, timestamp only at block start.
      const blocks: string[] = [];
      let block = -1;
      for (const item of items) {
        const line = text(item.Text);
        if (!line) continue;
        const b = Math.floor((Number(item.BeginSec) || 0) / timestamp_every_sec);
        if (b !== block) {
          block = b;
          blocks.push(with_timestamps ? `[${clock(Number(item.BeginSec) || 0)}] ${line}` : line);
        } else blocks[blocks.length - 1] += ` ${line}`;
      }
      full = blocks.join('\n');
    } else {
      full = items
        .map(c => text(c.Text))
        .map((line, i) => (with_timestamps ? `[${clock(items[i].BeginSec)}] ${line}` : line))
        .filter(line => line.replace(/^\[[\d:]+\]\s*/, ''))
        .join('\n');
    }
    const duration = items.length ? Number(items[items.length - 1].EndSec) || null : null;
    return {
      sub_id: String(sub_id),
      available: items.length > 0,
      segments: items.length,
      duration: duration ? clock(duration) : null,
      text: full.slice(offset, offset + max_characters),
      next_offset: offset + max_characters < full.length ? offset + max_characters : null,
      total_characters: full.length,
      note: '自动语音转录，可能有识别错误；时间戳为课堂录像内的相对时间。',
    };
  }

  async slides({ course_id, sub_id }: { course_id: unknown; sub_id: unknown }) {
    const slides: Slide[] = [];
    const seen = new Set<string>();
    let total = 0;
    // search-ppt ignores per_page and may repeat pages: de-duplicate in order and stop when nothing new arrives.
    for (let page = 1; page <= 50; page++) {
      const data = this.ok(await this.api.get(`${CLASSROOM}/pptnote/v1/schedule/search-ppt`, { course_id: id(course_id), sub_id: id(sub_id), page, per_page: 100 }), '读取 PPT');
      if (!Array.isArray(data.list)) {
        if (data.list == null && page === 1) break;
        throw new ToolError('SCHEMA_CHANGED', '智云课堂 PPT 结果缺少 list。');
      }
      total = Number(data.total) || total;
      let added = 0;
      for (const item of data.list as Raw[]) {
        let content: Raw = {};
        try {
          content = typeof item.content === 'string' ? JSON.parse(item.content) : item.content ?? {};
        } catch {}
        const url = text(content.pptimgurl ?? item.pptimgurl);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        added++;
        const offsetKey = OFFSET_KEYS.find(k => (item[k] ?? content[k]) != null && (item[k] ?? content[k]) !== '' && Number.isFinite(Number(item[k] ?? content[k])));
        const rawOffset = offsetKey ? Number(item[offsetKey] ?? content[offsetKey]) : null;
        const offsetSec = rawOffset != null && rawOffset >= 0 && rawOffset <= MAX_OFFSET_SEC ? rawOffset : null;
        const createdKey = CREATED_KEYS.find(k => (item[k] ?? content[k]) != null && (item[k] ?? content[k]) !== '');
        const created = createdKey ? item[createdKey] ?? content[createdKey] : null;
        slides.push({
          index: slides.length + 1,
          image_url: url,
          offset_sec: offsetSec,
          offset: offsetSec == null ? null : clock(offsetSec),
          captured_at: created == null ? null : /^\d{9,10}$/.test(String(created)) ? unixToShanghai(created) : String(created),
        });
      }
      if (slides.length >= total || added === 0) break;
    }
    return {
      course_id: String(course_id),
      sub_id: String(sub_id),
      total_reported: total || slides.length,
      complete: slides.length >= total,
      slides,
      note: 'PPT 为课堂录像自动截图，可能有重复页。offset 为截图在录像中的时间（时:分:秒）；平台给出异常值时为 null。',
    };
  }

  async downloadSlides({ course_id, sub_id, output_dir, max_files = 300 }: { course_id: unknown; sub_id: unknown; output_dir: string; max_files?: number }) {
    if (!isAbsolute(output_dir)) throw new ToolError('INVALID_PATH', 'output_dir 必须是本地绝对路径。');
    if (!this.api.image) throw new ToolError('INTERNAL_ERROR', '当前客户端不支持下载图片。');
    const { slides } = await this.slides({ course_id, sub_id });
    const dir = join(output_dir, `zhiyun-${id(course_id)}-${id(sub_id)}`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const files: Raw[] = [];
    const errors: Raw[] = [];
    for (const slide of slides.slice(0, max_files)) {
      try {
        const { bytes, contentType } = await this.api.image(slide.image_url, 20 * 1024 * 1024);
        const ext = (extname(new URL(slide.image_url).pathname).slice(0, 5) || (/png/i.test(contentType) ? '.png' : '.jpg')).toLowerCase();
        const path = join(dir, `${String(slide.index).padStart(4, '0')}${/^\.[a-z0-9]+$/.test(ext) ? ext : '.jpg'}`);
        let handle;
        try {
          handle = await open(path, 'wx', 0o600);
        } catch (e: any) {
          if (e?.code === 'EEXIST') {
            files.push({ index: slide.index, path, status: 'exists' });
            continue;
          }
          throw e;
        }
        try {
          await handle.writeFile(bytes);
        } catch (e) {
          await handle.close();
          handle = null;
          await unlink(path);
          throw e;
        } finally {
          if (handle) await handle.close();
        }
        files.push({ index: slide.index, path, bytes: bytes.length, sha256: hash(bytes), offset: slide.offset, status: 'downloaded' });
      } catch (e) {
        errors.push({ index: slide.index, error: e instanceof ToolError ? { code: e.code, message: e.message } : { code: 'DOWNLOAD_FAILED' } });
      }
    }
    const counts: Record<string, number> = {};
    for (const f of files) counts[f.status] = (counts[f.status] ?? 0) + 1;
    return { directory: dir, counts, deferred: Math.max(0, slides.length - max_files), complete: !errors.length && slides.length <= max_files, files, errors, note: '图片按页序编号保存，已存在的文件不覆盖。下载不携带登录 Cookie。' };
  }
}
