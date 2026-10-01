-- Migration 006 (D82): escalation enrichment, the escalation_updated event, and the notification
-- outbox for team notifications (the Discord sender is NOT part of this migration).
--
--   1. create_escalation_with_ticket v3: when the escalation already exists (same idempotency key,
--      e.g. created by a speculative attempt that was later replaced), fill ONLY its missing
--      fields from this call - preferred_time_text when it is null, and call_booked = true with it -
--      never overwriting a set value. Still inside the attempt guard. Returns `updated`.
--      (user_email is NOT NULL, so it is never missing and never enriched.)
--   2. conversation_events: event_type 'escalation_updated'.
--   3. notification_outbox: one row per team notification (ticket created, escalation created,
--      escalation updated), written in the SAME transaction as the ticket/escalation, so a
--      notification exists exactly when the record committed. dedupe_key is unique: a retry or a
--      duplicate call never queues a second message. No amounts, no support notes: the payload is
--      built only from the ticket/escalation row.
--
-- Same conventions as 005: security invoker, search_path pinned, EXECUTE revoked from
-- public/anon/authenticated and granted to service_role, RLS on (no policies).

begin;

-- 2. Event type ------------------------------------------------------------------------------------
alter table conversation_events drop constraint conversation_events_event_type_check;
alter table conversation_events add constraint conversation_events_event_type_check
  check (event_type in ('identity_verified', 'identity_failed', 'identity_ambiguous', 'lookup_performed',
                        'clarification_requested', 'escalation_created', 'escalation_updated', 'ticket_created',
                        'declined_unsupported', 'gate_blocked', 'other'));

-- 3. Notification outbox --------------------------------------------------------------------------
create table notification_outbox (
  id              bigint generated always as identity primary key,
  conversation_id text not null references conversations (conversation_id),
  kind            text not null check (kind in ('ticket_created', 'escalation_created', 'escalation_updated')),
  ref_id          text not null,                -- the ticket_id or escalation_id
  dedupe_key      text not null unique,         -- e.g. 'escalation_created:ESC-1A2B3C4D'
  payload         jsonb not null
    check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 4096),
  status          text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts        integer not null default 0 check (attempts >= 0),
  last_error      text check (last_error is null or char_length(last_error) <= 500),
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  check ((status = 'sent') = (sent_at is not null))
);
create index notification_outbox_pending_idx on notification_outbox (created_at) where status = 'pending';
alter table notification_outbox enable row level security;

comment on table notification_outbox is
  'Team notifications (D82), queued in the same transaction as the ticket/escalation they describe. '
  'Never contains amounts or support notes. dedupe_key unique: one message per event.';

-- Queue a notification; a repeat of the same dedupe_key is a no-op.
create function queue_notification(p_conversation_id text, p_kind text, p_ref_id text, p_dedupe_key text, p_payload jsonb)
returns void
language sql
security invoker
set search_path = public
as $$
  insert into notification_outbox (conversation_id, kind, ref_id, dedupe_key, payload)
  values (p_conversation_id, p_kind, p_ref_id, p_dedupe_key, p_payload)
  on conflict (dedupe_key) do nothing;
$$;

