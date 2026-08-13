-- Extend price_history retention so 30D / ALL chart ranges can return real data.
-- Previous cleanup kept only 7 days while the API advertised 30D and ALL.
-- 90 days covers 30D with headroom for ALL adaptive buckets.
--
-- PORTABLE: no hard-coded \c database switches.
-- Apply against the *connected* database (staging/prod/local):
--
--   psql "$DATABASE_URL" -f db/migrations/007_extend_price_history_retention.sql
--   # or:
--   psql -U jd -d <staging_db_name> -f db/migrations/007_extend_price_history_retention.sql
--
-- Name map (confirm on the target host before running):
--   README / migrations historically: coins_x , coins_x_test
--   Some local hosts:                 coins   , coins_test
-- Run once per environment database that holds price_history (app + test).

CREATE OR REPLACE FUNCTION cleanup_price_history() RETURNS void AS $$
BEGIN
  DELETE FROM price_history WHERE created_at < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;
