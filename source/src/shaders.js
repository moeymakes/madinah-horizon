// ============================================================================
// WGSL sources
// ============================================================================
// Noise, detail texture, blit/bloom and the composite chain follow Abyssal Garden (MIT); the air, sky, terrain
// materials, palms, buildings and birds are this world's own.

const W_NOISE = /*wgsl*/`
fn ss(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
fn h31(p: vec3f) -> f32 { var q = fract(p * vec3f(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
fn h33(p: vec3f) -> vec3f { var q = fract(p * vec3f(.1031, .1030, .0973)); q += dot(q, q.yxz + 33.33); return fract((q.xxy + q.yxx) * q.zyx); }
fn vn(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3. - 2. * f);
  return mix(mix(mix(h31(i), h31(i + vec3f(1., 0., 0.)), u.x), mix(h31(i + vec3f(0., 1., 0.)), h31(i + vec3f(1., 1., 0.)), u.x), u.y),
             mix(mix(h31(i + vec3f(0., 0., 1.)), h31(i + vec3f(1., 0., 1.)), u.x), mix(h31(i + vec3f(0., 1., 1.)), h31(i + vec3f(1., 1., 1.)), u.x), u.y), u.z);
}
fn fbm(p: vec3f, n: i32) -> f32 {
  var a = .5; var s = 0.; var q = p;
  for (var i = 0; i < n; i++) { s += a * vn(q); q = q * 2.03 + vec3f(17.1, 31.7, 5.3); a *= .5; }
  return s / (1. - 2. * a);
}
fn wor(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p); var d = 9.;
  for (var x = -1; x <= 1; x++) { for (var y = -1; y <= 1; y++) { for (var z = -1; z <= 1; z++) {
    let o = vec3f(f32(x), f32(y), f32(z)); let r = o + h33(i + o) - f; d = min(d, dot(r, r));
  } } }
  return sqrt(d);
}
`;

// ---------------------------------------------------------------- near-field rock density (compute)
// M holds the CPU ground model per column: x height, y basalt mask, z granite mask (masks fade to 0 at the
// box edge, so the near surface meets the far heightmap there).
const W_DENS = W_NOISE + /*wgsl*/`
struct U { n: vec4u, o: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read_write> D: array<f32>;
@group(0) @binding(2) var<storage, read> M: array<vec4f>;
fn colAt(x: f32, z: f32) -> vec4f {
  let fx = clamp(x, 0., f32(u.n.x) - 1.001); let fz = clamp(z, 0., f32(u.n.z) - 1.001);
  let ix = u32(fx); let iz = u32(fz); let tx = fx - f32(ix); let tz = fz - f32(iz); let w = u.n.x;
  return mix(mix(M[ix + w * iz], M[ix + 1u + w * iz], tx), mix(M[ix + w * (iz + 1u)], M[ix + 1u + w * (iz + 1u)], tx), tz);
}
fn dens(p: vec3f, gx: f32, gz: f32) -> f32 {
  let ef = ss(0., 16., min(min(gx, f32(u.n.x) - 1. - gx), min(gz, f32(u.n.z) - 1. - gz)));
  let m = colAt(gx, gz) * vec4f(1., ef, ef, 1.);
  var d = m.x - p.y;
  let w = vec3f(fbm(p * .05 + 11., 2), fbm(p * .05 + 47., 2), fbm(p * .05 + 83., 2)) - .5;
  if (m.y > .001) {
    // basalt: jointed blocks with a rough clinker crust, the cooling joints bite deeper near the flow front
    let q = p + w * 5.;
    let blk = (.5 - wor(q * vec3f(.3, .42, .3))) * 1.7;
    d += m.y * (blk + (fbm(p * .75, 3) - .5) * 1.1 + (fbm(p * 2.6, 2) - .5) * .55);
  }
  if (m.z > .001) {
    // granite: rounded tors and exfoliating slabs
    let q = p + w * 3.;
    d += m.z * ((.5 - wor(q * .085)) * 6.5 + (fbm(p * .22, 3) - .5) * 2.4 + (abs(fract(p.y * .33 + w.x) - .5) - .25) * .7);
  }
  d += (fbm(p * .9, 2) - .5) * .1 * (1. - m.y) * ef;
  return d;
}
@compute @workgroup_size(4, 4, 4) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id >= u.n.xyz)) { return; }
  var d = dens(u.o.xyz + vec3f(id) * u.o.w, f32(id.x), f32(id.z));
  if (id.y == u.n.y - 1u) { d = -1.; }
  if (id.y == 0u) { d = 1.; }
  D[id.x + u.n.x * (id.y + u.n.y * id.z)] = d;
}
`;

