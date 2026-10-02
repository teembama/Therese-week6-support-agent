#!/usr/bin/env bash
# Schema constraint, function and privilege suite (131 checks) for db/migrations.
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
eq "$(q "select count(*) filter (where relrowsecurity) || '/' || count(*) from pg_class where relnamespace='public'::regnamespace and relkind='r'")" 15/15 "RLS enabled on every table (incl. turn_attempts, conversation_events, notification_outbox, call_passes)"
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

echo "--- create_escalation_with_ticket v2 (migration 005; run as service_role with an active attempt)"
pg -c "insert into turn_attempts(attempt_id,conversation_id,turn_index,transcript_hash) values ('ATT-ESC','call-1',0,'h-esc')"
CALL="select ticket_id||'|'||escalation_id||'|'||created from create_escalation_with_ticket(
  p_attempt_id => 'ATT-ESC', p_conversation_id => 'call-1', p_ticket_idempotency_key => 'tk-A', p_escalation_idempotency_key => 'esc-A',
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
SIG="create_escalation_with_ticket(text,text,text,text,text,text,text,text,text,text,text,text,boolean,text)"
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

echo "--- social answer type (migration 004)"
pg -c "insert into conversations(conversation_id,channel) values ('call-social','voice')"
if pg -c "insert into conversation_turns(conversation_id,turn_index,answer_type) values ('call-social',0,'social')" >/dev/null 2>&1; then ok "answer_type 'social' accepted"; else bad "answer_type 'social' rejected"; fi
neg "insert into conversation_turns(conversation_id,turn_index,answer_type) values ('call-social',1,'smalltalk')" "unknown answer_type still rejected"
eq "$(q "select count(*) from pg_constraint where conname='conversation_turns_answer_type_check'")" 1 "exactly one answer_type check constraint"

echo "--- guarded writes, events, stale attempts, abandonment (migration 005)"
perr() { pg -v VERBOSITY=verbose -At -c "set role service_role; $1" 2>&1 >/dev/null | head -1; }
has_code() { case "$1" in *"$2"*) ok "$3";; *) bad "$3: got '$1'";; esac; }
pg -c "insert into conversations(conversation_id,channel) values ('call-5','voice')"
SR "select action from begin_turn_attempt('call-5','voice',null,0,'ATT-5A','h5a','my payout failed')" >/dev/null
SR "select action from begin_turn_attempt('call-5','voice',null,0,'ATT-5B','h5b','my payout failed, PAY-7003')" >/dev/null
eq "$(q "select status from turn_attempts where attempt_id='ATT-5A'")" replaced "setup: ATT-5A replaced by ATT-5B"
TKT() { echo "select ticket_id||'|'||priority||'|'||status||'|'||created from create_support_ticket_guarded('$1','$2',$3,$4,$5,'$6','summary','$7')"; }

