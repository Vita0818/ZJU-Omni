import { ToolError } from '../../core/errors.ts';
import type { Raw } from '../../core/util.ts';

export const TERMS = ['秋', '冬', '春', '夏'] as const;
export type Term = (typeof TERMS)[number];

export interface TermRef {
  academic_year: string;
  term: Term;
}

const YEAR = /^(\d{4})-(\d{4})$/;

export function checkAcademicYear(value: string): string {
  const m = value.match(YEAR);
  if (!m || Number(m[2]) !== Number(m[1]) + 1) throw new ToolError('INVALID_ARGUMENT', '学年格式应为 2025-2026。');
  return value;
}

/** ZJU 正方 xqm value: 秋/冬 belong to semester 1, 春/夏 to semester 2. */
export function termCode(term: Term): string {
  return `${term === '秋' || term === '冬' ? 1 : 2}|${term}`;
}

export function semesterOfTerm(term: Term): 1 | 2 {
  return term === '秋' || term === '冬' ? 1 : 2;
}

/** Best-effort guess of the current term from the Shanghai calendar date. */
export function currentTerm(now = new Date()): TermRef {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now).map(p => [p.type, p.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const start = month >= 8 ? year : year - 1;
  let term: Term;
  if (month >= 8 && (month <= 10 || (month === 11 && day < 15))) term = '秋';
  else if (month >= 11 || month <= 2) term = '冬';
  else if (month <= 4) term = '春';
  else term = '夏';
  return { academic_year: `${start}-${start + 1}`, term };
}

/** "(2025-2026-1)-CS1001G-0012345-1" → { academic_year: "2025-2026", semester: 1 } */
export function semesterOfCourseKey(key: unknown): { academic_year: string; semester: number } | null {
  const m = String(key ?? '').match(/^\((\d{4}-\d{4})-(\d)\)/);
  return m ? { academic_year: m[1], semester: Number(m[2]) } : null;
}

export function courseCodeOfKey(key: unknown): string | null {
  const m = String(key ?? '').match(/^\(\d{4}-\d{4}-\d\)-([^-]+)/);
  return m ? m[1] : null;
}

const text = (value: unknown) => (value == null ? '' : String(value)).trim();
const normalizeName = (value: string) => value.replace(/\(/g, '（').replace(/\)/g, '）');
const stripTags = (value: string) => value.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();

// Common 百分制 equivalents of 等级制 / 二级制 results.
const LEVEL_SCORES: Record<string, number> = {
  'A+': 95, A: 90, 'A-': 87, 'B+': 83, B: 80, 'B-': 77, 'C+': 73, C: 70, 'C-': 67, D: 60, F: 0,
  优秀: 90, 良好: 80, 中等: 70, 及格: 60, 不及格: 0, 合格: 75, 不合格: 0,
};
const NOT_COUNTED = new Set(['弃修', '待录', '缓考', '无效']);
const PASS_FAIL = new Set(['合格', '不合格']);
// 4.3 scale used by many graduate applications: 5.0→4.3, 4.8→4.2, 4.5→4.1, 4.2→4.0, otherwise capped at 4.0.
const FOUR_THREE: Record<string, number> = { '5': 4.3, '4.8': 4.2, '4.5': 4.1, '4.2': 4.0 };

export interface GradeRow {
  course_key: string;
  course_code: string | null;
  name: string;
  academic_year: string | null;
  semester: number | null;
  credit: number;
  score: string;
  grade_point: number | null;
  counted_in_gpa: boolean;
  counted_in_credits: boolean;
}

export function parseGrade(item: Raw): GradeRow {
  const key = text(item.xkkh);
  if (!key) throw new ToolError('SCHEMA_CHANGED', '成绩条目缺少选课课号 xkkh。');
  const score = text(item.cj);
  const credit = Number(item.xf);
  const point = item.jd === '' || item.jd == null ? null : Number(item.jd);
  const sem = semesterOfCourseKey(key);
  const countedInCredits = !NOT_COUNTED.has(score);
  return {
    course_key: key,
    course_code: courseCodeOfKey(key),
    name: normalizeName(text(item.kcmc) || '未知课程'),
    academic_year: sem?.academic_year ?? null,
    semester: sem?.semester ?? null,
    credit: Number.isFinite(credit) ? credit : 0,
    score,
    grade_point: point != null && Number.isFinite(point) ? point : null,
    counted_in_gpa: countedInCredits && !PASS_FAIL.has(score) && !key.includes('xtwkc') && point != null && Number.isFinite(point),
    counted_in_credits: countedInCredits,
  };
}

function hundredOf(row: GradeRow): number | null {
  if (row.score in LEVEL_SCORES) return LEVEL_SCORES[row.score];
  const n = Number(row.score);
  return Number.isFinite(n) ? n : null;
}

const round = (n: number, digits = 3) => Math.round(n * 10 ** digits) / 10 ** digits;

export interface GpaSummary {
  gpa_5: number | null;
  gpa_4_3: number | null;
  average_score: number | null;
  gpa_credits: number;
  earned_credits: number;
  courses: number;
}

export function gpaOf(rows: GradeRow[]): GpaSummary {
  const counted = rows.filter(r => r.counted_in_gpa);
  const credits = counted.reduce((s, r) => s + r.credit, 0);
  const earned = rows.filter(r => r.counted_in_credits && ((r.grade_point ?? 0) > 0 || r.score === '合格' || r.course_key.includes('xtwkc'))).reduce((s, r) => s + r.credit, 0);
  if (!credits) return { gpa_5: null, gpa_4_3: null, average_score: null, gpa_credits: 0, earned_credits: round(earned, 1), courses: rows.length };
  const five = counted.reduce((s, r) => s + (r.grade_point ?? 0) * r.credit, 0) / credits;
  const four = counted.reduce((s, r) => s + (r.grade_point! > 4 ? FOUR_THREE[String(r.grade_point)] ?? 4 : r.grade_point!) * r.credit, 0) / credits;
  const scored = counted.filter(r => hundredOf(r) != null);
  const scoredCredits = scored.reduce((s, r) => s + r.credit, 0);
  const avg = scoredCredits ? scored.reduce((s, r) => s + hundredOf(r)! * r.credit, 0) / scoredCredits : null;
  return { gpa_5: round(five), gpa_4_3: round(four), average_score: avg == null ? null : round(avg, 2), gpa_credits: round(credits, 1), earned_credits: round(earned, 1), courses: rows.length };
}

// Regular ZJU class periods (紫金港常规作息).
export const PERIOD_TIMES: Record<number, [string, string]> = {
  1: ['08:00', '08:45'], 2: ['08:50', '09:35'], 3: ['10:00', '10:45'], 4: ['10:50', '11:35'], 5: ['11:40', '12:25'],
  6: ['13:25', '14:10'], 7: ['14:15', '15:00'], 8: ['15:05', '15:50'], 9: ['16:15', '17:00'], 10: ['17:05', '17:50'],
  11: ['18:50', '19:35'], 12: ['19:40', '20:25'], 13: ['20:30', '21:15'],
};

export interface ClassSession {
  name: string;
  teacher: string | null;
  location: string | null;
  weekday: number;
  periods: number[];
  time: string | null;
  weeks: 'all' | 'odd' | 'even';
  terms: string | null;
  confirmed: boolean | null;
}

/** kcb: "课程名<br>学期信息<br>教师<br>地点zwf…" (HTML line blocks). */
export function parseSession(item: Raw): ClassSession | null {
  if (text(item.sfyjskc) === '1') return null;
  const block = text(item.kcb);
  if (!block) return null;
  const parts = block.split(/<br\s*\/?>/i).map(p => stripTags(p));
  const weekday = Number(item.xqj);
  const start = Number(item.djj);
  const length = Number(item.skcd);
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7 || !Number.isInteger(start) || !Number.isInteger(length) || length < 1) {
    throw new ToolError('SCHEMA_CHANGED', '课表条目缺少有效的星期或节次。');
  }
  const periods = Array.from({ length }, (_, i) => start + i);
  const first = PERIOD_TIMES[periods[0]];
  const last = PERIOD_TIMES[periods[periods.length - 1]];
  const rawLocation = (parts[3] ?? '').split('zwf')[0].trim();
  const dsz = text(item.dsz);
  return {
    name: normalizeName(parts[0] || '未知课程'),
    teacher: parts[2] || null,
    location: rawLocation || null,
    weekday,
    periods,
    time: first && last ? `${first[0]}-${last[1]}` : null,
    weeks: dsz === '0' ? 'odd' : dsz === '1' ? 'even' : 'all',
    terms: text(item.xxq) || null,
    confirmed: item.sfqd == null ? null : text(item.sfqd) === '1',
  };
}

