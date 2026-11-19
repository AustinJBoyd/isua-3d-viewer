// Measurement records and their CSV / GeoJSON export. Pure functions (testable in Node).
//
// A measurement is { id, label, type: 'point'|'distance'|'plane', points: [[x,y,z] ECEF ...],
//                    tileset, offset, created }. Derived values are recomputed from the points.

import { ecefToGeodetic, ecefToEnu, toUtm, fitPlane, measureDistance, formatOrientation } from './geomath.js';

const r = (x, d) => (x === undefined || x === null || Number.isNaN(x) ? '' : Number(x.toFixed(d)));

export function describePoint(p) {
  const g = ecefToGeodetic(p);
  const u = toUtm(g.lat, g.lon);
  return { lat: g.lat, lon: g.lon, h: g.h, easting: u.easting, northing: u.northing };
}

export function centroidOf(points) {
  return [0, 1, 2].map((i) => points.reduce((s, p) => s + p[i], 0) / points.length);
}

/** Recompute derived values for one measurement. */
export function evaluate(m) {
  if (m.type === 'point') return { at: describePoint(m.points[0]) };
  if (m.type === 'distance') return { at: describePoint(m.points[0]), ...measureDistance(m.points[0], m.points[1]) };
  if (m.type === 'plane') {
    const c = centroidOf(m.points);
    const fit = fitPlane(ecefToEnu(m.points, c));
    return { at: describePoint(c), ...fit, ...formatOrientation(fit) };
  }
  throw new Error(`unknown measurement type ${m.type}`);
}

export function summary(m) {
  const v = evaluate(m);
  if (m.type === 'point') return `${v.at.lat.toFixed(6)}, ${v.at.lon.toFixed(6)}, h ${v.at.h.toFixed(2)} m`;
  if (m.type === 'distance') return `3D ${v.distance3d.toFixed(2)} m · horiz ${v.horizontal.toFixed(2)} m · Δh ${v.dh >= 0 ? '+' : ''}${v.dh.toFixed(2)} m`;
  return `${v.dipDirDip} (dip dir/dip) · strike ${v.strikeDip} RHR · n=${v.n}, rms ${v.rms.toFixed(3)} m${v.poorlyConstrained ? ' · POORLY CONSTRAINED' : ''}`;
}

export const CSV_COLUMNS = [
  'id', 'label', 'type', 'tileset', 'vertical_offset_m',
  'lat', 'lon', 'h_ellipsoidal_m', 'h_model_m', 'utm22n_easting', 'utm22n_northing',
  'distance_3d_m', 'distance_horizontal_m', 'height_difference_m', 'azimuth_deg',
  'dip_direction_deg', 'dip_deg', 'strike_rhr_deg', 'n_points', 'rms_m', 'collinearity', 'poorly_constrained',
  'vertices_lon_lat_h', 'created',
];

function csvCell(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toRow(m) {
  const v = evaluate(m);
  const off = Number(m.offset) || 0;
  const verts = m.points.map((p) => { const g = ecefToGeodetic(p); return `${g.lon.toFixed(8)} ${g.lat.toFixed(8)} ${g.h.toFixed(3)}`; }).join('; ');
  return {
    id: m.id, label: m.label ?? '', type: m.type, tileset: m.tileset ?? '', vertical_offset_m: r(off, 3),
    lat: r(v.at.lat, 8), lon: r(v.at.lon, 8), h_ellipsoidal_m: r(v.at.h, 3), h_model_m: r(v.at.h - off, 3),
    utm22n_easting: r(v.at.easting, 3), utm22n_northing: r(v.at.northing, 3),
    distance_3d_m: r(v.distance3d, 3), distance_horizontal_m: r(v.horizontal, 3), height_difference_m: r(v.dh, 3),
    azimuth_deg: r(v.azimuth, 2),
    dip_direction_deg: r(v.dipDirection, 2), dip_deg: r(v.dip, 2), strike_rhr_deg: r(v.strike, 2),
    n_points: m.points.length, rms_m: r(v.rms, 4), collinearity: r(v.collinearity, 3),
    poorly_constrained: m.type === 'plane' ? String(!!v.poorlyConstrained) : '',
    vertices_lon_lat_h: verts, created: m.created ?? '',
  };
}

export function toCsv(measurements) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const m of measurements) {
    const row = toRow(m);
    lines.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function toGeoJson(measurements) {
  const lonLatH = (p) => { const g = ecefToGeodetic(p); return [Number(g.lon.toFixed(9)), Number(g.lat.toFixed(9)), Number(g.h.toFixed(3))]; };
  const features = measurements.map((m) => {
    const props = Object.fromEntries(Object.entries(toRow(m)).filter(([k, v]) => v !== '' && !['lat', 'lon', 'vertices_lon_lat_h'].includes(k)));
    let geometry;
    if (m.type === 'distance') geometry = { type: 'LineString', coordinates: m.points.map(lonLatH) };
    else if (m.type === 'plane') {
      geometry = { type: 'Point', coordinates: lonLatH(centroidOf(m.points)) };
      props.vertices = m.points.map(lonLatH);
    } else geometry = { type: 'Point', coordinates: lonLatH(m.points[0]) };
    return { type: 'Feature', id: m.id, geometry, properties: props };
  });
  return {
    type: 'FeatureCollection',
    // RFC 7946: WGS84 lon/lat; third coordinate is WGS84 ellipsoidal height in metres.
    properties: { heights: 'WGS84 ellipsoidal (m), as displayed incl. any vertical offset', azimuths: 'degrees from true north' },
    features,
  };
}