# Guard denial for a replaced attempt, on every guarded write; nothing written.
BEFORE_T=$(q "select count(*) from support_tickets"); BEFORE_E=$(q "select count(*) from escalations"); BEFORE_EV=$(q "select count(*) from conversation_events")
has_code "$(perr "$(TKT ATT-5A call-5 null null "'PAY-7003'" payout k5-denied)")" "P0001: ATTEMPT_NOT_ACTIVE" "ticket: replaced attempt denied (P0001 ATTEMPT_NOT_ACTIVE)"
has_code "$(perr "select * from create_escalation_with_ticket(p_attempt_id => 'ATT-5A', p_conversation_id => 'call-5', p_ticket_idempotency_key => 'tk5', p_escalation_idempotency_key => 'esc5', p_category => 'payment', p_ticket_summary => 's', p_reason => 'r', p_user_name => 'A', p_user_email => 'a@b.co')")" "P0001: ATTEMPT_NOT_ACTIVE" "escalation: replaced attempt denied"
has_code "$(perr "select set_verified_customer('ATT-5A','call-5','CUS-1004')")" "P0001: ATTEMPT_NOT_ACTIVE" "set_verified_customer: replaced attempt denied"
has_code "$(perr "select log_conversation_event_guarded('ATT-5A','call-5',0,'other','x')")" "P0001: ATTEMPT_NOT_ACTIVE" "log_conversation_event_guarded: replaced attempt denied"
eq "$(q "select count(*) from support_tickets")|$(q "select count(*) from escalations")|$(q "select count(*) from conversation_events")|$(q "select coalesce(verified_customer_id,'none') from conversations where conversation_id='call-5'")" "$BEFORE_T|$BEFORE_E|$BEFORE_EV|none" "denied writes wrote nothing (tickets, escalations, events, verified customer)"
has_code "$(perr "$(TKT ATT-5B call-1 null null null other k5-scope)")" "P0001: ATTEMPT_SCOPE_MISMATCH" "active attempt used for another conversation -> ATTEMPT_SCOPE_MISMATCH"
has_code "$(perr "select log_conversation_event_guarded('ATT-5B','call-5',7,'other','x')")" "P0001: ATTEMPT_SCOPE_MISMATCH" "event for another turn -> ATTEMPT_SCOPE_MISMATCH"

# Priority rule and idempotency.
eq "$(SR "$(TKT ATT-5B call-5 "'CUS-1004'" "'TXN-9004'" null payment k5-failed)" | cut -d'|' -f2-4)" "high|open|true" "failed transaction -> priority high, status open, created"
eq "$(SR "$(TKT ATT-5B call-5 null null "'PAY-7002'" compliance k5-review)" | cut -d'|' -f2)" high "review-required payout -> priority high"
eq "$(SR "$(TKT ATT-5B call-5 "'CUS-1001'" "'TXN-9001'" null payment k5-processing)" | cut -d'|' -f2)" normal "processing transaction -> priority normal"
eq "$(SR "$(TKT ATT-5B call-5 null null null other k5-none)" | cut -d'|' -f2)" normal "nothing linked -> priority normal"
T1=$(SR "$(TKT ATT-5B call-5 "'CUS-1004'" "'TXN-9004'" null payment k5-failed)")
eq "${T1##*|}|$(q "select count(*) from support_tickets where idempotency_key='k5-failed'")" "false|1" "same idempotency key -> existing ticket, created=false, one row"
eq "${T1%%|*}" "$(q "select ticket_id from support_tickets where idempotency_key='k5-failed'")" "duplicate returns the existing ticket_id"

# Old escalation signature gone; v2 is the only one.
eq "$(q "select to_regprocedure('create_escalation_with_ticket(text,text,text,text,text,text,text,text,text,text,text,boolean,text)') is null")" t "old 13-argument create_escalation_with_ticket dropped"
eq "$(q "select count(*) from pg_proc where proname='create_escalation_with_ticket'")" 1 "exactly one create_escalation_with_ticket"
eq "$(q "select (proargnames)[1] from pg_proc where proname='create_escalation_with_ticket'")" p_attempt_id "v2's first argument is p_attempt_id"

# Verified customer.
eq "$(SR "select set_verified_customer('ATT-5B','call-5','CUS-1004')")|$(q "select verified_customer_id from conversations where conversation_id='call-5'")" "CUS-1004|CUS-1004" "set_verified_customer sets conversations.verified_customer_id"
eq "$(SR "select set_verified_customer('ATT-5B','call-5','CUS-1004')")" CUS-1004 "re-verifying the same customer is a no-op"
has_code "$(perr "select set_verified_customer('ATT-5B','call-5','CUS-1001')")" "P0001: VERIFIED_CUSTOMER_CONFLICT" "a different customer is refused (VERIFIED_CUSTOMER_CONFLICT)"
eq "$(q "select verified_customer_id from conversations where conversation_id='call-5'")" CUS-1004 "verified customer unchanged after the conflict"

