-- Synthetic demo data only. Shared file: change only at a sync point.
-- X = CAGUAS (two approved responders, demo of the claim race), Y = SAN JUAN.
-- Zone names are real LUMA zones seen in the 2026-10-09 readings.

INSERT INTO organizations (id, name, kind, org_type, contact_email, status) VALUES
  (1, 'Plan de Salud Demo',              'responder', 'health-plan',  'demo-plan@example.org',   'approved'),
  (2, 'Oficina de Emergencias Demo',     'responder', 'municipality', 'demo-ome@example.org',    'approved'),
  (3, 'Suplidor de Oxígeno Demo',        'responder', 'supplier',     'demo-dme@example.org',    'pending'),
  (4, 'Hogar de Envejecientes Demo',     'facility',  'care-home',    'demo-hogar@example.org',  'approved');

INSERT INTO org_municipalities (org_id, municipality) VALUES
  (1, 'CAGUAS'), (1, 'SAN JUAN'),
  (2, 'CAGUAS'),
  (3, 'SAN JUAN');

INSERT INTO users (id, name, role, org_id) VALUES
  (1, 'Admin Plataforma',             'admin',       NULL),
  (2, 'Coordinadora Plan de Salud',   'coordinator', 1),
  (3, 'Coordinador Emergencias',      'coordinator', 2),
  (4, 'Coordinadora Suplidor',        'coordinator', 3),
  (5, 'Cuidadora Ana (hija)',         'caregiver',   NULL),
  (6, 'Personal del Hogar',           'caregiver',   4),
  (7, 'Paciente Luis (auto-registro)','caregiver',   NULL);

INSERT INTO patients (id, caregiver_id, facility_id, is_self, display_name, phone, municipality, zone, consent_at, consent_version, confirmed_at) VALUES
  (1, 5, NULL, 0, 'Don Ramón (sintético)',   '787-555-0101', 'CAGUAS',   'URB VILLA BLANCA',         '2026-10-08T12:00:00Z', 'v1', '2026-10-08T12:00:00Z'),
  (2, 5, NULL, 0, 'Doña Carmen (sintética)', '787-555-0102', 'CAGUAS',   'CANABONCITO/SEC HORMIGAS', '2026-10-08T12:00:00Z', 'v1', '2026-10-08T12:00:00Z'),
  (3, 6, 4,    0, 'Doña Elena (sintética)',  '787-555-0103', 'SAN JUAN', 'HATO REY SUR',             '2026-10-08T12:00:00Z', 'v1', '2026-10-08T12:00:00Z'),
  (4, 6, 4,    0, 'Don Pedro (sintético)',   '787-555-0104', 'SAN JUAN', 'HATO REY SUR',             '2026-10-08T12:00:00Z', 'v1', '2026-10-08T12:00:00Z'),
  (5, 7, NULL, 1, 'Luis (sintético)',        '787-555-0105', 'CAGUAS',   'URB VILLA BLANCA',         '2026-10-08T12:00:00Z', 'v1', '2026-10-08T12:00:00Z');

INSERT INTO patient_needs (patient_id, kind, battery_hours) VALUES
  (1, 'oxygen',     2),
  (2, 'insulin',    NULL),
  (3, 'cpap',       6),
  (4, 'dialysis',   NULL),
  (5, 'ventilator', 4);

INSERT INTO zones (municipality, zone) VALUES
  ('CAGUAS',   'URB VILLA BLANCA'),
  ('CAGUAS',   'CANABONCITO/SEC HORMIGAS'),
  ('SAN JUAN', 'HATO REY SUR');
