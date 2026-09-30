-- 005_guarded_writes_and_events.sql
-- Phase 2, Batch 2B (docs/decisions.md D29, D38).
--   1. Guarded write functions. Each calls require_active_attempt(p_attempt_id) FIRST, in the
--      same transaction as its write, then checks that the attempt belongs to the conversation
--      (and turn) being written. The pre-guard create_escalation_with_ticket is DROPPED so it
--      can't be used to bypass the guard.
--   2. conversation_events: important agent actions and decisions, one row per event.
--   3. Stale attempts: an 'active' attempt older than 60 s is failed ('stale') before a new
--      attempt for the same turn starts.
--   4. abandon_stale_conversations(): 'active' conversations with no activity for 15+ minutes.
--   5. conversations.ended_reason and vapi_metrics (filled by the Vapi webhook in 2D).
-- Every new function: EXECUTE revoked from public/anon/authenticated, granted to service_role.

begin;

-- ---------------------------------------------------------------------------
-- 5. New conversation columns
-- ---------------------------------------------------------------------------
alter table conversations
  add column ended_reason text,
  add column vapi_metrics jsonb;

comment on column conversations.ended_reason is 'Vapi endedReason, from the end-of-call webhook (Batch 2D).';
comment on column conversations.vapi_metrics is 'Vapi end-of-call metrics (cost, durations), from the webhook (Batch 2D).';

-- ---------------------------------------------------------------------------
-- 2. conversation_events
-- ---------------------------------------------------------------------------
create table conversation_events (
  id              bigint generated always as identity primary key,
  conversation_id text not null references conversations (conversation_id),
  turn_index      integer not null check (turn_index >= 0),
  attempt_id      text references turn_attempts (attempt_id),
  event_type      text not null
    check (event_type in ('identity_verified', 'identity_failed', 'identity_ambiguous', 'lookup_performed',
                          'clarification_requested', 'escalation_created', 'ticket_created',
                          'declined_unsupported', 'gate_blocked', 'other')),
  summary         text not null check (char_length(summary) between 1 and 500),
  metadata        jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 4096),
  created_at      timestamptz not null default now()
);

create index conversation_events_conversation_turn_idx on conversation_events (conversation_id, turn_index);
create index conversation_events_attempt_id_idx on conversation_events (attempt_id);

alter table conversation_events enable row level security;

-- ---------------------------------------------------------------------------
-- 1. Guarded writes
-- ---------------------------------------------------------------------------

-- Scope check, called right AFTER require_active_attempt: the attempt must belong to the
-- conversation (and, when given, the turn) being written. The MCP server passes both from the
-- same spawn environment (D9), so a mismatch is a bug; nothing is written.
create function check_attempt_scope(p_attempt_id text, p_conversation_id text, p_turn_index integer default null)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_conv text;
  v_idx  integer;
begin
  select conversation_id, turn_index into v_conv, v_idx from turn_attempts where attempt_id = p_attempt_id;
  if v_conv is distinct from p_conversation_id or (p_turn_index is not null and v_idx is distinct from p_turn_index) then
    raise exception 'ATTEMPT_SCOPE_MISMATCH: attempt % does not belong to conversation % turn %',
      p_attempt_id, p_conversation_id, coalesce(p_turn_index::text, '(any)')
      using errcode = 'P0001';
  end if;
end;
$$;

-- a. Support ticket. Priority is computed here (D1): 'high' if the linked transaction or payout
--    is 'failed' or 'review required', otherwise 'normal'. An existing idempotency key returns
--    the existing ticket with created = false (its original fields are kept).
create function create_support_ticket_guarded(
  p_attempt_id      text,
  p_conversation_id text,
  p_customer_id     text,
  p_transaction_id  text,
  p_payout_id       text,
  p_category        text,
  p_summary         text,
  p_idempotency_key text
)
returns table (ticket_id text, priority text, status text, created boolean)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_ticket_id text;
  v_priority  text;
  v_status    text;
begin
  perform require_active_attempt(p_attempt_id);
  perform check_attempt_scope(p_attempt_id, p_conversation_id);

  for attempt in 1..2 loop
    select t.ticket_id, t.priority, t.status into v_ticket_id, v_priority, v_status
      from support_tickets t where t.idempotency_key = p_idempotency_key;
    if found then
      return query select v_ticket_id, v_priority, v_status, false;
      return;
    end if;

    v_priority := case
      when exists (select 1 from transactions x where x.transaction_id = p_transaction_id
                     and x.status in ('failed', 'review required'))
        or exists (select 1 from payouts p where p.payout_id = p_payout_id
                     and p.status in ('failed', 'review required'))
      then 'high' else 'normal' end;

    begin
      insert into support_tickets as t
        (conversation_id, customer_id, transaction_id, payout_id, category, priority, summary, idempotency_key)
      values
        (p_conversation_id, p_customer_id, p_transaction_id, p_payout_id, p_category, v_priority, p_summary, p_idempotency_key)
      returning t.ticket_id, t.status into v_ticket_id, v_status;
      return query select v_ticket_id, v_priority, v_status, true;
      return;
    exception when unique_violation then
      -- Lost a race with an identical concurrent call: loop once to return the winner's row.
      if attempt = 2 then
        raise;
      end if;
    end;
  end loop;
