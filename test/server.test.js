import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import { openStore } from "../src/commands.js";
import { describeTarget } from "../src/db.js";

const URL_ = "postgresql://user:pw@localhost:5432/testdb";
const target = describeTarget(URL_);

// A stand-in for the database connection. No real database is needed.
function fakeConn(onResend) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (text.includes("to_regclass")) return { rows: [{ present: false }] };
      if (text.includes("net._http_response")) return { rows: [] };
      if (text.includes("pgnet_lens.resend")) return onResend(params);
      throw new Error("unexpected query: " + text);
    },
    async close() {},
  };
}

function seed(flags) {
  const store = openStore(URL_, flags);
  store.add({ key: "r|1|a", t: "response", id: "1", created: "2026-01-01T10:00:00.000Z", status: 200 });
  store.add({
    key: "h|1", t: "hook", requestId: "1", createdAt: "2026-01-01T10:00:00.000Z",
    hookName: "orders_hook", table: "public.orders", url: "https://x.test/h", method: "POST",
  });
  store.add({ key: "r|2|a", t: "response", id: "2", created: "2026-01-01T11:00:00.000Z", status: 500 });
  store.add({
    key: "q|2", t: "request", requestId: "2", createdAt: "2026-01-01T10:59:59.000Z",
    method: "POST", url: "https://x.test/pay", body: { amount: 5 }, headers: { "Content-Type": "application/json" },
  });
  store.add({
    key: "r|3|a", t: "response", id: "3", created: "2026-01-01T12:00:00.000Z",
    status: null, timedOut: true, error: "Timeout of 2000 ms reached.",
  });
}

async function withServer(onResend, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgl-srv-"));
  const flags = { dir, port: "0", interval: "1" };
  seed(flags);
  const conn = fakeConn(onResend ?? (() => ({ rows: [{ id: "99" }] })));
  const handle = await startServer(conn, target, URL_, flags, () => {});
  const base = `http://127.0.0.1:${handle.port}`;
  const api = (p, opts = {}) =>
    fetch(base + p, { ...opts, headers: { "x-token": handle.token, ...(opts.headers ?? {}) } });
  try {
    await fn({ handle, base, api, conn });
  } finally {
    await handle.stop();
  }
}

test("page is served with safe headers and never uses innerHTML", async () => {
  await withServer(null, async ({ base }) => {
    const res = await fetch(base + "/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const html = await res.text();
    assert.ok(!/innerHTML|insertAdjacentHTML|document\.write|eval\(/.test(html));
  });
});

test("the link contains the key, and the key is 32 hex characters", async () => {
  await withServer(null, async ({ handle }) => {
    assert.match(handle.token, /^[0-9a-f]{32}$/);
    assert.ok(handle.link.startsWith("http://127.0.0.1:"));
    assert.ok(handle.link.endsWith("?t=" + handle.token));
  });
});

test("API refuses requests without the key", async () => {
  await withServer(null, async ({ base }) => {
    assert.equal((await fetch(base + "/api/status")).status, 401);
    assert.equal(
      (await fetch(base + "/api/status", { headers: { "x-token": "wrong" } })).status,
      401
    );
  });
});

test("API refuses a wrong Host header (DNS rebinding)", async () => {
  await withServer(null, async ({ handle }) => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: handle.port, path: "/api/status",
          headers: { host: "evil.example.com", "x-token": handle.token } },
        (res) => { res.resume(); resolve(res.statusCode); }
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});

test("API refuses requests from another website (Origin)", async () => {
  await withServer(null, async ({ api }) => {
    const res = await api("/api/status", { headers: { origin: "https://evil.example.com" } });
    assert.equal(res.status, 403);
  });
});

test("status reports the target without any password", async () => {
  await withServer(null, async ({ api }) => {
    const body = await (await api("/api/status")).json();
    assert.equal(body.target.host, "localhost");
    assert.equal(body.target.database, "testdb");
    assert.equal(JSON.stringify(body).includes("pw"), false);
    assert.equal(body.total, 3);
  });
});

test("list is newest first and has plain-English results", async () => {
  await withServer(null, async ({ api }) => {
    const { items } = await (await api("/api/requests")).json();
    assert.deepEqual(items.map((i) => i.id), ["3", "2", "1"]);
    assert.equal(items[0].label, "Timed out");
    assert.equal(items[1].label, "Server error");
    assert.equal(items[2].label, "Worked");
    assert.equal(items[2].from, "public.orders (orders_hook)");
    assert.equal(items[1].canResend, true);
    assert.equal(items[2].canResend, false);
  });
});

test("problems filter hides successes", async () => {
  await withServer(null, async ({ api }) => {
    const { items } = await (await api("/api/requests?filter=problems")).json();
    assert.deepEqual(items.map((i) => i.id), ["3", "2"]);
  });
});

test("detail includes what was sent for a recorded request", async () => {
  await withServer(null, async ({ api }) => {
    const d = await (await api("/api/requests/2")).json();
    assert.equal(d.method, "POST");
    assert.equal(d.url, "https://x.test/pay");
    assert.deepEqual(d.requestBody, { amount: 5 });
    assert.equal((await api("/api/requests/12345")).status, 404);
    assert.equal((await api("/api/requests/abc")).status, 404);
  });
});

test("send again works for a recorded request", async () => {
  await withServer(null, async ({ api, conn }) => {
    const res = await api("/api/requests/2/resend", { method: "POST" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { newId: "99" });
    const call = conn.calls.find((c) => c.text.includes("pgnet_lens.resend"));
    assert.deepEqual(call.params, ["2"]);
  });
});

test("send again is refused for a request that was not recorded", async () => {
  await withServer(null, async ({ api, conn }) => {
    const res = await api("/api/requests/1/resend", { method: "POST" });
    assert.equal(res.status, 409);
    assert.equal(conn.calls.some((c) => c.text.includes("pgnet_lens.resend")), false);
  });
});

test("send again needs a POST and the key", async () => {
  await withServer(null, async ({ api, base }) => {
    assert.equal((await api("/api/requests/2/resend")).status, 404);
    assert.equal((await fetch(base + "/api/requests/2/resend", { method: "POST" })).status, 401);
  });
});

test("old database setup gives a helpful message", async () => {
  const missing = () => {
    const e = new Error('function pgnet_lens.resend(bigint) does not exist');
    e.code = "42883";
    throw e;
  };
  await withServer(missing, async ({ api }) => {
    const res = await api("/api/requests/2/resend", { method: "POST" });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /pgnet-lens init/);
  });
});

test("unknown paths return 404", async () => {
  await withServer(null, async ({ api, base }) => {
    assert.equal((await fetch(base + "/nope")).status, 404);
    assert.equal((await api("/api/nope")).status, 404);
  });
});