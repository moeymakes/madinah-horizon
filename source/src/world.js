// ============================================================================
// world layout + procedural content generation (load time only)
// ============================================================================
// Axes: +x east, -z north, y up, metres. Geography is composed and compressed: the Prophet's Mosque sits 1.5 km
// north of the start, Uhud 4.3 km. The ground model itself (heights and masks) is W_GROUND in shaders.js.

// sun 9 degrees up in the west-south-west: facing north it lights things from the left
const SUN = (() => { const v = [-.93, .158, .37]; const l = hypot(...v); return v.map((c) => c / l); })();
const MOSQ = [0, -1150], QUBA = [-95, -150], MS = 1.25;
// city block sizes (w, h, d), shared by the placement and the meshes: footprints nearly fill 30 m cells
// w, h, d, setback storey; indices 6-8 are the hotels near the Haram
const CITY = [[27, 6.6, 28, 0], [28, 9.9, 26, 0], [24, 9.9, 27, 1], [28, 13.2, 28, 0], [26, 6.6, 27, 1], [20, 9.9, 28, 0], [28, 19.8, 28, 1], [29, 26.4, 29, 0], [26, 33, 26, 1], [22, 6.6, 24, 1]];
const CITY_LOW = [0, 1, 2, 3, 4, 5, 9], NSOLID = 26 + CITY.length;
// viewpoints: x, eye height above the ground (absolute y when flying), z, look-at x, y, z, flying
const POSES = [
  [-12.4, 1.7, 128, -14, 6, -400, 0],
  [150, 1.7, -30, -40, 80, -900, 0],
  [-160, 1.7, 130, -110, 70, -400, 0],
  [95, 1.7, 165, 0, 40, -1150, 0],
  [-36, 1.7, -92, -98, 27, -152, 0],
  [230, 210, -400, 0, 25, -1190, 1],
];
// 60 s scripted camera path (position + look-at, absolute heights): the generator keeps it clear of palms
const FLY = new Float32Array([
  -12.4, 3.5, 150, -14, 6, -300,
  -12.4, 3.5, 60, -14, 6, -300,
  -22, 4, -40, -98, 14, -150,
  -58, 5, -104, -98, 16, -150,
  -105, 6, -114, -150, 12, -20,
  -140, 7, -84, -160, 6, 0,
  -162, 5, -30, -150, 4, 120,
  -158, 4.5, 60, -100, 6, 200,
  -140, 5, 140, -40, 6, 200,
  -80, 8, 200, 60, 12, 180,
  15, 18, 222, 95, 24, 170,
  62, 40, 196, 20, 15, -600,
  112, 32, 140, 140, 10, 0,
  150, 20, 60, 140, 8, -100,
  160, 18, -40, -60, 12, -700,
  130, 40, -120, -40, 20, -900,
  95, 90, -160, 0, 30, -1150,
  170, 160, -300, 0, 25, -1190,
  230, 210, -400, 0, 25, -1190,
]);

// walled date gardens: grid lines of the plots east of the wadi, and a strip west of it
const GX = [-112, -62, -14, 40, 96], GZ = [-96, -24, 52, 134, 236];
const WESTPLOTS = [[-252, -232, -192, -122], [-252, -114, -192, -12], [-252, -2, -192, 108], [-252, 118, -192, 240]];
const PLOTS = [];
for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (!(i === 3 && j === 3)) PLOTS.push([GX[i] + 3, GZ[j] + 3, GX[i + 1] - 3, GZ[j + 1] - 3]);
for (const p of WESTPLOTS) PLOTS.push(p);
// raised concrete irrigation channels along the lanes: polylines of x, z
const CHANNELS = [[[-112, 52], [40, 52]], [[-14, -96], [-14, 236]], [[-192, -60], [-192, 200]]];
const WELL = [-30, 82];
const inPlot = (x, z, m = 0) => PLOTS.some((p) => x > p[0] + m && x < p[2] - m && z > p[1] + m && z < p[3] - m);
const wadiX = (z) => -150 + 30 * sin(z * .009) + 14 * sin(z * .0023 + 1);

// ---------------------------------------------------------------- terrain mesh from the density grid
function buildTerrain(D) {
  const sn = surfaceNets(D, NX, NY, NZ), nv = sn.nv, gp = sn.pos;
  const smp = sampler3(D, NX, NY, NZ);
  const vb = new ArrayBuffer(nv * 16), vf = new Float32Array(vb), v8 = new Int8Array(vb);
  const wp = new Float32Array(nv * 3), wn = new Float32Array(nv * 3);
  for (let k = 0; k < nv; k++) {
    const x = gp[k * 3], y = gp[k * 3 + 1], z = gp[k * 3 + 2], e = 0.8;
    let nx = smp(x - e, y, z) - smp(x + e, y, z), ny = smp(x, y - e, z) - smp(x, y + e, z), nz = smp(x, y, z - e) - smp(x, y, z + e);
    const l = hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const X = OX + x * VS, Y = OY + y * VS, Z = OZ + z * VS;
    wp[k * 3] = vf[k * 4] = X; wp[k * 3 + 1] = vf[k * 4 + 1] = Y; wp[k * 3 + 2] = vf[k * 4 + 2] = Z;
    wn[k * 3] = nx; wn[k * 3 + 1] = ny; wn[k * 3 + 2] = nz;
    v8[k * 16 + 12] = round(nx * 127); v8[k * 16 + 13] = round(ny * 127); v8[k * 16 + 14] = round(nz * 127); v8[k * 16 + 15] = 127;
  }
  const nq = sn.ni / 6, key = new Uint8Array(nq), cnt = new Uint32Array(CELLS * CELLS + 1);
  const lo = new Float32Array(CELLS * CELLS).fill(1e9), hi = new Float32Array(CELLS * CELLS).fill(-1e9);
  for (let q = 0; q < nq; q++) {
    const a = sn.idx[q * 6] * 3;
    const c = clamp(floor((wp[a] - OX) / CELLW), 0, CELLS - 1) + CELLS * clamp(floor((wp[a + 2] - OZ) / CELLW), 0, CELLS - 1);
    key[q] = c; cnt[c + 1]++;
    for (let j = 0; j < 6; j++) { const y = wp[sn.idx[q * 6 + j] * 3 + 1]; if (y < lo[c]) lo[c] = y; if (y > hi[c]) hi[c] = y; }
  }
  for (let c = 0; c < CELLS * CELLS; c++) cnt[c + 1] += cnt[c];
  const ib = new Uint32Array(sn.ni), fill = cnt.slice();
  for (let q = 0; q < nq; q++) { const o = fill[key[q]]++ * 6; for (let j = 0; j < 6; j++) ib[o + j] = sn.idx[q * 6 + j]; }
  return { vb, ib, nv, wp, wn, smp, start: cnt, lo, hi };
}

