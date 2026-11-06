// The local history file. One JSON record per line, so it never needs a
// separate database program and is easy to open and read yourself.
import fs from "node:fs";
import path from "node:path";

export class Store {
  constructor(file) {
    this.file = file;
    this.keys = new Set();
    this.items = [];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          this.items.push(rec);
          this.keys.add(rec.key);
        } catch {
          // skip a damaged line instead of crashing
        }
      }
    }
  }

  has(key) {
    return this.keys.has(key);
  }

  /** Adds a record unless we already have it. Returns true if it was new. */
  add(rec) {
    if (this.keys.has(rec.key)) return false;
    fs.appendFileSync(this.file, JSON.stringify(rec) + "\n");
    this.keys.add(rec.key);
    this.items.push(rec);
    return true;
  }

  /** Combines responses, webhook records and captured requests by request id. */
  view() {
    const byId = new Map();
    const get = (id) => {
      if (!byId.has(id)) byId.set(id, { id });
      return byId.get(id);
    };
    for (const rec of this.items) {
      if (rec.t === "response") {
        const e = get(rec.id);
        if (!e.response || rec.created >= e.response.created) e.response = rec;
      } else if (rec.t === "hook") {
        get(rec.requestId).hook = rec;
      } else if (rec.t === "request") {
        get(rec.requestId).request = rec;
      }
    }
    const rows = [];
    for (const e of byId.values()) {
      const { response, hook, request } = e;
      rows.push({
        id: e.id,
        time: response?.created ?? request?.createdAt ?? hook?.createdAt ?? null,
        hasResponse: Boolean(response),
        status: response?.status ?? null,
        timedOut: response?.timedOut ?? false,
        error: response?.error ?? null,
        contentType: response?.contentType ?? null,
        responseHeaders: response?.headers ?? null,
        responseBody: response?.body ?? null,
        responseBodyTruncated: response?.bodyTruncated ?? false,
        hookName: hook?.hookName ?? null,
        table: hook?.table ?? null,
        url: request?.url ?? hook?.url ?? null,
        method: request?.method ?? hook?.method ?? null,
        requestHeaders: request?.headers ?? hook?.headers ?? null,
        requestParams: request?.params ?? hook?.params ?? null,
        requestBody: request?.body ?? null,
        source: request ? "recorded" : hook ? "webhook" : "unknown",
      });
    }
    rows.sort((a, b) => {
      const ta = a.time ?? "";
      const tb = b.time ?? "";
      if (ta !== tb) return ta < tb ? 1 : -1;
      return BigInt(a.id) < BigInt(b.id) ? 1 : -1;
    });
    return rows;
  }
}