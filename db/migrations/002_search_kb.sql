-- 002_search_kb.sql
-- Ranked OR-query search over kb_chunks, called by shared/src/retrieval.ts via supabase.rpc.
--
-- The query text is normalized with the same 'english' config as kb_chunks.search_tsv, which
-- drops stopwords and stems. p_exclude_words (corpus-common words such as 'relaypay') are
-- stemmed the same way and removed. The remaining lexemes are OR-ed, so a natural question
-- matches on any informative word rather than requiring all of them. Results are ranked with
-- ts_rank_cd(search_tsv, query, p_normalization) and only rows with rank >= p_min_rank are
-- returned, best first, at most p_match_count (clamped to 1..20).
-- A query with no informative lexemes returns no rows.

begin;

create function search_kb(
  p_query         text,
  p_match_count   integer,
  p_min_rank      real,
  p_normalization integer default 32,
  p_exclude_words text[]  default '{}'
)
returns table (chunk_id text, source_title text, heading text, content text, rank real)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_terms text;
  v_query tsquery;
begin
  select string_agg(
           -- Quote each lexeme as a tsquery literal: escape backslashes and single quotes.
           '''' || replace(replace(q.lexeme, '\', '\\'), '''', '''''') || '''',
           ' | ' order by q.lexeme)
    into v_terms
    from (
      select t.lexeme
        from unnest(to_tsvector('english', coalesce(p_query, ''))) as t
      except
      select x.lexeme
        from unnest(to_tsvector('english', array_to_string(coalesce(p_exclude_words, '{}'), ' '))) as x
    ) q;

  if v_terms is null then
    return;  -- nothing informative to search for
  end if;
  v_query := v_terms::tsquery;

  return query
    select r.chunk_id, r.source_title, r.heading, r.content, r.rank
      from (
        select k.chunk_id, k.source_title, k.heading, k.content,
               ts_rank_cd(k.search_tsv, v_query, p_normalization)::real as rank
          from kb_chunks k
         where k.search_tsv @@ v_query
      ) r
     where r.rank >= p_min_rank
     order by r.rank desc, r.chunk_id
     limit greatest(1, least(coalesce(p_match_count, 4), 20));
end;
$$;

revoke execute on function search_kb(text, integer, real, integer, text[]) from public, anon, authenticated;
grant execute on function search_kb(text, integer, real, integer, text[]) to service_role;

commit;
