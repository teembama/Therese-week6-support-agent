#!/usr/bin/env bash
# Schema constraint, function and privilege suite (39 checks) for db/migrations.
# Runs against a throwaway local Postgres only. See db/tests/README.md.
source "$(dirname "$0")/lib.sh"

FAILS=0
ok()  { echo "PASS  $1"; }
bad() { echo "FAIL  $1"; FAILS=$((FAILS+1)); }
neg() { if pg -c "$1" >/dev/null 2>&1; then bad "should be rejected: $2"; else ok "rejected: $2"; fi; }
eq()  { if [ "$1" = "$2" ]; then ok "$3 ($1)"; else bad "$3: got '$1', expected '$2'"; fi; }
q()   { pg -At -c "$1"; }
SR()  { pg -At -c "set role service_role; $1"; }

start_cluster
if setup_supabase_like_schema; then ok "migration applied"; else bad "migration failed"; fi

load_seed_csvs
eq "$(q "select count(*) from customers")" 5 "customers loaded"
eq "$(q "select count(*) from transactions")" 5 "transactions loaded"
eq "$(q "select count(*) from payouts")" 3 "payouts loaded"
eq "$(q "select estimated_arrival is null from transactions where transaction_id='TXN-9003'")" t "empty CSV cell -> NULL"
eq "$(q "select count(*) filter (where relrowsecurity) || '/' || count(*) from pg_class where relnamespace='public'::regnamespace and relkind='r'")" 12/12 "RLS enabled on every table (incl. turn_attempts)"
eq "$(q "select count(*) from pg_policies where schemaname='public'")" 0 "no RLS policies"

echo "--- constraint rejections"
neg "update customers set account_status='suspended' where customer_id='CUS-1001'" "bad account_status"
neg "insert into payouts values ('PAY-X','TXN-9001','CUS-1002','x',1,'USD','processing',null,null)" "payout customer != transaction customer"
neg "insert into payouts values ('PAY-X','TXN-9001','CUS-1001','x',1,'usd','processing',null,null)" "lowercase currency (payouts)"
neg "update transactions set currency='US' where transaction_id='TXN-9001'" "2-letter currency (transactions)"
pg -c "insert into conversations(conversation_id,channel) values ('call-1','voice')"
pg -c "insert into support_tickets(conversation_id,category,priority,summary,idempotency_key) values ('call-1','invoice','normal','t','k1')"
neg "insert into support_tickets(conversation_id,category,priority,summary,idempotency_key) values ('call-1','invoice','normal','t','k1')" "duplicate ticket idempotency_key"
neg "insert into support_tickets(conversation_id,category,priority,status,summary,idempotency_key) values ('call-1','invoice','normal','in_progress','t','k2')" "status in_progress (underscore)"
T=$(q "select ticket_id from support_tickets where idempotency_key='k1'")
neg "insert into escalations(conversation_id,ticket_id,user_name,user_email,category,reason,idempotency_key) values ('call-1','$T','A','not-an-email','account','r','e1')" "bad email"
neg "insert into escalations(conversation_id,user_name,user_email,category,reason,idempotency_key) values ('call-1','A','a@b.co','account','r','e2')" "escalation without ticket"
neg "insert into conversation_turns(conversation_id,turn_index) values ('call-1',0)" "turn with NULL answer_type"
if pg -c "insert into tool_calls(conversation_id,turn_index,tool_name,status) values ('call-1',0,'lookup_customer','denied')" >/dev/null 2>&1; then ok "tool_calls.status 'denied' accepted"; else bad "tool_calls.status 'denied' rejected"; fi
neg "insert into tool_calls(conversation_id,turn_index,tool_name,status) values ('call-1',0,'lookup_customer','refused')" "unknown tool_calls.status"
pg -c "insert into kb_chunks values ('c1','KB','How Does RelayPay Charge Fees?','Fees vary based on transaction type, corridor, and payment method.')"
eq "$(q "select chunk_id from kb_chunks where search_tsv @@ websearch_to_tsquery('english','what fees do you charge')")" c1 "kb full-text search"