// ---------------------------------------------------------------- ground model (compute, load time)
// One function for the whole 24 km world, sampled twice: 1 m over the near field and ~23 m over everything.
// A = height, basalt, granite, wadi sand · B = city ground (1 = the Haram plaza), palm groves
const W_GROUND = W_NOISE + /*wgsl*/`
struct U { n: vec4u, o: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read_write> A: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> B: array<vec4f>;
// scoria cones on the harrat: x, z, height, radius
const CONES = array<vec4f, 8>(vec4f(1800., -600., 70., 260.), vec4f(2600., 900., 90., 320.), vec4f(1400., 1700., 55., 220.),
  vec4f(3200., -2200., 80., 300.), vec4f(900., 2600., 60., 240.), vec4f(2200., 2400., 75., 280.), vec4f(3800., 300., 95., 340.), vec4f(1100., 650., 35., 160.));
// granite knolls in the near field (the climbable hill of viewpoint 4): x, z, height, radius
const KN = array<vec4f, 3>(vec4f(95., 165., 21., 26.), vec4f(128., 192., 9., 16.), vec4f(70., 205., 6., 14.));
fn wadiX(z: f32) -> f32 { return -150. + 30. * sin(z * .009) + 14. * sin(z * .0023 + 1.); }
fn lavaFront(z: f32) -> f32 { return 118. + 16. * sin(z * .014) + 9. * sin(z * .041 + 2.); }
fn ridged(p: vec2f, s: f32) -> f32 { return 1. - abs(fbm(vec3f(p * s, 5.), 4) * 2. - 1.); }
fn massif(p: vec2f, c: vec2f, ang: f32, L: f32, W: f32) -> f32 {
  let r = p - c; let a = vec2f(cos(ang), sin(ang));
  let lx = dot(r, a) / L; let lz = dot(r, vec2f(-a.y, a.x)) / W;
  return pow(max(1. - lx * lx - lz * lz, 0.), 1.2);
}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= u.n.x || id.y >= u.n.y) { return; }
  let x = u.o.x + f32(id.x) * u.o.z; let z = u.o.y + f32(id.y) * u.o.z; let p2 = vec2f(x, z);
  var h = 3.5 * (fbm(vec3f(x * .0013, 1.3, z * .0013), 3) - .5) + (fbm(vec3f(x * .011, 2.1, z * .011), 2) - .5);
  let wd = abs(x - wadiX(z)) + 6. * (fbm(vec3f(x * .03, 4., z * .03), 2) - .5);
  let wadi = ss(26., 8., wd) * ss(-1100., -700., z);
  h -= 2.3 * wadi;
  var gran = 0.;
  for (var k = 0; k < 3; k++) {
    let c = KN[k]; let d = distance(p2, c.xy) / (c.w * 1.35); let kk = max(1. - d * d, 0.);
    h += c.z * pow(kk, 1.7); gran = max(gran, ss(.04, .3, kk));
  }
  let lf = x - lavaFront(z) - 7. * (fbm(vec3f(x * .02, 3., z * .02), 2) - .5);
  let lavN = ss(-1.5, 3.5, lf) * ss(-800., -450., z) * ss(1700., 1200., z);
  let lavF = ss(0., 380., x - 650. - 300. * sin(z * .0006) - 420. * (fbm(vec3f(x * .0012, 8., z * .0012), 3) - .5)) * ss(-2600., -1700., z);
  let lavS = ss(0., 600., x + z * .6 - 1900.);
  var lava = max(max(lavN, lavF), lavS);
  h += 6.5 * lava * (.8 + .4 * fbm(vec3f(x * .01, 6., z * .01), 2)) + 9. * max(lavF, lavS) * (fbm(vec3f(x * .007, 14., z * .007), 3) - .5);
  for (var k = 0; k < 8; k++) {
    let c = CONES[k]; let d = distance(p2, c.xy);
    if (d < c.w) {
      h += c.z * pow(1. - d / c.w, 1.3) - c.z * .3 * pow(max(1. - d / (c.w * .2), 0.), 2.);
      lava = max(lava, ss(c.w, c.w * .7, d));
    }
  }
  let uh = massif(p2, vec2f(300., -4300.), .12, 2800., 820.);
  h += 600. * uh * (.32 + .68 * pow(ridged(p2, .0011), 1.4)) + 140. * uh * (ridged(p2 + 300., .0036) - .55) + 60. * uh * (fbm(vec3f(x * .009, 7., z * .009), 3) - .5);
  let ay = massif(p2, vec2f(-700., 4300.), -.08, 2000., 620.);
  h += 240. * ay * (.5 + .5 * ridged(p2 + 900., .0013));
  gran = max(gran, ss(0., .08, uh + ay));
  let r = length(p2);
  let rim = ss(6500., 11000., r) * (.45 + .75 * fbm(vec3f(x * .0005, 9., z * .0005), 3));
  h += 300. * rim; gran = max(gran, ss(.1, .3, rim) * .8);
  let dm = length((p2 - vec2f(0., -1500.)) * vec2f(1., 1.15));
  h = mix(h, -1.5, ss(950., 380., dm));
  h = mix(h, .4, ss(56., 40., distance(p2, vec2f(-95., -150.))));
  let plaza = step(abs(x), 262.) * step(abs(z + 1520.), 345.);
  let outNear = ss(300., 340., max(abs(x), abs(z)));
  var city = ss(3000., 1300., dm) * (1. - lava) * (1. - gran) * (1. - wadi * .8) * outNear * ss(-150., -420., z);
  city = mix(city * .5, 1., plaza);
  var palms = ss(.48, .6, fbm(vec3f(x * .0016, 11., z * .0016), 3)) * ss(-900., -250., z) * ss(1700., 1000., z) * ss(-2200., -1500., x) * ss(1600., 900., x);
  palms = max(palms, ss(.55, .7, fbm(vec3f(x * .003, 13., z * .003), 2)) * .3 * ss(2600., 1300., dm));
  palms *= (1. - lava) * (1. - gran) * (1. - plaza) * outNear * (1. - ss(.3, .5, city));
  A[id.x + u.n.x * id.y] = vec4f(h, lava, gran, wadi);
  B[id.x + u.n.x * id.y] = vec4f(city, palms, 0., 0.);
}
`;

// ---------------------------------------------------------------- fullscreen helpers
const W_FS = /*wgsl*/`
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32(i32(i & 1u) * 4 - 1), f32(i32(i >> 1u) * 4 - 1), 0., 1.); }
`;

// surface detail texture (tileable): rg = slope, b = height, a = mottling
const W_DETAIL = W_NOISE + W_FS + /*wgsl*/`
fn hp(p: vec2f, per: f32) -> f32 { return h31(vec3f(p - per * floor(p / per), per)); }
fn tn(p: vec2f, per: f32) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3. - 2. * f);
  return mix(mix(hp(i, per), hp(i + vec2f(1., 0.), per), u.x), mix(hp(i + vec2f(0., 1.), per), hp(i + vec2f(1., 1.), per), u.x), u.y);
}
fn tf(uv: vec2f, per: f32, n: i32) -> f32 { var a = .5; var s = 0.; var pr = per; for (var i = 0; i < n; i++) { s += a * tn(uv * pr + f32(i) * 7.3, pr); pr *= 2.; a *= .5; } return s / (1. - 2. * a); }
fn tw(p: vec2f, per: f32) -> vec3f {
  let i = floor(p); let f = fract(p); var d = vec2f(9.); var id = 0.;
  for (var x = -1; x <= 1; x++) { for (var y = -1; y <= 1; y++) {
    let o = vec2f(f32(x), f32(y)); let c = i + o; let cw = c - per * floor(c / per);
    let hh = h33(vec3f(cw, per)); let r = o + hh.xy - f; let l = dot(r, r);
    if (l < d.x) { d.y = d.x; d.x = l; id = hh.z; } else if (l < d.y) { d.y = l; }
  } }
  return vec3f(sqrt(d), id);
}
fn H(uv: vec2f) -> f32 {
  let wq = uv + .11 * (vec2f(tf(uv, 3., 4), tf(uv + .5, 3., 4)) - .5);
  let f = tf(wq, 3., 8);
  let r1 = 1. - abs(tf(wq + 1.7, 5., 6) * 2. - 1.);
  let cr = min(abs(tf(wq + 4.1, 4., 5) * 2. - 1.) * 7., 1.);
  let cr2 = min(abs(tf(wq.yx + 2.3, 9., 4) * 2. - 1.) * 9., 1.);
  let pt = tw(wq * 29., 29.);
  let pit = (1. - ss(.0, .34, pt.x)) * step(.62, pt.z);
  return f * .50 + r1 * r1 * .24 + cr * cr2 * .26 - pit * .07;
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / 1024.; let e = 1. / 1024.;
  let h = H(uv);
  let gx = H(uv + vec2f(e, 0.)) - H(uv - vec2f(e, 0.)); let gy = H(uv + vec2f(0., e)) - H(uv - vec2f(0., e));
  let s = clamp(vec2f(gx, gy) * 1024. * .5 * .075, vec2f(-1.), vec2f(1.));
  return vec4f(-s * .5 + .5, h, tf(uv + 3.7, 3., 5));
}
`;