end;
$$;

-- b. Escalation with ticket, v2: 001's function plus the guard. The old signature is dropped.
drop function create_escalation_with_ticket(
  text, text, text, text, text, text, text, text, text, text, text, boolean, text
);

create function create_escalation_with_ticket(
  p_attempt_id                 text,
  p_conversation_id            text,
  p_ticket_idempotency_key     text,
  p_escalation_idempotency_key text,
  p_category                   text,
  p_ticket_summary             text,
  p_reason                     text,
  p_user_name                  text,
  p_user_email                 text,
  p_customer_id                text    default null,
  p_transaction_id             text    default null,
  p_payout_id                  text    default null,
  p_call_booked                boolean default false,
  p_preferred_time_text        text    default null
)
returns table (ticket_id text, escalation_id text, created boolean)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_ticket_id     text;
  v_escalation_id text;
begin
  perform require_active_attempt(p_attempt_id);
  perform check_attempt_scope(p_attempt_id, p_conversation_id);

  -- From here on, identical to 001 (docs/decisions.md D11).
  for attempt in 1..2 loop
    select e.ticket_id, e.escalation_id
      into v_ticket_id, v_escalation_id
      from escalations e
     where e.idempotency_key = p_escalation_idempotency_key;
    if found then
      return query select v_ticket_id, v_escalation_id, false;
      return;
    end if;

    select t.ticket_id
      into v_ticket_id
      from support_tickets t
     where t.idempotency_key = p_ticket_idempotency_key;
    if found then
      select e.escalation_id
        into v_escalation_id
        from escalations e
       where e.ticket_id = v_ticket_id
       order by e.created_at
       limit 1;
      if found then
        return query select v_ticket_id, v_escalation_id, false;
        return;
      end if;
      raise exception 'ESCALATION_KEY_CONFLICT: ticket idempotency key % belongs to ticket % which has no escalation',
        p_ticket_idempotency_key, v_ticket_id
        using errcode = 'P0001';
    end if;

    begin
      insert into support_tickets as t
        (conversation_id, customer_id, transaction_id, payout_id,
         category, priority, summary, idempotency_key)
      values
        (p_conversation_id, p_customer_id, p_transaction_id, p_payout_id,
         p_category, 'high', p_ticket_summary, p_ticket_idempotency_key)
      returning t.ticket_id into v_ticket_id;

      insert into escalations as e
        (conversation_id, ticket_id, customer_id, user_name, user_email,
         category, reason, call_booked, preferred_time_text, idempotency_key)
      values
        (p_conversation_id, v_ticket_id, p_customer_id, p_user_name, p_user_email,
         p_category, p_reason, coalesce(p_call_booked, false), p_preferred_time_text,
         p_escalation_idempotency_key)
      returning e.escalation_id into v_escalation_id;

      return query select v_ticket_id, v_escalation_id, true;
      return;
    exception when unique_violation then
      if attempt = 2 then
        raise;
      end if;
    end;
  end loop;
end;
$$;

-- c. Verified customer for the conversation. Re-verifying the same customer is a no-op; a
--    DIFFERENT customer than the one already verified is refused (P0001
--    VERIFIED_CUSTOMER_CONFLICT): one call acts for one customer (D38).
create function set_verified_customer(p_attempt_id text, p_conversation_id text, p_customer_id text)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_current text;
begin
  perform require_active_attempt(p_attempt_id);
  perform check_attempt_scope(p_attempt_id, p_conversation_id);

  select verified_customer_id into v_current from conversations where conversation_id = p_conversation_id for update;
  if not found then
    raise exception 'set_verified_customer: unknown conversation %', p_conversation_id;
  end if;
  if v_current is not null and v_current <> p_customer_id then
    raise exception 'VERIFIED_CUSTOMER_CONFLICT: conversation % is already verified as another customer', p_conversation_id
      using errcode = 'P0001';
  end if;
  update conversations set verified_customer_id = p_customer_id where conversation_id = p_conversation_id;
  return p_customer_id;
end;
$$;

