// Parsing rules ported from zju-chaoxing (MIT).
import { ToolError, safeError } from '../../core/errors.ts';
import type { XxtApi } from './client.ts';

const URL_BASE = 'https://i.chaoxing.com/base';
const URL_COURSELIST = 'https://mooc2-ans.chaoxing.com/mooc2-ans/visit/courselistdata';
const URL_STUMIDDLE = 'https://mooc1.chaoxing.com/visit/stucoursemiddle';
const URL_WORKLIST = 'https://mooc1.chaoxing.com/mooc2/work/list';
const URL_EXAMLIST = 'https://mooc1-api.chaoxing.com/exam-ans/exam/test/examcode/examlist';
const URL_NOTICELIST = 'https://notice.chaoxing.com/pc/notice/getNoticeList';
const URL_SCHEDULE = 'https://kb.chaoxing.com/pc/curriculum/getMyLessons';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const unescapeHtml = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
export const stripTags = (s: string) => unescapeHtml(s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).split(/\s+/).join(' ').trim();

export function hiddenValue(html: string, id: string): string {
  const m = html.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`)) ?? html.match(new RegExp(`value="([^"]*)"[^>]*id="${id}"`));
  return m ? m[1] : '';
}

export interface XxtCourse {
  name: string;
  teacher: string;
  courseid: string;
  clazzid: string;
  cpi: string;
}