// blit / mip / bloom chain
const W_BLIT = W_FS + /*wgsl*/`
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
fn uvOf(fc: vec4f, k: f32) -> vec2f { return fc.xy * k / vec2f(textureDimensions(t)); }
@fragment fn fsMip(@builtin(position) fc: vec4f) -> @location(0) vec4f { return textureSampleLevel(t, s, uvOf(fc, 2.), 0.); }
fn kar(c: vec3f) -> vec4f { let w = 1. / (1. + max(c.r, max(c.g, c.b))); return vec4f(c * w, w); }
@fragment fn fsDown0(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, 2.); let e = 1. / vec2f(textureDimensions(t));
  let a = kar(min(textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.).rgb, vec3f(24.)));
  let b = kar(min(textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.).rgb, vec3f(24.)));
  let c = kar(min(textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.).rgb, vec3f(24.)));
  let d = kar(min(textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.).rgb, vec3f(24.)));
  let m = a + b + c + d;
  return vec4f(m.rgb / m.a, 1.);
}
@fragment fn fsDown(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, 2.); let e = 1. / vec2f(textureDimensions(t));
  return (textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.)
        + textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.)) * .25;
}
@fragment fn fsUp(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, .5); let e = .75 / vec2f(textureDimensions(t));
  return (textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.)
        + textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.)) * .25;
}
`;

// ---------------------------------------------------------------- shared: uniforms, sky, air
const S_G = /*wgsl*/`
struct G { vp: mat4x4f, sm: mat4x4f, cam: vec4f, right: vec4f, up: vec4f, fwd: vec4f, sun: vec4f, res: vec4f, mis: vec4f };
const SUNC = vec3f(2.9, 2.1, 1.35);
const ZEN = vec3f(.10, .24, .58);
const HOR = vec3f(.98, .66, .42);
const BETA = vec3f(1.1e-4, 1.4e-4, 1.9e-4);
const HSCALE = 420.;
const TAU = 6.2831853;
const NEARH = 256.;
const LOW = ${LV > 1};
fn sat(x: f32) -> f32 { return clamp(x, 0., 1.); }
fn ss(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
fn ign(p: vec2f) -> f32 { return fract(52.9829189 * fract(dot(p, vec2f(.06711056, .00583715)))); }
fn hs(x: f32) -> f32 { return fract(sin(x * 127.1) * 43758.5453); }
fn fin(c: vec3f) -> vec4f { return vec4f(min(max(c, vec3f(0.)), vec3f(60.)), 1.); }
// sky radiance in direction rd: blue overhead, warm along the horizon on the sun's side, violet-grey opposite
fn skyCol(rd: vec3f, sun: vec3f) -> vec3f {
  let y = max(rd.y, 0.);
  let h = vec2f(rd.x, rd.z); let hl = max(length(h), 1e-4);
  let tw = .5 + .5 * dot(h / hl, normalize(sun.xz));
  let mu = dot(rd, sun);
  let hor = mix(vec3f(.66, .67, .74), vec3f(1.35, .84, .44), tw * tw);
  var c = mix(hor, ZEN, pow(y, .5));
  c += vec3f(1., .5, .2) * .35 * pow(sat(1. - y * 4.), 3.) * tw * tw * tw;
  c += SUNC * (.04 * pow(max(mu, 0.), 5.) + .16 * pow(max(mu, 0.), 40.) + .45 * pow(max(mu, 0.), 500.));
  return mix(c, mix(vec3f(.46, .46, .5), vec3f(1., .66, .4), tw), sat(-rd.y * 5.));
}
// aerial perspective: exponential-height haze integrated in closed form along the view ray; distant things
// fade to the sky's horizon colour in their direction (warm toward the sun, cool away from it)
fn aerialAt(c: vec3f, cam: vec3f, wp: vec3f, sun: vec3f) -> vec3f {
  let v = wp - cam; let d = max(length(v), 1e-3); let rd = v / d;
  let k = rd.y / HSCALE;
  let od = select((1. - exp(-k * d)) / k, d, abs(k) < 1e-7) * exp(-max(cam.y, -30.) / HSCALE);
  let T = exp(-BETA * od);
  let ins = skyCol(normalize(vec3f(rd.x, max(rd.y, 0.) * .3 + .012, rd.z)), sun);
  return c * T + ins * (1. - T);
}
fn qrot(q: vec4f, v: vec3f) -> vec3f { return v + 2. * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
// palms sway as a whole from the root: the same offset moves trunk tops and their fronds together
fn palmSway(b: vec2f, h: f32, t: f32) -> vec2f {
  let ph = dot(b, vec2f(.043, .029));
  let gust = .65 + .35 * sin(t * .23 + b.x * .004 + b.y * .003);
  return .0045 * pow(max(h, 0.), 1.5) * gust * vec2f(sin(t * .8 + ph) + .3 * sin(t * 1.9 + ph * 2.), .6 * cos(t * .63 + ph * 1.3));
}
`;

const S_B = S_G + /*wgsl*/`
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(1) var sR: sampler;
@group(0) @binding(2) var sC: sampler;
@group(0) @binding(3) var sS: sampler_comparison;
@group(0) @binding(4) var tSh: texture_depth_2d;
@group(0) @binding(5) var tD: texture_2d<f32>;
@group(0) @binding(6) var tV: texture_3d<f32>;
@group(0) @binding(7) var tN: texture_2d<f32>;
@group(0) @binding(8) var tF: texture_2d<f32>;
fn nearK(p: vec3f) -> f32 { return 1. - ss(NEARH - 12., NEARH - 2., max(abs(p.x), abs(p.z))); }
fn shUV(p: vec3f) -> vec3f { let s = g.sm * vec4f(p, 1.); return vec3f(s.x * .5 + .5, .5 - s.y * .5, s.z - .0004); }
fn shadow1(p: vec3f) -> f32 {
  let s = shUV(p);
  return mix(1., textureSampleCompareLevel(tSh, sS, s.xy, s.z), nearK(p));
}
fn shadow9(p: vec3f) -> f32 {
  if (LOW) { return shadow1(p); }
  let s = shUV(p); let e = 1.4 / ${SHADOW}.; var a = 0.;
  for (var x = -1; x <= 1; x++) { for (var y = -1; y <= 1; y++) { a += textureSampleCompareLevel(tSh, sS, s.xy + vec2f(f32(x), f32(y)) * e, s.z); } }
  return mix(1., a / 9., nearK(p));
}
// r = openness, g = skylight; outside the near field everything is open sky
fn vol(p: vec3f) -> vec2f {
  let v = textureSampleLevel(tV, sC, (p - vec3f(-256., -16., -256.)) / vec3f(512., 96., 512.), 0.).rg;
  return mix(vec2f(1.), v, nearK(p));
}
fn amb(n: vec3f, sky: f32) -> vec3f {
  let up = n.y * .5 + .5;
  return (ZEN * 1.15 * up * up + vec3f(.62, .44, .30) * .32 * (1. - up) + vec3f(.08, .07, .065)) * (.3 + .7 * sky);
}
fn aerial(c: vec3f, wp: vec3f) -> vec3f { return aerialAt(c, g.cam.xyz, wp, g.sun.xyz); }
`;

