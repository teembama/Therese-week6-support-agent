-- Migration 007 (D86): one-time call passes for enforced customer login (L1), with the customer
-- mapping snapshot used by L3.
--
--   1. call_passes: one row per pass issued by POST /calls/pass to a logged-in user (role customer
--      or staff, from Supabase Auth app_metadata, checked by the backend). Only the SHA-256 of the
--      pass is stored; the pass itself exists only in the browser and in the call's
--      variableValues. A pass expires 5 minutes after issue (database clock) and can be redeemed
--      once, by one conversation.
--   2. redeem_call_pass(conversation_id, pass_hash): called by the backend on every turn.
--      - The conversation is already linked to a redeemed pass -> 'ok' (later turns, and Vapi's
--        speculative retries of turn 0, even without a pass).
--      - No pass -> 'missing'; unknown hash -> 'invalid'; used by another conversation ->
--        'reused'; past expires_at -> 'expired'.
--      - Otherwise mark it used and link it to this conversation -> 'ok'.
--      The pass row is locked FOR UPDATE, so two concurrent redeems of one pass can't both link
--      it; a concurrent redeem by the SAME conversation sees the link and gets 'ok'.
--      Returns the pass's user_id, role and customer_id (L3: the account mapped to the login).
--
-- Same conventions as 005/006: security invoker, search_path pinned, EXECUTE only for
-- service_role, RLS on with no policies (the browser never reads tables).

begin;

create table call_passes (
  id              bigint generated always as identity primary key,
  pass_hash       text not null unique check (pass_hash ~ '^[0-9a-f]{64}$'),
  user_id         uuid not null,                       -- auth.users.id (no cross-schema FK)
  role            text not null check (role in ('customer', 'staff')),
  customer_id     text references customers (customer_id), -- app_metadata.customer_id at issue (L3), or null
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '5 minutes',
  used_at         timestamptz,
  conversation_id text,
  check (expires_at > created_at and expires_at <= created_at + interval '10 minutes'),
  check ((used_at is null) = (conversation_id is null))
);
-- One pass per conversation.
create unique index call_passes_conversation_idx on call_passes (conversation_id) where conversation_id is not null;
create index call_passes_user_idx on call_passes (user_id, created_at);
alter table call_passes enable row level security;

comment on table call_passes is
  'One-time call passes (D86): SHA-256 only, 5-minute expiry, redeemed once by one conversation.';

create function redeem_call_pass(p_conversation_id text, p_pass_hash text)
returns table (status text, user_id uuid, role text, customer_id text)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  r call_passes%rowtype;
begin
  if p_conversation_id is null or btrim(p_conversation_id) = '' then
    return query select 'missing'::text, null::uuid, null::text, null::text;
    return;
  end if;

  -- Already linked: later turns and speculative retries need no pass.
  select * into r from call_passes c where c.conversation_id = p_conversation_id;
  if found then
    return query select 'ok'::text, r.user_id, r.role, r.customer_id;
    return;
  end if;

  if p_pass_hash is null or p_pass_hash !~ '^[0-9a-f]{64}$' then
    return query select (case when p_pass_hash is null then 'missing' else 'invalid' end)::text, null::uuid, null::text, null::text;
    return;
  end if;

  select * into r from call_passes c where c.pass_hash = p_pass_hash for update;
  if not found then
    return query select 'invalid'::text, null::uuid, null::text, null::text;
    return;
  end if;
  if r.used_at is not null then
    -- A concurrent redeem by this same conversation won the lock first: that's this call.
    return query select (case when r.conversation_id = p_conversation_id then 'ok' else 'reused' end)::text,
                        case when r.conversation_id = p_conversation_id then r.user_id end,
                        case when r.conversation_id = p_conversation_id then r.role end,
                        case when r.conversation_id = p_conversation_id then r.customer_id end;
    return;
  end if;
  if r.expires_at <= now() then
    return query select 'expired'::text, null::uuid, null::text, null::text;
    return;
  end if;

  begin
    update call_passes c set used_at = now(), conversation_id = p_conversation_id where c.id = r.id;
  exception when unique_violation then
    -- This conversation was linked meanwhile by a different pass: it is a logged-in call.
    select * into r from call_passes c where c.conversation_id = p_conversation_id;
    return query select 'ok'::text, r.user_id, r.role, r.customer_id;
    return;
  end;
  return query select 'ok'::text, r.user_id, r.role, r.customer_id;
end;
$$;

revoke all on call_passes from public, anon, authenticated;
revoke execute on function redeem_call_pass(text, text) from public, anon, authenticated;
grant select, insert, update on call_passes to service_role;
grant execute on function redeem_call_pass(text, text) to service_role;

commit;