# conversation_events.
EV=$(SR "select log_conversation_event_guarded('ATT-5B','call-5',0,'ticket_created','Ticket created for a failed payout','{\"ticket_id\":\"x\"}')")
eq "$(q "select event_type||'|'||attempt_id||'|'||turn_index from conversation_events where id=$EV")" "ticket_created|ATT-5B|0" "event written with attempt_id and turn_index"
neg "set role service_role; select log_conversation_event_guarded('ATT-5B','call-5',0,'refund_issued','x')" "unknown event_type"
neg "set role service_role; select log_conversation_event_guarded('ATT-5B','call-5',0,'other',repeat('x',501))" "summary over 500 characters"
neg "set role service_role; select log_conversation_event_guarded('ATT-5B','call-5',0,'other','x','[1,2]')" "metadata that is not an object"
neg "set role service_role; select log_conversation_event_guarded('ATT-5B','call-5',0,'other','x',jsonb_build_object('big',repeat('x',5000)))" "metadata over 4 KB"
eq "$(q "select relrowsecurity from pg_class where relname='conversation_events'")" t "RLS enabled on conversation_events"
eq "$(q "set role anon; select count(*) from conversation_events")" 0 "anon reads 0 events"
eq "$(q "select count(*) from information_schema.columns where table_name='conversations' and column_name in ('ended_reason','vapi_metrics')")" 2 "conversations.ended_reason and vapi_metrics added"

# Stale attempts.
pg -c "insert into turn_attempts(attempt_id,conversation_id,turn_index,transcript_hash,started_at) values ('ATT-OLD','call-5',3,'h-old',now()-interval '90 seconds')"
eq "$(SR "select array_to_string(replaced_attempt_ids,',') from begin_turn_attempt('call-5','voice',null,3,'ATT-NEW','h-new','hello')")" "" "stale attempt is not reported as replaced"
eq "$(q "select status||'|'||status_reason from turn_attempts where attempt_id='ATT-OLD'")" "failed|stale" "active attempt older than 60 s -> failed (stale)"
pg -c "insert into turn_attempts(attempt_id,conversation_id,turn_index,transcript_hash,started_at) values ('ATT-FRESH','call-5',4,'h-f',now()-interval '10 seconds')"
eq "$(SR "select array_to_string(replaced_attempt_ids,',') from begin_turn_attempt('call-5','voice',null,4,'ATT-NEW2','h-new2','hello')")" ATT-FRESH "attempt younger than 60 s is replaced as before"
eq "$(q "select status from turn_attempts where attempt_id='ATT-FRESH'")" replaced "fresh attempt status replaced"

# Abandonment.
pg -c "insert into conversations(conversation_id,channel,started_at) values ('call-idle','voice',now()-interval '20 minutes'), ('call-busy','voice',now()-interval '20 minutes')"
pg -c "insert into turn_attempts(attempt_id,conversation_id,turn_index,transcript_hash,started_at) values ('ATT-IDLE','call-idle',0,'hi',now()-interval '18 minutes')"
pg -c "insert into conversation_turns(conversation_id,turn_index,answer_type,t_received) values ('call-busy',0,'answer',now()-interval '1 minute')"
eq "$(SR "select abandon_stale_conversations()")" 1 "abandon_stale_conversations marks exactly the idle conversation"
eq "$(q "select final_status from conversations where conversation_id='call-idle'")|$(q "select final_status from conversations where conversation_id='call-busy'")" "abandoned|active" "idle 15+ min -> abandoned; recent turn activity -> still active"
eq "$(q "select ended_at = (select started_at from turn_attempts where attempt_id='ATT-IDLE') from conversations where conversation_id='call-idle'")" t "ended_at = last activity (the attempt start)"
eq "$(q "select status||'|'||status_reason from turn_attempts where attempt_id='ATT-IDLE'")" "failed|stale" "its still-active attempt -> failed (stale)"
eq "$(SR "select abandon_stale_conversations()")" 0 "second run marks nothing"

