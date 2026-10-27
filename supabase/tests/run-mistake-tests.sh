#!/usr/bin/env bash
# Runs the mistake-definition SQL tests against a disposable local database.
#
#   supabase/tests/run-mistake-tests.sh
#
# Requires a PostgreSQL superuser connection on the default socket
# (run it as the postgres user, or set PGHOST/PGPORT/PGUSER).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB="${MISTAKE_TEST_DB:-porokh_mistake_test}"
ADMIN_DB="${MISTAKE_TEST_ADMIN_DB:-postgres}"

echo "==> resetting $DB"
psql -d "$ADMIN_DB" -q -c "drop database if exists $DB" -c "create database $DB"

echo "==> loading minimal schema"
psql -d "$DB" -q -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/fixtures/mistake_minimal_schema.sql"

echo "==> applying the mistake source-of-truth migration"
psql -d "$DB" -q -v ON_ERROR_STOP=1 -f "$ROOT/supabase/migrations/20261027090000_mistake_dismissals.sql"
psql -d "$DB" -q -v ON_ERROR_STOP=1 -f "$ROOT/supabase/migrations/20261027120000_mistake_source_of_truth.sql"

echo "==> running behaviour tests"
psql -d "$DB" -q -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/mistake_source_of_truth.test.sql"

echo "==> all mistake tests passed"
