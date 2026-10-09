// The 78 municipalities as LUMA spells them: uppercase, no acute accents, Ñ kept.
// Probed 2026-10-09: BAYAMON, SAN GERMAN, RINCON, GUANICA return zones without accents; AÑASCO only with Ñ.
// MAYAGUEZ (no Ü) follows the accent-free pattern; it was not confirmable because it had no outages that day.
export const MUNICIPALITIES = [
  'ADJUNTAS', 'AGUADA', 'AGUADILLA', 'AGUAS BUENAS', 'AIBONITO', 'AÑASCO', 'ARECIBO', 'ARROYO',
  'BARCELONETA', 'BARRANQUITAS', 'BAYAMON', 'CABO ROJO', 'CAGUAS', 'CAMUY', 'CANOVANAS', 'CAROLINA',
  'CATAÑO', 'CAYEY', 'CEIBA', 'CIALES', 'CIDRA', 'COAMO', 'COMERIO', 'COROZAL', 'CULEBRA', 'DORADO',
  'FAJARDO', 'FLORIDA', 'GUANICA', 'GUAYAMA', 'GUAYANILLA', 'GUAYNABO', 'GURABO', 'HATILLO',
  'HORMIGUEROS', 'HUMACAO', 'ISABELA', 'JAYUYA', 'JUANA DIAZ', 'JUNCOS', 'LAJAS', 'LARES',
  'LAS MARIAS', 'LAS PIEDRAS', 'LOIZA', 'LUQUILLO', 'MANATI', 'MARICAO', 'MAUNABO', 'MAYAGUEZ',
  'MOCA', 'MOROVIS', 'NAGUABO', 'NARANJITO', 'OROCOVIS', 'PATILLAS', 'PEÑUELAS', 'PONCE',
  'QUEBRADILLAS', 'RINCON', 'RIO GRANDE', 'SABANA GRANDE', 'SALINAS', 'SAN GERMAN', 'SAN JUAN',
  'SAN LORENZO', 'SAN SEBASTIAN', 'SANTA ISABEL', 'TOA ALTA', 'TOA BAJA', 'TRUJILLO ALTO', 'UTUADO',
  'VEGA ALTA', 'VEGA BAJA', 'VIEQUES', 'VILLALBA', 'YABUCOA', 'YAUCO',
] as const

export type Municipality = (typeof MUNICIPALITIES)[number]