export interface ExamRow {
  course_key: string;
  name: string;
  credit: number | null;
  type: 'midterm' | 'final';
  time_text: string;
  start: string | null;
  end: string | null;
  location: string | null;
  seat: string | null;
  academic_year: string | null;
  semester: number | null;
}

/** "2026年01月15日(08:00-10:00)" → ISO strings with +08:00; week labels without a date stay null. */
export function parseExamTime(value: string): { start: string | null; end: string | null } {
  const date = value.match(/(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})/);
  const range = value.match(/(\d{1,2}):(\d{2})\s*[-~—至]\s*(\d{1,2}):(\d{2})/);
  if (!date || !range) return { start: null, end: null };
  const pad = (n: string) => n.padStart(2, '0');
  const day = `${date[1]}-${pad(date[2])}-${pad(date[3])}`;
  return { start: `${day}T${pad(range[1])}:${range[2]}:00+08:00`, end: `${day}T${pad(range[3])}:${range[4]}:00+08:00` };
}

export function parseExams(item: Raw): ExamRow[] {
  const key = text(item.xkkh);
  if (!key) throw new ToolError('SCHEMA_CHANGED', '考试条目缺少选课课号 xkkh。');
  const sem = semesterOfCourseKey(key);
  const base = { course_key: key, name: normalizeName(text(item.kcmc) || '未知课程'), credit: item.xf == null || item.xf === '' ? null : Number(item.xf), academic_year: sem?.academic_year ?? null, semester: sem?.semester ?? null };
  const out: ExamRow[] = [];
  const add = (type: ExamRow['type'], time: unknown, location: unknown, seat: unknown) => {
    const timeText = text(time);
    if (!timeText) return;
    out.push({ ...base, type, time_text: timeText, ...parseExamTime(timeText), location: text(location) || null, seat: text(seat) || null });
  };
  add('midterm', item.qzkssj, item.qzjsmc, item.qzzwxh);
  add('final', item.kssj, item.jsmc, item.zwxh);
  return out;
}
