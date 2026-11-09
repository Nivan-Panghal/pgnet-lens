// The optional "remember what was sent" setup. Nothing here runs unless the
// user runs `pgnet-lens init` and confirms.

export const CAPTURE_SUMMARY = [
  "Creates a private area called pgnet_lens in your database.",
  "Creates a table pgnet_lens.requests that remembers each request you send",
  "  (address, method, headers, data).",
  "Creates helper functions pgnet_lens.http_post / http_get / http_delete.",
  "  They work exactly like net.http_post / net.http_get / net.http_delete,",
  "  but also remember the request. Use them in place of the net.* ones.",
  "Creates pgnet_lens.resend(id) to send a remembered request again.",
  "Creates pgnet_lens.cleanup() to delete old remembered requests.",
  "Only the database owner and service_role can use any of it.",
  "Does NOT change any of your existing tables, triggers or webhooks.",
];

export const CAPTURE_SQL = `-- pgnet-lens: optional "remember what was sent" layer.
-- Safe to run more than once.

create schema if not exists pgnet_lens;

create table if not exists pgnet_lens.requests (
  request_id bigint primary key,
  created_at timestamptz not null default now(),
  method text not null,
  url text not null,
  params jsonb,
  headers jsonb,
  body jsonb,
  timeout_milliseconds integer
);

create index if not exists requests_created_at_idx
  on pgnet_lens.requests (created_at);

-- Nobody can read this table through the public web API.
alter table pgnet_lens.requests enable row level security;

create or replace function pgnet_lens.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer default 5000
) returns bigint
language plpgsql
as $fn$
declare
  rid bigint;
begin
  rid := net.http_post(
    url := url,
    body := body,
    params := params,
    headers := headers,
    timeout_milliseconds := timeout_milliseconds
  );
  insert into pgnet_lens.requests
    (request_id, method, url, params, headers, body, timeout_milliseconds)
  values
    (rid, 'POST', url, params, headers, body, timeout_milliseconds)
  on conflict (request_id) do nothing;
  return rid;
end;
$fn$;

create or replace function pgnet_lens.http_get(
  url text,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb,
  timeout_milliseconds integer default 5000
) returns bigint
language plpgsql
as $fn$
declare
  rid bigint;
begin
  rid := net.http_get(
    url := url,
    params := params,
    headers := headers,
    timeout_milliseconds := timeout_milliseconds
  );
  insert into pgnet_lens.requests
    (request_id, method, url, params, headers, body, timeout_milliseconds)
  values
    (rid, 'GET', url, params, headers, null, timeout_milliseconds)
  on conflict (request_id) do nothing;
  return rid;
end;
$fn$;

create or replace function pgnet_lens.http_delete(
  url text,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb,
  timeout_milliseconds integer default 5000,
  body jsonb default null
) returns bigint
language plpgsql
as $fn$
declare
  rid bigint;
begin
  rid := net.http_delete(
    url := url,
    params := params,
    headers := headers,
    timeout_milliseconds := timeout_milliseconds,
    body := body
  );
  insert into pgnet_lens.requests
    (request_id, method, url, params, headers, body, timeout_milliseconds)
  values
    (rid, 'DELETE', url, params, headers, body, timeout_milliseconds)
  on conflict (request_id) do nothing;
  return rid;
end;
$fn$;

create or replace function pgnet_lens.cleanup(
  older_than interval default interval '7 days'
) returns integer
language plpgsql
as $fn$
declare
  n integer;
begin
  delete from pgnet_lens.requests where created_at < now() - older_than;
  get diagnostics n = row_count;
  return n;
end;
$fn$;

create or replace function pgnet_lens.resend(original_id bigint)
returns bigint
language plpgsql
as $fn$
declare
  r pgnet_lens.requests%rowtype;
  rid bigint;
begin
  select * into r from pgnet_lens.requests where request_id = original_id;
  if not found then
    raise exception 'No remembered request with id %', original_id;
  end if;

  if r.method = 'POST' then
    rid := pgnet_lens.http_post(
      r.url,
      coalesce(r.body, '{}'::jsonb),
      coalesce(r.params, '{}'::jsonb),
      coalesce(r.headers, '{"Content-Type": "application/json"}'::jsonb),
      coalesce(r.timeout_milliseconds, 5000)
    );
  elsif r.method = 'GET' then
    rid := pgnet_lens.http_get(
      r.url,
      coalesce(r.params, '{}'::jsonb),
      coalesce(r.headers, '{}'::jsonb),
      coalesce(r.timeout_milliseconds, 5000)
    );
  elsif r.method = 'DELETE' then
    rid := pgnet_lens.http_delete(
      r.url,
      coalesce(r.params, '{}'::jsonb),
      coalesce(r.headers, '{}'::jsonb),
      coalesce(r.timeout_milliseconds, 5000),
      r.body
    );
  else
    raise exception 'Cannot send a % request again', r.method;
  end if;
  return rid;
end;
$fn$;

-- Lock it down: only the owner and service_role may use it.
revoke all on schema pgnet_lens from public;
revoke all on table pgnet_lens.requests from public;
revoke all on all functions in schema pgnet_lens from public;

do $lock$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema pgnet_lens from %I', r);
      execute format('revoke all on table pgnet_lens.requests from %I', r);
      execute format('revoke all on all functions in schema pgnet_lens from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema pgnet_lens to service_role;
    grant select, insert, delete on pgnet_lens.requests to service_role;
    grant execute on all functions in schema pgnet_lens to service_role;
  end if;
end
$lock$;
`;

export const REMOVE_SQL = `drop schema if exists pgnet_lens cascade;`;