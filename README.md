# pgnet-lens

A free flight recorder for Supabase webhooks. It keeps what Supabase throws
away, explains failures in plain English, and lets you send a request again.

> pgnet-lens is an independent project. It is not made by, or endorsed by,
> Supabase.

## The problem

When a Supabase Database Webhook (or any `pg_net` request) fails, you get very
little to work with:

- Supabase deletes the reply after a short time (6 hours by default).
- It never keeps what was sent.
- There is no way to send a failed request again.

By the time you notice a problem, the evidence is gone.

## What pgnet-lens does

- **Keeps history on your own computer.** It copies each reply before Supabase
  deletes it.
- **Explains what went wrong** in plain English: "The other server did not
  answer in time", "The web address could not be found", "The server refused the
  connection", and so on.
- **Shows a simple web page** with the full list and a detail view for each
  request.
- **Sends a request again** with one click (for requests it recorded, see below).
- **Costs nothing and needs no account.** It runs on your computer and talks only
  to your own database.

### How it is different

Most webhook tools sit between Supabase and your server, so you have to change
your webhook address to theirs. They can only see requests that arrive. If your
server is down, the address is wrong, or the request times out, they see nothing.

pgnet-lens reads Supabase's own records instead, so it also shows the requests
that never arrived, and you do not change any webhook address.

## Quick start

You need [Node.js](https://nodejs.org) 18.3 or newer and your database link.

Get the link from the Supabase dashboard: **Connect** -> **Direct** tab ->
**Session pooler** -> **URI**. Replace `[YOUR-PASSWORD]` with your database
password. A password with only letters and numbers avoids trouble with special
characters.

macOS / Linux:

```bash
export DATABASE_URL='postgresql://postgres.xxxx:PASSWORD@...pooler.supabase.com:5432/postgres'
npx pgnet-lens doctor
npx pgnet-lens serve
```

Windows PowerShell:

```powershell
$env:DATABASE_URL='postgresql://postgres.xxxx:PASSWORD@...pooler.supabase.com:5432/postgres'
npx pgnet-lens doctor
npx pgnet-lens serve
```

`doctor` checks that everything can be read. `serve` opens the page in your
browser and keeps copying new replies while it is open. If the browser does not
open, copy the link it prints.

## Commands

| Command | What it does |
|---|---|
| `doctor` | Checks the link works and which parts of Supabase can be read |
| `serve` | Opens the web page and keeps copying new replies |
| `watch` | Copies new replies and prints them in the terminal |
| `list` | Shows saved history (`--failed`, `--limit 50`) |
| `show <id>` | Shows one request in detail (`--full` for long contents) |
| `init` | Optional: also remember what was sent (see below) |

Useful options: `--port 8080` (page port), `--no-open` (do not open the
browser), `--no-bodies` (do not save message contents), `--dir <folder>` (where
history is saved). Run `npx pgnet-lens --help` for the full list.

## What you can see

| | Without `init` | With `init` |
|---|---|---|
| Reply status, error and reply body | yes | yes |
| Plain-English explanation | yes | yes |
| Webhook name and table (Database Webhooks) | yes | yes |
| Address and method of a Database Webhook | yes | yes |
| Data that was sent | no | for requests sent with `pgnet_lens.http_post` |
| Send again | no | for requests sent with `pgnet_lens.http_post` |

### Remembering what was sent (optional)

Run `npx pgnet-lens init`. It asks before changing anything, and
`npx pgnet-lens init --print` shows the exact SQL first. It adds a private area
called `pgnet_lens` to your database with:

- `pgnet_lens.http_post`, `http_get` and `http_delete`. They work like
  `net.http_post` and friends but also remember the request. Use them in your
  own SQL in place of the `net.*` versions.
- `pgnet_lens.resend(id)`, used by the page's "Send again" button.
- `pgnet_lens.cleanup()` to delete old remembered requests.

Only the database owner and `service_role` can use it, and it does not touch
your tables, triggers or webhooks. Remove it any time with
`npx pgnet-lens init --remove`.

### Webhooks created in the Supabase dashboard

pgnet-lens shows their name, table, address and result. It cannot show the data
they sent or send them again, because Supabase never stores that data.

## Privacy and safety

- History is saved in a `.pgnet-lens` folder on your computer. Add it to
  `.gitignore`.
- Nothing is sent anywhere except to your own database (and, when you press
  "Send again", from your database to the original address).
- Secret-looking headers (Authorization, API keys, cookies) and secrets in
  web addresses are replaced with `[hidden]` before anything is saved.
- Message contents can still contain private data. Use `--no-bodies` to avoid
  saving them.
- **"Send again" runs inside your database**, so the original secret headers
  never leave it. It sends the request a second time to the other server, so
  think before you resend something like a payment.
- The web page only listens on your own computer (`127.0.0.1`). Every data
  request needs a private key that is only in the link printed in your
  terminal, and requests that look like they come from another website are
  refused. Do not share that link.
- The page shows all data as plain text, so a malicious reply body cannot run
  code in your browser.
- The connection to hosted Supabase is encrypted, but the server certificate is
  not verified. This is the same as Supabase's own `sslmode=require` links.
- The tool only reads from your database, apart from `init` and "Send again".
  Use a database user with only the access you are comfortable with.

## Limits

- Supabase's reply table (`net._http_response`) is internal and may change
  between versions. Tested with `pg_net` 0.20.
- The history file grows over time. Delete the `.pgnet-lens` folder to start
  fresh.
- Only requests recorded with `pgnet_lens.http_post` (or `http_get`,
  `http_delete`) can be sent again.

## Development

```bash
npm install
npm test
```

Tests need no database. Issues and pull requests are welcome.

## License

MIT