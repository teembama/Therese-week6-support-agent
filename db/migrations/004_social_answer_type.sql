-- 004_social_answer_type.sql
-- Adds 'social' to conversation_turns.answer_type (docs/decisions.md D31): the model only picks a
-- social intent (thanks / goodbye / greeting) and the backend speaks a fixed line, so these turns
-- need their own answer type instead of being forced into 'answer' (blocked: no kb) or 'clarify'.
-- Only this change; Phase 2 gets its own migration.

begin;

alter table conversation_turns drop constraint conversation_turns_answer_type_check;
alter table conversation_turns add constraint conversation_turns_answer_type_check
  check (answer_type in ('answer', 'clarify', 'escalate', 'decline', 'blocked', 'error', 'social'));

commit;