export function parseCourses(html: string): XxtCourse[] {
  const out: XxtCourse[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/stucoursemiddle\?courseid=(\d+)&(?:amp;)?clazzid=(\d+)&(?:amp;)?cpi=(\d+)/g)) {
    const key = `${m[1]}/${m[2]}/${m[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const seg = html.slice(m.index! + m[0].length, m.index! + m[0].length + 1600);
    const name = seg.match(/course-name[^>]*title="([^"]+)"/)?.[1];
    let teacher = '';
    for (const p of seg.matchAll(/<p class="overHidden2"[^>]*>([^<]{2,15})<\/p>/g)) {
      const t = p[1].trim();
      if (t && t !== name) {
        teacher = t;
        break;
      }
    }
    out.push({ name: name ? unescapeHtml(name) : '?', teacher: unescapeHtml(teacher), courseid: m[1], clazzid: m[2], cpi: m[3] });
  }
  return out;
}

const DONE = ['已完成', '已提交', '待批阅', '已批阅', '已批改'];
export const isPending = (status: string) => !DONE.some(mark => (status || '').includes(mark));

export function parseHomeworkDetail(html: string) {
  const text = stripTags(html);
  const out: { title: string | null; question_count: number | null; full_score: number | null; start_time: string | null; deadline: string | null; score: string | null } = { title: null, question_count: null, full_score: null, start_time: null, deadline: null, score: null };
  const q = text.match(/题量[:：]/);
  if (q) {
    const head = text.slice(0, q.index);
    const k = head.lastIndexOf('作业详情');
    if (k >= 0) out.title = head.slice(k + 4).trim() || null;
  }
  out.question_count = Number(text.match(/题量[:：]\s*(\d+)/)?.[1] ?? NaN) || null;
  out.full_score = Number(text.match(/满分[:：]\s*(\d+)/)?.[1] ?? NaN) || null;
  const range = text.match(/作答时间[:：]\s*(\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})\s*至\s*(\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})/);
  if (range) [out.start_time, out.deadline] = [range[1], range[2]];
  out.score = (text.match(/智能分析\s*(\d+(?:\.\d+)?)\s*分/) ?? text.match(/(?:得分|总评|成绩|批阅)[:：]?\s*(\d+(?:\.\d+)?)\s*分/))?.[1] ?? null;
  return out;
}

/** "MM-DD HH:MM" has no year: pick the year closest to today (Shanghai). Returns an ISO string with +08:00. */
export function nearestDate(monthDay: string, now: Date): string | null {
  const m = monthDay.trim().match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const today = Date.parse(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now) + 'T00:00:00+08:00');
  const year = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(now));
  const pad = (s: string | number) => String(s).padStart(2, '0');
  let best: { iso: string; diff: number } | null = null;
  for (const y of [year - 1, year, year + 1]) {
    const iso = `${y}-${pad(m[1])}-${pad(m[2])}T${pad(m[3])}:${m[4]}:00+08:00`;
    const t = Date.parse(iso);
    const local = new Date(t + 8 * 3600000);
    if (!Number.isFinite(t) || local.getUTCMonth() + 1 !== Number(m[1]) || local.getUTCDate() !== Number(m[2])) continue;
    const diff = Math.abs(t - today);
    if (!best || diff < best.diff) best = { iso, diff };
  }
  return best?.iso ?? null;
}

export class XxtReader {
  readonly api: XxtApi;
  readonly now: () => Date;
  private coursesCache: { at: number; courses: XxtCourse[] } | null = null;
  constructor(api: XxtApi, now: () => Date = () => new Date()) {
    this.api = api;
    this.now = now;
  }

  async courses(): Promise<XxtCourse[]> {
    if (this.coursesCache && Date.now() - this.coursesCache.at < 300000) return this.coursesCache.courses;
    const base = await this.api.get(URL_BASE);
    const fid = base.match(/"fid"\s*:\s*"?(\d+)"?/)?.[1] ?? base.match(/var fid = '(\d+)'/)?.[1] ?? '427';
    const html = await this.api.get(URL_COURSELIST, { courseType: 1, courseFid: fid, courseTeacherid: 0, courseOrderBy: 0 });
    const courses = parseCourses(html);
    this.coursesCache = { at: Date.now(), courses };
    return courses;
  }

  async listCourses() {
    const courses = await this.courses();
    return { courses: courses.map(c => ({ course_id: c.courseid, class_id: c.clazzid, name: c.name, teacher: c.teacher || null })) };
  }

  async findCourse(course: string): Promise<XxtCourse> {
    const courses = await this.courses();
    const hit = courses.find(c => c.courseid === course) ?? courses.find(c => c.name === course) ?? courses.find(c => c.name.includes(course));
    if (!hit) throw new ToolError('COURSE_NOT_FOUND', `学习通中没有找到“${course}”这门课。`);
    return hit;
  }

  async homework(c: XxtCourse) {
    const page = await this.api.get(URL_STUMIDDLE, { courseid: c.courseid, clazzid: c.clazzid, cpi: c.cpi, ismooc2: 1, v: 2 });
    const workEnc = hiddenValue(page, 'workEnc');
    if (!workEnc) throw new ToolError('HOMEWORK_UNAVAILABLE', '这门课没有开放作业功能（缺少作业签名）。');
    const html = await this.api.get(URL_WORKLIST, { courseId: c.courseid, classId: c.clazzid, cpi: c.cpi, ut: 's', openc: hiddenValue(page, 'openc'), enc: workEnc, t: Date.now(), stuenc: hiddenValue(page, 'enc'), isdisplaytable: 2 });
    if (html.includes('没有此页面访问权限')) throw new ToolError('SIGNATURE_REJECTED', '作业页签名校验失败，请稍后重试。');
    const progress = html.match(/<span>(\d+)\/(\d+)<\/span>\s*<\/div>\s*<\/div>/);
    const items = [...html.matchAll(/<li onclick="goTask\(this\);" data="([^"]+)"[\s\S]*?<p class="overHidden2 fl">([^<]+)<\/p>[\s\S]*?<p class="status fl">([^<]*)<\/p>/g)].map((m, i) => ({
      index: i + 1,
      title: unescapeHtml(m[2].trim()),
      status: m[3].trim() || '未知',
      url: decodeURIComponent(unescapeHtml(m[1])),
    }));
    return { progress: progress ? { done: Number(progress[1]), total: Number(progress[2]) } : null, items };
  }

  async listHomework({ course }: { course: string }) {
    const c = await this.findCourse(course);
    const hw = await this.homework(c);
    return { course: c.name, progress: hw.progress, homework: hw.items.map(({ url: _url, ...rest }) => ({ ...rest, pending: isPending(rest.status) })) };
  }

  async deadlines({ course, horizon_days = 90, max_courses = 30 }: { course?: string; horizon_days?: number; max_courses?: number } = {}) {
    const courses = course ? [await this.findCourse(course)] : (await this.courses()).slice(0, max_courses);
    const now = this.now();
    const horizon = now.getTime() + horizon_days * 86400000;
    const rows: { course: string; title: string; status: string; deadline: string | null }[] = [];
    const errors: unknown[] = [];
    for (const c of courses) {
      let hw;
      try {
        hw = await this.homework(c);
      } catch (e) {
        if (!(e instanceof ToolError && e.code === 'HOMEWORK_UNAVAILABLE')) errors.push({ course: c.name, error: safeError(e) });
        continue;
      }
      for (const item of hw.items.filter(i => isPending(i.status))) {
        let due: string | null = null;
        if (item.url.startsWith('https://')) {
          try {
            const detail = parseHomeworkDetail(await this.api.get(item.url));
            due = detail.deadline ? nearestDate(detail.deadline, now) : null;
          } catch (e) {
            errors.push({ course: c.name, title: item.title, error: safeError(e) });
          }
        }
        if (due && Date.parse(due) > horizon) continue;
        rows.push({ course: c.name, title: item.title, status: item.status, deadline: due });
      }
    }
    const nowMs = now.getTime();
    rows.sort((a, b) => {
      const rank = (r: typeof a) => (r.deadline == null ? 2 : Date.parse(r.deadline) < nowMs ? 1 : 0);
      return rank(a) - rank(b) || (a.deadline ?? '').localeCompare(b.deadline ?? '');
    });
    return { items: rows, courses_scanned: courses.length, complete: errors.length === 0, errors, note: '只列未完成的作业；截止时间来自作业详情页（原文无年份，按最接近今天的年份补全，北京时间）。' };
  }

  async exams() {
    const html = await this.api.get(URL_EXAMLIST);
    const rows = [...html.matchAll(/<tr[^>]*class="dataTr"[^>]*>([\s\S]*?)<\/tr>/g)]
      .map(m => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(td => unescapeHtml(td[1].replace(/<[^>]+>/g, '')).trim()))
      .filter(tds => tds.length >= 9);
    return { exams: rows.map(t => ({ name: t[1], time: t[2], minutes: t[3], exam_status: t[4], my_status: t[5], score: t[6] || null, mode: t[7] || null })) };
  }

  async notices({ limit = 20, unread_only = false, keyword = '' }: { limit?: number; unread_only?: boolean; keyword?: string } = {}) {
    const kw = keyword.trim();
    const match = (it: Record<string, any>) => (!unread_only || !it.isread) && (!kw || `${it.title ?? ''}${it.content ?? ''}`.includes(kw));
    const items: Record<string, any>[] = [];
    let last = '';
    for (let page = 0; page < 5; page++) {
      const text = await this.api.post(URL_NOTICELIST, { type: '0', notice_type: '0', lastValue: last, sort: '0', folderUUID: '', kw: '', startTime: '', endTime: '', gKw: '', gName: '', year: '', tag: '', fidsCode: '', filterSenderPuids: '', filterTags: '' });
      let j: Record<string, any>;
      try {
        j = JSON.parse(text);
      } catch {
        throw new ToolError('SCHEMA_CHANGED', '学习通通知接口未返回 JSON。');
      }
      if (!j.status) throw new ToolError('PLATFORM_REJECTED', '学习通通知接口返回失败。');
      const data = j.notices ?? {};
      const list: Record<string, any>[] = data.list ?? [];
      items.push(...list);
      last = data.lastGetId ?? '';
      if (!list.length || data.lastPage || items.filter(match).length >= limit) break;
    }
    return {
      notices: items.filter(match).slice(0, limit).map(it => ({ title: it.title ?? null, sender: it.createrName ?? it.senderName ?? null, time: it.completeTime ?? it.insertTime ?? null, read: Boolean(it.isread), content: it.content ? stripTags(String(it.content)).slice(0, 800) : null })),
    };
  }

  async schedule({ week }: { week?: number } = {}) {
    const text = await this.api.post(URL_SCHEDULE, week ? { week: String(week) } : {});
    let j: Record<string, any>;
    try {
      j = JSON.parse(text);
    } catch {
      throw new ToolError('SCHEMA_CHANGED', '学习通课表接口未返回 JSON。');
    }
    if (j.result !== 1) throw new ToolError('PLATFORM_REJECTED', '学习通课表接口返回失败。');
    const cur = j.data?.curriculum ?? {};
    const lessons: Record<string, any>[] = j.data?.lessonArray ?? [];
    const times: string[] = cur.lessonTimeConfigArray ?? [];
    return {
      school_year: cur.schoolYear ?? null,
      semester: cur.semester ?? null,
      week: week ?? cur.realCurrentWeek ?? cur.currentWeek ?? null,
      lessons: lessons
        .map(l => {
          const begin = Number(l.beginNumber) || 0;
          const len = Number(l.length) || 1;
          const span = times[begin - 1] && times[begin + len - 2] ? `${String(times[begin - 1]).split('-')[0]}-${String(times[begin + len - 2]).split('-')[1]}` : null;
          return { weekday: Number(l.dayOfWeek) || null, periods: `${begin}-${begin + len - 1}`, time: span, course: l.name ?? null, teacher: l.teacherName ?? null, place: l.location ?? null, weeks: l.weeks ?? null };
        })
        .sort((a, b) => (a.weekday ?? 9) - (b.weekday ?? 9) || a.periods.localeCompare(b.periods, undefined, { numeric: true })),
      note: '不传 week 时为平台当前周。weekday 1=周一。',
    };
  }
}
