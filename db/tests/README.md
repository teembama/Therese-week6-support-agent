# db tests

Shell tests for `db/migrations/`. They run against a **throwaway local Postgres cluster** and never against Supabase.

## What they do

Each script:

1. creates a fresh cluster in a temp directory, listening on localhost only;
2. creates Supabase-like `anon`, `authenticated` and `service_role` roles with Supabase's default grants;
3. applies every migration in `db/migrations/`, in filename order;
4. runs its checks;
5. stops the cluster and deletes it on exit.

| Script | Checks |
| --- | --- |
| `schema-suite.sh` | 48 checks: seed load, RLS on with no policies, CHECK and FK rejections, `search_kb` (OR semantics, stopword-only and excluded-word queries, min rank, match count, quoting, privileges), `create_escalation_with_ticket` (idempotency, no orphan ticket, `P0001 ESCALATION_KEY_CONFLICT`), and privileges (anon can't execute the functions or read any rows) |
| `race.sh` | Two real concurrent sessions calling the function with the same keys. Session B must block on A's lock, then return A's IDs with `created=false`, leaving exactly one ticket and one escalation |

## Safety: they can't reach Supabase

- The connection host must be `localhost`, `127.0.0.1` or `::1`. Otherwise the script refuses to run and exits with code 2.
- All libpq and Supabase environment variables are unset before anything runs. This includes `PGHOST`, `PGHOSTADDR`, `DATABASE_URL`, `SUPABASE_URL` and the keys.
- Every `psql` call goes through one wrapper, which re-checks the host.
- If the test port is already in use, the script aborts. It never reuses a server it didn't start.

## Running

You need the Postgres server binaries (`initdb`, `pg_ctl`, `psql`) on this machine. The scripts look for them on `PATH`, then in `C:\Program Files\PostgreSQL\<ver>\bin`. To point at a specific install, set `PG_BIN`.

```bash
bash db/tests/schema-suite.sh     # port 54329 by default
bash db/tests/race.sh             # port 54330 by default
TEST_PG_PORT=55000 bash db/tests/schema-suite.sh   # choose a different port
```

Exit code 0 means every check passed. Otherwise the exit code is the number of failed checks, or 2 for a setup or refusal error.
