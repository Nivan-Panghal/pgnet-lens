# pgnet-lens

A free, local "flight recorder" for Supabase Database Webhooks and `pg_net`.

Supabase keeps the replies to your webhooks for only **6 hours**, and it does
not keep what was sent. When a webhook fails, the evidence is gone before you
look. `pgnet-lens` copies it to your own computer, explains failures in plain
English, and (optionally) remembers what was sent.

Other webhook tools sit between Supabase and your server, so they cannot see
requests that never arrive (timeouts, unknown addresses, refused connections).
`pgnet-lens` reads Supabase's own records instead, so it can.

> Status: early (v0.1). Works from the terminal. A web page and one-click
> resend are planned.

## Use it

You need Node.js 18.3 or newer and your database link (Supabase dashboard ->
**Connect** -> **Direct** tab -> **Session pooler** -> URI).

```bash
# macOS / Linux
export DATABASE_URL='postgresql://postgres.xxxx:PASSWORD@...pooler.supabase.com:5432/postgres'
npx pgnet-lens doctor
npx pgnet-lens watch
```

```powershell
# Windows PowerShell
$env:DATABASE_URL='postgresql://postgres.xxxx:PASSWORD@...pooler.supabase.com:5432/postgres'
npx pgnet-lens doctor
npx pgnet-lens watch
```

Leave `watch` running. In another terminal:

```bash
npx pgnet-lens list            # recent requests
npx pgnet-lens list --failed   # only problems
npx pgnet-lens show 42         # everything about request #42
```

## Commands

| Command | What it does |
|---|---|
| `doctor` | Checks the link works and which parts of Supabase it can read |
| `watch` | Copies new replies to your computer every 2 seconds |
| `list` | Shows saved history (`--failed`, `--limit 50`) |
| `show <id>` | Shows one request in detail (`--full` for long contents) |
| `init` | Optional: also remember what was sent (see below) |

## What it can and cannot show

| | Without `init` | With `init` |
|---|---|---|
| Reply status, error, reply body | yes | yes |
| Plain-English explanation | yes | yes |
| Webhook name and table (Database Webhooks) | yes | yes |
| Address and method of a Database Webhook | yes | yes |
| Data that was sent | no | only for requests sent with `pgnet_lens.http_post` |

`init` adds a small private area called `pgnet_lens` to your database. It
creates `pgnet_lens.http_post`, `http_get` and `http_delete`, which work like
`net.http_post` etc. but also remember the request. Run `pgnet-lens init --print`
to read the exact SQL before anything runs. Remove it any time with
`pgnet-lens init --remove`.

## Your data

- Everything stays on your computer in `.pgnet-lens/` (add it to `.gitignore`).
- Nothing is sent anywhere except to your own database.
- Secret-looking headers (Authorization, API keys, cookies) and web-address
  secrets are replaced with `[hidden]` before saving.
- Message contents can still contain private data. Use `--no-bodies` to avoid
  saving them.
- Use a link with the minimum access you are comfortable with. The tool only
  reads, apart from `init`.

## Limits

- Supabase's reply table is internal and may change between versions.
- The connection to hosted Supabase is encrypted but the server certificate is
  not verified yet.
- Webhooks created from the Supabase dashboard can show their address, but not
  the data they sent (Supabase does not keep it).

## License

MIT