// ---------------------------------------------------------------- far landscape: polar grid out to 12 km
// FA: far ground grid (FN x FN, cell FC, origin FO) of [height, basalt, granite, wadi]. Heights inside the near
// field drop a metre so the detailed near terrain always wins there.
const FN = 1024, FC = 24000 / (FN - 1), FO = -12000;
function farSampler(FA) {
  return (x, z) => {
    const gx = clamp((x - FO) / FC, 0, FN - 1.001), gz = clamp((z - FO) / FC, 0, FN - 1.001), ix = gx | 0, iz = gz | 0, fx = gx - ix, fz = gz - iz;
    const i = (ix + FN * iz) * 4;
    return mix(mix(FA[i], FA[i + 4], fx), mix(FA[i + FN * 4], FA[i + FN * 4 + 4], fx), fz);
  };
}
function buildFar(fh) {
  const NR = 260, NS = 768, R0 = 190, R1 = 12000, nv = NR * NS;
  const vb = new ArrayBuffer(nv * 16), vf = new Float32Array(vb), v8 = new Int8Array(vb);
  const sx = SUN[0], sy = SUN[1], sz = SUN[2], sl = hypot(sx, sz), tn = sy / sl;
  for (let r = 0; r < NR; r++) {
    const rad = R0 * pow(R1 / R0, r / (NR - 1));
    for (let s = 0; s < NS; s++) {
      const a = (s + (r & 1) * .5) / NS * TAU, x = cos(a) * rad, z = sin(a) * rad, k = r * NS + s;
      let h = fh(x, z);
      if (max(abs(x), abs(z)) < 253) h -= 1;
      const e = max(FC * .7, rad * .004);
      let nx = fh(x - e, z) - fh(x + e, z), ny = 2 * e, nz = fh(x, z - e) - fh(x, z + e); const l = hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      // soft heightfield shadow: march toward the sun and keep the smallest clearance over the terrain
      let sh = 1;
      for (let t = 25; t < 3600; t *= 1.09) { const c = h + 2 + t * tn - fh(x + sx / sl * t, z + sz / sl * t); if (c < 0) { sh = 0; break; } sh = min(sh, c / (t * .045)); }
      vf[k * 4] = x; vf[k * 4 + 1] = h; vf[k * 4 + 2] = z;
      v8[k * 16 + 12] = round(nx * 127); v8[k * 16 + 13] = round(ny * 127); v8[k * 16 + 14] = round(nz * 127); v8[k * 16 + 15] = round(clamp(sh, 0, 1) * 127);
    }
  }
  const ib = [];
  for (let r = 0; r < NR - 1; r++) for (let s = 0; s < NS; s++) {
    const a = r * NS + s, b = r * NS + (s + 1) % NS, c = (r + 1) * NS + s, d = (r + 1) * NS + (s + 1) % NS;
    if (r & 1) ib.push(a, c, b, b, c, d); else ib.push(a, c, d, a, d, b);
  }
  return { vb, ib: new Uint32Array(ib), nv };
}

