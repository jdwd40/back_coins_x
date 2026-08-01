-- Extend price_history retention so 30D / ALL chart ranges can return real data.
-- Previous cleanup kept only 7 days while the API advertised 30D and ALL.
-- 90 days covers 30D with headroom for ALL adaptive buckets (~15–45 MB raw ticks).
-- Apply manually on staging/prod before relying on long ranges (same as migration 006).

\c coins_x jd;

CREATE OR REPLACE FUNCTION cleanup_price_history() RETURNS void AS $$
BEGIN
  DELETE FROM price_history WHERE created_at < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;

\c coins_x_test jd;

CREATE OR REPLACE FUNCTION cleanup_price_history() RETURNS void AS $$
BEGIN
  DELETE FROM price_history WHERE created_at < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;