// ---------------------------------------------------------------- solids: terrain, rocks, buildings, trunks
// instance c: x material, y seed, z distance at which the mesh has shrunk away (0 = never), w 1 = sways like a palm
const W_SOLID = S_B + /*wgsl*/`
struct VI { @location(0) p: vec3f, @location(1) n: vec4f, @location(2) a: vec4f, @location(3) b: vec4f, @location(4) c: vec4f };
struct VO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) op: vec3f, @location(3) on: vec3f,
  @location(4) @interpolate(flat) m: vec4f, @location(5) @interpolate(flat) q: vec4f, @location(6) ao: f32 };
@vertex fn vs(i: VI) -> VO {
  var o: VO;
  var sc = i.a.w;
  if (i.c.z > .5 && g.res.x > 0.) { sc *= 1. - ss(i.c.z * .7, i.c.z, distance(i.a.xyz, g.cam.xyz) / g.mis.z); }
  let lp = i.p * sc;
  var w = i.a.xyz + qrot(i.b, lp);
  let mt = i.c.x;
  if (abs(mt - 12.) < .5 || abs(mt - 18.) < .5) { let sw = palmSway(i.a.xz, lp.y, g.cam.w); w.x += sw.x; w.z += sw.y; }
  if (abs(mt - 13.) < .5) { let sw = palmSway(i.a.xz, i.c.w, g.cam.w); w.x += sw.x; w.z += sw.y; }
  o.cp = g.vp * vec4f(w, 1.); o.wp = w; o.n = qrot(i.b, i.n.xyz);
  let arch = (mt > 4.5 && mt < 11.5) || abs(mt - 17.) < .5;
  o.op = select(select(lp + i.c.y * 37., lp, arch), w, mt < 1.5); o.on = i.n.xyz;
  o.m = i.c; o.q = i.b; o.ao = i.n.w;
  return o;
}
struct TP { h: f32, c: f32, n: vec3f };
fn tri(p: vec3f, n: vec3f, s: f32) -> TP {
  var w = pow(abs(n), vec3f(4.)); w /= (w.x + w.y + w.z);
  let x = textureSample(tD, sR, p.zy * s); let y = textureSample(tD, sR, p.xz * s); let z = textureSample(tD, sR, p.xy * s);
  var o: TP;
  o.h = x.b * w.x + y.b * w.y + z.b * w.z;
  o.c = x.a * w.x + y.a * w.y + z.a * w.z;
  let a = x.rg * 2. - 1.; let b = y.rg * 2. - 1.; let c = z.rg * 2. - 1.;
  o.n = vec3f(0., a.y, a.x) * w.x + vec3f(b.x, 0., b.y) * w.y + vec3f(c.x, c.y, 0.) * w.z;
  return o;
}
// pointed-arch arcade on facades: bay width bw, opening height ah; returns 1 inside an opening
fn arcade(u: f32, v: f32, bw: f32, ah: f32, v0: f32) -> f32 {
  let x = (fract(u / bw) - .5) * bw; let hw = bw * .36;
  let y = v - v0;
  let top = ah + hw * 1.15 * sqrt(max(1. - (x / hw) * (x / hw), 0.)) - abs(x) * .35;
  return step(abs(x), hw) * step(0., y) * step(y, top);
}
@fragment fn fs(i: VO, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let mat = i32(i.m.x + .5); let sd = i.m.y; let fl_ = select(-1., 1., ff);
  let on = normalize(i.on) * fl_; let n0 = normalize(i.n) * fl_;
  let dist = length(i.wp - g.cam.xyz);
  let far = mat == 1;
  let ts = select(select(1., .035, far), .5, mat >= 5 && mat != 12);
  let A = tri(i.op, on, .07 * ts); let B = tri(i.op, on, .31 * ts); let C = tri(i.op, on, 1.3 * ts); let F = tri(i.op, on, 5.1 * ts);
  let fk = ss(14., 2., dist) * f32(mat <= 4);
  let nm = textureSample(tN, sC, i.wp.xz / 512. + .5);
  let fm = textureSample(tF, sC, i.wp.xz / 24000. + .5);
  let rpW = textureSample(tD, sR, i.wp.xz * .7 + vec2f(g.cam.w * .03, 0.)).rg * 2. - 1.;
  var bump = 1.2; var gloss = .08; var alb = vec3f(.5); var emi = vec3f(0.); var metal = 0.; var vao = 1.;
  let flt = ss(.7, .92, n0.y);
  let nk = nearK(i.wp);
  // facade coordinates for building materials: along the wall and up it
  let fu = select(i.op.z, i.op.x, abs(on.z) > abs(on.x)); let fv = i.op.y; let wall = 1. - ss(.45, .7, abs(on.y));
  if (mat <= 1) {
    let lava = mix(fm.r, nm.g, nk); let gran = mix(fm.g, nm.b, nk); let wadi = nm.r * nk; let irr = nm.a * nk; let city = fm.b * (1. - nk);
    alb = mix(vec3f(.52, .34, .19), vec3f(.68, .49, .30), sat(A.c * 1.4 - .2)) * (.72 + .5 * B.h) * (.82 + .36 * C.c);
    alb = mix(alb, vec3f(.36, .26, .18) * (.8 + .4 * C.h), ss(.55, .75, B.c) * .35);
    alb = mix(alb, vec3f(.76, .62, .45) * (.86 + .25 * B.h), wadi);
    alb = mix(alb, mix(vec3f(.21, .14, .085), vec3f(.12, .15, .055), ss(.35, .65, B.c)), irr * .85);
    let bas = mix(vec3f(.032, .031, .03), vec3f(.065, .052, .045), ss(.5, .78, A.c)) * (.65 + .7 * C.h);
    alb = mix(alb, mix(bas, vec3f(.40, .28, .17) * (.8 + .3 * B.h), flt * ss(.6, .9, B.c + .2 * A.h) * .45), lava);
    var gra = mix(vec3f(.40, .18, .11), vec3f(.56, .30, .19), A.c) * (.68 + .55 * B.h);
    gra = mix(gra, vec3f(.13, .10, .10), ss(.55, .7, fract(i.wp.y * select(.11, .013, far) + A.h * 1.5)) * .45);
    alb = mix(alb, gra, gran * (1. - .55 * flt));
    alb = mix(alb, mix(vec3f(.52, .45, .37) * (.8 + .3 * B.h), vec3f(.84, .82, .77), ss(.9, .97, city)), ss(.05, .2, city));
    alb = mix(alb, mix(mix(vec3f(.05, .045, .04), vec3f(.11, .085, .065), A.h) * (.7 + .6 * B.c), vec3f(.42, .30, .19), ss(.62, .82, B.c) * .35), lava * (1. - nk) * .7);
    alb *= mix(1., .6 + .8 * F.h, fk);
    bump = select(1.3, 1., far); gloss = mix(.06, .22, lava * (1. - flt));
  } else if (mat == 2) {
    alb = mix(vec3f(.033, .032, .031), vec3f(.07, .055, .046), ss(.45, .75, A.c)) * (.6 + .8 * B.h);
    alb = mix(alb, vec3f(.40, .28, .17), flt * ss(.65, .9, B.c) * .3); bump = 1.8; gloss = .28;
  } else if (mat == 3) {
    alb = mix(vec3f(.26, .17, .13), vec3f(.38, .27, .20), A.c) * (.6 + .6 * B.h); bump = 1.4;
  } else if (mat == 4) {
    alb = mix(vec3f(.54, .45, .36), vec3f(.44, .36, .29), hs(sd * 91.)) * (.75 + .4 * B.h); bump = .6; gloss = .12;
  } else if (mat == 5) {
    // mud brick: courses of sun-dried bricks, rendered and eroded, darker at the foot
    let row = floor(fv / .34); let bx = fract(fu / .7 + row * .5); let by = fract(fv / .34);
    let mortar = (1. - ss(.0, .06, by) * ss(1., .94, by)) * .5 + (1. - ss(.0, .05, bx) * ss(1., .95, bx)) * .5;
    let render = ss(.45, .65, B.c + .25 * A.h);
    alb = mix(vec3f(.52, .35, .21), vec3f(.44, .29, .17), hs(row * 7.1 + floor(fu / .7 + row * .5)) * .6) * (.78 + .4 * C.h);
    alb = mix(alb * (1. - .35 * mortar * (1. - render)), vec3f(.60, .44, .29) * (.8 + .3 * B.h), render * .55);
    alb *= mix(.7, 1., ss(0., .6, fv)); bump = .45;
  } else if (mat == 6 || mat == 7 || mat == 17) {
    // stucco and stone: white (6), cream (7), mixed city buildings (17) with windows by floor
    let hh = hs(sd * 3.7);
    let ct = select(select(select(select(vec3f(.80, .70, .55), vec3f(.70, .58, .44), hh > .3), vec3f(.82, .80, .75), hh > .55), vec3f(.66, .48, .32), hh > .75), vec3f(.55, .53, .50), hh > .9);
    let tone = select(select(vec3f(.80, .78, .74), vec3f(.84, .74, .60), mat == 7), ct, mat == 17);
    alb = tone * (.86 + .2 * B.h) * (.94 + .1 * C.c);
    if (mat == 17) {
      let wx = fract(fu / 3.4); let wy = fract(fv / 3.3); let flr = floor(fv / 3.3); let bay = floor(fu / 3.4);
      let win = step(.28, wx) * step(wx, .72) * step(.3, wy) * step(wy, .78) * step(1., flr) * wall * step(fv, i.m.w - 1.);
      let lit = step(.86, hs(flr * 13.1 + bay * 7.7 + sd * 31.));
      alb = mix(alb, vec3f(.05, .055, .06), win * .9);
      emi = vec3f(1., .62, .30) * .9 * win * lit;
      alb = mix(alb, alb * vec3f(.5, .47, .45), ss(.6, .9, on.y));
      gloss = mix(.08, .55, win);
    } else {
      let bw = select(4.2, 6.5, mat == 7);
      let a1 = arcade(fu, fv, bw, select(3.2, 8.5, mat == 7), select(.6, 1., mat == 7)) * wall;
      let a2 = arcade(fu + bw * .5, fv, bw, select(1.2, 2.4, mat == 7), select(5.8, 12.6, mat == 7)) * wall * step(fv, select(7.6, 16., mat == 7));
      let ins = max(a1, a2 * .8);
      alb = mix(alb, vec3f(.20, .16, .12), a1 * step(.5, i.m.w));
      alb = mix(alb, vec3f(.07, .07, .08), a2 * .85 * step(.5, i.m.w));
      emi = vec3f(1., .7, .4) * (.05 * a1 + .18 * a2) * step(.5, i.m.w);
      gloss = mix(.08, .5, a2);
      alb = mix(alb, alb * vec3f(.78, .72, .66), ss(.6, .9, on.y));
      let band = ss(.92, .97, fract(fv / select(7.9, 16.6, mat == 7))) * wall;
      alb = mix(alb, alb * vec3f(.92, .84, .7), band * .6);
    }
    bump = .12;
  } else if (mat == 8) {
    let rib = ss(.4, .5, abs(fract(atan2(i.op.z, i.op.x) / TAU * 24.) - .5)) * .3;
    alb = vec3f(.06, .40, .16) * (1. - rib) * (.92 + .16 * B.h); gloss = .6; bump = .05;
  } else if (mat == 9) {
    alb = vec3f(.58, .60, .62) * (.9 + .15 * B.h); gloss = .75; metal = .6; bump = .1;
  } else if (mat == 10) {
    alb = vec3f(1., .70, .28); gloss = .9; metal = 1.; bump = 0.;
  } else if (mat == 11) {
    alb = vec3f(.86, .85, .81) * (.92 + .1 * B.h); gloss = .2; bump = .1;
  } else if (mat == 12 || mat == 18) {
    // date palm trunk: spiral of cut leaf bases makes a diamond crosshatch
    let ang = atan2(i.op.z - sd * 37., i.op.x - sd * 37.) / TAU;
    let k1 = abs(fract(i.op.y * 3.3 + ang * 8.) - .5); let k2 = abs(fract(i.op.y * 3.3 - ang * 8.) - .5);
    let grv = 1. - ss(.03, .2, min(k1, k2));
    alb = mix(vec3f(.34, .25, .16), vec3f(.24, .17, .11), B.c) * (1. - .3 * grv * f32(mat == 12)) * (.88 + .24 * C.h);
    vao = mix(.55, 1., ss(0., 2., i.op.y - sd * 37.)); bump = .8;
  } else if (mat == 13) {
    alb = mix(vec3f(.52, .20, .035), vec3f(.32, .10, .025), hs(sd * 17.)) * (.8 + .3 * C.h); gloss = .4; bump = .6;
  } else if (mat == 14) {
    alb = vec3f(.66, .60, .52) * (.8 + .3 * B.h); bump = .3;
  } else if (mat == 16) {
    alb = vec3f(.24, .15, .08) * (.7 + .5 * C.c); bump = .7;
  }
  // water: sky reflection over a dark channel bed, ripples from the detail texture
  if (mat == 15) {
    let V = normalize(g.cam.xyz - i.wp);
    let N = normalize(vec3f(rpW.x * .06, 1., rpW.y * .06));
    let fr = .02 + .98 * pow(1. - sat(dot(N, V)), 5.);
    let R = reflect(-V, N);
    var c = mix(vec3f(.03, .045, .03), skyCol(R, g.sun.xyz) * .9, fr) + SUNC * shadow1(i.wp) * pow(sat(dot(R, g.sun.xyz)), 400.) * 6.;
    return fin(aerial(c, i.wp));
  }
  let N = normalize(qrot(i.q, normalize(on + (A.n * .8 + B.n * .6 + C.n * .4 * ss(70., 10., dist) + F.n * .5 * fk) * bump)));
  let L = g.sun.xyz; let V = normalize(g.cam.xyz - i.wp);
  let vv = vol(i.wp + n0 * 1.2); let v2 = vol(i.wp + n0 * 4.);
  var ao = (sat((vv.x - .5) * 6.) * .5 + sat((v2.x - .5) * 2.5) * .5) * vao * mix(1., i.ao, f32(mat == 1));
  ao = mix(ao, vao * select(1., i.ao, far), 1. - nk);
  ao = select(ao, .5 + .5 * ao, mat >= 5 && mat != 12 && mat != 13);
  let sh = select(shadow9(i.wp + n0 * (.3 + dist * .002)), sat(i.ao * 1.6 - .3), far);
  let E = SUNC * sh;
  let ndl = sat(dot(N, L));
  let am = amb(N, vv.y) * ao;
  var c = alb * (E * ndl + am) + emi;
  let Hh = normalize(V + L);
  let spc = mix(vec3f(.04), alb, metal);
  c += E * spc * pow(sat(dot(N, Hh)), mix(8., 120., gloss)) * gloss * ndl * 4.;
  c += skyCol(reflect(-V, N), L) * ao * spc * gloss * pow(1. - sat(dot(N, V)), 3.) * 1.5;
  return fin(aerial(c, i.wp));
}
`;

