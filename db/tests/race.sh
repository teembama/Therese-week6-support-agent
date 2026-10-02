#!/usr/bin/env bash
# Two-session race test of create_escalation_with_ticket (v2, migration 005: guarded by an active attempt).
# Session A opens a transaction, calls the function and holds it uncommitted; session B makes
# the same call with the same keys and must block, then return A's rows with created=false.
# Runs against a throwaway local Postgres only. See db/tests/README.md.
TEST_PG_PORT="${TEST_PG_PORT:-54330}"
source "$(dirname "$0")/lib.sh"

start_cluster
setup_supabase_like_schema || exit 1
pg -c "\copy customers from '$REPO/assets/seed-data/customers.csv' csv header"
pg -c "insert into conversations(conversation_id,channel) values ('call-race','voice')"
pg -c "insert into turn_attempts(attempt_id,conversation_id,turn_index,transcript_hash) values ('ATT-RACE','call-race',0,'h')"

CALL="select 'result: ticket_id=' || ticket_id || ' escalation_id=' || escalation_id || ' created=' || created
  from create_escalation_with_ticket(
    p_attempt_id => 'ATT-RACE', p_conversation_id => 'call-race', p_ticket_idempotency_key => 'K1', p_escalation_idempotency_key => 'K2',
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

# ---- Migration 007 (D86): one pass redeemed concurrently by two conversations. A holds the pass
# row locked (redeemed, uncommitted); B must block, then see it used by another conversation.
PH=$(printf '%064d' 7)
pg -c "insert into call_passes(pass_hash,user_id,role) values ('$PH','11111111-1111-4111-8111-111111111111','customer')" >/dev/null
pg -At > "$TEST_TMP/PA.out" 2>&1 <<SQL &
set role service_role;
begin;
select 'pass: ' || status from redeem_call_pass('conv-A', '$PH');
select '' from pg_sleep(3);
commit;
SQL
PID_PA=$!
sleep 1
pg -At > "$TEST_TMP/PB.out" 2>&1 <<SQL &
set role service_role;
select 'pass: ' || status from redeem_call_pass('conv-B', '$PH');
SQL
PID_PB=$!
wait $PID_PA $PID_PB
PA=$(grep '^pass:' "$TEST_TMP/PA.out"); PB=$(grep '^pass:' "$TEST_TMP/PB.out")
LINKED=$(pg -At -c "select conversation_id from call_passes where pass_hash='$PH'")
echo "=== Call pass race: A=$PA B=$PB linked=$LINKED"
check '[[ "$PA" == "pass: ok" && "$PB" == "pass: reused" && "$LINKED" == "conv-A" ]]' "one pass, two concurrent conversations: exactly one redeems it (007)"

# ---- Migration 009 (D97): two calls book the same callback slot at once. A books and holds its
# transaction open; B must block on the unique index, then get slot_taken (not an error).
pg -c "insert into conversations(conversation_id,channel) values ('race-slot-a','voice'),('race-slot-b','voice')" >/dev/null
pg -c "insert into turn_attempts(attempt_id,conversation_id,turn_index,transcript_hash) values ('ATT-RSA','race-slot-a',0,'h'),('ATT-RSB','race-slot-b',0,'h')" >/dev/null
BOOK() { echo "select 'slot: created=' || created || ' taken=' || slot_taken from create_escalation_with_ticket(
  p_attempt_id => '$1', p_conversation_id => '$2', p_ticket_idempotency_key => 'tk-$2', p_escalation_idempotency_key => 'ek-$2',
  p_category => 'account', p_ticket_summary => 'Race', p_reason => 'Race', p_user_name => 'Efua Mensah', p_user_email => 'efua@accrastack.example',
  p_preferred_time_text => 'Monday at 10 AM', p_callback_slot => '2030-10-07 10:00+01');"; }
pg -At > "$TEST_TMP/SA.out" 2>&1 <<SQL &
set role service_role;
begin;
$(BOOK ATT-RSA race-slot-a)
select '' from pg_sleep(3);
commit;
SQL
PID_SA=$!
sleep 1
pg -At > "$TEST_TMP/SB.out" 2>&1 <<SQL &
set role service_role;
$(BOOK ATT-RSB race-slot-b)
SQL
PID_SB=$!
wait $PID_SA $PID_SB
SA=$(grep '^slot:' "$TEST_TMP/SA.out"); SB=$(grep '^slot:' "$TEST_TMP/SB.out")
BOOKED=$(pg -At -c "select count(*) from escalations where callback_slot = '2030-10-07 10:00+01' and status in ('open','in progress')")
B_TICKETS=$(pg -At -c "select count(*) from support_tickets where conversation_id = 'race-slot-b'")
echo "=== Slot race: A=$SA B=$SB booked=$BOOKED b_tickets=$B_TICKETS"
check '[[ "$SA" == "slot: created=true taken=false" && "$SB" == "slot: created=false taken=true" && "$BOOKED" == 1 && "$B_TICKETS" == 0 ]]' "one slot, two concurrent bookings: one wins, the other gets slot_taken and writes nothing (009)"
echo "--- failures: $FAILS"
exit $FAILS
