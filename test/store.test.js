import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { parseTriggerArgs } from "../src/sync.js";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pgl-")), "h.jsonl");

test("duplicates are ignored", () => {
  const s = new Store(tmp());
  assert.equal(s.add({ key: "r|1|x", t: "response", id: "1", created: "2026-01-01T00:00:00Z" }), true);
  assert.equal(s.add({ key: "r|1|x", t: "response", id: "1", created: "2026-01-01T00:00:00Z" }), false);
});

test("history survives a restart", () => {
  const file = tmp();
  const a = new Store(file);
  a.add({ key: "r|1|x", t: "response", id: "1", created: "2026-01-01T00:00:00Z", status: 200 });
  const b = new Store(file);
  assert.equal(b.view().length, 1);
  assert.equal(b.add({ key: "r|1|x", t: "response", id: "1", created: "2026-01-01T00:00:00Z" }), false);
});

test("damaged lines are skipped", () => {
  const file = tmp();
  fs.writeFileSync(file, 'not json\n{"key":"h|2","t":"hook","requestId":"2","hookName":"w"}\n');
  const s = new Store(file);
  assert.equal(s.items.length, 1);
});

test("view joins reply, webhook and recorded request by id", () => {
  const s = new Store(tmp());
  s.add({ key: "r|5|a", t: "response", id: "5", created: "2026-01-01T10:00:00Z", status: 500 });
  s.add({ key: "h|5", t: "hook", requestId: "5", hookName: "orders_hook", table: "public.orders", url: "https://x.test/h", method: "POST" });
  s.add({ key: "q|5", t: "request", requestId: "5", createdAt: "2026-01-01T09:59:59Z", method: "POST", url: "https://x.test/h", body: { a: 1 } });
  const [row] = s.view();
  assert.equal(row.status, 500);
  assert.equal(row.table, "public.orders");
  assert.equal(row.hookName, "orders_hook");
  assert.deepEqual(row.requestBody, { a: 1 });
  assert.equal(row.source, "recorded");
});

test("a request without a reply is still listed", () => {
  const s = new Store(tmp());
  s.add({ key: "h|9", t: "hook", requestId: "9", createdAt: "2026-01-01T10:00:00Z", hookName: "w" });
  const [row] = s.view();
  assert.equal(row.hasResponse, false);
});

test("newest first, large ids compare correctly", () => {
  const s = new Store(tmp());
  s.add({ key: "r|9|a", t: "response", id: "9", created: "2026-01-01T10:00:00Z" });
  s.add({ key: "r|10|a", t: "response", id: "10", created: "2026-01-01T10:00:00Z" });
  assert.deepEqual(s.view().map((r) => r.id), ["10", "9"]);
});

test("trigger arguments are split into address, method, headers", () => {
  const buf = Buffer.from(
    ["https://x.test/h", "POST", '{"Content-Type":"application/json"}', "{}", "5000", ""].join("\u0000"),
    "utf8"
  );
  const a = parseTriggerArgs(buf);
  assert.equal(a.url, "https://x.test/h");
  assert.equal(a.method, "POST");
  assert.deepEqual(a.headers, { "Content-Type": "application/json" });
  assert.equal(a.timeout, 5000);
});

test("trigger arguments tolerate nothing and bad JSON", () => {
  assert.equal(parseTriggerArgs(null), null);
  const a = parseTriggerArgs(Buffer.from(["u", "POST", "{bad", "{}", ""].join("\u0000"), "utf8"));
  assert.equal(a.headers, null);
});
