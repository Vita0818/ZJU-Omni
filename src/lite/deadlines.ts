// One merged, pre-sorted deadline list: small models mis-order dates when
// they have to combine several lists themselves.

export type DeadlineSource = '学在浙大' | '拼题A' | '学习通';

export interface DeadlineInput {
  source: DeadlineSource;
  course?: string | null;
  title: string;
  due_iso: string | null;
  status: string;
  activity_id?: unknown;
  problem_set_id?: string;
  solved?: string;
  group?: boolean;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const parts = (date: Date) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map(p => [p.type, p.value]),
  );

/** "2026-10-13 12:00 周二" in Beijing time. */
export function beijing(iso: string | null, withTime = true): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const p = parts(date);
  const weekday = WEEKDAYS[new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day))).getUTCDay()];
  return withTime ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${weekday}` : `${p.year}-${p.month}-${p.day} ${weekday}`;
}

/** Upcoming (soonest first), then overdue (most recent first), then unknown deadlines. */
export function mergeDeadlines(items: DeadlineInput[], now: Date) {
  const nowMs = now.getTime();
  const rank = (item: DeadlineInput) => {
    const t = item.due_iso ? Date.parse(item.due_iso) : NaN;
    if (!Number.isFinite(t)) return { group: 2, key: 0 };
    return t >= nowMs ? { group: 0, key: t } : { group: 1, key: -t };
  };
  return items
    .map(item => ({ item, r: rank(item) }))
    .sort((a, b) => a.r.group - b.r.group || a.r.key - b.r.key)
    .map(({ item, r }, index) => ({
      no: index + 1,
      source: item.source,
      course: item.course ?? undefined,
      title: item.title,
      due: beijing(item.due_iso) ?? '截止时间未知',
      overdue: r.group === 1 || undefined,
      status: item.status,
      solved: item.solved,
      group: item.group || undefined,
      activity_id: item.activity_id ?? undefined,
      problem_set_id: item.problem_set_id,
    }));
}