// ---------------------------------------------------------------- fronds, grass, shrubs
// instance: a = anchor xyz + length, b = yaw, tilt from vertical, half width, height of the anchor above ground,
// c (unorm8) = type, seed1, seed2, bend
const W_LEAF = S_B + /*wgsl*/`
override ROWS: f32 = 7.;
override FAR: f32 = 400.;
struct LI { @location(0) a: vec4f, @location(1) b: vec4f, @location(2) c: vec4f };
struct LO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f,
  @location(3) @interpolate(flat) col: vec3f, @location(4) @interpolate(flat) pr: vec4f, @location(5) @interpolate(flat) sd: vec2f };
fn grassSway(p: vec2f, h: f32, t: f32) -> vec2f {
  let ph = dot(p, vec2f(.071, .043));
  return .05 * h * (vec2f(sin(t * 1.3 + ph), cos(t * 1.1 + ph * 1.3)) + .4 * vec2f(sin(t * 3.1 + ph * 3.), cos(t * 2.7 + ph * 2.)));
}
@vertex fn vs(@builtin(vertex_index) vi: u32, i: LI) -> LO {
  var o: LO;
  let u = f32(vi & 1u) * 2. - 1.; let v = f32(vi >> 1u) / (ROWS - 1.);
  let ty = i32(i.c.x * 255. + .5); let s1 = i.c.y; let s2 = i.c.z;
  let t = g.cam.w; let len = i.a.w; let hA = i.b.w;
  let cy = cos(i.b.x); let sy = sin(i.b.x); let ct = cos(i.b.y); let st = sin(i.b.y);
  let d = vec3f(st * cy, ct, st * sy); let pe = vec3f(ct * cy, -st, ct * sy); let sd = vec3f(-sy, 0., cy);
  var col = vec3f(0.); var pr = vec4f(0.); var shp = 0.; var fold = 0.;
  let palm = ty == 0 || ty == 1 || ty == 5;
  switch ty {
    case 0 { col = mix(vec3f(.07, .11, .03), vec3f(.14, .15, .045), s1); pr = vec4f(1., .55, 0., 0.); fold = .5; }
    case 1 { col = mix(vec3f(.30, .20, .10), vec3f(.40, .30, .16), s1); pr = vec4f(1., .35, 0., 0.); fold = .3; }
    case 2 { col = mix(vec3f(.16, .19, .05), vec3f(.30, .28, .10), s1); pr = vec4f(0., .7, 0., 0.); }
    case 3 { col = mix(vec3f(.20, .21, .14), vec3f(.28, .23, .13), s1); pr = vec4f(0., .4, 0., 0.); }
    case 4 { col = mix(vec3f(.12, .16, .06), vec3f(.18, .20, .08), s1); pr = vec4f(0., .6, 0., 0.); }
    default { col = mix(vec3f(.09, .12, .04), vec3f(.15, .16, .05), s1); pr = vec4f(0., .6, 0., 0.); }
  }
  // fronds droop along a circular arc and flutter; grass and shrubs bend and sway from the root
  let fl = sin(t * (1.7 + s1) + s2 * 40. + hA * .3) * select(.12, .2, palm);
  let k0 = (i.c.w - .2) * select(1.5, 2.6, palm) + fl * v;
  let ka = select(k0, .05, abs(k0) < .05);
  let sK = sin(ka * v); let cK = cos(ka * v);
  let c = i.a.xyz + len * (d * (sK / ka) + pe * ((1. - cK) / ka));
  let N = normalize(pe * cK - d * sK);
  var w = i.b.z;
  if (palm) { w *= ss(.0, .16, v) * (1. - .8 * pow(v, 1.8)) * select(1., .55, ty == 5); }
  else { w *= pow(max(sin(3.14159 * pow(v, .6)), 0.), .7); }
  let cd = distance(i.a.xyz, g.cam.xyz);
  let farK = select((1. - ss(FAR * g.mis.z * .8, FAR * g.mis.z, cd)), 1., g.res.x == 0.);
  var p = c + sd * u * w * farK - N * abs(u) * w * fold;
  if (palm) { let sw = palmSway(i.a.xz - vec2f(0., 0.), hA, t); p.x += sw.x; p.z += sw.y; }
  else { let sw = grassSway(i.a.xz, p.y - i.a.y + hA, t); p.x += sw.x; p.z += sw.y; }
  o.cp = g.vp * vec4f(p, 1.); o.wp = p; o.n = normalize(-N - sd * u * fold * .9); o.uv = vec2f(u, v);
  o.col = col; o.pr = pr; o.sd = vec2f(s1, s2);
  return o;
}
fn leafCov(i: LO) -> f32 {
  let s = i.uv.y * 34. + abs(i.uv.x) * 2.4 + i.sd.x * 7.;
  let fw = fwidth(s);
  let f = abs(fract(s) - .5) * 2.;
  let lw = .7 * (1. - .4 * abs(i.uv.x));
  var cov = 1. - ss(lw - fw, lw + fw, f);
  cov = max(cov, 1. - ss(.04, .07, abs(i.uv.x)));
  cov *= 1. - ss(.82, 1., abs(i.uv.x) + .1 * f);
  cov = mix(cov, .9, ss(.16, .45, fw));
  return select(1., cov, i.pr.x > .5);
}
@fragment fn fsSh(i: LO) { if (leafCov(i) < .5) { discard; } }
@fragment fn fs(i: LO, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  // leaflets: slanted strips either side of the rachis, cut from the frond by alpha (to coverage with MSAA)
  let alpha = leafCov(i);
  let lt = textureSample(tD, sR, vec2f(i.uv.x * .1 + i.sd.x * 3.7, i.uv.y * .6 + i.sd.y * 5.3));
  if ((LOW || g.res.x == 0.) && alpha < .5) { discard; }
  let dist = length(i.wp - g.cam.xyz);
  var n = normalize(i.n); if (!ff) { n = -n; }
  let V = normalize(g.cam.xyz - i.wp); let L = g.sun.xyz;
  let vv = vol(i.wp + vec3f(0., .5, 0.));
  let E = SUNC * shadow1(i.wp + L * .4);
  let ndl = dot(n, L);
  var alb = i.col * (.7 + .3 * ss(0., .3, abs(i.uv.x))) * mix(.75, 1.1, i.uv.y) * (.6 + .8 * lt.b) * (.75 + .5 * lt.a);
  let tr = (max(-ndl, 0.) * .9 + .1) * i.pr.y;
  let trc = alb * vec3f(1.2, 1.25, .55);
  let aov = sat((vv.x - .5) * 5.);
  let am = (amb(n, vv.y) + amb(-n, vv.y) * i.pr.y * .45) * (.35 + .65 * aov);
  var c = E * (alb * max(ndl, 0.) + trc * tr) + alb * am;
  let H = normalize(V + L);
  c += E * pow(sat(dot(n, H)), 30.) * .25;
  c += E * trc * i.pr.y * pow(sat(dot(-V, L)), 4.) * .8;
  return vec4f(aerial(min(max(c, vec3f(0.)), vec3f(60.)), i.wp), alpha);
}
`;