// ---------------------------------------------------------------- procedural meshes
const box = (m, x0, y0, z0, x1, y1, z1, aux = 1) => {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  for (const f of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 4, 7, 3], [1, 2, 6, 5], [3, 7, 6, 2], [0, 1, 5, 4]]) { const q = f.map((i) => m.v(...v[i], aux)); m.quad(q[0], q[1], q[2], q[3]); }
};
// surface of revolution: prof = [[radius, height, ao]...] bottom to top, seg sides (8 = octagonal)
function lathe(m, prof, seg, cx = 0, cy = 0, cz = 0, rot = PI / seg) {
  const rings = [];
  for (const [r, h, ao = 1] of prof) { const ring = []; for (let s = 0; s < seg; s++) { const a = s / seg * TAU + rot; ring.push(m.v(cx + cos(a) * r, cy + h, cz + sin(a) * r, ao)); } rings.push(ring); }
  for (let k = 0; k < rings.length - 1; k++) for (let s = 0; s < seg; s++) { const s2 = (s + 1) % seg; m.quad(rings[k][s], rings[k + 1][s], rings[k + 1][s2], rings[k][s2]); }
}
// drum + slightly pointed dome of radius r standing on height y
const domeProf = (r, drum, point = 1.12) => {
  const p = [[r * 1.04, 0], [r * 1.04, drum], [r * 1.08, drum + .2], [r, drum + .35]];
  for (let i = 1; i <= 12; i++) { const a = i / 12 * PI / 2; p.push([r * cos(a), drum + .35 + r * point * pow(sin(a), .92)]); }
  return p;
};
function meshDome(r, drum) { const m = new Mesh(); lathe(m, domeProf(r, drum), 24); return m; }
// Masjid an-Nabawi minaret: square base, three octagonal stages with balconies, a lantern and a cap
const MINARET_N = [[3.3, 20], [3.3, 50], [4.4, 50.4], [4.4, 52], [3, 52.4], [3, 68], [4, 68.4], [4, 70], [2.5, 70.4], [2.5, 80], [3.4, 80.4], [3.4, 81.8], [2.1, 82.2], [2.1, 86], [2.35, 86.2], [2.2, 87.8], [1.3, 89.8], [.3, 91.3], [0, 91.5]];
const MINARET_Q = [[1.9, 12], [1.9, 30], [2.5, 30.3], [2.5, 31.3], [1.7, 31.6], [1.7, 39.5], [1.95, 39.8], [1.75, 41.2], [1, 43.3], [.2, 44.8], [0, 45]];
function meshMinaret(prof, base, baseH, k = 1) {
  prof = prof.map(([r, h]) => [r * k, h]);
  const m = new Mesh();
  box(m, -base * .6, 0, -base * .6, base * .6, 1.4, base * .6);
  box(m, -base / 2, 1.4, -base / 2, base / 2, baseH, base / 2);
  lathe(m, prof, 8);
  return m;
}
// alem: a short pole with stacked spheres and an upturned crescent on top
function meshFinial(s) {
  const m = new Mesh(), ball = (y, r) => { const p = []; for (let i = 0; i <= 8; i++) { const a = -PI / 2 + i / 8 * PI; p.push([cos(a) * r, y + r + sin(a) * r]); } return p; };
  lathe(m, [[.15 * s, 0], [.15 * s, .9 * s], [.1 * s, .9 * s]], 10);
  lathe(m, ball(.9 * s, .34 * s), 12); lathe(m, ball(1.55 * s, .24 * s), 12);
  lathe(m, [[.07 * s, 2 * s], [.07 * s, 2.35 * s], [0, 2.36 * s]], 8);
  const R = .55 * s, cy = 2.3 * s + R * .95, pts = [];
  for (let k = 0; k <= 16; k++) { const a = (200 + k / 16 * 140) * PI / 180; pts.push([cos(a) * R, cy + sin(a) * R, 0]); }
  m.tube(pts, (k) => .015 * s + .1 * s * sin(PI * k / 16), 6, false, () => 1);
  return m;
}
// the Prophet's Mosque (local coordinates, centre of the plaza): Saudi-era hall, the lower Ottoman part to
// the south with the Green Dome in its south-east, gate blocks on the north front
function meshNabawi() {
  const m = new Mesh();
  box(m, -150, 0, -230, 150, 18, 110);
  box(m, -150, 0, 110, -75, 18, 190); box(m, 75, 0, 110, 150, 18, 190);
  box(m, -75, 0, 110, 75, 13, 190);
  box(m, -32, 0, -237, 32, 24, -228); box(m, -153, 0, -60, -146, 22, -20); box(m, 146, 0, -60, 153, 22, -20);
  box(m, -150.5, 18, -230.5, 150.5, 19.2, 110.5);
  return m;
}
function meshNabawiDomes() {
  const m = new Mesh();
  for (const x of [-100, -60, -20, 20, 60, 100]) for (const z of [-180, -120, -60, 0, 60]) lathe(m, domeProf(7.5, 1.2, 1), 16, x, 19.2, z);
  return m;
}
function meshGreenDome() { const m = new Mesh(); lathe(m, [[8.6, 0], [8.6, 3], [8.2, 3.4], ...domeProf(7.6, 5, 1.18).map(([r, h]) => [r, h + 3.4])], 28); return m; }
// opened courtyard umbrella: column with a square membrane rising from its head to four tips
function meshUmbrella() {
  const m = new Mesh();
  m.tube([[0, 0, 0], [0, 7, 0], [0, 14, 0]], (k) => [.55, .45, .4][k], 10, false, () => 1);
  // shared vertices, so the membrane shades as one smooth surface instead of bright-ridged facets
  const C = 14.2, S = 12.5, T = 19.5, N = 8, c = m.v(0, C, 0, .7), ring = [], mid = [];
  for (let q = 0; q < 4; q++) for (let i = 0; i < N; i++) {
    const t = i / N, a = q * PI / 2 + PI / 4 + t * PI / 2, r = S * 1.414 * (1 - .2 * sin(t * PI));
    ring.push(m.v(cos(a) * r, T - 2.6 * sin(t * PI), sin(a) * r)); mid.push(m.v(cos(a) * r * .5, C + (T - 2.6 * sin(t * PI) - C) * .38, sin(a) * r * .5, .85));
  }
  for (let i = 0; i < ring.length; i++) { const j = (i + 1) % ring.length; m.tri(c, mid[i], mid[j]); m.quad(mid[i], ring[i], ring[j], mid[j]); }
  return m;
}
// Quba-style mosque: white hall with arcades, a great dome, five lesser domes and a field of small ones
function meshQubaBody() { const m = new Mesh(); box(m, -28, 0, -28, 28, 11, 28); box(m, -28.4, 11, -28.4, 28.4, 11.9, 28.4); return m; }
function meshQubaDomes() {
  const m = new Mesh();
  lathe(m, domeProf(8.5, 3.5), 28, 0, 11.9, 10);
  for (const [x, z] of [[-16, 10], [16, 10], [-16, -14], [16, -14], [0, -14]]) lathe(m, domeProf(4.6, 1.6), 20, x, 11.9, z);
  for (let x = -24; x <= 24; x += 6) for (let z = -24; z <= 24; z += 6) {
    if (abs(x) < 13 && z > -2) continue; if (abs(x) > 10 && abs(x) < 22 && (abs(z - 10) < 7 || abs(z + 14) < 7)) continue; if (abs(x) < 7 && abs(z + 14) < 7) continue;
    lathe(m, domeProf(1.9, .5, 1.05), 12, x, 11.9, z);
  }
  return m;
}
function meshTrunk(curve, sd) {
  rseed(300 + sd);
  const m = new Mesh(), pts = [], lean = rr(.2, .9);
  for (let k = 0; k <= 12; k++) { const t = k / 12; pts.push([lean * t * t + curve * sin(t * PI) * .5, t * 10, curve * .3 * sin(t * PI * 1.3)]); }
  m.tube(pts, (k) => .34 * (1.12 - .2 * k / 12) * (k === 0 ? 1.25 : 1), LV > 1 ? 6 : 9, true, (k) => .55 + .45 * k / 12);
  m.top = pts[12];
  return m;
}
function meshFarTrunk() { const m = new Mesh(); m.tube([[0, 0, 0], [.15, 5, 0], [.3, 10, 0]], (k) => .3 - k * .03, 5, true); return m; }
function meshDates() { rseed(320); return icosphere(1, (x, y, z) => { const r = .5 + .18 * fbm(x * 3, y * 3, z * 3, 2); return [x * r, y * r * 1.5 - .3, z * r]; }); }
function meshRock(sd, sub, round_) {
  if (LV > 1 && sub > 1) sub--;
  rseed(100 + sd);
  const pl = []; for (let i = 0; i < (round_ ? 0 : 5); i++) { const q = qRand(); const l = hypot(q[0], q[1], q[2]) || 1; pl.push([q[0] / l, q[1] / l, q[2] / l, rr(.65, .95)]); }
  return icosphere(sub, (x, y, z) => {
    const r = 1 + (fbm(x * 1.6 + sd, y * 1.6, z * 1.6, 2) - .5) * (round_ ? .5 : .9);
    let px = x * r, py = y * r * (round_ ? .75 : .7), pz = z * r;
    for (const p of pl) { const d = px * p[0] + py * p[1] + pz * p[2] - p[3]; if (d > 0) { px -= p[0] * d; py -= p[1] * d; pz -= p[2] * d; } }
    return [px, py, pz];
  });
}
function meshCityBox(w, h, d, step) {
  const m = new Mesh();
  box(m, -w / 2, 0, -d / 2, w / 2, h, d / 2);
  box(m, -w / 2 - .2, h, -d / 2 - .2, w / 2 + .2, h + .9, d / 2 + .2);
  if (step) { const s = h > 20 ? h * .25 : 3.3; box(m, -w * .3, h, -d * .3, w * .25, h + s, d * .3); box(m, -w * .3 - .15, h + s, -d * .3 - .15, w * .25 + .15, h + s + .7, d * .3 + .15); }
  box(m, w * .15, h + .9, -d * .3, w * .15 + 2.4, h + 3.2, -d * .3 + 2.4); box(m, -w * .4, h + .9, d * .2, -w * .4 + 3, h + 2.2, d * .2 + 1.8);
  return m;
}
function meshAcacia(sd) {
  rseed(340 + sd);
  const m = new Mesh(), tops = [];
  const trunk = [[0, 0, 0], [rr(-.2, .2), 1.2, rr(-.2, .2)]];
  m.tube([[0, -.2, 0], [0, .15, 0], trunk[1]], (k) => [.34, .2, .14][k], 7, false);
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * TAU + rr(-.4, .4), r = rr(1.2, 2.4), h = rr(3, 4.2);
    const end = [cos(a) * r, h, sin(a) * r];
    m.tube([trunk[1], [end[0] * .4, h * .6, end[2] * .4], end], (k) => .12 - k * .035, 5, true);
    for (let j = 0; j < 5; j++) { const b = rnd() * TAU, l = rr(.9, 1.7), tip = [end[0] + cos(b) * l, end[1] + rr(-.1, .35), end[2] + sin(b) * l]; m.tube([end, tip], (k) => k ? .012 : .035, 3, false); tops.push(tip); }
  }
  m.tops = tops;
  return m;
}
function meshBird() {
  const m = new Mesh(), X = [.17, .1, 0, -.12, -.2], H = [.01, .045, .055, .04, .012];
  const rings = [];
  for (let i = 0; i < 5; i++) { const r = []; for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; r.push(m.v(sin(a) * H[i] * .9, cos(a) * H[i], X[i], 0)); } rings.push(r); }
  for (let i = 0; i < 4; i++) for (let k = 0; k < 6; k++) { const k2 = (k + 1) % 6; m.quad(rings[i][k], rings[i + 1][k], rings[i + 1][k2], rings[i][k2]); }
  for (const sx of [-1, 1]) {
    const a = m.v(sx * .03, .02, .06, 0), b = m.v(sx * .03, .02, -.06, 0), c = m.v(sx * .36, .03, -.02, sx), d = m.v(sx * .3, .03, -.12, sx);
    m.quad(a, c, d, b);
  }
  const t0 = m.v(0, .01, -.18, 0), t1 = m.v(.07, .01, -.3, 0), t2 = m.v(-.07, .01, -.3, 0); m.tri(t0, t1, t2);
  return m;
}

