// Small helpers for hiding secrets and printing things nicely.

const SENSITIVE_KEY =
  /authorization|api[-_]?key|apikey|cookie|token|secret|password|passwd|signature|credential/i;

/** Hide the values of headers that look like secrets. */
export function redactHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return headers ?? null;
  }
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_KEY.test(key) && !/^access-control-/i.test(key) ? "[hidden]" : value;
  }
  return out;
}

/** Hide passwords and secret-looking query values inside a web address. */
export function redactUrl(raw) {
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    if (u.password) u.password = "hidden";
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) u.searchParams.set(key, "hidden");
    }
    return u.toString();
  } catch {
    return raw;
  }
}

export function truncate(text, max) {
  const s = String(text ?? "");
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s;
}

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function isLocalUrl(url) {
  try {
    const h = new URL(url).hostname;
    return (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "::1" ||
      h === "[::1]" ||
      h === "host.docker.internal" ||
      h.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

const pad2 = (n) => String(n).padStart(2, "0");

/** Local time as "YYYY-MM-DD HH:MM:SS". */
export function fmtTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

export function fmtClock(iso) {
  const t = fmtTime(iso);
  return t === "-" ? t : t.slice(11);
}

/** Print rows as a plain text table. columns: [{ key, title, max }] */
export function renderTable(rows, columns) {
  const cells = rows.map((row) =>
    columns.map((c) => truncate(row[c.key] ?? "", c.max))
  );
  const widths = columns.map((c, i) =>
    Math.max(c.title.length, ...cells.map((r) => r[i].length))
  );
  const line = (arr) => arr.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
  const out = [line(columns.map((c) => c.title))];
  out.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of cells) out.push(line(r));
  return out.join("\n");
}