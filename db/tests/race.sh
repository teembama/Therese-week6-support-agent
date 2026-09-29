#!/usr/bin/env bash
# Two-session race test of create_escalation_with_ticket.
# Session A opens a transaction, calls the function and holds it uncommitted; session B makes
# the same call with the same keys and must block, then return A's rows with created=false.
# Runs against a throwaway local Postgres only. See db/tests/README.md.
TEST_PG_PORT="${TEST_PG_PORT:-54330}"
source "$(dirname "$0")/lib.sh"

start_cluster
setup_supabase_like_schema || exit 1
pg -c "\copy customers from '$REPO/assets/seed-data/customers.csv' csv header"
pg -c "insert into conversations(conversation_id,channel) values ('call-race','voice')"

CALL="select 'result: ticket_id=' || ticket_id || ' escalation_id=' || escalation_id || ' created=' || created
  from create_escalation_with_ticket(
    p_conversation_id => 'call-race', p_ticket_idempotency_key => 'K1', p_escalation_idempotency_key => 'K2',
    p_category => 'account', p_ticket_summary => 'Race test', p_reason => 'Race test',
    p_user_name => 'Efua Mensah', p_user_email => 'efua@accrastack.example', p_customer_id => 'CUS-1003');"
TS="to_char(clock_timestamp(), 'HH24:MI:SS.MS')"

# Session A: BEGIN, call, hold the transaction open (uncommitted) for 4s, then COMMIT.
pg -At > "$TEST_TMP/A.out" 2>&1 <<SQL &
set role service_role;
select 'A ' || $TS || '  BEGIN';
begin;
select 'A ' || $TS || '  calling create_escalation_with_ticket(K1, K2)';
$CALL
select 'A ' || $TS || '  pid=' || pg_backend_pid() || ', transaction open, NOT committed; holding 4s';
select '' from pg_sleep(4);
select 'A ' || $TS || '  COMMIT';
commit;
select 'A ' || $TS || '  committed';
SQL
PID_A=$!
sleep 1

# Session B: same call, same keys. Should block on A's uncommitted unique-index entry.
pg -At > "$TEST_TMP/B.out" 2>&1 <<SQL &
set role service_role;
select 'B ' || $TS || '  pid=' || pg_backend_pid() || ', calling create_escalation_with_ticket(K1, K2)';
$CALL
select 'B ' || $TS || '  returned';
SQL
PID_B=$!
sleep 1.5

# Observer: is B waiting, and on whom?
OBS=$(pg -At <<SQL
select 'OBSERVER ' || $TS || '  pid=' || a.pid || ' state=' || a.state
       || ' wait=' || coalesce(a.wait_event_type || '/' || a.wait_event, 'none')
       || ' blocked_by=' || coalesce(pg_blocking_pids(a.pid)::text, '{}')
  from pg_stat_activity a
 where a.query like '%create_escalation_with_ticket%' and a.pid <> pg_backend_pid()
 order by a.backend_start;
SQL
)
wait $PID_A $PID_B

echo "=== Session A";  grep -v '^$' "$TEST_TMP/A.out"
echo "=== Observer (1.5s after B started)"; echo "$OBS"
echo "=== Session B";  grep -v '^$' "$TEST_TMP/B.out"
echo "=== Totals"
TICKETS=$(pg -At -c "select count(*) from support_tickets")
ESCS=$(pg -At -c "select count(*) from escalations")
echo "support_tickets rows: $TICKETS"
echo "escalations rows:     $ESCS"

# Assertions
A_RES=$(grep '^result:' "$TEST_TMP/A.out"); B_RES=$(grep '^result:' "$TEST_TMP/B.out")
FAILS=0
check() { if eval "$1"; then echo "PASS  $2"; else echo "FAIL  $2"; FAILS=$((FAILS+1)); fi; }
check '[[ "$OBS" == *"wait=Lock/"* && "$OBS" == *"blocked_by={"*"}"* && "$OBS" != *"blocked_by={}"* ]]' "B was blocked on A's lock"
check '[[ "$A_RES" == *"created=true" ]]' "A created=true"
check '[[ "$B_RES" == *"created=false" ]]' "B created=false"
check '[[ "${A_RES% created=*}" == "${B_RES% created=*}" && -n "$A_RES" ]]' "B returned A's ticket_id and escalation_id"
check '[[ "$TICKETS" == 1 && "$ESCS" == 1 ]]' "exactly one ticket and one escalation"
echo "--- failures: $FAILS"
exit $FAILS
