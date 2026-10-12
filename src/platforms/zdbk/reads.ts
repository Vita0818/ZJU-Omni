import { ToolError } from '../../core/errors.ts';
import { requiredArray, type Raw } from '../../core/util.ts';
import { ZDBK_PATHS, type ZdbkApi } from './client.ts';
import { checkAcademicYear, currentTerm, gpaOf, parseExams, parseGrade, parseSession, semesterOfTerm, termCode, type ExamRow, type GradeRow, type Term } from './parse.ts';

const ALL = { doType: 'query', 'queryModel.showCount': 5000 };
const WEEKDAYS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export interface SemesterFilter {
  academic_year?: string;
  semester?: 1 | 2;
}

function matches(row: { academic_year: string | null; semester: number | null }, filter: SemesterFilter): boolean {
  if (filter.academic_year && row.academic_year !== filter.academic_year) return false;
  if (filter.semester && row.semester !== filter.semester) return false;
  return true;
}

export class ZdbkReader {
  readonly api: ZdbkApi;
  readonly now: () => Date;
  constructor(api: ZdbkApi, now: () => Date = () => new Date()) {
    this.api = api;
    this.now = now;
  }

  private async items(path: string): Promise<Raw[]> {
    return requiredArray(await this.api.post(path, { query: ALL }), 'items');
  }

  private rows<T>(items: Raw[], parse: (item: Raw) => T | T[]): { rows: T[]; skipped: number } {
    const rows: T[] = [];
    let skipped = 0;
    for (const item of items) {
      try {
        const parsed = parse(item);
        rows.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      } catch {
        skipped++;
      }
    }
    if (items.length && !rows.length && skipped) throw new ToolError('SCHEMA_CHANGED', '教务系统返回的条目都无法识别，接口字段可能已变化。');
    return { rows, skipped };
  }

  async grades(filter: SemesterFilter & { major_only?: boolean } = {}) {
    if (filter.academic_year) checkAcademicYear(filter.academic_year);
    const { rows, skipped } = this.rows<GradeRow>(await this.items(filter.major_only ? ZDBK_PATHS.majorGrades : ZDBK_PATHS.grades), parseGrade);
    const selected = rows.filter(r => matches(r, filter)).sort((a, b) => `${b.academic_year}${b.semester}`.localeCompare(`${a.academic_year}${a.semester}`) || a.name.localeCompare(b.name, 'zh'));
    return {
      scope: { academic_year: filter.academic_year ?? null, semester: filter.semester ?? null, major_only: filter.major_only ?? false },
      summary: gpaOf(selected),
      grades: selected,
      skipped_items: skipped,
      note: 'GPA 由本地按学分加权计算（五分制直接取教务绩点；4.3 制按 5.0→4.3、4.8→4.2、4.5→4.1、4.2→4.0，其余封顶 4.0）。弃修、待录、缓考、无效不计学分，合格/不合格不计 GPA。以学校官方成绩单为准。',
    };
  }

  async gpaSummary() {
    const all = this.rows<GradeRow>(await this.items(ZDBK_PATHS.grades), parseGrade).rows;
    let major: ReturnType<typeof gpaOf> | null = null;
    let majorError: string | null = null;
    try {
      major = gpaOf(this.rows<GradeRow>(await this.items(ZDBK_PATHS.majorGrades), parseGrade).rows);
    } catch (e) {
      majorError = e instanceof ToolError ? e.code : 'INTERNAL_ERROR';
    }
    const bySemester = new Map<string, GradeRow[]>();
    for (const row of all) {
      const key = row.academic_year ? `${row.academic_year}-${row.semester}` : 'unknown';
      bySemester.set(key, [...(bySemester.get(key) ?? []), row]);
    }
    return {
      overall: gpaOf(all),
      major,
      major_error: majorError,
      semesters: [...bySemester.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([key, rows]) => ({ semester: key, ...gpaOf(rows) })),
      note: 'semester 形如 2025-2026-1（1=秋冬，2=春夏）。GPA 为本地计算，以学校官方成绩单为准。',
    };
  }

  async exams(filter: SemesterFilter & { upcoming_only?: boolean } = {}) {
    if (filter.academic_year) checkAcademicYear(filter.academic_year);
    const { rows, skipped } = this.rows<ExamRow>(await this.items(ZDBK_PATHS.exams), parseExams);
    const now = this.now().getTime();
    const selected = rows
      .filter(r => matches(r, filter))
      .filter(r => !filter.upcoming_only || r.end == null || Date.parse(r.end) >= now)
      .sort((a, b) => (a.start ? Date.parse(a.start) : Infinity) - (b.start ? Date.parse(b.start) : Infinity) || a.name.localeCompare(b.name, 'zh'));
    return {
      scope: { academic_year: filter.academic_year ?? null, semester: filter.semester ?? null, upcoming_only: filter.upcoming_only ?? false },
      exams: selected,
      skipped_items: skipped,
      note: '时间为北京时间。start 为空表示教务只给出考试周等描述（time_text），尚未排定具体日期；upcoming_only 会保留这类考试。',
    };
  }

  async timetable(args: { academic_year?: string; term?: Term } = {}) {
    const guessed = currentTerm(this.now());
    const academic_year = checkAcademicYear(args.academic_year ?? guessed.academic_year);
    const term = args.term ?? guessed.term;
    const data = await this.api.post(ZDBK_PATHS.timetable, { form: { xnm: academic_year, xqm: termCode(term), captcha_value: '' }, allowNull: true });
    const items = data == null ? [] : requiredArray(data, 'kbList');
    const { rows, skipped } = this.rows(items, item => {
      const session = parseSession(item);
      return session ? [session] : [];
    });
    rows.sort((a, b) => a.weekday - b.weekday || a.periods[0] - b.periods[0]);
    return {
      academic_year,
      term,
      semester: semesterOfTerm(term),
      inferred_term: !args.academic_year || !args.term,
      sessions: rows.map(s => ({ ...s, weekday_name: WEEKDAYS[s.weekday] })),
      skipped_items: skipped,
      note: '节次时间按紫金港常规作息推算；weeks=odd/even 表示单/双周；terms 为课程所跨学期（如“秋冬”）。未指定学年学期时按当前日期推断。',
    };
  }
}