// ---------------------------------------------------------------- birds (pigeons): flight and flapping in the shader
const W_ANIM = S_B + /*wgsl*/`
struct VI { @location(0) p: vec3f, @location(1) n: vec4f, @location(2) a: vec4f, @location(3) b: vec4f };
struct VO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) op: vec3f, @location(3) @interpolate(flat) sd: f32 };
@vertex fn vs(i: VI) -> VO {
  var o: VO;
  let s = i.b.x; let h = vec3f(hs(s), hs(s + .37), hs(s + .71));
  let R = i.a.w; let t = g.cam.w;
  let ta = t * i.b.y + i.b.w * 6.3 + (h.x - .5) * (14. / R);
  let ph = i.b.w * 17.;
  let P = i.a.xyz + vec3f(R * cos(ta), 4. * sin(2. * ta + ph), R * .8 * sin(ta));
  let T = normalize(vec3f(-R * sin(ta), 8. * cos(2. * ta + ph), R * .8 * cos(ta))) * sign(i.b.y);
  let S = normalize(cross(vec3f(0., 1., 0.), T)); let Up = cross(T, S);
  let off = S * ((h.y - .5) * 9. + sin(t * .5 + s * 40.) * 1.5) + Up * ((h.z - .5) * 5. + cos(t * .4 + s * 31.) * 1.);
  var l = i.p * i.b.z;
  let au = abs(i.n.w);
  let flap = ss(-.3, .4, sin(t * .45 + s * 23.));
  l.y += sin(t * 13. + s * 50.) * .55 * au * au * i.b.z * flap + au * .12 * i.b.z * (1. - flap);
  let w = P + off + S * l.x + Up * l.y + T * l.z;
  o.cp = g.vp * vec4f(w, 1.); o.wp = w; o.n = S * i.n.x + Up * i.n.y + T * i.n.z; o.op = i.p; o.sd = s;
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let n = normalize(i.n); let L = g.sun.xyz; let V = normalize(g.cam.xyz - i.wp);
  var alb = mix(vec3f(.30, .32, .36), vec3f(.48, .49, .52), ss(-.02, .02, i.op.y));
  alb = mix(alb, vec3f(.12, .13, .15), ss(.7, .9, abs(i.op.x)));
  alb = mix(alb, alb * vec3f(.7, 1.1, .9), step(.8, hs(i.sd * 3.)) );
  let E = SUNC * shadow1(i.wp);
  var c = alb * (E * (.2 + .8 * sat(dot(n, L))) + amb(n, 1.) * 1.2) + E * pow(sat(dot(n, normalize(V + L))), 20.) * .2;
  return fin(aerial(c, i.wp));
}
`;