echo "--- migration 006: escalation enrichment and the notification outbox (D82)"
pg -c "insert into conversations(conversation_id,channel) values ('call-enr','voice')"
pg -c "insert into turn_attempts(attempt_id,conversation_id,turn_index,transcript_hash) values ('ATT-SPEC','call-enr',3,'h-spec')"
ENR="select ticket_id||'|'||escalation_id||'|'||created||'|'||updated from create_escalation_with_ticket(
  p_attempt_id => ATT, p_conversation_id => 'call-enr', p_ticket_idempotency_key => 'tk-enr', p_escalation_idempotency_key => 'esc-enr',
  p_category => 'account', p_ticket_summary => 'Account restricted', p_reason => 'Account restriction',
  p_user_name => 'Amara Okafor', p_user_email => 'amara@lagosledger.example', p_call_booked => BOOKED, p_preferred_time_text => TIME)"
call_enr() { SR "$(echo "$ENR" | sed "s/ATT/'$1'/; s/BOOKED/$2/; s/TIME/$3/")"; }
E1=$(call_enr ATT-SPEC false null)
eq "${E1##*|}" false "speculative attempt creates the escalation without a time (updated=false)"
eq "$(echo "$E1" | cut -d'|' -f3)" true "speculative attempt: created=true"
eq "$(q "select coalesce(preferred_time_text,'NULL')||'|'||call_booked from escalations where idempotency_key='esc-enr'")" "NULL|false" "stored without a time, call_booked false"
# The speculative attempt is replaced; the full attempt carries the time.
pg -c "update turn_attempts set status='replaced', ended_at=now() where attempt_id='ATT-SPEC'"
pg -c "insert into turn_attempts(attempt_id,conversation_id,turn_index,transcript_hash) values ('ATT-FULL','call-enr',3,'h-full')"
E2=$(call_enr ATT-FULL true "'tomorrow morning'")
eq "$(echo "$E2" | cut -d'|' -f1-2)" "$(echo "$E1" | cut -d'|' -f1-2)" "full attempt returns the SAME ticket and escalation"
eq "$(echo "$E2" | cut -d'|' -f3-4)" "false|true" "full attempt: created=false, updated=true"
eq "$(q "select count(*) from escalations where idempotency_key='esc-enr'")" 1 "still exactly one escalation row"
eq "$(q "select preferred_time_text||'|'||call_booked from escalations where idempotency_key='esc-enr'")" "tomorrow morning|true" "missing time filled, call_booked true"
E3=$(call_enr ATT-FULL true "'Friday 3pm'")
eq "$(echo "$E3" | cut -d'|' -f3-4)" "false|false" "a later, different time: updated=false"
eq "$(q "select preferred_time_text from escalations where idempotency_key='esc-enr'")" "tomorrow morning" "a set time is never overwritten"
pg -c "insert into turn_attempts(attempt_id,conversation_id,turn_index,transcript_hash) values ('ATT-BLANK','call-enr',4,'h-b')"
E4=$(SR "$(echo "$ENR" | sed "s/ATT/'ATT-BLANK'/; s/BOOKED/true/; s/TIME/'   '/; s/'esc-enr'/'esc-blank'/; s/'tk-enr'/'tk-blank'/")")
eq "$(q "select coalesce(preferred_time_text,'NULL')||'|'||call_booked from escalations where idempotency_key='esc-blank'")" "NULL|false" "a blank time is stored as NULL, call_booked false"
pg -c "update turn_attempts set status='replaced', ended_at=now() where attempt_id='ATT-FULL'"
has_code "$(perr "set role service_role; select * from create_escalation_with_ticket(p_attempt_id => 'ATT-FULL', p_conversation_id => 'call-enr', p_ticket_idempotency_key => 'tk-blank', p_escalation_idempotency_key => 'esc-blank', p_category => 'account', p_ticket_summary => 's', p_reason => 'r', p_user_name => 'A', p_user_email => 'a@b.co', p_call_booked => true, p_preferred_time_text => 'tonight')")" "P0001: ATTEMPT_NOT_ACTIVE" "enrichment by a replaced attempt is denied by the guard"
eq "$(q "select coalesce(preferred_time_text,'NULL') from escalations where idempotency_key='esc-blank'")" "NULL" "denied enrichment changed nothing"
# Outbox.
eq "$(q "select string_agg(kind, ',' order by id) from notification_outbox where conversation_id='call-enr'")" "escalation_created,escalation_updated,escalation_created" "outbox: created, updated (once), created (blank-time escalation)"
eq "$(q "select payload->>'preferred_time_text' from notification_outbox where kind='escalation_updated' and conversation_id='call-enr'")" "tomorrow morning" "the update notification carries the new time"
eq "$(q "select count(*) from notification_outbox where payload::text ~* 'amount|currency|support_notes'")" 0 "no amounts or notes in any payload"
eq "$(q "select status||'|'||attempts from notification_outbox where kind='escalation_updated' and conversation_id='call-enr'")" "pending|0" "queued as pending (no sender in 006)"
pg -c "insert into turn_attempts(attempt_id,conversation_id,turn_index,transcript_hash) values ('ATT-TK6','call-enr',5,'h-tk6')"
TK6="select created from create_support_ticket_guarded('ATT-TK6','call-enr',null,'TXN-9004',null,'payment','Payment failed, beneficiary details','tk6')"
eq "$(SR "$TK6")|$(SR "$TK6")" "t|f" "ticket: created, then the repeat returns it"
eq "$(q "select count(*)||'|'||max(payload->>'priority') from notification_outbox where kind='ticket_created' and conversation_id='call-enr'")" "1|high" "exactly one ticket_created notification (priority high for failed TXN-9004)"
neg "insert into notification_outbox(conversation_id,kind,ref_id,dedupe_key,payload) select conversation_id,kind,ref_id,dedupe_key,payload from notification_outbox where kind='ticket_created' and conversation_id='call-enr'" "duplicate dedupe_key"
neg "insert into notification_outbox(conversation_id,kind,ref_id,dedupe_key,payload) values ('call-enr','sms_sent','x','k-x','{}')" "unknown notification kind"
neg "insert into notification_outbox(conversation_id,kind,ref_id,dedupe_key,payload,status) values ('call-enr','ticket_created','x','k-y','{}','sent')" "status sent without sent_at"
eq "$(q "select relrowsecurity from pg_class where relname='notification_outbox'")" t "RLS enabled on notification_outbox"
eq "$(q "select has_table_privilege('anon','notification_outbox','select')")|$(q "select has_table_privilege('authenticated','notification_outbox','select')")" "f|f" "anon/authenticated have no SELECT on the outbox"
eq "$(q "select has_function_privilege('anon','queue_notification(text,text,text,text,jsonb)','execute')")|$(q "select has_function_privilege('service_role','queue_notification(text,text,text,text,jsonb)','execute')")" "f|t" "only service_role executes queue_notification"
eq "$(SR "select log_conversation_event_guarded('ATT-TK6','call-enr',5,'escalation_updated','Escalation enriched',jsonb_build_object('field','preferred_time_text')) is not null")" t "event type escalation_updated accepted"