echo "--- search_kb (migration 002)"
pg -c "insert into kb_chunks values ('c2','KB','How Long Do Payments Take To Process?','Local payouts typically take 1 to 2 business days. RelayPay international payouts usually take 2 to 5 business days.')"
SK() { q "set role service_role; select string_agg(chunk_id, ',' order by chunk_id) from search_kb($1)"; }
eq "$(SK "'fees for payouts', 4, 0.0")" "c1,c2" "OR query matches either term (AND would match neither chunk)"
eq "$(SK "'what is the', 4, 0.0")" "" "stopword-only query returns no rows"
eq "$(SK "'relaypay', 4, 0.0, 32, array['relaypay']")" "" "excluded corpus word removed from query"
eq "$(SK "'relaypay', 4, 0.0, 32, array[]::text[]")" "c1,c2" "same word matches when not excluded (c1 heading, c2 content)"
eq "$(SK "'fees for payouts', 4, 0.99")" "" "min_rank filters low-ranked rows"
eq "$(SK "'fees for payouts', 1, 0.0")" "$(q "set role service_role; select chunk_id from search_kb('fees for payouts', 4, 0.0) limit 1")" "match_count limits rows, best first"
eq "$(SK "\$\$what's the payout's \\\\ timeline\$\$, 4, 0.0")" "c2" "quotes and backslashes in query are safe"
eq "$(q "select has_function_privilege('anon','search_kb(text,integer,real,integer,text[])','execute')")" f "anon has no EXECUTE on search_kb"
eq "$(q "select has_function_privilege('service_role','search_kb(text,integer,real,integer,text[])','execute')")" t "service_role has EXECUTE on search_kb"

echo "--- create_escalation_with_ticket (run as service_role)"
CALL="select ticket_id||'|'||escalation_id||'|'||created from create_escalation_with_ticket(
  p_conversation_id => 'call-1', p_ticket_idempotency_key => 'tk-A', p_escalation_idempotency_key => 'esc-A',
  p_category => 'account', p_ticket_summary => 'Account restricted, caller frustrated', p_reason => 'Account restriction',
  p_user_name => 'Efua Mensah', p_user_email => EMAIL, p_customer_id => 'CUS-1003', p_preferred_time_text => 'tomorrow morning')"
GOODCALL=$(echo "$CALL" | sed "s/EMAIL/'efua@accrastack.example'/")
BADEMAILCALL=$(echo "$CALL" | sed "s/EMAIL/'not-an-email'/")
R1=$(SR "$GOODCALL")
echo "      first call  -> $R1"
eq "${R1##*|}" true "first call created=true"
eq "$(q "select priority from support_tickets where idempotency_key='tk-A'")" high "escalation ticket priority is high"
eq "$(q "select count(*) from escalations e join support_tickets t using (ticket_id) where e.idempotency_key='esc-A' and t.idempotency_key='tk-A'")" 1 "escalation linked to its ticket"
R2=$(SR "$GOODCALL")
echo "      repeat call -> $R2"
eq "${R2%|*}" "${R1%|*}" "repeat returns same ticket_id and escalation_id"
eq "${R2##*|}" false "repeat created=false"
R3=$(SR "$(echo "$GOODCALL" | sed "s/'esc-A'/'esc-OTHER'/")")
eq "$R3" "${R1%|*}|false" "same ticket key, new escalation key -> existing rows, created=false"
eq "$(q "select count(*) from support_tickets where idempotency_key='tk-A'")|$(q "select count(*) from escalations where idempotency_key in ('esc-A','esc-OTHER')")" "1|1" "no duplicate rows after repeats"
BEFORE=$(q "select count(*) from support_tickets")
BADCALL=$(echo "$BADEMAILCALL" | sed "s/'tk-A'/'tk-B'/; s/'esc-A'/'esc-B'/")
E=$(SR "$BADCALL" 2>&1 >/dev/null | head -1)
case "$E" in *escalations_user_email_check*) ok "bad email raises: $E";; *) bad "bad email: $E";; esac
eq "$(q "select count(*) from support_tickets")" "$BEFORE" "bad email left no orphan ticket"
eq "$(q "select count(*) from support_tickets where idempotency_key='tk-B'")" 0 "ticket tk-B not written"
KCOLL=$(echo "$GOODCALL" | sed "s/'tk-A'/'k1'/; s/'esc-A'/'esc-C'/")
E=$(pg -v VERBOSITY=verbose -At -c "set role service_role; $KCOLL" 2>&1 >/dev/null | head -1)
case "$E" in *"P0001: ESCALATION_KEY_CONFLICT:"*) ok "plain-ticket key collision raises P0001: $E";; *) bad "key collision: $E";; esac
eq "$(q "select count(*) from escalations where idempotency_key='esc-C'")" 0 "no escalation written on key collision"

