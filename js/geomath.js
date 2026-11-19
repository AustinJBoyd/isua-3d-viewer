// Geodesy and structural-geology maths for the viewer. Pure functions, no Cesium, so they
// can be unit tested in Node. All angles in degrees unless noted; heights are WGS84 ellipsoidal.

export const WGS84 = { a: 6378137.0, f: 1 / 298.257223563 };
WGS84.e2 = WGS84.f * (2 - WGS84.f);

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export const normDeg = (d) => ((d % 360) + 360) % 360;

export function geodeticToEcef(latDeg, lonDeg, h) {
  const lat = latDeg * D2R, lon = lonDeg * D2R;
  const N = WGS84.a / Math.sqrt(1 - WGS84.e2 * Math.sin(lat) ** 2);
  return [
    (N + h) * Math.cos(lat) * Math.cos(lon),
    (N + h) * Math.cos(lat) * Math.sin(lon),
    (N * (1 - WGS84.e2) + h) * Math.sin(lat),
  ];
}

export function ecefToGeodetic([x, y, z]) {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - WGS84.e2));
  let h = 0;
  for (let i = 0; i < 8; i++) {
    const N = WGS84.a / Math.sqrt(1 - WGS84.e2 * Math.sin(lat) ** 2);
    h = p / Math.cos(lat) - N;
    lat = Math.atan2(z, p * (1 - (WGS84.e2 * N) / (N + h)));
  }
  const N = WGS84.a / Math.sqrt(1 - WGS84.e2 * Math.sin(lat) ** 2);
  h = p / Math.cos(lat) - N;
  return { lat: lat * R2D, lon: lon * R2D, h };
}