// ---------------------------------------------------------------- instance stores
function makeWorld(D, T, NA, FAR, flyPts) {
  const gi = (x, y, z) => x + NX * (y + NY * z);
  const smp = T.smp;
  const Dw = (x, y, z) => smp((x - OX) / VS, (y - OY) / VS, (z - OZ) / VS);
  const nCells = CELLS * CELLS;
  const cellOf = (x, z) => clamp(floor((x - OX) / CELLW), 0, CELLS - 1) + CELLS * clamp(floor((z - OZ) / CELLW), 0, CELLS - 1);
  const big = Array.from({ length: nCells }, () => []), small = Array.from({ length: nCells }, () => []), farL = [];
  let nth = 0;
  // leaf record: x y z length · yaw tilt halfwidth anchor-height · type seed1 seed2 bend
  const leaf = (L, x, y, z, len, yaw, tilt, wid, hA, type, s1, s2, bend) => { L[cellOf(x, z)].push(x, y, z, len, yaw, tilt, wid, hA, type, s1, s2, bend); };
  const grass = (x, y, z, len, yaw, tilt, wid, hA, type, s1, s2, bend) => { if (!(nth++ % THIN)) leaf(small, x, y, z, len, yaw, tilt, wid * (1 + LV / 2), hA, type, s1, s2, bend); };
  const cells = Array.from({ length: 8 }, () => Array.from({ length: nCells }, () => []));
  const solids = [];
  // instance record: x y z scale · quaternion · material seed shrink-distance extra
  const solid = (mesh, x, y, z, sc, q, mat, seed, far = 0, ex = 0) => {
    if (mesh < 8) cells[mesh][cellOf(x, z)].push(x, y, z, sc, q[0], q[1], q[2], q[3], mat, seed, far, ex);
    else (solids[mesh] ||= []).push(x, y, z, sc, q[0], q[1], q[2], q[3], mat, seed, far, ex);
  };
  const Q0 = [0, 0, 0, 1], yawQ = (a) => qAxis(0, 1, 0, a);
  const fh = farSampler(FAR.A);
  const farB = (x, z, c) => { const gx = clamp(round((x - FO) / FC), 0, FN - 1), gz = clamp(round((z - FO) / FC), 0, FN - 1); return FAR.B[(gx + FN * gz) * 4 + c]; };
  const nearA = (x, z, c) => { const ix = clamp(round(x - OX), 0, NX - 1), iz = clamp(round(z - OZ), 0, NZ - 1); return NA[(ix + NX * iz) * 4 + c]; };

  // --- surface queries
  const fl = [];
  const floorsAt = (x, z) => {
    const ix = clamp(round((x - OX) / VS), 1, NX - 2), iz = clamp(round((z - OZ) / VS), 1, NZ - 2);
    fl.length = 0; let ceil = 80;
    for (let gy = NY - 2; gy >= 0; gy--) {
      const d = D[gi(ix, gy, iz)], da = D[gi(ix, gy + 1, iz)];
      if (da <= 0 && d > 0) { const y = OY + (gy + d / (d - da)) * VS; fl.push(y, ceil - y); } else if (da > 0 && d <= 0) ceil = OY + (gy + 0.5) * VS;
    }
    return fl;
  };
  const gy = (x, z) => { if (max(abs(x), abs(z)) > 250) return fh(x, z); const f = floorsAt(x, z); return f.length ? f[0] : 0; };
  const grad = (x, y, z) => {
    const e = 0.6; let nx = Dw(x - e, y, z) - Dw(x + e, y, z), ny = Dw(x, y - e, z) - Dw(x, y + e, z), nz = Dw(x, y, z - e) - Dw(x, y, z + e);
    const l = hypot(nx, ny, nz) || 1; return [nx / l, ny / l, nz / l];
  };
  const pickV = () => ((rnd() * T.nv) | 0) * 3;
  const nearFly = (x, z, r) => { for (const p of flyPts) if (p[1] < 26 && hypot(x - p[0], z - p[2]) < r) return true; return false; };
  const nearPose = (x, z, r = 3) => { for (const p of POSES) if (!p[6] && hypot(x - p[0], z - p[2]) < r) return true; return false; };
  const inQuba = (x, z, m = 0) => abs(x - QUBA[0]) < 30 + m && abs(z - QUBA[1]) < 30 + m;
  const crownAbs = new Float32Array((NX / 2) * (NY / 2) * (NZ / 2));

  // --- date palms: trunk (3 curved meshes), crown of fronds in tiers, dead fronds hanging, date clusters
  const trunks = [meshTrunk(.25, 0), meshTrunk(.6, 1), meshTrunk(1.1, 2)];
  const palm = (x, z, H, young = 0) => {
    const y = gy(x, z) - .2, ti = (rnd() * 3) | 0, s = H / 10, yaw = rnd() * TAU, q = yawQ(yaw);
    const tp = trunks[ti].top, top = qrot3(q, [tp[0] * s, tp[1] * s, tp[2] * s]);
    const cx = x + top[0], cy = y + top[1], cz = z + top[2];
    solid(ti, x, y, z, s, q, 12, rnd(), 0, 0);
    const nF = (young ? 16 : 36) + (rnd() * (young ? 6 : 13) | 0), off = rnd() * TAU, ls = (young ? .7 : 1) * rr(.8, 1.15);
    for (let f = 0; f < nF; f++) {
      const t = f / nF, tilt = mix(.12, 1.5, pow(t, .7)) + rr(-.1, .1);
      const len = (4 + 1.4 * rnd()) * ls * mix(.78, 1.05, sqrt(t));
      leaf(big, cx, cy + .25, cz, len, off + f * 2.39996 + rr(-.12, .12), tilt, .42 * len / 4, H, 0, rnd(), rnd(), clamp(mix(.38, 1, t) + rr(-.1, .1), 0, 1));
    }
    if (!young) for (let f = 2 + (rnd() * 3 | 0); f > 0; f--) leaf(big, cx, cy - .3, cz, rr(2.6, 3.6), rnd() * TAU, rr(2.5, 2.9), .28, H, 1, rnd(), rnd(), .3);
    if (!young && H > 6.5) for (let k = 3 + (rnd() * 3 | 0); k > 0; k--) { const a = rnd() * TAU; solid(3, cx + cos(a) * .55, cy - .75 - rnd() * .3, cz + sin(a) * .55, rr(.2, .27), yawQ(rnd() * TAU), 13, rnd(), 80, H); }
    // crowns shade the ground beneath them in the skylight bake
    const hx = round((cx - OX) / VS / 2), hz = round((cz - OZ) / VS / 2), hy = round((cy - OY) / VS / 2);
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 0; dy++) {
      const ax = hx + dx, ay = hy + dy, az = hz + dz;
      if (ax > 0 && ay > 0 && az > 0 && ax < NX / 2 - 1 && ay < NY / 2 - 1 && az < NZ / 2 - 1 && dx * dx + dz * dz < 6) crownAbs[ax + NX / 2 * (ay + NY / 2 * az)] += .22;
    }
  };
  rseed(1);
  for (const p of PLOTS) {
    const sp = rr(6.5, 9), jx = rr(0, sp), jz = rr(0, sp), old = rr(.6, 1);
    for (let z = p[1] + 3 + jz % 3; z < p[3] - 2; z += sp) for (let x = p[0] + 3 + jx % 3; x < p[2] - 2; x += sp) {
      if (rnd() < .22) continue;
      const px = x + rr(-2.2, 2.2), pz = z + rr(-2.2, 2.2);
      if (nearFly(px, pz, 4.5) || nearPose(px, pz, 3.5) || hypot(px - WELL[0], pz - WELL[1]) < 4) continue;
      const young = rnd() < .18;
      palm(px, pz, young ? rr(2.2, 4.2) : rr(5, 17) * old * rr(.85, 1.1), young);
      if (!young && rnd() < .2) { const a = rnd() * TAU; palm(px + cos(a) * 1.3, pz + sin(a) * 1.3, rr(1.6, 2.6), 1); }
    }
  }
  // the garden around the white mosque
  rseed(2);
  for (let i = 0; i < 46; i++) {
    const a = i / 46 * TAU + rr(-.04, .04), r = rr(36, 47), x = QUBA[0] + cos(a) * r, z = QUBA[1] + sin(a) * r;
    if (nearFly(x, z, 5) || nearPose(x, z, 4) || (abs(z - QUBA[1] - 30) < 6 && abs(x - QUBA[0]) < 30)) continue;
    palm(x, z, rr(8, 14));
  }
  // single palms along the wadi edge and the lanes
  rseed(3);
  for (let i = 0; i < 70; i++) {
    const z = rr(-240, 240), x = wadiX(z) + (rnd() < .5 ? -1 : 1) * rr(24, 36);
    if (inPlot(x, z, -2) || nearFly(x, z, 5) || nearPose(x, z, 4) || nearA(x, z, 1) > .2) continue;
    palm(x, z, rr(7, 14));
  }

  // --- garden walls, channels, well: one world-space mesh each
  const walls = new Mesh(), chan = new Mesh(), water = new Mesh(), well = new Mesh(), wood = new Mesh();
  rseed(4);
  for (const p of PLOTS) {
    const cs = [[p[0], p[1]], [p[2], p[1]], [p[2], p[3]], [p[0], p[3]]];
    for (let e = 0; e < 4; e++) {
      const a = cs[e], b = cs[(e + 1) % 4], L = hypot(b[0] - a[0], b[1] - a[1]), gate = rr(.2, .8), h0 = rr(1.25, 1.65);
      let pts = [];
      for (let t = 0; t <= L; t += 3) {
        const u = t / L, x = mix(a[0], b[0], u), z = mix(a[1], b[1], u);
        if (abs(u - gate) * L < 2.2 || (rnd() < .03 && pts.length)) { if (pts.length > 1) walls.sweep(pts, .55, h0, () => [0, 1, 0]); pts = []; continue; }
        const h = h0 * (1 - .3 * fbm(x * .35, 2, z * .35, 2));
        pts.push([x, gy(x, z) + h - h0 / 2 - .3, z]);
      }
      if (pts.length > 1) walls.sweep(pts, .55, h0, () => [0, 1, 0]);
    }
  }
  for (const c of CHANNELS) {
    const a = c[0], b = c[1], L = hypot(b[0] - a[0], b[1] - a[1]), side = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
    for (const s of [-1, 1]) {
      const pts = [];
      for (let t = 0; t <= L; t += 2) { const u = t / L, x = mix(a[0], b[0], u) + side[0] * s * .42, z = mix(a[1], b[1], u) + side[1] * s * .42; pts.push([x, gy(x, z) + .2, z]); }
      chan.sweep(pts, .14, .6, () => [0, 1, 0]);
    }
    for (let t = 0; t < L; t += 2) {
      const u0 = t / L, u1 = min(t + 2, L) / L;
      const p0 = [mix(a[0], b[0], u0), mix(a[1], b[1], u0)], p1 = [mix(a[0], b[0], u1), mix(a[1], b[1], u1)];
      const y0 = gy(...p0) + .32, y1 = gy(...p1) + .32;
      const v = [[p0[0] - side[0] * .36, y0, p0[1] - side[1] * .36], [p0[0] + side[0] * .36, y0, p0[1] + side[1] * .36], [p1[0] + side[0] * .36, y1, p1[1] + side[1] * .36], [p1[0] - side[0] * .36, y1, p1[1] - side[1] * .36]];
      const q = v.map((pp) => water.v(...pp)); water.quad(q[0], q[1], q[2], q[3]);
      const qb = v.map((pp) => chan.v(pp[0], pp[1] - .25, pp[2])); chan.quad(qb[0], qb[1], qb[2], qb[3]);
    }
  }
  {
    const y = gy(...WELL);
    lathe(well, [[1.25, -.2], [1.25, .85], [1.1, .95], [.85, .95], [.85, .3]], 16, WELL[0], y, WELL[1]);
    const wq = water; const r = 6, c0 = wq.v(WELL[0], y + .3, WELL[1]);
    for (let i = 0; i < r * 2; i++) { const a = i / (r * 2) * TAU, b = (i + 1) / (r * 2) * TAU; wq.tri(c0, wq.v(WELL[0] + cos(a) * .85, y + .3, WELL[1] + sin(a) * .85), wq.v(WELL[0] + cos(b) * .85, y + .3, WELL[1] + sin(b) * .85)); }
    wood.sweep([[WELL[0] - 1.1, y + .4, WELL[1]], [WELL[0] - 1.1, y + 2.6, WELL[1]]], .16, .16, () => [1, 0, 0]);
    wood.sweep([[WELL[0] + 1.1, y + .4, WELL[1]], [WELL[0] + 1.1, y + 2.6, WELL[1]]], .16, .16, () => [1, 0, 0]);
    wood.sweep([[WELL[0] - 1.3, y + 2.5, WELL[1]], [WELL[0] + 1.3, y + 2.5, WELL[1]]], .2, .2, () => [0, 1, 0]);
  }
  const worldMeshes = { walls, chan, water, well, wood };
  solid(18, 0, 0, 0, 1, Q0, 5, .1, 0, 0); solid(19, 0, 0, 0, 1, Q0, 14, .2, 0, 0); solid(20, 0, 0, 0, 1, Q0, 15, .3, 0, 0);
  solid(21, 0, 0, 0, 1, Q0, 14, .4, 0, 0); solid(22, 0, 0, 0, 1, Q0, 16, .5, 0, 0);

  // --- the white mosque and its finials
  const qy = gy(...QUBA);
  solid(14, QUBA[0], qy - .3, QUBA[1], 1, Q0, 6, .2, 0, 1);
  solid(15, QUBA[0], qy - .3, QUBA[1], 1, Q0, 6, .3, 0, 0);
  for (const [x, z] of [[-28, -28], [28, -28], [-28, 28], [28, 28]]) { solid(16, QUBA[0] + x, qy - .3, QUBA[1] + z, 1, yawQ(PI / 8), 6, .4, 0, 0); solid(17, QUBA[0] + x, qy + 44.4, QUBA[1] + z, 1, Q0, 10, 0, 0, 0); }
  solid(17, QUBA[0], qy + 11.9 + 3.5 + .35 + 8.5 * 1.12 - .4, QUBA[1] + 10, 1.3, Q0, 10, 0, 0, 0);

  // --- the Prophet's Mosque on the horizon
  const my = fh(MOSQ[0], MOSQ[1]);
  solid(9, MOSQ[0], my, MOSQ[1], MS, Q0, 7, .1, 0, 1);
  solid(10, MOSQ[0], my, MOSQ[1], MS, Q0, 9, .2, 0, 0);
  const GD = 1.6 * MS;
  solid(11, MOSQ[0] + 42 * MS, my + 13 * MS, MOSQ[1] + 158 * MS, GD, Q0, 8, .3, 0, 0);
  solid(17, MOSQ[0] + 42 * MS, my + 13 * MS + (3.4 + 5 + .35 + 7.6 * 1.18 - .3) * GD, MOSQ[1] + 158 * MS, 1.5 * GD, Q0, 10, 0, 0, 0);
  for (const [x, z, s] of [[-150, -230, 1], [150, -230, 1], [-150, 110, 1], [150, 110, 1], [-25, -237, 1], [25, -237, 1], [-75, 190, .7], [75, 190, .7], [-75, 110, .66], [75, 110, .66]]) {
    solid(12, MOSQ[0] + x * MS, my, MOSQ[1] + z * MS, s * MS, yawQ(PI / 8), 7, .5, 0, 0);
    solid(17, MOSQ[0] + x * MS, my + 91.3 * s * MS, MOSQ[1] + z * MS, 1.6 * s * MS, Q0, 10, 0, 0, 0);
  }
  for (let x = -238; x <= 238; x += 34) for (let z = -320; z <= 320; z += 34) {
    const lx = x, lz = z - 20;
    if (lx > -175 && lx < 175 && lz > -255 && lz < 222) continue;
    solid(13, MOSQ[0] + lx * MS, my, MOSQ[1] + lz * MS, MS * 1.05, Q0, 11, rnd(), 0, 0);
  }

  // --- the city: low houses spreading out, hotels close to the Haram
  rseed(5);
  for (let dz = -3240; dz < 900; dz += 360) for (let dx = -3240; dx < 3240; dx += 360) {
   const near = hypot(dx - MOSQ[0], dz - MOSQ[1]) < 700, ang = near ? rr(-.03, .03) : rr(-.55, .55), ca = cos(ang), sa = sin(ang);
   const sx = 4 + (rnd() * 3 | 0), sz = 4 + (rnd() * 3 | 0), lane = rnd() * 12 | 0;
   for (let j = 0; j < 12; j++) for (let i = 0; i < 12; i++) {
    if (i % sx === 0 || j % sz === 0 || (i + j) === lane + 6 || (i === lane && j > 4)) continue;
    const lx = i * 30 - 165 + rr(-3, 3), lz = j * 30 - 165 + rr(-3, 3), x = dx + lx * ca - lz * sa, z = dz + lx * sa + lz * ca, c = farB(x, z, 0), gx = x, gz = z;
    if (c < .05 || c > .95 || rnd() > min(1, c * 2.2) || rnd() < .1) continue;
    const dm = hypot(x - MOSQ[0], (z - MOSQ[1]) * 1.15);
    let t = CITY_LOW[(rnd() * CITY_LOW.length) | 0];
    if (dm < 650 && rnd() < .45) t = rnd() < .55 ? 6 : rnd() < .88 ? 7 : 8;
    else if (dm < 1050 && rnd() < .08) t = 6;
    if (z > MOSQ[1] + 300 && abs(x - MOSQ[0]) < 700 && t >= 6 && t <= 8) t = CITY_LOW[(rnd() * 4) | 0];
    const sc = rr(.82, 1.04), yaw = -ang + (rnd() < .5 ? 0 : PI / 2) + rr(-.025, .025);
    solid(26 + t, x, fh(x, z) - .5, z, sc, yawQ(yaw), 17, rnd(), 0, CITY[t][1] * sc);
   }
  }
  // far palm groves and gardens
  rseed(6);
  const farTrunk = (x, z, H) => {
    const y = fh(x, z) - .3, s = H / 10, yaw = rnd() * TAU, q = yawQ(yaw), top = qrot3(q, [.3 * s, 10 * s, 0]);
    solid(8, x, y, z, s, q, 18, rnd(), 0, 0);
    const off = rnd() * TAU, n = LV > 1 ? 6 : 9;
    for (let f = 0; f < n; f++) farL.push(x + top[0], y + top[1] + .2, z + top[2], rr(3.2, 4.2), off + f * 2.39996, mix(.4, 1.9, f / n), .6, H, 5, rnd(), rnd(), .55);
  };
  let nFar = 0;
  for (let gz = -3000; gz < 2600 && nFar < 9000; gz += 13) for (let gx = -3000; gx < 2600 && nFar < 9000; gx += 13) {
    const x = gx + rr(-4, 4), z = gz + rr(-4, 4);
    if (max(abs(x), abs(z)) < 258) continue;
    const pd = farB(x, z, 1);
    if (rnd() > pd * .9) continue;
    farTrunk(x, z, rr(7, 15)); nFar++;
  }

  // --- wadi: acacias, cobbles, sand-loving shrubs
  rseed(7);
  const acacias = [meshAcacia(0), meshAcacia(1), meshAcacia(2)];
  // hand-placed acacias framing viewpoint 3 (forward, right of its view), then a scatter along the wadi
  const rel = (i, f, r) => { const p = POSES[i]; let fx = p[3] - p[0], fz = p[5] - p[2]; const l = hypot(fx, fz); fx /= l; fz /= l; return [p[0] + fx * f - fz * r, p[2] + fz * f + fx * r]; };
  const ACS = [rel(2, 15, -8), rel(2, 30, 10), rel(2, 48, -14), rel(2, 9, 13)];
  for (let i = 0; i < 18; i++) { const z = rr(-240, 240); ACS.push([wadiX(z) + rr(-16, 16), z]); }
  for (let i = 0; i < ACS.length; i++) {
    const [x, z] = ACS[i];
    if (nearFly(x, z, 7) || (i > 3 && nearPose(x, z, 5))) continue;
    const k = (rnd() * 3) | 0, s = rr(.9, 1.4), y = gy(x, z), q = yawQ(rnd() * TAU);
    solid(23 + k, x, y - .1, z, s, q, 16, rnd(), 0, 0);
    for (const tp of acacias[k].tops) {
      const w = qrot3(q, tp.map((v) => v * s));
      for (let j = 0; j < 190; j++) {
        const a = rnd() * TAU, r = sqrt(rnd()) * 1.15 * s;
        leaf(big, x + w[0] + cos(a) * r, y + w[1] + rr(-.18, .22) - r * r * .05, z + w[2] + sin(a) * r, rr(.22, .38), rnd() * TAU, rr(1.2, 1.9), .07, 4, 4, rnd(), rnd(), .3);
      }
    }
  }
  rseed(8);
  for (let i = 0; i < 11000; i++) {
    const near3 = i < 260, c3 = rel(2, rr(5, 26), rr(-10, 10));
    const z = near3 ? c3[1] : rr(-250, 250), x = near3 ? c3[0] : wadiX(z) + rr(-22, 22), y = gy(x, z);
    if (nearFly(x, z, 1.5) || nearPose(x, z, 1.5) || fbm(x * .06, 5, z * .06, 2) < .55) continue;
    const sc = .05 + .28 * pow(rnd(), 2.6), q = qRand();
    if (!(nth++ % THIN)) solid(7, x, y - sc * .15, z, sc, q, 4, rnd(), 40, 0);
  }
  const shrub = (x, z, n, s) => {
    const y = gy(x, z), yw = rnd() * TAU;
    for (let j = 0; j < n; j++) grass(x + rr(-.2, .2), y - .05, z + rr(-.2, .2), rr(.25, .8) * s, yw + j * 2.4, rr(.2, 1.1), rr(.03, .06), 0, 3, rnd(), rnd(), rr(.3, .7));
  };
  rseed(9);
  for (const [f, r] of [[5, -3.5], [7, 3], [11, -1]]) { const p = rel(2, f, r); shrub(p[0], p[1], 16, 1.3); }
  for (let i = 0; i < 2600; i++) {
    const x = rr(-255, 255), z = rr(-255, 255);
    if (inPlot(x, z, -3) || inQuba(x, z, 4) || nearFly(x, z, 2) || nearPose(x, z, 2)) continue;
    const lava = nearA(x, z, 1), wadi = nearA(x, z, 3), gr = nearA(x, z, 2);
    if (rnd() > .25 + .5 * wadi + .25 * lava - .2 * gr) continue;
    shrub(x, z, 8 + (rnd() * 12 | 0), rr(.7, 1.3));
  }

  // --- grass and fallen fronds inside the gardens, thicker by the channels
  rseed(10);
  for (const p of PLOTS) for (let i = (p[2] - p[0]) * (p[3] - p[1]) * .12 | 0; i > 0; i--) {
    const x = rr(p[0] + 1, p[2] - 1), z = rr(p[1] + 1, p[3] - 1);
    if (nearPose(x, z, 1.2) || rnd() > .35 + .6 * fbm(x * .08, 4, z * .08, 2)) continue;
    const y = gy(x, z), yw = rnd() * TAU;
    for (let j = 0; j < 4; j++) grass(x + rr(-.15, .15), y - .03, z + rr(-.15, .15), rr(.2, .55), yw + j * 1.6, rr(.1, .7), rr(.025, .05), 0, 2, rnd(), rnd(), rr(.3, .8));
  }
  for (const c of CHANNELS) {
    const a = c[0], b = c[1], L = hypot(b[0] - a[0], b[1] - a[1]);
    for (let t = 0; t < L; t += .45) for (const s of [-1, 1]) {
      const u = t / L, nx = -(b[1] - a[1]) / L, nz = (b[0] - a[0]) / L, o = s * rr(.6, 1.6), x = mix(a[0], b[0], u) + nx * o, z = mix(a[1], b[1], u) + nz * o;
      if (rnd() < .4) continue;
      const y = gy(x, z);
      for (let j = 0; j < 3; j++) grass(x, y - .03, z, rr(.25, .75), rnd() * TAU, rr(.05, .6), rr(.025, .05), 0, 2, rnd(), rnd(), rr(.3, .8));
    }
  }
  rseed(11);
  for (let i = 0; i < 260; i++) {
    const p = PLOTS[(rnd() * PLOTS.length) | 0], x = rr(p[0] + 2, p[2] - 2), z = rr(p[1] + 2, p[3] - 2);
    if (nearPose(x, z, 2.5)) continue;
    leaf(big, x, gy(x, z) + .08, z, rr(2.2, 3.4), rnd() * TAU, PI / 2 - rr(0, .12), .42, 0, 1, rnd(), rnd(), .2);
  }

  // --- rocks: basalt rubble at the lava front and on the plateau, granite boulders on the hill, cobbles
  rseed(12);
  for (let i = 0; i < 70000; i++) {
    const k = pickV(), x = T.wp[k], y = T.wp[k + 1], z = T.wp[k + 2], ny = T.wn[k + 1];
    if (max(abs(x), abs(z)) > 248 || nearFly(x, z, 2.5) || nearPose(x, z, 2.5)) continue;
    const lava = nearA(x, z, 1), gr = nearA(x, z, 2);
    const q = qRand();
    if (lava > .1 && rnd() < sstep(.5, .95, lava) * .9 + (lava < .5 ? .35 : 0)) {
      const sc = (.2 + 1.4 * pow(rnd(), 3) + (rnd() < .04 ? rr(1.2, 2.6) : 0)) * (ny > .8 ? .75 : 1), bigR = sc > 1;
      solid(bigR ? 5 : 4, x - T.wn[k] * sc * .3, y - ny * sc * .3, z - T.wn[k + 2] * sc * .3, sc, q, 2, rnd(), bigR ? 0 : 110, 0);
    } else if (gr > .3 && rnd() < gr * .25) {
      const sc = .3 + 1.3 * pow(rnd(), 2);
      solid(6, x - T.wn[k] * sc * .35, y - ny * sc * .35, z - T.wn[k + 2] * sc * .35, sc, q, 3, rnd(), 0, 0);
    } else if (rnd() < .05 && !inPlot(x, z, -1) && !inQuba(x, z, 3)) {
      const sc = .05 + .25 * pow(rnd(), 2);
      if (!(nth++ % THIN)) solid(7, x, y - sc * .2, z, sc, q, 4, rnd(), 45, 0);
    }
  }

  // --- life: pigeons over the Haram and the gardens, a few around the white mosque's domes
  rseed(13);
  const birds = [];
  for (const f of [[MOSQ[0], 70, MOSQ[1], 160, 90, 1], [MOSQ[0] + 60, 110, MOSQ[1] - 80, 240, 80, -1], [MOSQ[0] - 80, 50, MOSQ[1] + 120, 120, 70, 1],
    [-30, 26, 60, 38, 26, -1], [40, 34, 120, 55, 22, 1], [QUBA[0], 30, QUBA[1], 30, 30, 1], [-150, 22, -40, 40, 16, -1]]) {
    const ss_ = rnd();
    for (let i = 0; i < f[4]; i++) birds.push(f[0], f[1], f[2], f[3], ss_ + rnd() * .2, f[5] * rr(.9, 1.1) * 7 / f[3], rr(.9, 1.15), rnd());
  }
  const motes = new Float32Array(4000 * 4);
  for (let i = 0; i < motes.length; i++) motes[i] = rnd();

  // --- packing
  const pack = (L) => {
    let n = 0; const start = new Uint32Array(nCells + 1);
    for (let c = 0; c < nCells; c++) { start[c] = n; n += L[c].length / 12; }
    start[nCells] = n;
    const buf = new ArrayBuffer(n * 36), f = new Float32Array(buf), u8 = new Uint8Array(buf), lo = new Float32Array(nCells).fill(1e9), hi = new Float32Array(nCells).fill(-1e9);
    let k = 0;
    for (let c = 0; c < nCells; c++) { const a = L[c]; for (let i = 0; i < a.length; i += 12, k++) {
      for (let j = 0; j < 8; j++) f[k * 9 + j] = a[i + j];
      u8[k * 36 + 32] = a[i + 8]; u8[k * 36 + 33] = a[i + 9] * 255; u8[k * 36 + 34] = a[i + 10] * 255; u8[k * 36 + 35] = a[i + 11] * 255;
      const y = a[i + 1], l = a[i + 3]; if (y - l < lo[c]) lo[c] = y - l; if (y + l > hi[c]) hi[c] = y + l;
    } }
    return { buf, n, start, lo, hi };
  };
  const packFlat = (a) => { const L = Array.from({ length: nCells }, (_, c) => c ? [] : a); return pack(L); };
  const packC = (L) => {
    let n = 0; const start = new Uint32Array(nCells + 1);
    for (let c = 0; c < nCells; c++) { start[c] = n; n += L[c].length / 12; }
    start[nCells] = n;
    const data = new Float32Array(n * 12), lo = new Float32Array(nCells).fill(1e9), hi = new Float32Array(nCells).fill(-1e9);
    let k = 0;
    for (let c = 0; c < nCells; c++) { const a = L[c]; for (let i = 0; i < a.length; i += 12) { for (let j = 0; j < 12; j++) data[k++] = a[i + j]; lo[c] = min(lo[c], a[i + 1] - 4); hi[c] = max(hi[c], a[i + 1] + 18); } }
    return { data, n, start, lo, hi };
  };

  // --- half-res volume: r = openness, g = skylight (palm crowns shade what is under them)
  const hx = NX / 2, hy = NY / 2, hz = NZ / 2, volD = new Uint8Array(hx * hy * hz * 2);
  let Lp = new Float32Array(hx * hz).fill(1), Ln = new Float32Array(hx * hz), tmp = new Float32Array(hx * hz);
  for (let y = hy - 1; y >= 0; y--) {
    for (let z = 0; z < hz; z++) for (let x = 0; x < hx; x++) { const i = x + hx * z; tmp[i] = (Lp[x > 0 ? i - 1 : i] + 2 * Lp[i] + Lp[x < hx - 1 ? i + 1 : i]) * 0.25; }
    for (let z = 0; z < hz; z++) for (let x = 0; x < hx; x++) {
      const i = x + hx * z, b = (tmp[z > 0 ? i - hx : i] + 2 * tmp[i] + tmp[z < hz - 1 ? i + hx : i]) * 0.25;
      const g0 = gi(x * 2, y * 2, z * 2);
      const d = (D[g0] + D[g0 + 1] + D[g0 + NX] + D[g0 + NX + 1] + D[g0 + NX * NY] + D[g0 + NX * NY + 1] + D[g0 + NX * NY + NX] + D[g0 + NX * NY + NX + 1]) * 0.125;
      const o = x + hx * (y + hy * z);
      const l = b * clamp(0.5 - d / 1.5, 0, 1) * (1 - min(crownAbs[o], 0.6));
      Ln[i] = l;
      volD[o * 2] = clamp(0.5 - d / 10, 0, 1) * 255; volD[o * 2 + 1] = min(1, b) * 255;
    }
    const t = Lp; Lp = Ln; Ln = t;
  }

  // --- maps: near (1 m): wadi sand, basalt, granite, irrigated soil · far (~23 m): basalt, granite, city, groves
  const nm = new Uint8Array(NX * NZ * 4);
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const x = OX + i, z = OZ + j, o = (i + NX * j) * 4, a = (i + NX * j) * 4;
    nm[o] = NA[a + 3] * 255; nm[o + 1] = NA[a + 1] * 255; nm[o + 2] = NA[a + 2] * 255;
    nm[o + 3] = inPlot(x, z, .4) ? (.55 + .45 * fbm(x * .07, 3, z * .07, 2)) * 255 : 0;
  }
  const fmap = new Uint8Array(FN * FN * 4);
  for (let k = 0; k < FN * FN; k++) { fmap[k * 4] = FAR.A[k * 4 + 1] * 255; fmap[k * 4 + 1] = FAR.A[k * 4 + 2] * 255; fmap[k * 4 + 2] = FAR.B[k * 4] * 255; fmap[k * 4 + 3] = FAR.B[k * 4 + 1] * 255; }

  const sol = { data: [], ranges: [] }; let si = 0;
  for (let m = 0; m < NSOLID; m++) { const a = solids[m] || []; sol.ranges.push([si, a.length / 12]); si += a.length / 12; for (let i = 0; i < a.length; i++) sol.data.push(a[i]); }
  return { gy, fh, trunks, acacias, worldMeshes, cells: cells.map(packC), big: pack(big), small: pack(small), far: packFlat(farL),
    solids: { data: new Float32Array(sol.data), ranges: sol.ranges }, birds: new Float32Array(birds), motes, volD, nm, fmap };
}
const fract = (x) => x - floor(x);
const qrot3 = (q, v) => {
  const [x, y, z, w] = q, cx = y * v[2] - z * v[1] + w * v[0], cy = z * v[0] - x * v[2] + w * v[1], cz = x * v[1] - y * v[0] + w * v[2];
  return [v[0] + 2 * (y * cz - z * cy), v[1] + 2 * (z * cx - x * cz), v[2] + 2 * (x * cy - y * cx)];
};
