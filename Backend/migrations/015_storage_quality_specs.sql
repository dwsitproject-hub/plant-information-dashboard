-- Storage quality specs per site and commodity, edited on Master > Commodities.
-- quality_rules already holds the shape (site, commodity, scope, parameter, bound, limit, severity).
-- This adds who changed a rule and when, and loads starting limits for sites that already have storage
-- results. A site with no results gets no limits: it stays "spec pending" until QC sets its own.

BEGIN;

ALTER TABLE quality_rules
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_by BIGINT;

COMMENT ON TABLE quality_rules IS
  'Quality limits per site and commodity. scope storage = tank results (Master > Commodities); inbound = trucks and vessels. severity reject quarantines a tank; watch only flags the figure. lab.odor has no limit: the result must pass.';

-- Starting limits: common palm-oil trade specifications and the site''s CPO contract header.
-- Only where the commodity exists and the site has no storage rule for it yet.
INSERT INTO quality_rules (site_id, commodity_id, scope, parameter_code, bound, limit_value, severity)
SELECT s.id, v.commodity_id, 'storage', v.parameter_code, v.bound, v.limit_value, v.severity
FROM sites s
CROSS JOIN (VALUES
  ('cpo',   'lab.ffa',         'max', 5::numeric, 'reject'),
  ('cpo',   'lab.moisture',    'max', 0.5,  'reject'),
  ('cpo',   'lab.dobi',        'min', 2,    'reject'),
  ('cpo',   'lab.iv',          'min', 50,   'watch'),
  ('cpo',   'lab.iv',          'max', 55,   'watch'),
  ('cpo',   'lab.carotene',    'min', 500,  'watch'),
  ('rpo',   'lab.ffa',         'max', 0.1,  'reject'),
  ('rpo',   'lab.moisture',    'max', 0.1,  'reject'),
  ('rpo',   'lab.color_r',     'max', 3,    'reject'),
  ('rpo',   'lab.iv',          'min', 50,   'reject'),
  ('rpo',   'lab.iv',          'max', 55,   'reject'),
  ('rpo',   'lab.smp',         'min', 33,   'reject'),
  ('rpo',   'lab.smp',         'max', 39,   'reject'),
  ('rpo',   'lab.pv',          'max', 2,    'watch'),
  ('rpo',   'lab.odor',        'max', NULL, 'reject'),
  ('olein', 'lab.ffa',         'max', 0.1,  'reject'),
  ('olein', 'lab.moisture',    'max', 0.1,  'reject'),
  ('olein', 'lab.color_r',     'max', 3,    'reject'),
  ('olein', 'lab.iv',          'min', 56,   'reject'),
  ('olein', 'lab.cloud_point', 'max', 10,   'reject'),
  ('olein', 'lab.pv',          'max', 2,    'watch'),
  ('olein', 'lab.odor',        'max', NULL, 'reject'),
  ('rps',   'lab.ffa',         'max', 0.2,  'reject'),
  ('rps',   'lab.moisture',    'max', 0.15, 'reject'),
  ('rps',   'lab.color_r',     'max', 3,    'reject'),
  ('rps',   'lab.iv',          'max', 48,   'reject'),
  ('rps',   'lab.smp',         'min', 44,   'reject'),
  ('rps',   'lab.odor',        'max', NULL, 'reject'),
  ('pfad',  'lab.ffa',         'min', 70,   'reject'),
  ('pfad',  'lab.moisture',    'max', 1,    'reject'),
  ('pfad',  'lab.odor',        'max', NULL, 'reject')
) AS v (commodity_id, parameter_code, bound, limit_value, severity)
JOIN commodities c ON c.id = v.commodity_id
WHERE EXISTS (SELECT 1 FROM storage_certificates sc WHERE sc.site_id = s.id)
  AND NOT EXISTS (
    SELECT 1 FROM quality_rules q
    WHERE q.site_id = s.id AND q.commodity_id = v.commodity_id AND q.scope = 'storage'
  )
ON CONFLICT DO NOTHING;

COMMIT;
