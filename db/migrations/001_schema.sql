-- 001_schema.sql
-- RelayPay support agent: seed tables, runtime tables, knowledge-base chunks.
-- Enum values are exact strings (including spaces) from assets/supabase-schema-and-seed-data.md,
-- assets/escalation-rules.md, and docs/decisions.md (D1).
-- Plain CREATE TABLE on purpose: re-running fails loudly instead of drifting.

begin;

-- ---------------------------------------------------------------------------
-- Seed tables
-- ---------------------------------------------------------------------------

create table customers (
  customer_id    text primary key,
  company_name   text not null,
  contact_name   text not null,
  contact_email  text not null,
  plan           text not null
    check (plan in ('Starter', 'Growth', 'Scale')),
  account_status text not null
    check (account_status in ('active', 'restricted', 'pending verification')),
  region         text not null,
  kyc_status     text not null
    check (kyc_status in ('pending', 'approved', 'review required')),
  support_notes  text
);

create table transactions (
  transaction_id      text primary key,
  customer_id         text not null references customers (customer_id),
  transaction_type    text not null
    check (transaction_type in ('incoming transfer', 'outgoing payout', 'invoice payment')),
  amount              numeric(12,2) not null,
  currency            text not null check (currency ~ '^[A-Z]{3}$'),
  destination_country text,
  status              text not null
    check (status in ('processing', 'completed', 'delayed', 'failed', 'review required')),
  created_at          date not null,
  estimated_arrival   date,
  support_summary     text,
  -- Target for the payouts consistency FK below.
  unique (transaction_id, customer_id)
);

create table payouts (
  payout_id      text primary key,
  transaction_id text not null references transactions (transaction_id),
  customer_id    text not null references customers (customer_id),
  recipient_name text not null,
  amount         numeric(12,2) not null,
  currency       text not null check (currency ~ '^[A-Z]{3}$'),
  status         text not null
    check (status in ('scheduled', 'processing', 'completed', 'failed', 'review required')),
  scheduled_for  date,
  failure_reason text,
  -- A payout's customer must be the same customer as its transaction's.
  foreign key (transaction_id, customer_id)
    references transactions (transaction_id, customer_id)
);

create index transactions_customer_id_idx on transactions (customer_id);
create index payouts_transaction_id_idx on payouts (transaction_id);
create index payouts_customer_id_idx on payouts (customer_id);

-- ---------------------------------------------------------------------------
-- Runtime tables
-- ---------------------------------------------------------------------------

create table conversations (
  conversation_id      text primary key,  -- Vapi call.id
  channel              text not null,
  caller               text,
  started_at           timestamptz not null default now(),
  ended_at             timestamptz,
  final_status         text not null default 'active'
    check (final_status in ('active', 'completed', 'failed', 'abandoned')),
  summary              text,
  verified_customer_id text references customers (customer_id),
  total_cost_usd       numeric(12,6) not null default 0,
  total_input_tokens   bigint not null default 0,
  total_output_tokens  bigint not null default 0
);

comment on column conversations.total_cost_usd is
  'SUM(conversation_turns.cost_usd_estimate) for this conversation. Client-side ESTIMATE, not billing. '
  'Code sets this only by recomputing SUM() from conversation_turns, never by incrementing.';
comment on column conversations.total_input_tokens is
  'SUM(conversation_turns.input_tokens) for this conversation. '
  'Code sets this only by recomputing SUM() from conversation_turns, never by incrementing.';
comment on column conversations.total_output_tokens is
  'SUM(conversation_turns.output_tokens) for this conversation. '
  'Code sets this only by recomputing SUM() from conversation_turns, never by incrementing.';

create table conversation_turns (
  id                    bigint generated always as identity primary key,
  conversation_id       text not null references conversations (conversation_id),
  turn_index            integer not null check (turn_index >= 0),
  user_transcript       text,
  assistant_response    text,
  answer_type           text not null
    check (answer_type in ('answer', 'clarify', 'escalate', 'decline', 'blocked', 'error')),
  confidence_note       text,
  kb_chunk_ids          text[] not null default '{}',
  -- latency
  t_received            timestamptz not null default now(),
  ms_retrieval          integer,
  ms_first_token        integer,
  ms_tools              integer,
  ms_total              integer,
  -- usage
  model                 text,
  input_tokens          integer,
  output_tokens         integer,
  cache_read_tokens     integer,
  cache_creation_tokens integer,
  cost_usd_estimate     numeric(12,6),
  sdk_duration_ms       integer,
  sdk_num_turns         integer,
  unique (conversation_id, turn_index)
);

comment on column conversation_turns.cost_usd_estimate is
  'Agent SDK total_cost_usd for this turn. Client-side ESTIMATE, not billing.';

create table retrieval_logs (
  id                     bigint generated always as identity primary key,
  conversation_id        text not null references conversations (conversation_id),
  turn_index             integer not null,
  query                  text not null,
  chunk_ids              text[] not null default '{}',
  source_titles          text[] not null default '{}',
  source_summary         text,
  insufficient_knowledge boolean not null default false,
  created_at             timestamptz not null default now()
);

create table tool_calls (
  id              bigint generated always as identity primary key,
  conversation_id text not null references conversations (conversation_id),
  turn_index      integer not null,
  tool_name       text not null,
  purpose         text,
  input_summary   text,
  result_summary  text,
  status          text not null
    -- denied = policy refusal (e.g. identity gate), distinct from not_found / invalid_input.
    check (status in ('success', 'not_found', 'invalid_input', 'denied', 'error')),
  error_message   text,
  duration_ms     integer,
  created_at      timestamptz not null default now()
);