echo "--- privileges"
SIG="create_escalation_with_ticket(text,text,text,text,text,text,text,text,text,text,text,boolean,text)"
eq "$(q "select has_function_privilege('anon','$SIG','execute')")" f "anon has no EXECUTE"
eq "$(q "select has_function_privilege('authenticated','$SIG','execute')")" f "authenticated has no EXECUTE"
eq "$(q "select has_function_privilege('service_role','$SIG','execute')")" t "service_role has EXECUTE"
ANONCALL=$(echo "set role anon; $GOODCALL" | sed "s/'tk-A'/'tk-anon'/; s/'esc-A'/'esc-anon'/")
OUT=$(pg -At -c "$ANONCALL" 2>&1)
case "$OUT" in *"permission denied for function create_escalation_with_ticket"*) ok "anon call fails: permission denied for function";; *) bad "anon call: $OUT";; esac
eq "$(q "set role anon; select count(*) from customers")" 0 "anon reads 0 customers (RLS, no policies)"
eq "$(q "set role anon; select count(*) from support_tickets")" 0 "anon reads 0 tickets"
neg "set role anon; insert into conversations(conversation_id,channel) values ('x','voice')" "anon insert blocked by RLS"
eq "$(q "set role service_role; select count(*) from customers")" 5 "service_role reads 5 customers"