echo "--- migration 007: one-time call passes (D86)"
H() { printf '%064d' "$1"; }   # a well-formed 64-hex hash
UID1="11111111-1111-4111-8111-111111111111"
RP() { SR "select status||'|'||coalesce(user_id::text,'-')||'|'||coalesce(role,'-')||'|'||coalesce(customer_id,'-') from redeem_call_pass($1)"; }
SR "insert into call_passes(pass_hash,user_id,role) values ('$(H 1)','$UID1','customer')" >/dev/null
SR "insert into call_passes(pass_hash,user_id,role,customer_id) values ('$(H 2)','$UID1','customer','CUS-1001')" >/dev/null
SR "insert into call_passes(pass_hash,user_id,role,created_at,expires_at) values ('$(H 3)','$UID1','staff',now()-interval '6 minutes',now()-interval '1 minute')" >/dev/null
eq "$(q "select (expires_at - created_at)::text from call_passes where pass_hash='$(H 1)'")" "00:05:00" "a pass expires 5 minutes after issue by default"
eq "$(RP "'conv-p1','$(H 1)'")" "ok|$UID1|customer|-" "valid pass: ok, linked to the conversation"
eq "$(q "select (used_at is not null)||'|'||conversation_id from call_passes where pass_hash='$(H 1)'")" "true|conv-p1" "marked used and linked"
eq "$(RP "'conv-p1',null")" "ok|$UID1|customer|-" "later turn of the linked conversation: ok without a pass"
eq "$(RP "'conv-p1','$(H 1)'")" "ok|$UID1|customer|-" "speculative retry of turn 0 with the same pass: ok"
eq "$(RP "'conv-p2','$(H 1)'")" "reused|-|-|-" "the same pass on another conversation: reused"
eq "$(RP "'conv-p3',null")" "missing|-|-|-" "no pass: missing"
eq "$(RP "'conv-p3','$(H 9)'")" "invalid|-|-|-" "unknown (forged) pass: invalid"
eq "$(RP "'conv-p3','not-hex'")" "invalid|-|-|-" "malformed pass hash: invalid"
eq "$(RP "'conv-p3','$(H 3)'")" "expired|-|-|-" "expired pass: expired"
eq "$(q "select used_at is null from call_passes where pass_hash='$(H 3)'")" t "an expired pass is not marked used"
eq "$(RP "'conv-p4','$(H 2)'")" "ok|$UID1|customer|CUS-1001" "mapped pass returns its customer_id (L3)"
SR "insert into call_passes(pass_hash,user_id,role) values ('$(H 4)','$UID1','customer')" >/dev/null
eq "$(RP "'conv-p4','$(H 4)'")" "ok|$UID1|customer|CUS-1001" "a second pass on an already-linked conversation: ok, the conversation keeps its first pass"
eq "$(q "select used_at is null from call_passes where pass_hash='$(H 4)'")" t "the second pass stays unused"
eq "$(RP "'','$(H 4)'")" "missing|-|-|-" "empty conversation id: missing"
neg "insert into call_passes(pass_hash,user_id,role) values ('$(H 5)','$UID1','admin')" "unknown role"
neg "insert into call_passes(pass_hash,user_id,role) values ('abc','$UID1','customer')" "pass_hash not 64 hex"
neg "insert into call_passes(pass_hash,user_id,role,expires_at) values ('$(H 6)','$UID1','customer',now()+interval '1 hour')" "expiry longer than 10 minutes"
neg "insert into call_passes(pass_hash,user_id,role,customer_id) values ('$(H 7)','$UID1','customer','CUS-9999')" "unknown customer_id"
neg "insert into call_passes(pass_hash,user_id,role,used_at) values ('$(H 8)','$UID1','customer',now())" "used without a conversation"
neg "insert into call_passes(pass_hash,user_id,role) values ('$(H 1)','$UID1','customer')" "duplicate pass_hash"
neg "update call_passes set conversation_id='conv-p1', used_at=now() where pass_hash='$(H 4)'" "two passes on one conversation"
eq "$(q "select has_table_privilege('anon','call_passes','select')")|$(q "select has_table_privilege('authenticated','call_passes','select')")|$(q "select has_table_privilege('service_role','call_passes','insert')")" "f|f|t" "only service_role reads or writes call_passes"
eq "$(q "select has_function_privilege('anon','redeem_call_pass(text,text)','execute')")|$(q "select has_function_privilege('authenticated','redeem_call_pass(text,text)','execute')")|$(q "select has_function_privilege('service_role','redeem_call_pass(text,text)','execute')")" "f|f|t" "only service_role executes redeem_call_pass"