create index retrieval_logs_conversation_turn_idx on retrieval_logs (conversation_id, turn_index);
create index tool_calls_conversation_turn_idx on tool_calls (conversation_id, turn_index);

create table support_tickets (
  ticket_id       text primary key
    default ('TKT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  conversation_id text not null references conversations (conversation_id),
  customer_id     text references customers (customer_id),
  transaction_id  text references transactions (transaction_id),
  payout_id       text references payouts (payout_id),
  category        text not null
    check (category in ('payment', 'payout', 'invoice', 'account', 'compliance', 'dispute', 'other')),
  -- Computed in code (docs/decisions.md D1), never chosen by the model.
  priority        text not null
    check (priority in ('low', 'normal', 'high')),
  status          text not null default 'open'
    check (status in ('open', 'in progress', 'closed')),
  summary         text not null,
  idempotency_key text not null unique,
  created_at      timestamptz not null default now()
);

create table escalations (
  escalation_id       text primary key
    default ('ESC-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  conversation_id     text not null references conversations (conversation_id),
  ticket_id           text not null references support_tickets (ticket_id),
  customer_id         text references customers (customer_id),
  user_name           text not null,
  user_email          text not null
    check (user_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  category            text not null
    check (category in ('compliance', 'account', 'dispute', 'payment', 'other')),
  reason              text not null,
  call_booked         boolean not null default false,
  -- What the caller said, verbatim. Never parsed into a timestamp.
  preferred_time_text text,
  status              text not null default 'open'
    check (status in ('open', 'in progress', 'closed')),
  idempotency_key     text not null unique,
  created_at          timestamptz not null default now()
);

create index support_tickets_conversation_id_idx on support_tickets (conversation_id);
create index escalations_conversation_id_idx on escalations (conversation_id);
create index escalations_ticket_id_idx on escalations (ticket_id);

create table evaluations (
  id              bigint generated always as identity primary key,
  run_id          text not null,
  conversation_id text references conversations (conversation_id),
  scenario        text not null,
  expected        text not null,
  actual          text,
  passed          boolean not null,
  notes           text,
  created_at      timestamptz not null default now()
);

create index evaluations_run_id_idx on evaluations (run_id);

-- ---------------------------------------------------------------------------
-- Knowledge base
-- ---------------------------------------------------------------------------

create table kb_chunks (
  chunk_id     text primary key,
  source_title text not null,
  heading      text not null,
  content      text not null,
  search_tsv   tsvector generated always as (
    setweight(to_tsvector('english', heading), 'A') ||
    setweight(to_tsvector('english', content), 'B')
  ) stored
);

create index kb_chunks_search_tsv_idx on kb_chunks using gin (search_tsv);

-- ---------------------------------------------------------------------------
-- Atomic, idempotent escalation (called by the MCP server via supabase.rpc)
--
-- Inserts a support ticket and its escalation in one transaction.
-- - Escalation key already used  -> returns that escalation and its ticket, created = false.
-- - Ticket key already used by a ticket that has an escalation -> returns them, created = false.
-- - Ticket key already used by a ticket WITHOUT an escalation -> raises P0001 'ESCALATION_KEY_CONFLICT: ...'
--   (a bug, not a duplicate; nothing written).
-- - Any constraint failure (bad email, bad category, missing FK) -> raises; the ticket insert is
--   rolled back with it, so no orphan ticket.
-- - A concurrent duplicate that loses the race hits unique_violation and returns the winner's rows.
-- p_category is used for both rows: every escalation category is also a valid ticket category.
-- Ticket priority is always 'high' (docs/decisions.md D1: tickets from escalations are high).
-- ---------------------------------------------------------------------------

create function create_escalation_with_ticket(
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
  for attempt in 1..2 loop
    -- Existing escalation for this key?
    select e.ticket_id, e.escalation_id
      into v_ticket_id, v_escalation_id
      from escalations e
     where e.idempotency_key = p_escalation_idempotency_key;
    if found then
      return query select v_ticket_id, v_escalation_id, false;
      return;
    end if;

    -- Existing ticket for this key?
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
      -- Deliberately NOT unique_violation: callers must never mistake this bug case
      -- for a harmless duplicate (docs/decisions.md D11).
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
      -- Lost a race with a concurrent identical call (both inserts are rolled back to the
      -- block start). Loop once to return the winner's rows; re-raise if it happens again.
      if attempt = 2 then
        raise;
      end if;
    end;
  end loop;
end;
$$;

revoke execute on function create_escalation_with_ticket(
  text, text, text, text, text, text, text, text, text, text, text, boolean, text
) from public, anon, authenticated;
grant execute on function create_escalation_with_ticket(
  text, text, text, text, text, text, text, text, text, text, text, boolean, text
) to service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security: enabled everywhere, NO policies.
-- anon/authenticated read and write nothing; only the service role (which
-- bypasses RLS) touches these tables.
-- ---------------------------------------------------------------------------

alter table customers          enable row level security;
alter table transactions       enable row level security;
alter table payouts            enable row level security;
alter table conversations      enable row level security;
alter table conversation_turns enable row level security;
alter table retrieval_logs     enable row level security;
alter table tool_calls         enable row level security;
alter table support_tickets    enable row level security;
alter table escalations        enable row level security;
alter table evaluations        enable row level security;
alter table kb_chunks          enable row level security;

commit;
