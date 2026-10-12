export type CookieSource = "curl 命令" | "请求头" | "DevTools Cookies 表格" | "Cookie 字符串";

export type ExtractedCookie = { cookie: string; source: CookieSource; names: string[] };

const COOKIE_PAIR = /[\w\-]+=[^;\s]+/;

function normalizePairs(pairs: [string, string][]): string | undefined {
  const seen = new Map<string, string>();
  for (const [name, value] of pairs) {
    if (!/^[\w\-]+$/.test(name)) continue;
    if (!value) continue;
    seen.set(name, value);
  }
  return seen.size ? [...seen].map(([k, v]) => `${k}=${v}`).join("; ") : undefined;
}

function splitTableLine(line: string): string[] {
  return line.split("\t").length > 1 ? line.split("\t") : line.trim().split(/\s{2,}|,(?=\s)|\s{1,}(?=[^ ]+$)/);
}

/**
 * 接受用户从浏览器里随手复制的任何形态，避免要求他们精确地只挑出 Cookie 那一行。
 */
export function extractCookie(input: string): ExtractedCookie | undefined {
  const text = input.replace(/\r\n?/g, "\n").trim();
  if (!text) return undefined;

  const curl = text.match(/(?:--header|-H)\s+['"]?\s*cookie\s*:\s*([^'"\n]+)['"]?/i) ?? text.match(/(?:--cookie|-b)\s+['"]([^'"]+)['"]/i);
  if (curl?.[1]?.match(COOKIE_PAIR)) return finish(curl[1].replace(/^['"]|["';,]+$/g, ""), "curl 命令");

  const header = text.match(/^\s*(?:[-*]\s*)?cookie\s*:\s*(.+)$/im)?.[1];
  if (header?.match(COOKIE_PAIR)) return finish(header, "请求头");

  if (text.includes("\n")) {
    const rows: [string, string][] = [];
    for (const line of text.split("\n")) {
      const cells = splitTableLine(line).map((cell) => cell.trim().replace(/^["']|["']$/g, ""));
      if (cells.length < 2) continue;
      const skip = ["name", "名称", "cookie", "domain", "域"];
      if (skip.includes(cells[0].toLowerCase()) || /^(value|值)$/.test(cells[1])) continue;
      if (!/^[\w\-]{1,80}$/.test(cells[0])) continue;
      // DevTools 的表格列是 Name, Value, Domain…；只要前两列，后面的域/路径/过期时间对请求没用。
      if (!cells[1] || cells[1].length > 512) continue;
      rows.push([cells[0], cells[1]]);
    }
    const joined = normalizePairs(rows);
    if (joined) return finish(joined, "DevTools Cookies 表格");
  }

  const loose = [...text.matchAll(/([\w\-]+)\s*[=]\s*([^;\s"']+)/g)].map((m) => [m[1], m[2]] as [string, string]);
  if (loose.length >= 2 || text.match(COOKIE_PAIR)) {
    const joined = normalizePairs(loose);
    if (joined) return finish(joined, "Cookie 字符串");
  }
  return undefined;
}

function finish(cookie: string, source: CookieSource): ExtractedCookie | undefined {
  const joined = normalizePairs(
    cookie.split(";").map((part) => {
      const idx = part.indexOf("=");
      return idx < 0 ? ["", ""] : [part.slice(0, idx).trim(), part.slice(idx + 1).trim()];
    }) as [string, string][],
  );
  if (!joined) return undefined;
  return { cookie: joined, source, names: joined.split("; ").map((pair) => pair.split("=")[0]) };
}