-- d. Conversation event (log_conversation_event and the tools' own events). Guarded like every
--    other model-initiated write: a superseded attempt records nothing.
create function log_conversation_event_guarded(
  p_attempt_id      text,
  p_conversation_id text,
  p_turn_index      integer,
  p_event_type      text,
  p_summary         text,
  p_metadata        jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id bigint;
begin
  perform require_active_attempt(p_attempt_id);
  perform check_attempt_scope(p_attempt_id, p_conversation_id, p_turn_index);
  insert into conversation_events (conversation_id, turn_index, attempt_id, event_type, summary, metadata)
  values (p_conversation_id, p_turn_index, p_attempt_id, p_event_type, p_summary, coalesce(p_metadata, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. begin_turn_attempt: 003's function plus the stale rule (step 2b below).
-- ---------------------------------------------------------------------------
create or replace function begin_turn_attempt(
  p_conversation_id text,
  p_channel         text,
  p_caller          text,
  p_turn_index      integer,
  p_attempt_id      text,
  p_transcript_hash text,
  p_user_transcript text
)
returns table (action text, assistant_response text, answer_type text, replaced_attempt_ids text[])
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_response text;
  v_type     text;
  v_hash     text;
  v_replaced text[];
begin
  insert into conversations (conversation_id, channel, caller)
  values (p_conversation_id, p_channel, p_caller)
  on conflict (conversation_id) do nothing;

  select t.assistant_response, t.answer_type, t.transcript_hash
    into v_response, v_type, v_hash
    from conversation_turns t
   where t.conversation_id = p_conversation_id and t.turn_index = p_turn_index;
  if found and v_response is not null and v_hash = p_transcript_hash then
    return query select 'replay'::text, v_response, v_type, '{}'::text[];
    return;
  end if;

  -- 2b. Stale: an attempt still 'active' after 60 s is a crashed or lost backend, not a live
  -- request (the turn hard cap is far shorter). It is failed, not 'replaced'.
  update turn_attempts a
     set status = 'failed',
         status_reason = 'stale',
         ended_at = now()
   where a.conversation_id = p_conversation_id
     and a.turn_index = p_turn_index
     and a.status = 'active'
     and a.started_at < now() - interval '60 seconds';

  with r as (
    update turn_attempts a
       set status = 'replaced',
           status_reason = case when a.status = 'aborted'
                                then 'aborted by the client, then replaced by a request with a different transcript'
                                else 'replaced by a newer request for the same turn' end,
           replaced_by = p_attempt_id,
           ended_at = coalesce(a.ended_at, now())
     where a.conversation_id = p_conversation_id
       and a.turn_index = p_turn_index
       and (a.status = 'active' or (a.status = 'aborted' and a.transcript_hash <> p_transcript_hash))
    returning a.attempt_id
  )
  select coalesce(array_agg(r.attempt_id), '{}') into v_replaced from r;

  insert into turn_attempts (attempt_id, conversation_id, turn_index, transcript_hash, user_transcript)
  values (p_attempt_id, p_conversation_id, p_turn_index, p_transcript_hash, p_user_transcript);

  return query select 'run'::text, null::text, null::text, v_replaced;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. abandon_stale_conversations: 'active' conversations whose last activity (start, any turn,
--    any attempt start or end) is p_idle_minutes or more ago become 'abandoned', with ended_at
--    set to that last activity. Their still-active attempts are failed ('stale'). ended_reason
--    is left for the Vapi webhook. Returns the number of conversations marked.
-- ---------------------------------------------------------------------------
create function abandon_stale_conversations(p_idle_minutes integer default 15)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer;
begin
  with activity as (
    select c.conversation_id,
           greatest(c.started_at,
                    (select max(t.t_received) from conversation_turns t where t.conversation_id = c.conversation_id),
                    (select max(greatest(a.started_at, coalesce(a.ended_at, a.started_at)))
                       from turn_attempts a where a.conversation_id = c.conversation_id)) as last_activity
      from conversations c
     where c.final_status = 'active'
  ),
  stale as (
    select conversation_id, last_activity from activity
     where last_activity < now() - make_interval(mins => p_idle_minutes)
  ),
  failed_attempts as (
    update turn_attempts a
       set status = 'failed', status_reason = 'stale', ended_at = now()
      from stale s
     where a.conversation_id = s.conversation_id and a.status = 'active'
    returning a.attempt_id
  ),
  marked as (
    update conversations c
       set final_status = 'abandoned',
           ended_at = coalesce(c.ended_at, s.last_activity)
      from stale s
     where c.conversation_id = s.conversation_id and c.final_status = 'active'
    returning c.conversation_id
  )
  select count(*) into v_count from marked;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function check_attempt_scope(text, text, integer) from public, anon, authenticated;
revoke execute on function create_support_ticket_guarded(text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function create_escalation_with_ticket(text, text, text, text, text, text, text, text, text, text, text, text, boolean, text) from public, anon, authenticated;
revoke execute on function set_verified_customer(text, text, text) from public, anon, authenticated;
revoke execute on function log_conversation_event_guarded(text, text, integer, text, text, jsonb) from public, anon, authenticated;
revoke execute on function begin_turn_attempt(text, text, text, integer, text, text, text) from public, anon, authenticated;
revoke execute on function abandon_stale_conversations(integer) from public, anon, authenticated;
grant execute on function check_attempt_scope(text, text, integer) to service_role;
grant execute on function create_support_ticket_guarded(text, text, text, text, text, text, text, text) to service_role;
grant execute on function create_escalation_with_ticket(text, text, text, text, text, text, text, text, text, text, text, text, boolean, text) to service_role;
grant execute on function set_verified_customer(text, text, text) to service_role;
grant execute on function log_conversation_event_guarded(text, text, integer, text, text, jsonb) to service_role;
grant execute on function begin_turn_attempt(text, text, text, integer, text, text, text) to service_role;
grant execute on function abandon_stale_conversations(integer) to service_role;

commit;
