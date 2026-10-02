-- Migration 009 (D97): real callback booking. Slots are Monday-Friday, 09:00-16:30 Africa/Lagos
-- (WAT, UTC+1, no DST), every 30 minutes; one open escalation per slot.
--
--   1. escalations.callback_slot timestamptz (null = no callback booked).
--   2. A CHECK: a slot is a weekday, 09:00-16:30 Lagos time, on :00 or :30, with no seconds.
--   3. A partial UNIQUE index: one OPEN ('open' or 'in progress') escalation per slot. Closing an
--      escalation frees its slot.
--   4. create_escalation_with_ticket v4: p_callback_slot (must be at least 30 minutes ahead);
--      call_booked = (callback_slot is not null) for new rows; a taken slot returns slot_taken =
--      true (nothing written) instead of raising; enrichment fills a missing callback_slot like
--      the other fields (never overwriting one). All earlier guards kept (active attempt, scope,
--      idempotency, the outbox in the same transaction).
--   5. next_free_slots(p_from, p_count): the next free valid slots (read-only).
--
-- Same conventions: security invoker, search_path pinned, EXECUTE only for service_role.

begin;

alter table escalations add column callback_slot timestamptz;

alter table escalations add constraint escalations_callback_slot_valid check (
  callback_slot is null or (
    extract(isodow from (callback_slot at time zone 'Africa/Lagos')) between 1 and 5
    and (callback_slot at time zone 'Africa/Lagos')::time between time '09:00' and time '16:30'
    and extract(minute from (callback_slot at time zone 'Africa/Lagos')) in (0, 30)
    and extract(second from (callback_slot at time zone 'Africa/Lagos')) = 0
  )
);

create unique index escalations_callback_slot_open_idx on escalations (callback_slot)
  where callback_slot is not null and status in ('open', 'in progress');

comment on column escalations.callback_slot is
  'D97: the booked callback slot (Mon-Fri 09:00-16:30 Africa/Lagos, :00/:30). One open escalation per slot.';

-- v4: the return type gains slot_taken, so the function is replaced (arguments: v3 + p_callback_slot).
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
  p_customer_id                text        default null,
  p_transaction_id             text        default null,
  p_payout_id                  text        default null,
  p_call_booked                boolean     default false,
  p_preferred_time_text        text        default null,
  p_callback_slot              timestamptz default null
)
returns table (ticket_id text, escalation_id text, created boolean, updated boolean, slot_taken boolean)
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
  v_constraint    text;
begin
  perform require_active_attempt(p_attempt_id);
  perform check_attempt_scope(p_attempt_id, p_conversation_id);

  if p_callback_slot is not null and p_callback_slot < now() + interval '30 minutes' then
    raise exception 'CALLBACK_SLOT_PAST: a callback slot must be at least 30 minutes ahead' using errcode = 'P0001';
  end if;

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
      -- Enrichment (D82, D97): fill ONLY missing fields; a set value is never overwritten.
      select * into v_row from escalations e where e.escalation_id = v_escalation_id for update;
      if v_row.callback_slot is null and p_callback_slot is not null then
        begin
          update escalations e
             set callback_slot = p_callback_slot, call_booked = true,
                 preferred_time_text = coalesce(e.preferred_time_text, v_time)
           where e.escalation_id = v_escalation_id and e.callback_slot is null;
          v_updated := found;
        exception when unique_violation then
          return query select v_row.ticket_id, v_escalation_id, false, false, true;
          return;
        end;
      elsif v_row.preferred_time_text is null and v_time is not null then
        update escalations e set preferred_time_text = v_time
         where e.escalation_id = v_escalation_id and e.preferred_time_text is null;
        v_updated := found;
      end if;
      if v_updated then
        select * into v_row from escalations e where e.escalation_id = v_escalation_id;
        perform queue_notification(p_conversation_id, 'escalation_updated', v_escalation_id,
          'escalation_updated:' || v_escalation_id || case when v_row.callback_slot is not null then ':callback_slot' else ':preferred_time' end,
          jsonb_build_object('escalation_id', v_escalation_id, 'ticket_id', v_row.ticket_id,
                             'category', v_row.category, 'customer_id', v_row.customer_id,
                             'user_email', v_row.user_email, 'preferred_time_text', v_row.preferred_time_text,
                             'callback_slot', v_row.callback_slot, 'call_booked', v_row.call_booked));
      end if;
      return query select v_row.ticket_id, v_escalation_id, false, v_updated, false;
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
         category, reason, call_booked, preferred_time_text, callback_slot, idempotency_key)
      values
        (p_conversation_id, v_ticket_id, p_customer_id, p_user_name, p_user_email,
         p_category, p_reason, p_callback_slot is not null, v_time, p_callback_slot,
         p_escalation_idempotency_key)
      returning e.escalation_id into v_escalation_id;

      perform queue_notification(p_conversation_id, 'escalation_created', v_escalation_id,
        'escalation_created:' || v_escalation_id,
        jsonb_build_object('escalation_id', v_escalation_id, 'ticket_id', v_ticket_id,
                           'category', p_category, 'priority', 'high', 'customer_id', p_customer_id,
                           'reason', left(p_reason, 500), 'user_email', p_user_email,
                           'preferred_time_text', v_time, 'callback_slot', p_callback_slot,
                           'call_booked', p_callback_slot is not null));

      return query select v_ticket_id, v_escalation_id, true, false, false;
      return;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'escalations_callback_slot_open_idx' then
        -- The slot was taken (by another call): nothing was written (the ticket insert is rolled
        -- back with this block). Not an error: the caller is offered other slots.
        return query select null::text, null::text, false, false, true;
        return;
      end if;
      if attempt = 2 then
        raise;
      end if;
      v_escalation_id := null;
    end;
  end loop;
end;
$$;

-- The next free valid slots from p_from (never earlier than 30 minutes from now), up to 21 days ahead.
-- Lagos is UTC+1 with no DST, so 30-minute steps on the UTC epoch are 30-minute steps in Lagos.
create function next_free_slots(p_from timestamptz, p_count integer)
returns setof timestamptz
language sql
stable
security invoker
set search_path = public
as $$
  with start as (
    select to_timestamp(ceil(extract(epoch from greatest(coalesce(p_from, now()), now() + interval '30 minutes')) / 1800) * 1800) as t
  )
  select s
    from start, generate_series(start.t, start.t + interval '21 days', interval '30 minutes') as s
   where extract(isodow from (s at time zone 'Africa/Lagos')) between 1 and 5
     and (s at time zone 'Africa/Lagos')::time between time '09:00' and time '16:30'
     and not exists (
       select 1 from escalations e
        where e.callback_slot = s and e.status in ('open', 'in progress'))
   order by s
   limit greatest(1, least(coalesce(p_count, 3), 50));
$$;

revoke execute on function create_escalation_with_ticket(text, text, text, text, text, text, text, text, text, text, text, text, boolean, text, timestamptz) from public, anon, authenticated;
revoke execute on function next_free_slots(timestamptz, integer) from public, anon, authenticated;
grant execute on function create_escalation_with_ticket(text, text, text, text, text, text, text, text, text, text, text, text, boolean, text, timestamptz) to service_role;
grant execute on function next_free_slots(timestamptz, integer) to service_role;

commit;