echo "--- migration 008: call pass sources and identity from a form pass (D88)"
SR "insert into call_passes(pass_hash,source,customer_id) values ('$(H 21)','form_customer','CUS-1001')" >/dev/null
SR "insert into call_passes(pass_hash,source) values ('$(H 22)','guest')" >/dev/null
eq "$(q "select source from call_passes where pass_hash='$(H 1)'")" "login" "existing (007) passes become source login"
neg "insert into call_passes(pass_hash,source) values ('$(H 23)','form_customer')" "form_customer pass without a customer"
neg "insert into call_passes(pass_hash,source,customer_id) values ('$(H 24)','guest','CUS-1001')" "guest pass with a customer"
neg "insert into call_passes(pass_hash,source,user_id,role) values ('$(H 25)','guest','$UID1','customer')" "guest pass with a user"
neg "insert into call_passes(pass_hash,source) values ('$(H 26)','login')" "login pass without a user"
neg "insert into call_passes(pass_hash,source) values ('$(H 27)','sso')" "unknown source"
AP() { SR "select coalesce(apply_call_pass_identity($1),'-')"; }
eq "$(RP "'conv-f1','$(H 21)'")" "ok|-|-|CUS-1001" "form pass redeems ok with its customer"
eq "$(AP "'conv-f1','voice',null")" "CUS-1001" "form pass: identity applied before the first turn (conversation created)"
eq "$(q "select channel||'|'||verified_customer_id from conversations where conversation_id='conv-f1'")" "voice|CUS-1001" "conversation verified as the pass's customer"
eq "$(q "select count(*)||'|'||max(event_type) from conversation_events where conversation_id='conv-f1'")" "1|identity_verified" "one identity_verified event"
eq "$(AP "'conv-f1','voice',null")|$(q "select count(*) from conversation_events where conversation_id='conv-f1'")" "CUS-1001|1" "applying again: same customer, no second event"
eq "$(RP "'conv-g1','$(H 22)'")" "ok|-|-|-" "guest pass redeems ok with no customer"
eq "$(AP "'conv-g1','voice',null")" "-" "guest pass: no identity applied"
eq "$(q "select count(*) from conversations where conversation_id='conv-g1'")" 0 "guest: no conversation row created by the pass"
eq "$(AP "'conv-p1','voice',null")" "-" "login pass (007): no identity applied"
eq "$(AP "'conv-none','voice',null")" "-" "no redeemed pass: nothing applied"
SR "insert into call_passes(pass_hash,source,customer_id) values ('$(H 28)','form_customer','CUS-1002')" >/dev/null
pg -c "insert into conversations(conversation_id,channel,verified_customer_id) values ('conv-f2','voice','CUS-1001')" >/dev/null
SR "select status from redeem_call_pass('conv-f2','$(H 28)')" >/dev/null
neg "set role service_role; select apply_call_pass_identity('conv-f2','voice',null)" "conversation already verified as another customer"
eq "$(q "select has_function_privilege('anon','apply_call_pass_identity(text,text,text)','execute')")|$(q "select has_function_privilege('authenticated','apply_call_pass_identity(text,text,text)','execute')")|$(q "select has_function_privilege('service_role','apply_call_pass_identity(text,text,text)','execute')")" "f|f|t" "only service_role executes apply_call_pass_identity"

# Privileges on every new or replaced function.
for fn in "check_attempt_scope(text,text,integer)" "create_support_ticket_guarded(text,text,text,text,text,text,text,text)" "create_escalation_with_ticket(text,text,text,text,text,text,text,text,text,text,text,text,boolean,text)" "set_verified_customer(text,text,text)" "log_conversation_event_guarded(text,text,integer,text,text,jsonb)" "begin_turn_attempt(text,text,text,integer,text,text,text)" "abandon_stale_conversations(integer)"; do
  eq "$(q "select has_function_privilege('anon','$fn','execute')")|$(q "select has_function_privilege('authenticated','$fn','execute')")|$(q "select has_function_privilege('service_role','$fn','execute')")" "f|f|t" "only service_role executes ${fn%%(*}"
done

echo "--- failures: $FAILS"
exit $FAILS