-- a. Support ticket: unchanged from 005 except that a NEW ticket queues 'ticket_created'.
create or replace function create_support_ticket_guarded(
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

      perform queue_notification(p_conversation_id, 'ticket_created', v_ticket_id, 'ticket_created:' || v_ticket_id,
        jsonb_build_object('ticket_id', v_ticket_id, 'category', p_category, 'priority', v_priority,
                           'customer_id', p_customer_id, 'transaction_id', p_transaction_id,
                           'payout_id', p_payout_id, 'summary', left(p_summary, 500)));

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

-- b. Escalation with ticket, v3. The return type gains `updated`, so the function is replaced
--    (same arguments as v2).
drop function create_escalation_with_ticket(
  text, text, text, text, text, text, text, text, text, text, text, text, boolean, text
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
returns table (ticket_id text, escalation_id text, created boolean, updated boolean)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_ticket_id     text;
  v_escalation_id text;
  v_time          text := nullif(btrim(coalesce(p_preferred_time_text, '')), '');
  v_updated       boolean := false;
  v_row           escalations%rowtype;
begin
  perform require_active_attempt(p_attempt_id);
  perform check_attempt_scope(p_attempt_id, p_conversation_id);

  for attempt in 1..2 loop
    -- Existing escalation (same key, or reached through its ticket's key).
    select e.escalation_id into v_escalation_id
      from escalations e where e.idempotency_key = p_escalation_idempotency_key;
    if not found then
      select t.ticket_id into v_ticket_id
        from support_tickets t where t.idempotency_key = p_ticket_idempotency_key;
      if found then
        select e.escalation_id into v_escalation_id
          from escalations e where e.ticket_id = v_ticket_id order by e.created_at limit 1;
        if not found then
          raise exception 'ESCALATION_KEY_CONFLICT: ticket idempotency key % belongs to ticket % which has no escalation',
            p_ticket_idempotency_key, v_ticket_id
            using errcode = 'P0001';
        end if;
      end if;
    end if;

    if v_escalation_id is not null then
      -- Enrichment (D82): fill ONLY missing fields; a set value is never overwritten. The row is
      -- locked so two concurrent enrichments can't interleave.
      select * into v_row from escalations e where e.escalation_id = v_escalation_id for update;
      if v_row.preferred_time_text is null and v_time is not null then
        update escalations e
           set preferred_time_text = v_time, call_booked = true
         where e.escalation_id = v_escalation_id and e.preferred_time_text is null;
        v_updated := found;
      end if;
      if v_updated then
        perform queue_notification(p_conversation_id, 'escalation_updated', v_escalation_id,
          'escalation_updated:' || v_escalation_id || ':preferred_time',
          jsonb_build_object('escalation_id', v_escalation_id, 'ticket_id', v_row.ticket_id,
                             'category', v_row.category, 'customer_id', v_row.customer_id,
                             'user_email', v_row.user_email, 'preferred_time_text', v_time,
                             'call_booked', true));
      end if;
      return query select v_row.ticket_id, v_escalation_id, false, v_updated;
      return;
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
         p_category, p_reason, coalesce(p_call_booked, false) and v_time is not null, v_time,
         p_escalation_idempotency_key)
      returning e.escalation_id into v_escalation_id;

      perform queue_notification(p_conversation_id, 'escalation_created', v_escalation_id,
        'escalation_created:' || v_escalation_id,
        jsonb_build_object('escalation_id', v_escalation_id, 'ticket_id', v_ticket_id,
                           'category', p_category, 'priority', 'high', 'customer_id', p_customer_id,
                           'reason', left(p_reason, 500), 'user_email', p_user_email,
                           'preferred_time_text', v_time, 'call_booked', coalesce(p_call_booked, false) and v_time is not null));

      return query select v_ticket_id, v_escalation_id, true, false;
      return;
    exception when unique_violation then
      if attempt = 2 then
        raise;
      end if;
      v_escalation_id := null;
    end;
  end loop;
end;
$$;

-- Privileges: service_role only (as in 005).
revoke all on notification_outbox from public, anon, authenticated;
revoke execute on function queue_notification(text, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function create_support_ticket_guarded(text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function create_escalation_with_ticket(text, text, text, text, text, text, text, text, text, text, text, text, boolean, text) from public, anon, authenticated;
grant execute on function queue_notification(text, text, text, text, jsonb) to service_role;
grant execute on function create_support_ticket_guarded(text, text, text, text, text, text, text, text) to service_role;
grant execute on function create_escalation_with_ticket(text, text, text, text, text, text, text, text, text, text, text, text, boolean, text) to service_role;
grant select, insert, update on notification_outbox to service_role;

commit;
