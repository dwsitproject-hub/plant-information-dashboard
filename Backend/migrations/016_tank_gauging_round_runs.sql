-- The scheduled gauge poll's attempts at each daily round of a site: when it ran, how many times, how it went.
-- The poll runs at the round times set in Master > Tank gauging > Daily rounds. A failed attempt is tried
-- again every 20 minutes, up to 6 more times; then the round is marked failed.
CREATE TABLE IF NOT EXISTS tank_gauging_round_runs (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  recorded_on DATE NOT NULL,
  round_index INT NOT NULL,
  target_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('retrying', 'ok', 'failed')),
  attempts INT NOT NULL DEFAULT 0,
  first_attempt_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  written INT NOT NULL DEFAULT 0,
  missing INT NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (site_id, recorded_on, round_index)
);

CREATE INDEX IF NOT EXISTS tank_gauging_round_runs_recent ON tank_gauging_round_runs (site_id, target_at DESC);