// ---------------------------------------------------------------- sky dome behind everything
const W_SKY = S_B + W_NOISE.replace(/fn ss\(.*\n/, '') + /*wgsl*/`
struct VO { @builtin(position) cp: vec4f, @location(0) d: vec3f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var o: VO;
  let p = vec2f(f32(i & 1u), f32(i >> 1u)) * 2. - 1.;
  o.d = g.fwd.xyz + g.right.xyz * (p.x * g.right.w) + g.up.xyz * (p.y * g.up.w);
  o.cp = vec4f(p, 1e-9, 1.);
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let rd = normalize(i.d); let L = g.sun.xyz; let mu = dot(rd, L);
  var c = skyCol(rd, L);
  // high thin cloud: streaks of cirrus on a plane 6 km up, lit gold toward the sun
  if (rd.y > .004) {
    let q = rd.xz / rd.y * 6000.;
    let r = vec2f(q.x * .96 + q.y * .28, q.y * .96 - q.x * .28) * vec2f(.00011, .00042) + vec2f(g.cam.w * .002, 0.);
    let n = fbm(vec3f(r, 1.3), 5) + .35 * (fbm(vec3f(r * 3.1, 4.1), 3) - .5);
    let cov = ss(.58, .84, n) * ss(.004, .09, rd.y) * (1. - ss(.35, .9, rd.y));
    let lit = mix(vec3f(1.2, .74, .52), vec3f(2.4, 1.3, .62), pow(max(mu, 0.), 3.)) * (.75 + .5 * fbm(vec3f(r * 7., 2.), 2));
    c = mix(c, lit, cov * .5);
  }
  c += SUNC * 24. * ss(.99988, .99994, mu);
  return fin(c);
}
`;

// ---------------------------------------------------------------- dust motes and pollen (additive)
const W_SPR = S_B + /*wgsl*/`
struct VO { @builtin(position) cp: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) pr: vec4f };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) a: vec4f) -> VO {
  var o: VO; let q = vec2f(f32(vi & 1u), f32(vi >> 1u)) * 2. - 1.; let t = g.cam.w;
  let B = 26.;
  var p = a.xyz * B + vec3f(t * .18, t * .03, t * .07) + .4 * vec3f(sin(t * .3 + a.x * 60.), sin(t * .23 + a.y * 50.), cos(t * .27 + a.z * 70.));
  p = g.cam.xyz + (fract((p - g.cam.xyz) / B + .5) - .5) * B;
  let d = length(p - g.cam.xyz);
  let sz = .006 + .02 * a.w * a.w * a.w;
  let w = p + (g.right.xyz * q.x + g.up.xyz * q.y) * max(sz, d * .0009);
  o.cp = g.vp * vec4f(w, 1.); o.uv = q;
  let fade = ss(B * .5, B * .3, d) * ss(.4, 2., d) * min(1., sz / (d * .0009)) * ss(-2., 1., -abs(p.y - 4.) + 4.);
  let mu = dot(normalize(p - g.cam.xyz), g.sun.xyz);
  let ph = .15 + 2.2 * pow(max(mu, 0.), 6.);
  o.pr = vec4f(fade * ph * shadow1(p), a.w, 0., 0.);
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let m = ss(1., .15, length(i.uv));
  return vec4f(min(SUNC * mix(vec3f(1.), vec3f(1., .9, .6), i.pr.y) * m * m * i.pr.x * .9, vec3f(6.)), 0.);
}
`;

// ---------------------------------------------------------------- sun shafts through the grove dust (half res)
const W_RAYS = S_G + W_FS + /*wgsl*/`
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(1) var sS: sampler_comparison;
@group(0) @binding(2) var tSh: texture_depth_2d;
@group(0) @binding(3) var tDp: texture_depth${AA > 1 ? '_multisampled' : ''}_2d;
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let dp = textureLoad(tDp, vec2i(fc.xy) * 2, 0);
  let uv = fc.xy * 2. * g.res.zw;
  let nd = vec2f(uv.x * 2. - 1., 1. - uv.y * 2.);
  let rv = g.fwd.xyz + g.right.xyz * (nd.x * g.right.w) + g.up.xyz * (nd.y * g.up.w);
  let rl = length(rv); let rd = rv / rl;
  let zl = g.fwd.w / max(dp, 1e-6);
  let tm = min(zl * rl, 150.);
  let ro = g.cam.xyz; let sx = g.sun.xyz;
  let dt = tm / ${RAYN}.;
  let j = ign(fc.xy);
  var acc = 0.;
  for (var n = 0; n < ${RAYN}; n++) {
    let t = (f32(n) + j) * dt;
    let p = ro + rd * t;
    let s = g.sm * vec4f(p, 1.);
    let inb = 1. - ss(NEARH - 12., NEARH - 2., max(abs(p.x), abs(p.z)));
    let vis = mix(1., textureSampleCompareLevel(tSh, sS, vec2f(s.x * .5 + .5, .5 - s.y * .5), s.z - .0004), inb);
    let dust = .25 + exp(-max(p.y, 0.) / 9.) * 1.2;
    acc += vis * dust * exp(-t * .004);
  }
  let mu = dot(rd, sx);
  let gg = .72;
  let ph = (1. - gg * gg) / pow(1. + gg * gg - 2. * gg * mu, 1.5) * .08 + .04;
  return vec4f(min(SUNC * vec3f(1., .86, .66) * acc * dt * .0045 * ph * g.mis.y, vec3f(20.)), zl);
}
`;
// depth-aware 3x3 blur of the half-res shafts (hides the sampling dither)
const W_RBLUR = W_FS + /*wgsl*/`
@group(0) @binding(0) var tR: texture_2d<f32>;
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let p = vec2i(fc.xy); let mx = vec2i(textureDimensions(tR)) - 1;
  let c = textureLoad(tR, p, 0);
  var acc = vec3f(0.); var ws = 0.;
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let r = textureLoad(tR, clamp(p + vec2i(x, y), vec2i(0), mx), 0);
    let w = 1. / (.03 + abs(r.a - c.a) / c.a);
    acc += r.rgb * w; ws += w;
  } }
  return vec4f(acc / ws, c.a);
}
`;

// ---------------------------------------------------------------- final composite
const W_POST = S_G + W_FS + /*wgsl*/`
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(1) var sC: sampler;
@group(0) @binding(2) var tS: texture_2d<f32>;
@group(0) @binding(3) var tR: texture_2d<f32>;
@group(0) @binding(4) var tB: texture_2d<f32>;
@group(0) @binding(5) var tDp: texture_depth${AA > 1 ? '_multisampled' : ''}_2d;
fn tmap(x: vec3f) -> vec3f { return clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), vec3f(0.), vec3f(1.)); }
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let px = vec2i(fc.xy);
  let uv = fc.xy * g.res.zw;
  let zf = g.fwd.w / max(textureLoad(tDp, px, 0), 1e-6);
  let h = fc.xy * .5 - .5; let b = floor(h); let f = h - b; let bi = vec2i(b);
  let mx = vec2i(textureDimensions(tR)) - 1;
  var acc = vec3f(0.); var ws = 0.;
  for (var k = 0; k < 4; k++) {
    let o = vec2i(k & 1, k >> 1);
    let r = textureLoad(tR, clamp(bi + o, vec2i(0), mx), 0);
    let bw = mix(1. - f.x, f.x, f32(o.x)) * mix(1. - f.y, f.y, f32(o.y));
    let w = (bw + .02) / (.02 + abs(r.a - zf) / zf);
    acc += r.rgb * w; ws += w;
  }
  var c = textureLoad(tS, px, 0).rgb + acc / ws;
  let bl = textureSampleLevel(tB, sC, uv, 0.).rgb;
  c = mix(c, bl, .05) + bl * .03;
  c *= g.mis.x;
  let q = uv - .5;
  c *= 1. - dot(q, q) * .45;
  c = tmap(c);
  let l0 = dot(c, vec3f(.2126, .7152, .0722));
  let l = mix(l0, l0 * l0 * (3. - 2. * l0), .4);
  c *= l / max(l0, 1e-4);
  c = mix(vec3f(l), c, 1.04) + vec3f(.006, .003, 0.);
  c = pow(max(c, vec3f(0.)), vec3f(1. / 2.2));
  let n = ign(fc.xy) + ign(fc.xy + 37.) - 1.;
  return vec4f(c + n / 255., 1.);
}
`;