/** Unit vectors east, north, up (ECEF) at a geodetic position. */
export function enuAxes(latDeg, lonDeg) {
  const lat = latDeg * D2R, lon = lonDeg * D2R;
  const sl = Math.sin(lat), cl = Math.cos(lat), so = Math.sin(lon), co = Math.cos(lon);
  return { e: [-so, co, 0], n: [-sl * co, -sl * so, cl], u: [cl * co, cl * so, sl] };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** ECEF points -> local ENU coordinates (metres) relative to `origin` (ECEF). */
export function ecefToEnu(points, origin) {
  const g = ecefToGeodetic(origin);
  const ax = enuAxes(g.lat, g.lon);
  return points.map((p) => { const d = sub(p, origin); return [dot(d, ax.e), dot(d, ax.n), dot(d, ax.u)]; });
}

export function enuToEcef(enu, origin) {
  const g = ecefToGeodetic(origin);
  const ax = enuAxes(g.lat, g.lon);
  return [0, 1, 2].map((i) => origin[i] + enu[0] * ax.e[i] + enu[1] * ax.n[i] + enu[2] * ax.u[i]);
}

// ---------------------------------------------------------------- UTM (zone 22N by default)
// Transverse Mercator via Krüger series to n^6 (Karney 2011): sub-millimetre within the zone.
const n = WGS84.f / (2 - WGS84.f);
const n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
const A = (WGS84.a / (1 + n)) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
const ALPHA = [
  n / 2 - (2 / 3) * n2 + (5 / 16) * n3 + (41 / 180) * n4 - (127 / 288) * n5 + (7891 / 37800) * n6,
  (13 / 48) * n2 - (3 / 5) * n3 + (557 / 1440) * n4 + (281 / 630) * n5 - (1983433 / 1935360) * n6,
  (61 / 240) * n3 - (103 / 140) * n4 + (15061 / 26880) * n5 + (167603 / 181440) * n6,
  (49561 / 161280) * n4 - (179 / 168) * n5 + (6601661 / 7257600) * n6,
  (34729 / 80640) * n5 - (3418889 / 1995840) * n6,
  (212378941 / 319334400) * n6,
];

/**
 * Geodetic (WGS84) -> UTM. Zone 22 (central meridian 51 W) by default, as used for Isua
 * (EPSG:32622). Returns easting/northing in metres plus grid convergence (deg) and scale.
 */
export function toUtm(latDeg, lonDeg, zone = 22, north = true) {
  const k0 = 0.9996;
  const lon0 = (zone - 1) * 6 - 180 + 3;
  const phi = latDeg * D2R;
  const lam = (lonDeg - lon0) * D2R;
  const e = Math.sqrt(WGS84.e2);
  const tau = Math.tan(phi);
  const sigma = Math.sinh(e * Math.atanh((e * tau) / Math.sqrt(1 + tau * tau)));
  const taup = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
  const xip = Math.atan2(taup, Math.cos(lam));
  const etap = Math.asinh(Math.sin(lam) / Math.sqrt(taup * taup + Math.cos(lam) ** 2));
  let xi = xip, eta = etap, p = 1, q = 0;
  for (let j = 1; j <= 6; j++) {
    const a = ALPHA[j - 1];
    xi += a * Math.sin(2 * j * xip) * Math.cosh(2 * j * etap);
    eta += a * Math.cos(2 * j * xip) * Math.sinh(2 * j * etap);
    p += 2 * j * a * Math.cos(2 * j * xip) * Math.cosh(2 * j * etap);
    q += 2 * j * a * Math.sin(2 * j * xip) * Math.sinh(2 * j * etap);
  }
  const easting = 500000 + k0 * A * eta;
  const northing = (north ? 0 : 10000000) + k0 * A * xi;
  const gammaP = Math.atan2(q, p);
  const gammaPP = Math.atan2(taup * Math.tan(lam), Math.sqrt(1 + taup * taup));
  return { easting, northing, zone, hemisphere: north ? 'N' : 'S', convergence: (gammaP + gammaPP) * R2D };
}

// ---------------------------------------------------------------- plane fitting
/** Eigen-decomposition of a symmetric 3x3 matrix (cyclic Jacobi). Values ascending. */
export function eigenSym3(m) {
  const a = m.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
    if (off < 1e-30) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { // A = A * J
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) { // A = J^T * A
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return [0, 1, 2].map((i) => ({ value: a[i][i], vector: [v[0][i], v[1][i], v[2][i]] }))
    .sort((x, y) => x.value - y.value);
}

/**
 * Orientation of a plane from its normal in ENU coordinates.
 * Dip direction = azimuth (from true north) of the steepest descent; strike follows the
 * right-hand rule (dip to the right of strike): strike = dip direction - 90.
 */
export function orientationFromNormal([ne, nn, nu]) {
  const len = Math.hypot(ne, nn, nu);
  if (!(len > 0)) throw new Error('zero normal');
  let e = ne / len, nN = nn / len, u = nu / len;
  if (u < 0) { e = -e; nN = -nN; u = -u; } // upward normal
  const horiz = Math.hypot(e, nN);
  const dip = Math.atan2(horiz, u) * R2D;
  const isHorizontal = horiz < 1e-12;
  const isVertical = u < 1e-12;
  let dipDirection = isHorizontal ? 0 : normDeg(Math.atan2(e, nN) * R2D);
  // Vertical planes have two equivalent dip directions; report the one in [0, 180).
  if (isVertical && dipDirection >= 180) dipDirection -= 180;
  // Round tiny negatives / 360 artefacts to a canonical value.
  if (dipDirection >= 360 - 1e-9) dipDirection = 0;
  return { dip, dipDirection, strike: normDeg(dipDirection - 90), isHorizontal, isVertical };
}

/**
 * Total least-squares (orthogonal regression) plane through >= 3 points given in local ENU
 * metres. Works for vertical planes, unlike z = ax + by + c fits.
 * Returns orientation, centroid, unit normal (upward), RMS misfit (m) and a collinearity ratio
 * (sqrt of middle/largest eigenvalue; near 0 means the points are almost on a line and the
 * plane is poorly constrained).
 */
export function fitPlane(points) {
  if (points.length < 3) throw new Error('need at least 3 points');
  const c = [0, 1, 2].map((i) => points.reduce((s, p) => s + p[i], 0) / points.length);
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of points) {
    const d = sub(p, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += d[i] * d[j];
  }
  const eig = eigenSym3(cov);
  let normal = eig[0].vector;
  if (normal[2] < 0) normal = normal.map((x) => -x);
  const rms = Math.sqrt(Math.max(0, eig[0].value) / points.length);
  const shape = eig[2].value > 0 ? Math.sqrt(Math.max(0, eig[1].value) / eig[2].value) : 0;
  return {
    ...orientationFromNormal(normal),
    centroid: c,
    normal,
    rms,
    collinearity: shape,
    poorlyConstrained: points.length < 3 || shape < 0.05,
    n: points.length,
  };
}

/** Format as "dip direction/dip" and "strike/dip" (RHR), e.g. 045/30 and 315/30. */
export function formatOrientation(o) {
  const f3 = (x) => String(Math.round(x) % 360).padStart(3, '0');
  const f2 = (x) => String(Math.round(x)).padStart(2, '0');
  return { dipDirDip: `${f3(o.dipDirection)}/${f2(o.dip)}`, strikeDip: `${f3(o.strike)}/${f2(o.dip)}` };
}

/** Distances between two ECEF points: 3D (slope), horizontal (in ENU at the first point), dh. */
export function measureDistance(p1, p2) {
  const [d] = ecefToEnu([p2], p1);
  const g1 = ecefToGeodetic(p1), g2 = ecefToGeodetic(p2);
  return {
    distance3d: Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]),
    horizontal: Math.hypot(d[0], d[1]),
    dh: g2.h - g1.h,
    azimuth: normDeg(Math.atan2(d[0], d[1]) * R2D),
  };
}

/** Corners (ENU, relative to centroid) of a square of half-size `r` lying in the plane. */
export function planeSquare(normal, r) {
  const ref = Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
  const u = unit(cross(normal, ref));
  const w = unit(cross(normal, u));
  return [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([s, t]) => [0, 1, 2].map((i) => r * (s * u[i] + t * w[i])));
}