echo "--- turn attempts (migration 003)"
pg -c "insert into conversations(conversation_id,channel) values ('call-att','voice')"
BEGIN_SQL() { SR "select action||'|'||coalesce(assistant_response,'')||'|'||array_to_string(replaced_attempt_ids,',') from begin_turn_attempt('call-att','voice',null,0,'$1','$2','$3')"; }
TURN_JSON() { echo "jsonb_build_object('transcript_hash','$1','user_transcript','$2','assistant_response',$3,'answer_type','$4','confidence_note','ok','cost_usd_estimate',$5,'input_tokens',100,'output_tokens',10)"; }
FINISH() { SR "select finish_turn_attempt('$1','$2','r', jsonb_build_object('cost_usd_estimate',$3,'input_tokens',100,'output_tokens',10), $4)"; }
eq "$(BEGIN_SQL ATT-A hA 'What fees does.')" "run||" "speculative attempt A starts (run)"
eq "$(q "select status from turn_attempts where attempt_id='ATT-A'")" active "A is active"
neg "set role service_role; insert into turn_attempts(attempt_id,conversation_id,turn_index,transcript_hash) values ('ATT-X','call-att',0,'hX')" "second active attempt for the same turn (one-active index)"
eq "$(BEGIN_SQL ATT-B hB 'What fees does RelayPay charge?')" "run||ATT-A" "fuller transcript B replaces A"
eq "$(q "select status||'|'||replaced_by from turn_attempts where attempt_id='ATT-A'")" "replaced|ATT-B" "A recorded as replaced by B"
eq "$(FINISH ATT-A completed 0.001 "$(TURN_JSON hA 'What fees does.' "'stale answer'" answer 0.001)")" replaced "late finish of replaced A keeps 'replaced'"
eq "$(q "select count(*) from conversation_turns where conversation_id='call-att'")" 0 "replaced A wrote no turn row"
eq "$(FINISH ATT-B completed 0.002 "$(TURN_JSON hB 'What fees does RelayPay charge?' "'Fees vary.'" answer 0.002)")" completed "B completes"
eq "$(q "select attempt_id||'|'||assistant_response from conversation_turns where conversation_id='call-att' and turn_index=0")" "ATT-B|Fees vary." "B's answer stored as the turn"
eq "$(q "select total_cost_usd from conversations where conversation_id='call-att'")" "0.003000" "totals = turn B (0.002) + replaced A (0.001)"
eq "$(BEGIN_SQL ATT-C hB 'What fees does RelayPay charge?')" "replay|Fees vary.|" "identical retry of B replays B's stored answer"
eq "$(q "select count(*) from turn_attempts where attempt_id='ATT-C'")" 0 "replay creates no attempt"
# A turn attempt that disconnects before speaking: aborted, no turn row; the identical request runs fresh.
pg -c "insert into conversations(conversation_id,channel) values ('call-att2','voice')"
B2() { SR "select action from begin_turn_attempt('call-att2','voice',null,0,'$1','hZ','hi')"; }
eq "$(B2 ATT-D)" run "attempt D starts"
eq "$(FINISH ATT-D aborted 0.0005 null)" aborted "D aborted (client disconnected before speech)"
eq "$(B2 ATT-E)" run "identical request after an aborted attempt runs fresh (never replays nothing)"
eq "$(q "select status from turn_attempts where attempt_id='ATT-D'")" aborted "identical follow-up leaves the aborted attempt 'aborted'"
pg -c "insert into conversations(conversation_id,channel) values ('call-att3','voice')"
SR "select action from begin_turn_attempt('call-att3','voice',null,0,'ATT-P','hPart','What fees does.')" >/dev/null
FINISH ATT-P aborted 0.0004 null >/dev/null
eq "$(SR "select array_to_string(replaced_attempt_ids,',') from begin_turn_attempt('call-att3','voice',null,0,'ATT-Q','hFull','What fees does RelayPay charge?')")" ATT-P "Vapi flow: aborted partial A, then fuller B -> A marked replaced"
eq "$(q "select status||'|'||replaced_by from turn_attempts where attempt_id='ATT-P'")" "replaced|ATT-Q" "A: replaced, replaced_by B"
eq "$(q "select total_cost_usd from conversations where conversation_id='call-att2'")" "0.000500" "aborted attempt's cost counted in totals"
# A completed turn answered again (different transcript) -> previous attempt becomes replaced; no double count.
eq "$(FINISH ATT-E completed 0.002 "$(TURN_JSON hZ 'hi' "'Hello.'" clarify 0.002)")" completed "E completes"
eq "$(SR "select action from begin_turn_attempt('call-att2','voice',null,0,'ATT-F','hZ2','hi there')")" run "different transcript for an answered turn runs a new attempt"
eq "$(FINISH ATT-F completed 0.003 "$(TURN_JSON hZ2 'hi there' "'Hello there.'" clarify 0.003)")" completed "F completes"
eq "$(q "select attempt_id from conversation_turns where conversation_id='call-att2' and turn_index=0")|$(q "select status from turn_attempts where attempt_id='ATT-E'")" "ATT-F|replaced" "turn row now F's; E counted as replaced"
eq "$(q "select total_cost_usd from conversations where conversation_id='call-att2'")" "0.005500" "totals = F 0.003 + E 0.002 + D 0.0005, no double count"
# Supersession guard
eq "$(q "set role service_role; select attempt_is_active('ATT-B')||'|'||attempt_is_active('ATT-A')||'|'||attempt_is_active('nope')")" "false|false|false" "attempt_is_active: completed/replaced/unknown are not active"
eq "$(q "set role service_role; select attempt_is_active('ATT-F')")" f "attempt_is_active: F completed -> not active"
SR "select action from begin_turn_attempt('call-att2','voice',null,1,'ATT-G','hG','next')" >/dev/null
eq "$(q "set role service_role; select attempt_is_active('ATT-G')")" t "attempt_is_active: G active"
if SR "select require_active_attempt('ATT-G')" >/dev/null 2>&1; then ok "require_active_attempt passes for an active attempt"; else bad "require_active_attempt rejected an active attempt"; fi
E=$(pg -v VERBOSITY=verbose -At -c "set role service_role; select require_active_attempt('ATT-A')" 2>&1 >/dev/null | head -1)
case "$E" in *"P0001: ATTEMPT_NOT_ACTIVE:"*) ok "require_active_attempt raises P0001 ATTEMPT_NOT_ACTIVE for a replaced attempt";; *) bad "require_active_attempt: $E";; esac
eq "$(q "select relrowsecurity from pg_class where relname='turn_attempts'")" t "RLS enabled on turn_attempts"
for fn in "begin_turn_attempt(text,text,text,integer,text,text,text)" "finish_turn_attempt(text,text,text,jsonb,jsonb)" "attempt_is_active(text)" "require_active_attempt(text)" "recompute_conversation_totals(text)"; do
  eq "$(q "select has_function_privilege('anon','$fn','execute')")|$(q "select has_function_privilege('service_role','$fn','execute')")" "f|t" "only service_role executes ${fn%%(*}"
done

echo "--- failures: $FAILS"
exit $FAILS
