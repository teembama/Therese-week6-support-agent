-- Migration 008 (D88): call passes without a Supabase login (L1b). The call page offers two paths:
--   form_customer: the caller gives name + email; the backend matches BOTH to one customer and
--                  issues a pass carrying that customer_id (identification, not authentication).
--   guest:         a pass with no customer; the call behaves exactly as before login existed.
--   login:         the earlier Supabase-login passes (L1, D86), kept for existing rows.
--
--   1. call_passes: user_id and role become nullable; a source column; a shape check per source.
--   2. apply_call_pass_identity(conversation, channel, caller): after redeem_call_pass (007,
--      unchanged) links a pass, a pass WITH a customer sets the conversation's verified customer
--      from the PASS ROW (never from the caller or the model), creating the conversation row if
--      the first turn hasn't yet, and logs one identity_verified event. The tools then treat the
--      call as verified from turn 0, and D74 refuses a spoken claim to be someone else. A
--      conversation already verified as a different customer raises VERIFIED_CUSTOMER_CONFLICT
--      (can't happen: one pass per conversation, and the pass is applied before any turn runs).
--
-- Same conventions: security invoker, search_path pinned, EXECUTE only for service_role.

begin;

alter table call_passes alter column user_id drop not null;
alter table call_passes alter column role drop not null;
alter table call_passes add column source text not null default 'login'
  check (source in ('form_customer', 'guest', 'login'));
alter table call_passes add constraint call_passes_source_shape check (
     (source = 'login'         and user_id is not null and role is not null)
  or (source = 'form_customer' and user_id is null and role is null and customer_id is not null)
  or (source = 'guest'         and user_id is null and role is null and customer_id is null)
);

create function apply_call_pass_identity(p_conversation_id text, p_channel text, p_caller text)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_customer text;
  v_current  text;
begin
  select c.customer_id into v_customer
    from call_passes c
   where c.conversation_id = p_conversation_id and c.used_at is not null and c.source = 'form_customer';
  if v_customer is null then
    return null;
  end if;

  insert into conversations (conversation_id, channel, caller)
  values (p_conversation_id, p_channel, p_caller)
  on conflict (conversation_id) do nothing;

  select verified_customer_id into v_current from conversations where conversation_id = p_conversation_id for update;
  if v_current is not null and v_current <> v_customer then
    raise exception 'VERIFIED_CUSTOMER_CONFLICT: conversation % is already verified as another customer', p_conversation_id
      using errcode = 'P0001';
  end if;
  if v_current is null then
    update conversations set verified_customer_id = v_customer where conversation_id = p_conversation_id;
    insert into conversation_events (conversation_id, turn_index, event_type, summary, metadata)
    values (p_conversation_id, 0, 'identity_verified',
            'Identified by the call page form (name and email matched one customer)',
            jsonb_build_object('source', 'form_customer', 'customer_id', v_customer));
  end if;
  return v_customer;
end;
$$;

revoke execute on function apply_call_pass_identity(text, text, text) from public, anon, authenticated;
grant execute on function apply_call_pass_identity(text, text, text) to service_role;

commit;
