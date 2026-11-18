// ============================================================================
// WGSL sources
// ============================================================================
// Noise, detail texture, blit/bloom and the composite chain follow Abyssal Garden (MIT); the air, sky, terrain
// materials, palms, buildings and birds are this world's own.

// smoothstep lives in its own string so modules that already have it (via S_G) can take the noise without it
const W_SS = /*wgsl*/`
fn ss(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
`;
const W_NOISE = /*wgsl*/`
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
const W_DENS = W_SS + W_NOISE + /*wgsl*/`
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
const W_GROUND = W_SS + W_NOISE + /*wgsl*/`
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
  let lavN = ss(-1.5, 3.5, lf) * ss(-420., -300., z) * ss(1700., 1200., z);
  let lavF = ss(0., 380., x - 2300. - 300. * sin(z * .0006) - 420. * (fbm(vec3f(x * .0012, 8., z * .0012), 3) - .5)) * ss(-2600., -1700., z);
  let lavS = ss(0., 600., x + z * .6 - 1900.);
  var lava = max(max(lavN, lavF), lavS);
  h += 6.5 * lava * (.8 + .4 * fbm(vec3f(x * .01, 6., z * .01), 2)) + 9. * max(lavF, lavS) * (fbm(vec3f(x * .007, 14., z * .007), 3) - .5);
  h += 7. * ss(.05, .35, max(lavF, lavS)) * ss(.95, .6, max(lavF, lavS)) * (.5 + fbm(vec3f(x * .02, 15., z * .02), 2)) * ss(300., 500., max(abs(x), abs(z)));
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
  let dm = length((p2 - vec2f(0., -1150.)) * vec2f(1., 1.15));
  h = mix(h, -1.5, ss(950., 380., dm));
  h = mix(h, .4, ss(56., 40., distance(p2, vec2f(-95., -150.))));
  let plaza = step(abs(x), 330.) * step(abs(z + 1175.), 432.);
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

// ---------------------------------------------------------------- physically based atmosphere (Hillaire 2020)
// Rayleigh + Mie + ozone in km, Earth radius 6360 km. Madinah sits ~600 m up in dusty desert air, so the Mie
// (aerosol) density is a few times the clear-sky value and its absorption leans blue, which is what makes the haze
// warm. The same media drive the sun colour (CPU, below), the sky (LUTs, main.js) and the aerial perspective.
// turb: aerosol multiple of a clear sky. haze: the dusty boundary layer over the city (per km, ~1 km deep) that
// makes Uhud and the far city fade; dust: the 70 m ground layer (dawn mist lies thicker in the hollows)
const ATM = { turb: [7, 8, 12][TOD], haze: [.06, .075, .04][TOD], dust: [1.3, 1, 1][TOD], alt: .62 };
const ATM_BR = [5.802e-3, 13.558e-3, 33.1e-3], ATM_BO = [.65e-3, 1.881e-3, .085e-3];
const ATM_BMS = 3.996e-3 * ATM.turb, ATM_BME = [4.5e-3, 4.75e-3, 5.2e-3].map((v) => v * ATM.turb);
const SUNV = TP.sun.map((c) => c / hypot(...TP.sun));
// sun transmittance from altitude h (km) to space, integrated on the CPU with the same media as the LUTs
const atmT = (h) => {
  const N = 600, r0 = 6360 + h, mu = SUNV[1], R2 = 6460 * 6460;
  const tmax = -r0 * mu + sqrt(r0 * r0 * (mu * mu - 1) + R2), dt = tmax / N, od = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const t = (i + .5) * dt, x = t * sqrt(1 - mu * mu), y = r0 + t * mu, hh = hypot(x, y) - 6360;
    const dr = exp(-hh / 8), dm = exp(-hh / 1.2), dz = max(0, 1 - abs(hh - 25) / 15);
    for (let c = 0; c < 3; c++) od[c] += (ATM_BR[c] * dr + ATM_BME[c] * dm + ATM_BO[c] * dz) * dt;
  }
  return od.map((v) => exp(-v));
};
// the solar scale keeps each preset's sun brightness; the hue now comes from the air it passes through. At night the
// moon gets a blue Purkinje tint, as the eye sees moonlight, so the night keeps its look.
const ATM_TS = atmT(ATM.alt), ATM_T6 = atmT(6), lum3 = (v) => v[0] * .2126 + v[1] * .7152 + v[2] * .0722;
const ATM_NT = TP.night ? [.62, .78, 1.3] : [1, 1, 1];
const ATM_S = lum3(TP.sunc) / lum3(ATM_TS);
const SUNCP = ATM_TS.map((v, c) => v * ATM_S * ATM_NT[c] * (TP.night ? .7 : 1)), CLOUDSUN = ATM_T6.map((v, c) => v * ATM_S * ATM_NT[c]);
const f3 = (v) => v.map((x) => x.toPrecision(5)).join(', ');
const W_ATMC = /*wgsl*/`
const RG = 6360.; const RT = 6460.; const HR = 8.; const HM = 1.2; const MG = .76;
const BR = vec3f(${f3(ATM_BR)}); const BO = vec3f(${f3(ATM_BO)});
const BMS = vec3f(${ATM_BMS.toPrecision(5)}); const BME = vec3f(${f3(ATM_BME)});
const SUNL = vec3f(${f3(SUNV)}); const ALT = ${ATM.alt};
const PI = 3.1415927;
struct Md { sr: vec3f, sm: vec3f, e: vec3f };
fn medium(h: f32) -> Md {
  let dr = exp(-h / HR); let dm = exp(-h / HM);
  return Md(BR * dr, BMS * dm, BR * dr + BME * dm + BO * max(0., 1. - abs(h - 25.) / 15.));
}
fn phR(mu: f32) -> f32 { return .0596831 * (1. + mu * mu); }
fn phG(mu: f32, g: f32) -> f32 { let g2 = g * g; return .1193662 * (1. - g2) * (1. + mu * mu) / ((2. + g2) * pow(max(1. + g2 - 2. * g * mu, 1e-4), 1.5)); }
fn phM(mu: f32) -> f32 { return phG(mu, MG); }
fn tUV(r: f32, mu: f32) -> vec2f {
  let H = sqrt(RT * RT - RG * RG); let rho = sqrt(max(r * r - RG * RG, 0.));
  let d = max(-r * mu + sqrt(max(r * r * (mu * mu - 1.) + RT * RT, 0.)), 0.);
  let dmin = RT - r; let dmax = rho + H;
  return vec2f((d - dmin) / (dmax - dmin), rho / H);
}
// sky-view LUT: u = azimuth from the sun's vertical plane (0..pi, the sky is symmetric about it), v = elevation,
// squeezed toward the horizon where the colour changes fastest
fn svUV(rd: vec3f) -> vec2f {
  let h = vec2f(rd.x, rd.z); let s = vec2f(SUNL.x, SUNL.z);
  let az = acos(clamp(dot(h, s) / max(length(h) * length(s), 1e-5), -1., 1.)) / PI;
  let e = asin(clamp(rd.y, -1., 1.)) / (PI * .5);
  return vec2f(az, .5 + .5 * sign(e) * sqrt(abs(e)));
}
`;
// LUT passes, run once at load (the sun does not move)
const W_ATMLUT = W_FS + W_ATMC + /*wgsl*/`
@group(0) @binding(0) var tT: texture_2d<f32>;
@group(0) @binding(1) var tM: texture_2d<f32>;
@group(0) @binding(2) var sL: sampler;
fn trans(r: f32, mu: f32) -> vec3f {
  if (mu < 0. && r * r * (mu * mu - 1.) + RG * RG >= 0.) { return vec3f(0.); }
  return textureSampleLevel(tT, sL, tUV(r, mu), 0.).rgb;
}
fn hitR(r: f32, mu: f32, R: f32) -> f32 { let d = r * r * (mu * mu - 1.) + R * R; return select(-1., -r * mu - sqrt(max(d, 0.)), d >= 0.); }
fn tmaxOf(r: f32, mu: f32) -> f32 {
  let g = hitR(r, mu, RG);
  if (mu < 0. && g > 0.) { return g; }
  return -r * mu + sqrt(max(r * r * (mu * mu - 1.) + RT * RT, 0.));
}
@fragment fn fsT(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / vec2f(256., 64.);
  let H = sqrt(RT * RT - RG * RG); let rho = H * uv.y; let r = sqrt(rho * rho + RG * RG);
  let dmin = RT - r; let dmax = rho + H; let d = dmin + uv.x * (dmax - dmin);
  let mu = clamp(select((H * H - rho * rho - d * d) / (2. * r * d), 1., d <= 0.), -1., 1.);
  var od = vec3f(0.); let dt = d / 40.;
  for (var i = 0; i < 40; i++) {
    let t = (f32(i) + .5) * dt; let hh = sqrt(r * r + t * t + 2. * r * mu * t) - RG;
    od += medium(hh).e * dt;
  }
  return vec4f(exp(-od), 1.);
}
// multiple scattering (Hillaire 2020 sec. 5.5): second-order light from 64 directions, as a geometric series
@fragment fn fsM(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / 32.; let mus = uv.x * 2. - 1.; let r = RG + uv.y * (RT - RG) + .01;
  let sd = vec3f(sqrt(1. - mus * mus), mus, 0.);
  var L2 = vec3f(0.); var fm = vec3f(0.);
  for (var i = 0; i < 8; i++) { for (var j = 0; j < 8; j++) {
    let th = PI * 2. * (f32(i) + .5) / 8.; let ph = acos(1. - 2. * (f32(j) + .5) / 8.);
    let rd = vec3f(cos(th) * sin(ph), cos(ph), sin(th) * sin(ph));
    let tm = tmaxOf(r, rd.y); let dt = tm / 20.;
    var T = vec3f(1.); var L = vec3f(0.); var f = vec3f(0.);
    for (var k = 0; k < 20; k++) {
      let p = vec3f(0., r, 0.) + rd * (f32(k) + .5) * dt; let pr = length(p);
      let m = medium(pr - RG); let s = m.sr + m.sm; let e = max(m.e, vec3f(1e-7));
      let st = trans(pr, dot(p / pr, sd));
      let x = (vec3f(1.) - exp(-e * dt)) / e;
      L += T * s * st * .0795775 * x; f += T * s * x;
      T *= exp(-e * dt);
    }
    if (hitR(r, rd.y, RG) > 0. && rd.y < 0.) {
      let gp = vec3f(0., r, 0.) + rd * tm; let gn = normalize(gp);
      L += T * trans(RG, dot(gn, sd)) * max(dot(gn, sd), 0.) * .3 / PI;
    }
    L2 += L / 64.; fm += f / 64.;
  } }
  return vec4f(L2 / (vec3f(1.) - fm), 1.);
}
@fragment fn fsS(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / vec2f(192., 108.);
  let az = uv.x * PI; let v = uv.y * 2. - 1.; let e = sign(v) * v * v * PI * .5;
  let sh = normalize(vec2f(SUNL.x, SUNL.z)); let ch = vec2f(-sh.y, sh.x);
  let hd = sh * cos(az) + ch * sin(az);
  let rd = vec3f(hd.x * cos(e), sin(e), hd.y * cos(e));
  let r = RG + ALT; let tm = tmaxOf(r, rd.y); let mu = dot(rd, SUNL);
  let pR = phR(mu); let pM = phM(mu);
  var T = vec3f(1.); var L = vec3f(0.); var t0 = 0.;
  for (var k = 0; k < 40; k++) {
    let t1 = tm * pow((f32(k) + 1.) / 40., 2.); let dt = t1 - t0; let t = (t0 + t1) * .5; t0 = t1;
    let p = vec3f(0., r, 0.) + rd * t; let pr = length(p); let up = p / pr;
    let m = medium(pr - RG); let e = max(m.e, vec3f(1e-7));
    let ms = textureSampleLevel(tM, sL, vec2f(dot(up, SUNL) * .5 + .5, (pr - RG) / (RT - RG)), 0.).rgb;
    let S = (m.sr * pR + m.sm * pM) * trans(pr, dot(up, SUNL)) + (m.sr + m.sm) * ms;
    L += T * S * (vec3f(1.) - exp(-e * dt)) / e;
    T *= exp(-e * dt);
  }
  return vec4f(L, 1.);
}
`;

// surface detail texture (tileable): rg = slope, b = height, a = mottling
const W_DETAIL = W_SS + W_NOISE + W_FS + /*wgsl*/`
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
// pvp: last frame's unjittered view-projection; jit: xy this frame's projection jitter in NDC, z history reset (1), w frame
// amb: sky light on an up-facing white surface, integrated from the sky-view LUT at load
// smc: the city's light matrix
struct G { vp: mat4x4f, sm: mat4x4f, cam: vec4f, right: vec4f, up: vec4f, fwd: vec4f, sun: vec4f, res: vec4f, mis: vec4f, pvp: mat4x4f, jit: vec4f, amb: vec4f, smc: mat4x4f };
const SUNC = vec3f(${f3(SUNCP)}); const CLOUDSUN = vec3f(${f3(CLOUDSUN)});
// sky radiance per unit of the LUT: pi * solar scale, because surfaces here take SUNC as irradiance / pi
const SKYS = vec3f(${f3(ATM_NT.map((v) => v * ATM_S * PI * (TP.night ? .45 : 1)))});
const BAND = vec3f(${TP.band.join(', ')});
const BOUNCE = vec3f(${TP.bounce.join(', ')}); const AMB0 = vec3f(${TP.amb.join(', ')});
const LIGHTS = ${TP.lights}; const LITF = ${TP.litf}; const NIGHT = ${TP.night}.;
const TAU = 6.2831853;
const LUMA = vec3f(.2126, .7152, .0722);
const NEARH = 256.;
const LOW = ${LV > 1};
fn sat(x: f32) -> f32 { return clamp(x, 0., 1.); }
fn ss(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
fn ign(p: vec2f) -> f32 { return fract(52.9829189 * fract(dot(p, vec2f(.06711056, .00583715)))); }
fn hs(x: f32) -> f32 { return fract(sin(x * 127.1) * 43758.5453); }
fn fin(c: vec3f) -> vec4f { return vec4f(min(max(c, vec3f(0.)), vec3f(60.)), 1.); }
fn qrot(q: vec4f, v: vec3f) -> vec3f { return v + 2. * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
// palms sway as a whole from the root: the same offset moves trunk tops and their fronds together
fn palmSway(b: vec2f, h: f32, t: f32) -> vec2f {
  let ph = dot(b, vec2f(.043, .029));
  let gust = .65 + .35 * sin(t * .23 + b.x * .004 + b.y * .003);
  return .0045 * pow(max(h, 0.), 1.5) * gust * vec2f(sin(t * .8 + ph) + .3 * sin(t * 1.9 + ph * 2.), .6 * cos(t * .63 + ph * 1.3));
}
`;

const S_B = S_G + W_ATMC + /*wgsl*/`
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(1) var sR: sampler;
@group(0) @binding(2) var sC: sampler;
@group(0) @binding(3) var sS: sampler_comparison;
@group(0) @binding(4) var tSh: texture_depth_2d;
@group(0) @binding(5) var tD: texture_2d<f32>;
@group(0) @binding(6) var tV: texture_3d<f32>;
@group(0) @binding(7) var tN: texture_2d<f32>;
@group(0) @binding(8) var tF: texture_2d<f32>;
@group(0) @binding(9) var tSV: texture_2d<f32>;
@group(0) @binding(10) var tMS: texture_2d<f32>;
@group(0) @binding(11) var tShC: texture_depth_2d;
// beyond the near field: the city shadow map (2x2 taps), 1 outside its box
fn shadowC(p: vec3f) -> f32 {
  // a 9 degree sun spans ~4 m of depth per texel on flat roofs: look up from 2.5 m toward the sun to avoid acne
  let s = g.smc * vec4f(p + g.sun.xyz * 2.5, 1.); let uv = vec2f(s.x * .5 + .5, .5 - s.y * .5);
  let inb = step(abs(s.x), .995) * step(abs(s.y), .995);
  let e = .7 / ${LV ? 2048 : 4096}.; var a = 0.;
  for (var k = 0; k < 4; k++) { a += textureSampleCompareLevel(tShC, sS, uv + vec2f(f32(k & 1) - .5, f32(k >> 1) - .5) * e, s.z - .00015); }
  return mix(1., a * .25, inb);
}
// sky radiance in direction rd, from the sky-view LUT; at night the city's light dome glows low on the horizon
fn skyCol(rd: vec3f, sun: vec3f) -> vec3f {
  var c = textureSampleLevel(tSV, sC, svUV(rd), 0.).rgb * SKYS;
  c += BAND * .35 * pow(sat(1. - max(rd.y, 0.) * 4.), 3.) * (.4 + .6 * sat(-rd.z * .8 + .5)) * NIGHT;
  return c;
}
// aerial perspective from the same media, in closed form: optical depth of each exponential layer along the ray,
// single scattering of the sun (Rayleigh and Mie phase) plus the LUT's multiple scattering, and a 70 m dust layer
// over the ground. Far away it hands over to the sky LUT so the horizon has no seam.
struct Air { t: vec3f, i: vec3f };
const DUST = vec3f(.8e-4, .86e-4, .95e-4) * ${ATM.dust};
// dust absorbs a little more blue than red, which is what warms the haze
const HAZE = vec3f(.9, 1., 1.12) * ${ATM.haze};
fn airAt(cam: vec3f, wp: vec3f, sun: vec3f) -> Air {
  let v = wp - cam; let d = max(length(v), 1e-3); let rd = v / d;
  let hc = max(cam.y, -30.) * 1e-3 + ALT; let dk = d * 1e-3;
  let kr = rd.y / HR; let km = rd.y / HM; let k2 = rd.y / 70.;
  let odR = select((1. - exp(-kr * dk)) / kr, dk, abs(kr) < 1e-6) * exp(-hc / HR);
  let odM = select((1. - exp(-km * dk)) / km, dk, abs(km) < 1e-6) * exp(-hc / HM);
  let od2 = select((1. - exp(-k2 * d)) / k2, d, abs(k2) < 1e-7) * exp(-max(cam.y, -30.) / 70.);
  let kh = rd.y / 1.;
  let odH = select((1. - exp(-kh * dk)) / kh, dk, abs(kh) < 1e-6) * exp(-max(cam.y, -30.) * 1e-3);
  let sR = BR * odR; let sM = BMS * odM; let sD = DUST * .9 * od2 + HAZE * .85 * odH;
  let tau = sR + BME * odM + DUST * od2 + HAZE * odH;
  let T = exp(-tau);
  let mu = dot(rd, sun);
  let ms = textureSampleLevel(tMS, sC, vec2f(sun.y * .5 + .5, ALT / (RT - RG)), 0.).rgb;
  var ins = (SUNC * PI * (sR * phR(mu) + sM * phM(mu) + sD * phG(mu, .45)) + SKYS * ms * (sR + sM + sD)) * (vec3f(1.) - T) / max(tau, vec3f(1e-7));
  ins = mix(ins, skyCol(normalize(vec3f(rd.x, max(rd.y, 0.) * .3 + .012, rd.z)), sun) * (vec3f(1.) - T), ss(4000., 16000., d));
  return Air(T, ins);
}
fn aerialAt(c: vec3f, cam: vec3f, wp: vec3f, sun: vec3f) -> vec3f { let a = airAt(cam, wp, sun); return c * a.t + a.i; }
fn nearK(p: vec3f) -> f32 { return 1. - ss(NEARH - 12., NEARH - 2., max(abs(p.x), abs(p.z))); }
fn shUV(p: vec3f) -> vec3f { let s = g.sm * vec4f(p, 1.); return vec3f(s.x * .5 + .5, .5 - s.y * .5, s.z - .0004); }
fn shadow1(p: vec3f) -> f32 {
  let s = shUV(p);
  return mix(shadowC(p), textureSampleCompareLevel(tSh, sS, s.xy, s.z), nearK(p));
}
fn shadow9(p: vec3f) -> f32 {
  if (LOW) { return shadow1(p); }
  let s = shUV(p); let e = 1.4 / ${SHADOW}.; var a = 0.;
  for (var x = -1; x <= 1; x++) { for (var y = -1; y <= 1; y++) { a += textureSampleCompareLevel(tSh, sS, s.xy + vec2f(f32(x), f32(y)) * e, s.z); } }
  return mix(shadowC(p), a / 9., nearK(p));
}
// r = openness, g = skylight; outside the near field everything is open sky
fn vol(p: vec3f) -> vec2f {
  let v = textureSampleLevel(tV, sC, (p - vec3f(-256., -16., -256.)) / vec3f(512., 96., 512.), 0.).rg;
  return mix(vec2f(1.), v, nearK(p));
}
fn amb(n: vec3f, sky: f32) -> vec3f {
  let up = n.y * .5 + .5;
  return (g.amb.xyz * up * up + BOUNCE * .36 * (1. - up) + AMB0) * (.3 + .7 * sky);
}
fn aerial(c: vec3f, wp: vec3f) -> vec3f { return aerialAt(c, g.cam.xyz, wp, g.sun.xyz); }
// second target: the share of the pixel's light that is ambient (sky and bounce), so screen-space AO can darken
// only that part and never the sunlit or emissive part
struct FO { @location(0) c: vec4f, @location(1) a: vec4f };
fn outA(c: vec3f, amb: vec3f, alb: vec3f, wp: vec3f, alpha: f32) -> FO {
  let air = airAt(g.cam.xyz, wp, g.sun.xyz);
  let col = min(max(min(max(c, vec3f(0.)), vec3f(60.)) * air.t + air.i, vec3f(0.)), vec3f(60.));
  return FO(vec4f(col, alpha), vec4f(sat(dot(amb * air.t, LUMA) / max(dot(col, LUMA), 1e-5)), min(alb * air.t, vec3f(1.))));
}
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
@fragment fn fs(i: VO, @builtin(front_facing) ff: bool) -> FO {
  let mat = i32(i.m.x + .5); let sd = i.m.y; let fl_ = select(-1., 1., ff);
  let on = normalize(i.on) * fl_; let n0 = normalize(i.n) * fl_;
  let dist = length(i.wp - g.cam.xyz);
  let far = mat == 1;
  let ts = select(select(1., .035, far), .5, mat >= 5 && mat != 12);
  let A = tri(i.op, on, .07 * ts); let B = tri(i.op, on, .31 * ts); let C = tri(i.op, on, 1.3 * ts); let F = tri(i.op, on, 5.1 * ts);
  let fk = ss(14., 2., dist) * f32(mat <= 4);
  let Lg = textureSample(tD, sR, i.wp.xz * .0045 + .31);
  // districts: two very low-frequency lookups (1.4 and 3.2 km periods) give whole neighbourhoods a shared age
  // (grime, darker roofs, dust in the streets) and tone (warm ochre, cool grey, fresh whitewash)
  let D1 = textureSample(tD, sR, i.wp.xz * .0007 + .17); let D2 = textureSample(tD, sR, i.wp.xz * .00031 + .63);
  let dAge = ss(.38, .66, D1.a * .6 + D2.b * .4); let dTone = ss(.3, .7, D2.a); let dWash = ss(.62, .78, D1.b);
  let nm = textureSample(tN, sC, i.wp.xz / 512. + .5);
  let fm = textureSample(tF, sC, i.wp.xz / 24000. + .5);
  let rpW = textureSample(tD, sR, i.wp.xz * .7 + vec2f(g.cam.w * .03, 0.)).rg * 2. - 1.;
  var bump = 1.2; var gloss = .08; var alb = vec3f(.5); var emi = vec3f(0.); var metal = 0.; var vao = 1.;
  let flt = ss(.7, .92, n0.y);
  let nk = nearK(i.wp);
  // facade coordinates for building materials: along the wall and up it
  let fu = select(i.op.z, i.op.x, abs(on.z) > abs(on.x)); let fv = i.op.y; let wall = 1. - ss(.45, .7, abs(on.y));
  // window grid fades before it can sparkle (derivatives must be taken outside the material branches)
  let wfade = 1. - ss(.25, .6, fwidth(fu / 3.4) + fwidth(fv / 3.3));
  // rooms behind the glass show while a window is a dozen pixels or more across
  let ifade = 1. - ss(.15, .5, fwidth(fu) + fwidth(fv));
  if (mat <= 1) {
    let lava = mix(fm.r, nm.g, nk); let gran = mix(fm.g, nm.b, nk); let wadi = nm.r * nk; let irr = nm.a * nk; let city = fm.b * (1. - nk);
    alb = mix(vec3f(.52, .34, .19), vec3f(.64, .45, .27), sat(A.c * .9 + Lg.a * .9 - .55)) * (.7 + .45 * mix(B.h, Lg.b, .45)) * (.84 + .32 * C.c);
    alb *= mix(vec3f(1.), vec3f(1.06, .95, .82), ss(.4, .7, Lg.a));
    alb = mix(alb, vec3f(.36, .26, .18) * (.8 + .4 * C.h), ss(.55, .75, B.c) * .35);
    alb = mix(alb, vec3f(.66, .51, .34) * (.86 + .25 * B.h), wadi);
    alb = mix(alb, mix(vec3f(.21, .14, .085), vec3f(.12, .15, .055), ss(.35, .65, B.c)), irr * .85);
    // weathered basalt is .06-.10, not coal black, with dust settled on it
    let bas = mix(vec3f(.062, .058, .055), vec3f(.115, .098, .085), ss(.45, .8, C.c)) * (.6 + .8 * F.h * C.h);
    let lv = max(lava, ss(.04, .25, lava));
    alb = mix(alb, mix(bas, vec3f(.40, .30, .20) * (.8 + .3 * B.h), flt * ss(.7, .95, Lg.a + .3 * B.c) * .4), lv);
    var gra = select(mix(vec3f(.30, .22, .18), vec3f(.42, .32, .26), A.c), mix(vec3f(.46, .19, .10), vec3f(.62, .31, .17), A.c), far) * (.68 + .55 * B.h);
    gra = mix(gra, vec3f(.16, .11, .09), ss(.5, .75, fract(i.wp.y * .11 + A.h * 1.5)) * select(.45, 0., far));
    gra = mix(gra, gra * vec3f(.55, .5, .5), ss(.55, .8, B.c) * f32(far) * .5);
    alb = mix(alb, gra, sat(gran * 1.4) * (1. - .1 * flt));
    let tile = 1. - ss(.0, .05, min(abs(fract(i.wp.x / 6.) - .5), abs(fract(i.wp.z / 6.) - .5)) * 2. - .86);
    let bandM = ss(.45, .5, abs(fract(i.wp.z / 30.) - .5));
    let marble = vec3f(.86, .84, .80) * (1. - .16 * tile) * mix(1., .9, bandM) * (.96 + .06 * B.c);
    // asphalt and paving between the blocks, dustier in the old districts
    let street = mix(vec3f(.17, .165, .16) * (.85 + .3 * C.c), vec3f(.5, .46, .4) * (.9 + .12 * B.c), ss(.45, .7, Lg.a + dAge * .3));
    alb = mix(alb, mix(street, marble, ss(.9, .97, city)), ss(.05, .2, city));
    emi = mix(vec3f(1., .55, .25) * .035 * (.4 + .6 * ss(.4, .7, Lg.a)), vec3f(1., .86, .66) * (.025 + .045 * ss(.55, .05, length(fract(i.wp.xz / 24.) - .5))), ss(.9, .97, city)) * ss(.05, .2, city) * NIGHT;
    alb = mix(alb, mix(mix(vec3f(.09, .075, .065), vec3f(.18, .135, .10), A.h) * (.7 + .6 * B.c), vec3f(.42, .30, .19), ss(.6, .8, B.c) * .4), lava * (1. - nk) * .8);
    alb *= mix(1., .6 + .8 * F.h, fk);
    bump = select(1.3, mix(.8, .2, ss(.05, .2, city)), far); gloss = mix(.03, .16, lava * (1. - flt)) * ss(120., 20., dist);
  } else if (mat == 2) {
    alb = mix(vec3f(.055, .052, .05), vec3f(.105, .088, .075), ss(.45, .75, C.c)) * (.6 + .8 * F.h);
    alb = mix(alb, vec3f(.40, .28, .17), flt * ss(.75, .95, B.c) * .2); bump = 1.8; gloss = .3;
  } else if (mat == 3) {
    alb = mix(vec3f(.22, .17, .14), vec3f(.33, .26, .21), C.c) * (.65 + .55 * B.h); bump = 1.2;
  } else if (mat == 4) {
    alb = mix(vec3f(.54, .45, .36), vec3f(.44, .36, .29), hs(sd * 91.)) * (.75 + .4 * B.h); bump = .6; gloss = .12;
  } else if (mat == 5) {
    // mud brick: courses of sun-dried bricks, rendered and eroded, darker at the foot
    let row = floor(fv / .34); let bx = fract(fu / .7 + row * .5); let by = fract(fv / .34);
    let mortar = (1. - ss(.0, .1, by) * ss(1., .9, by)) * .6 + (1. - ss(.0, .07, bx) * ss(1., .93, bx)) * .5;
    let render = ss(.55, .7, C.c + .2 * B.h);
    alb = mix(vec3f(.47, .32, .19), vec3f(.39, .26, .15), hs(row * 7.1 + floor(fu / .7 + row * .5)) * .6) * (.8 + .35 * C.h);
    alb = mix(alb * (1. - .75 * mortar * (1. - render)) * (.85 + .3 * hs(row * 3.3 + floor(fu / .7 + row * .5) * 1.7)), vec3f(.56, .41, .28) * (.75 + .4 * B.h), render * .12);
    alb *= mix(.7, 1., ss(0., .6, fv)); bump = .7;
  } else if (mat == 6 || mat == 7 || mat == 17) {
    // stucco and stone: white (6), cream (7), mixed city buildings (17) with windows by floor
    let hh = hs(sd * 3.7);
    let ct = select(select(select(select(select(vec3f(.60, .51, .38), vec3f(.49, .40, .30), hh > .25), vec3f(.66, .63, .57), hh > .45), vec3f(.52, .38, .27), hh > .62), vec3f(.42, .40, .38), hh > .78), vec3f(.70, .67, .61), hh > .9);
    // real whitewash and pale stone reflect .6-.75 of the light, not .85+; brighter washes every sunlit wall to flat white
    let tone = select(select(vec3f(.66, .65, .62), vec3f(.74, .69, .60), mat == 7), ct, mat == 17);
    // plaster is never one flat white: trowel marks, patched render and broad dust stains give the eye something to read in full sun
    alb = tone * (.8 + .3 * B.h) * (.9 + .16 * C.c) * mix(1., .84, ss(.5, .82, A.c)) * (1. - .06 * ss(.4, .7, F.h) * ss(30., 5., dist));
    if (mat == 17) {
      alb = mix(alb * mix(vec3f(.93, .96, 1.02), vec3f(1.07, .98, .84), dTone), vec3f(.68, .66, .62) * (.92 + .1 * B.h), dWash * .7);
      alb *= mix(1., .8, dAge * (1. - dWash));
    }
    // near-city parts tagged in the vertex aux: carved wood, metal and plastic, bare concrete
    let sub = i.ao;
    if (mat == 17 && sub < -.1) {
      if (sub > -.4) {
        let lat = step(.3, fract(fu * 5.)) * step(.3, fract(fv * 5.));
        alb = mix(vec3f(.22, .13, .07), vec3f(.36, .22, .12), hs(sd * 19.)) * (.55 + .45 * lat) * (.85 + .3 * C.c); gloss = .15;
      } else if (sub > -.65) {
        alb = mix(vec3f(.62, .62, .6), vec3f(.48, .5, .52), hs(floor(fu * 2.) + sd)) * (.85 + .2 * B.h) * (1. - .2 * step(.7, fract(fv * 9.)) * wall); gloss = .4;
      } else {
        alb = tone * vec3f(.9, .9, .92) * (.82 + .25 * B.h) * mix(.78, 1., ss(-.05, .2, fract(fv / 3.3)));
      }
      alb *= mix(.75, 1., ss(0., 3., fv + C.h));
    } else if (mat == 17) {
      let bw = mix(2.6, 4.6, hs(sd * 11.)); let ww = mix(.18, .34, hs(sd * 13.));
      let wx = fract(fu / bw); let wy = fract(fv / 3.3); let flr = floor(fv / 3.3); let bay = floor(fu / bw);
      let win = step(.5 - ww, wx) * step(wx, .5 + ww) * step(.3, wy) * step(wy, .74) * step(1., flr) * wall * step(fv, i.m.w - 1.) * wfade * step(.15, hs(bay * 3.1 + flr * 5.7 + sd));
      let lit = step(LITF, hs(flr * 13.1 + bay * 7.7 + sd * 31.));
      let frame = step(.5 - ww - .05, wx) * step(wx, .5 + ww + .05) * step(.25, wy) * step(wy, .79) * step(1., flr) * wall * step(fv, i.m.w - 1.) * wfade * (1. - win);
      // window frames: white uPVC on some buildings, dark aluminium on others
      alb = mix(alb, select(alb * 1.12 + .03, vec3f(.2, .2, .21), hs(sd * 37.) > .5), frame);
      let roshan = step(.8, hs(sd * 19.)) * step(.5, hs(bay * 7.3 + sd * 3.)) * step(1., flr) * wall * wfade * step(.12, wy) * step(wy, .9) * step(abs(wx - .5), ww + .12);
      alb = mix(alb, vec3f(.30, .18, .10) * (.75 + .5 * step(.5, fract(fu * 3.))), roshan);
      alb = mix(alb, vec3f(.05, .055, .06), win * .9 * (1. - roshan));
      let shop = step(fv, 3.3) * wall * step(.3, hs(sd * 23.));
      let awn = step(2.55, fv) * step(fv, 3.05) * shop;
      alb = mix(alb, alb * vec3f(.42, .4, .38), shop * step(fv, 2.5) * step(.15, fract(fu / 4.)));
      alb = mix(alb, mix(vec3f(.15, .32, .22), vec3f(.55, .16, .12), step(.5, hs(sd * 29.))), awn);
      alb *= 1. - .1 * ss(.06, .0, abs(fract(fv / 3.3))) * wall * step(1., flr) * wfade;
      alb *= mix(.72, 1., ss(0., 3.5, fv + 1.5 * C.h));
      // grime washed down from the window sills, strongest just below each opening
      let streak = ss(.5, .9, hs(floor(fu * 2.3) * 7.1 + sd * 3.) * (.7 + .6 * B.h)) * ss(.3, .0, wy) * step(1., flr) * wall * wfade;
      alb *= 1. - (.16 + .22 * dAge) * streak * (.6 + .4 * hs(bay * 5.1 + sd));
      // the window reveal: the lintel shades the top of the opening, the sill catches light below it
      let lint = step(.5 - ww - .05, wx) * step(wx, .5 + ww + .05) * ss(.66, .74, wy) * step(wy, .79) * step(1., flr) * wall * wfade;
      alb = mix(alb, alb * .45, lint * .7);
      alb = mix(alb, alb * vec3f(.82, .8, .78), (1. - wfade) * wall * .5);
      // interior mapping: intersect the view ray with this window's room (walls, floor, ceiling, back wall) in the
      // building's own frame, so each window shows a room with depth that shifts with the viewpoint
      let rdo = qrot(vec4f(-i.q.xyz, i.q.w), normalize(i.wp - g.cam.xyz));
      let xw = abs(on.z) <= abs(on.x);
      let rr3 = vec3f(select(rdo.x, rdo.z, xw), rdo.y, max(select(-rdo.z * sign(on.z), -rdo.x * sign(on.x), xw), .02));
      let ru = fu - bay * bw; let rv = fv - flr * 3.3; let rid = bay * 1.7 + flr * 2.9 + sd * 5.;
      let dep = mix(3.2, 6., hs(rid));
      let tu = (select(0., bw, rr3.x > 0.) - ru) / (rr3.x + select(-1e-5, 1e-5, rr3.x >= 0.));
      let tv = (select(0., 3.3, rr3.y > 0.) - rv) / (rr3.y + select(-1e-5, 1e-5, rr3.y >= 0.));
      let tw = dep / rr3.z; let tt = min(tu, min(tv, tw));
      let hp = vec3f(ru, rv, 0.) + rr3 * tt;
      let wallC = mix(vec3f(.56, .5, .42), vec3f(.4, .45, .48), hs(rid + 3.)) * (.8 + .3 * hs(rid + 7.));
      var rc = wallC * .85;
      if (tw <= tu && tw <= tv) { rc = wallC * mix(1., mix(.35, .7, hs(rid + 11.)), step(hp.y, .85) * step(.2, fract(hp.x / bw + hs(rid)))); }
      else if (tv < tu) { rc = select(vec3f(.72, .7, .66), mix(vec3f(.22, .15, .1), vec3f(.32, .3, .28), hs(rid + 13.)), rr3.y < 0.); }
      let inner = rc * mix(1., .4, hp.z / dep);
      let lamp = mix(mix(vec3f(1., .72, .45), vec3f(1., .9, .78), step(.55, hs(rid + 29.))), vec3f(.72, .84, 1.), step(.88, hs(rid + 31.))) * LIGHTS * .17 * (1. + .8 * ss(2.2, 3.3, hp.y)) * mix(1., .6, hp.z / dep);
      var room = inner * (g.amb.xyz * .55 + lamp * lit);
      // curtains drawn part way across some windows, glowing when the room is lit
      let cur = step(.4, hs(rid + 17.)) * hs(rid + 19.) * .8;
      room = mix(room, mix(vec3f(.62, .55, .45), vec3f(.5, .52, .56), hs(rid + 23.)) * (g.amb.xyz * .2 + lamp * lit * .9), step(1. - cur, abs(wx - .5) / ww));
      emi = (room * ifade + vec3f(1., .62, .30) * .15 * lit * LIGHTS * (1. - ifade)) * win * (1. - roshan);
      // flat roofs: bare concrete, tar sheeting or white membrane, smooth rather than plastered, older ones darker
      let rh = hs(sd * 41.);
      let roof = select(select(vec3f(.44, .42, .38), vec3f(.15, .145, .14), rh > .55), vec3f(.6, .58, .54), rh > .85) * (.92 + .12 * C.c) * mix(1., .72, dAge);
      alb = mix(alb, roof, ss(.6, .9, on.y));
      gloss = mix(.08, .55, win);
    } else {
      let bw = select(4.2, 6.5, mat == 7);
      let a1 = arcade(fu, fv, bw, select(3.2, 8.5, mat == 7), select(.6, 1., mat == 7)) * wall;
      let a1i = arcade(fu, fv + .25, bw * .86, select(3.2, 8.5, mat == 7) - .5, select(.6, 1., mat == 7)) * wall;
      let a2 = arcade(fu + bw * .5, fv, bw, select(1.2, 2.4, mat == 7), select(5.8, 12.6, mat == 7)) * wall * step(fv, select(7.6, 16., mat == 7));
      let ins = max(a1, a2 * .8);
      let inner = mix(vec3f(.30, .24, .18), vec3f(.08, .065, .05), ss(.6, select(5., 10., mat == 7), fv));
      alb = mix(alb, alb * vec3f(1.08, 1.02, .94), (a1 - a1i) * step(.5, i.m.w));
      alb = mix(alb, inner, a1i * step(.5, i.m.w));
      alb = mix(alb, vec3f(.05, .05, .06), a2 * .9 * step(.5, i.m.w));
      // lamps hang high in the openings: brightest at the top, falling to the floor
      emi = vec3f(1., .7, .4) * (.022 * a1i + .035 * a2) * step(.5, i.m.w) * LIGHTS * (.35 + .9 * ss(.5, select(4., 9., mat == 7), fv));
      gloss = mix(.08, .5, a2);
      let seam = (1. - ss(.0, .04, abs(fract(i.op.x / 12.) - .5) * 2. - .9) * ss(.0, .04, abs(fract(i.op.z / 12.) - .5) * 2. - .9));
      alb = mix(alb, vec3f(.62, .58, .51) * (1. - .25 * seam) * (.85 + .3 * B.c), ss(.6, .9, on.y) * f32(mat == 7));
      let band = ss(.92, .97, fract(fv / select(7.9, 16.6, mat == 7))) * wall;
      alb = mix(alb, alb * vec3f(.92, .84, .7), band * .6);
    }
    bump = .04 * (1. - ss(.6, .9, on.y));
    emi += alb * mix(.11, .03, ss(0., 14., fv)) * NIGHT * f32(mat != 17);
  } else if (mat == 8) {
    let rib = ss(.4, .5, abs(fract(atan2(i.op.z, i.op.x) / TAU * 24.) - .5)) * .3;
    alb = vec3f(.06, .30, .17) * (1. - rib) * (.92 + .16 * B.h); gloss = .5; bump = .05; emi = alb * vec3f(1.1, .75, .45) * NIGHT;
  } else if (mat == 9) {
    alb = vec3f(.58, .60, .62) * (.9 + .15 * B.h); gloss = .75; metal = .6; bump = .1; emi = alb * .3 * NIGHT;
  } else if (mat == 10) {
    alb = vec3f(1., .70, .28); gloss = .9; metal = 1.; bump = 0.; emi = alb * 1.5 * NIGHT;
  } else if (mat == 11) {
    // umbrella fabric: off-white membrane in eight panels, the seams a shade darker so the canopy reads as a shape
    let pan = abs(fract(atan2(i.op.z, i.op.x) / TAU * 8.) - .5);
    alb = vec3f(.54, .53, .5) * (.92 + .1 * B.h) * (1. - .16 * ss(.06, .0, pan)); gloss = .12; bump = .1; emi = vec3f(1., .82, .6) * .07 * NIGHT;
  } else if (mat == 12 || mat == 18) {
    // date palm trunk: spiral of cut leaf bases makes a diamond crosshatch
    let ang = atan2(i.op.z - sd * 37., i.op.x - sd * 37.) / TAU;
    let k1 = abs(fract(i.op.y * 3.3 + ang * 8.) - .5); let k2 = abs(fract(i.op.y * 3.3 - ang * 8.) - .5);
    let grv = 1. - ss(.03, .2, min(k1, k2));
    alb = mix(vec3f(.34, .25, .16), vec3f(.24, .17, .11), B.c) * (1. - .3 * grv * f32(mat == 12)) * (.88 + .24 * C.h);
    vao = mix(.55, 1., ss(0., 2., i.op.y - sd * 37.)); bump = .8;
  } else if (mat == 13) {
    alb = mix(vec3f(.38, .15, .04), vec3f(.24, .08, .03), hs(sd * 17.)) * (.8 + .3 * C.h); gloss = .35; bump = .6;
  } else if (mat == 14) {
    alb = vec3f(.46, .37, .27) * (.8 + .35 * B.h); bump = .5; gloss = .02;
  } else if (mat == 16) {
    alb = vec3f(.24, .15, .08) * (.7 + .5 * C.c); bump = .7;
  }
  // water: sky reflection over a dark channel bed, ripples from the detail texture
  if (mat == 15) {
    let V = normalize(g.cam.xyz - i.wp);
    let N = normalize(vec3f(rpW.x * .02, 1., rpW.y * .02));
    let fr = .02 + .98 * pow(1. - sat(dot(N, V)), 5.);
    let R = reflect(-V, N);
    var c = mix(vec3f(.015, .025, .018), skyCol(R, g.sun.xyz) * .75, .15 + .7 * fr) + SUNC * shadow1(i.wp) * pow(sat(dot(R, g.sun.xyz)), 700.) * 6.;
    return outA(c, vec3f(0.), vec3f(0.), i.wp, 1.);
  }
  let lvN = select(0., max(nm.g * nk, fm.r * (1. - nk)), mat <= 1);
  let N = normalize(qrot(i.q, normalize(on + (A.n * .8 * (1. - lvN * .8) + B.n * .6 * (1. - lvN * .5) + C.n * (.4 + lvN) * ss(70., 10., dist) + F.n * (.5 + lvN) * fk) * bump)));
  let L = g.sun.xyz; let V = normalize(g.cam.xyz - i.wp);
  let vv = vol(i.wp + n0 * 1.2); let v2 = vol(i.wp + n0 * 4.);
  var ao = (sat((vv.x - .5) * 6.) * .5 + sat((v2.x - .5) * 2.5) * .5) * vao * mix(1., i.ao, f32(mat == 1));
  ao = mix(ao, vao * select(1., i.ao, far), 1. - nk);
  ao = select(ao, .5 + .5 * ao, mat >= 5 && mat != 12 && mat != 13);
  ao = select(ao, .35 + .65 * ao, mat == 12 || mat == 13);
  ao = select(ao, .25 + .75 * ao, mat == 2 || (mat <= 1 && lvN > .5));
  let sh = select(shadow9(i.wp + n0 * (.45 + dist * .003) + g.sun.xyz * .25), sat(i.ao * 1.6 - .3) * shadowC(i.wp + n0 * 1.5 + g.sun.xyz), far);
  let E = SUNC * sh;
  let ndl = sat(dot(N, L));
  let am = amb(N, vv.y) * ao;
  var c = alb * (E * ndl + am) + emi;
  let Hh = normalize(V + L);
  let spc = mix(vec3f(.04), alb, metal);
  c += E * spc * pow(sat(dot(N, Hh)), mix(8., 120., gloss)) * gloss * ndl * 4.;
  let refl = skyCol(reflect(-V, N), L) * ao * spc * gloss * pow(1. - sat(dot(N, V)), 3.) * 1.5;
  return outA(c + refl, alb * am + refl, alb * ao, i.wp, 1.);
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
    case 0 {
      // date palm fronds are glaucous grey-green, not lime; each palm (keyed by its crown) has its own tint and
      // its own share of yellowing fronds
      let ph = hs(i.a.x * .37 + i.a.z * .71);
      col = mix(vec3f(.12, .135, .09), vec3f(.2, .21, .15), s1) * mix(vec3f(.9, .97, 1.06), vec3f(1.1, 1., .78), ph);
      col = mix(col, vec3f(.30, .22, .11) * (.8 + .4 * s1), step(s2, ph * .22) * .75);
      pr = vec4f(1., .55, 0., 0.); fold = .5; }
    case 1 { col = mix(vec3f(.20, .14, .075), vec3f(.28, .20, .10), s1); pr = vec4f(1., .3, 0., 0.); fold = .3; }
    case 2 { col = mix(vec3f(.24, .27, .08), vec3f(.42, .38, .14), s1); pr = vec4f(0., .8, 0., 0.); }
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
  let s = i.uv.y * 38. + abs(i.uv.x) * 4.2 + i.sd.x * 7.;
  let fw = fwidth(s);
  let f = abs(fract(s) - .5) * 2.;
  let lw = .56 * (1. - .45 * abs(i.uv.x));
  var cov = 1. - ss(lw - fw, lw + fw, f);
  cov = max(cov, 1. - ss(.04, .07, abs(i.uv.x)));
  cov *= 1. - ss(.82, 1., abs(i.uv.x) + .1 * f);
  cov = mix(cov, .85, ss(.15, .38, fw));
  let sharp = sat((cov - .5) / max(fwidth(cov), 1e-4) + .5);
  return select(1., sharp, i.pr.x > .5);
}
@fragment fn fsSh(i: LO) { if (leafCov(i) < .5) { discard; } }
@fragment fn fs(i: LO, @builtin(front_facing) ff: bool) -> FO {
  // leaflets: slanted strips either side of the rachis, cut from the frond by alpha (to coverage with MSAA)
  let alpha = leafCov(i);
  let lt = textureSample(tD, sR, vec2f(i.uv.x * .1 + i.sd.x * 3.7, i.uv.y * .6 + i.sd.y * 5.3));
  if ((LOW || g.res.x == 0.) && alpha < .5) { discard; }
  let dist = length(i.wp - g.cam.xyz);
  var n = normalize(i.n); if (!ff) { n = -n; }
  let V = normalize(g.cam.xyz - i.wp); let L = g.sun.xyz;
  let vv = vol(i.wp + vec3f(0., .5, 0.));
  let E = SUNC * mix(shadow1(i.wp + L * .6), 1., .3);
  let ndl = dot(n, L);
  var alb = i.col * (.7 + .3 * ss(0., .3, abs(i.uv.x))) * mix(.75, 1.1, i.uv.y) * (.6 + .8 * lt.b) * (.75 + .5 * lt.a);
  // sun-dried tips on palm fronds
  alb = mix(alb, vec3f(.24, .17, .09) * (.8 + .4 * lt.a), ss(.8, 1., i.uv.y) * (.25 + .55 * i.sd.y) * step(.5, i.pr.x));
  let tr = (max(-ndl, 0.) * .9 + .25) * i.pr.y;
  let trc = alb * vec3f(1.05, 1.3, .75);
  let aov = sat((vv.x - .5) * 5.);
  let am = (amb(n, vv.y) + amb(-n, vv.y) * i.pr.y * .45) * (.35 + .65 * aov);
  var c = E * (alb * max(ndl, 0.) + trc * tr) + alb * am;
  let H = normalize(V + L);
  c += E * pow(sat(dot(n, H)), 18.) * .12;
  c += E * trc * i.pr.y * pow(sat(dot(-V, L)), 4.) * .8;
  return outA(c, alb * am, alb, i.wp, alpha);
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
const W_SKY = S_B + W_NOISE + /*wgsl*/`
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
    let cov = ss(.58, .84, n) * ss(.03, .2, rd.y) * (1. - ss(.35, .9, rd.y));
    let lit = (CLOUDSUN * (.05 + .45 * pow(max(mu, 0.), 4.)) + g.amb.xyz * .9) * (.75 + .5 * fbm(vec3f(r * 7., 2.), 2));
    c = mix(c, lit, cov * .5);
  }
  // scattered altocumulus 3 km up: density from fbm on the cloud plane, self-shadowed by sampling the density a
  // little toward the sun, lit by the sun as it is at that height plus sky light, fading into the sky with distance
  if (rd.y > .008) {
    let tpl = (3000. - g.cam.y) / rd.y;
    let pp = g.cam.xz + rd.xz * tpl;
    let uv = pp * .00013 + vec2f(g.cam.w * .0008, g.cam.w * .0003);
    let dn = fbm(vec3f(uv, 4.2), 5) + .25 * (fbm(vec3f(uv * 3.3, 7.7), 3) - .5);
    let cov = ss(.57, .76, dn) * ss(.008, .06, rd.y) * ss(70000., 20000., tpl);
    if (cov > .001) {
      let dl = fbm(vec3f(uv + normalize(L.xz) * .05, 4.2), 4);
      let sh = exp(-ss(.5, .85, dl) * 2.4);
      let lit = CLOUDSUN * (.22 + 1.1 * pow(max(mu, 0.), 4.)) * sh + g.amb.xyz * (.8 + .4 * ss(.6, .9, dn));
      c = mix(c, mix(lit, c, ss(15000., 70000., tpl) * .7), cov * .92);
    }
  }
  c += mix(SUNC * 9., vec3f(2.4, 2.4, 2.2), NIGHT) * ss(mix(.99988, .99975, NIGHT), mix(.99994, .99982, NIGHT), mu);
  // stars: one soft point per sky cell, a pixel or two wide, so they hold still as the camera moves
  if (NIGHT > .5 && rd.y > 0.) {
    let p = rd * 230.; let h = h33(floor(p)); let off = fract(p) - .5 - (h - .5) * .5;
    c += vec3f(.85, .9, 1.) * step(.982, h.z) * ss(.14, .0, length(off)) * (.4 + 1.6 * h.x * h.x) * ss(.02, .2, rd.y) * 1.6;
  }
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
  let w = p + (g.right.xyz * q.x + g.up.xyz * q.y) * max(sz, d * .0016);
  o.cp = g.vp * vec4f(w, 1.); o.uv = q;
  let fade = ss(B * .5, B * .3, d) * ss(.4, 2., d) * min(1., sz / (d * .0016)) * ss(-2., 1., -abs(p.y - 4.) + 4.) * .3;
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
    let dust = (.12 + exp(-max(p.y, 0.) / 12.) * 1.6) * mix(.3, 1., inb);
    acc += vis * dust * exp(-t * .004);
  }
  let mu = dot(rd, sx);
  let gg = .6;
  let ph = (1. - gg * gg) / pow(1. + gg * gg - 2. * gg * mu, 1.5) * .07 + .1;
  return vec4f(min(SUNC * vec3f(1., .84, .62) * acc * dt * .011 * ph * g.mis.y, vec3f(20.)), zl);
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
const SHARP = .8;
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
  var c = textureLoad(tS, px, 0).rgb;
  if (${LV < 2}) {
    // TAA averages sub-pixel detail away; a clamped unsharp mask brings it back without halos
    let sm = vec2i(textureDimensions(tS)) - 1;
    let n0 = textureLoad(tS, clamp(px + vec2i(1, 0), vec2i(0), sm), 0).rgb; let n1 = textureLoad(tS, clamp(px - vec2i(1, 0), vec2i(0), sm), 0).rgb;
    let n2 = textureLoad(tS, clamp(px + vec2i(0, 1), vec2i(0), sm), 0).rgb; let n3 = textureLoad(tS, clamp(px - vec2i(0, 1), vec2i(0), sm), 0).rgb;
    c = clamp(c + (c - (n0 + n1 + n2 + n3) * .25) * SHARP, min(min(min(n0, n1), min(n2, n3)), c), max(max(max(n0, n1), max(n2, n3)), c));
  }
  c += acc / ws;
  let bl = textureSampleLevel(tB, sC, uv, 0.).rgb;
  c = mix(c, bl, .025) + bl * .012;
  c *= g.mis.x;
  let q = uv - .5;
  c *= 1. - dot(q, q) * .45;
  c = tmap(c);
  let l0 = dot(c, vec3f(.2126, .7152, .0722));
  let l = mix(l0, l0 * l0 * (3. - 2. * l0), .55);
  c *= l / max(l0, 1e-4);
  c = mix(vec3f(l), c, 1.04) + vec3f(.006, .003, 0.);
  c = pow(max(c, vec3f(0.)), vec3f(1. / 2.2));
  let n = ign(fc.xy) + ign(fc.xy + 37.) - 1.;
  return vec4f(c + n / 255., 1.);
}
`;

// ---------------------------------------------------------------- ground-truth ambient occlusion (half res)
// GTAO (Jimenez et al. 2016, structure after XeGTAO): per slice direction, find the highest horizon on each side
// from the depth buffer, then integrate the cosine-weighted visible arc against the projected normal. Positions
// are camera-relative world space, so no view matrix is needed. Noise rotates every frame; TAA averages it.
const W_AO = S_G + W_FS + /*wgsl*/`
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(1) var tDp: texture_depth_multisampled_2d;
@group(0) @binding(2) var tPrev: texture_2d<f32>;
struct AOut { @location(0) ao: vec4f, @location(1) gi: vec4f };
// cosine-weighted visible arc of one side of a slice, from the normal's angle n to the horizon angle a
fn arcI(a: f32, n: f32, cn: f32) -> f32 { return (cn + 2. * a * sin(n) - cos(2. * a - n)) * .25; }
const SLICES = ${LV ? 2 : 3}; const STEPS = ${LV ? 3 : 4};
fn zAt(p: vec2i) -> f32 { return g.fwd.w / max(textureLoad(tDp, clamp(p, vec2i(0), vec2i(g.res.xy) - 1), 0), 1e-7); }
fn posAt(q: vec2f, z: f32) -> vec3f {
  let uv = q * g.res.zw; let nd = vec2f(uv.x * 2. - 1., 1. - uv.y * 2.) - g.jit.xy;
  return (g.fwd.xyz + g.right.xyz * (nd.x * g.right.w) + g.up.xyz * (nd.y * g.up.w)) * z;
}
fn fastAcos(x: f32) -> f32 { let a = abs(x); let r = (-.156583 * a + 1.570796) * sqrt(max(1. - a, 0.)); return select(3.141593 - r, r, x >= 0.); }
@fragment fn fs(@builtin(position) fc: vec4f) -> AOut {
  let p = vec2i(fc.xy) * 2; let q = vec2f(p) + .5;
  let dp = textureLoad(tDp, p, 0);
  if (dp < 1e-7) { return AOut(vec4f(1., 6e4, 0., 0.), vec4f(0.)); }
  let z = g.fwd.w / dp; let P = posAt(q, z);
  let zr = zAt(p + vec2i(2, 0)); let zl = zAt(p - vec2i(2, 0)); let zd = zAt(p + vec2i(0, 2)); let zu = zAt(p - vec2i(0, 2));
  let dx = select(P - posAt(q - vec2f(2., 0.), zl), posAt(q + vec2f(2., 0.), zr) - P, abs(zr - z) < abs(zl - z));
  let dy = select(P - posAt(q - vec2f(0., 2.), zu), posAt(q + vec2f(0., 2.), zd) - P, abs(zd - z) < abs(zu - z));
  let V = -normalize(P);
  var N = normalize(cross(dx, dy));
  if (dot(N, V) < 0.) { N = -N; }
  // 2.5 m around the point, but never under 8 px, so the far city still gets dark alleys and building feet
  let ppm = g.res.y * .5 / (z * g.up.w);
  let rpx = clamp(2.5 * ppm, 8., 110.); let R = rpx / ppm;
  let fr = R * .62; let fmul = -1. / fr; let fadd = (R - fr) / fr + 1.;
  let nz = fract(ign(fc.xy) + g.jit.w * .618034); let nz2 = fract(ign(fc.xy + 71.) + g.jit.w * .754877);
  var vis = 0.; var gi = vec3f(0.);
  for (var sl = 0; sl < SLICES; sl++) {
    let phi = (f32(sl) + nz) / f32(SLICES) * 3.141593;
    let om = vec2f(cos(phi), -sin(phi));
    let dir = g.right.xyz * om.x - g.up.xyz * om.y;
    let od = dir - dot(dir, V) * V;
    let ax = normalize(cross(od, V));
    let pn = N - ax * dot(N, ax); let pl = length(pn);
    let cn = sat(dot(pn, V) / max(pl, 1e-4));
    let n = sign(dot(od, pn)) * fastAcos(cn);
    let lo0 = cos(n + 1.570796); let lo1 = cos(n - 1.570796);
    var h0 = lo0; var h1 = lo1;
    for (var st = 0; st < STEPS; st++) {
      var t = (f32(st) + nz2) / f32(STEPS); t = t * t;
      let o = om * max(t * rpx, 2. + f32(st));
      let a = vec2i(q + o); let b = vec2i(q - o);
      let da = posAt(vec2f(a) + .5, zAt(a)) - P; let db = posAt(vec2f(b) + .5, zAt(b)) - P;
      let la = max(length(da), 1e-4); let lb = max(length(db), 1e-4);
      // a sample that raises the horizon hides sky and shows its own surface instead: it adds the light it
      // reflects (last frame's image) over the arc it newly covers, bounded by the AO radius
      let c0 = mix(lo0, dot(da / la, V), sat(la * fmul + fadd)); let c1 = mix(lo1, dot(db / lb, V), sat(lb * fmul + fadd));
      if (c0 > h0) { gi += min(textureLoad(tPrev, clamp(a, vec2i(0), vec2i(g.res.xy) - 1), 0).rgb, vec3f(4.)) * pl * max(arcI(n + clamp(fastAcos(h0) - n, -1.570796, 1.570796), n, cn) - arcI(n + clamp(fastAcos(c0) - n, -1.570796, 1.570796), n, cn), 0.); h0 = c0; }
      if (c1 > h1) { gi += min(textureLoad(tPrev, clamp(b, vec2i(0), vec2i(g.res.xy) - 1), 0).rgb, vec3f(4.)) * pl * max(arcI(n + clamp(-fastAcos(h1) - n, -1.570796, 1.570796), n, cn) - arcI(n + clamp(-fastAcos(c1) - n, -1.570796, 1.570796), n, cn), 0.); h1 = c1; }
    }
    let a0 = n + clamp(-fastAcos(h1) - n, -1.570796, 1.570796);
    let a1 = n + clamp(fastAcos(h0) - n, -1.570796, 1.570796);
    vis += pl * ((cn + 2. * a0 * sin(n) - cos(2. * a0 - n)) + (cn + 2. * a1 * sin(n) - cos(2. * a1 - n))) * .25;
  }
  return AOut(vec4f(pow(sat(vis / f32(SLICES)), 1.6), z, 0., 0.), vec4f(gi / f32(SLICES) * ss(400., 150., z), 0.));
}
`;
// depth-aware 5x5 blur of the half-res AO
const W_AOB = W_FS + /*wgsl*/`
@group(0) @binding(0) var tO: texture_2d<f32>;
@group(0) @binding(1) var tG: texture_2d<f32>;
struct BOut { @location(0) ao: vec4f, @location(1) gi: vec4f };
@fragment fn fs(@builtin(position) fc: vec4f) -> BOut {
  let p = vec2i(fc.xy); let mx = vec2i(textureDimensions(tO)) - 1;
  let c = textureLoad(tO, p, 0);
  var acc = 0.; var ws = 0.; var ga = vec3f(0.);
  for (var y = -2; y <= 2; y++) { for (var x = -2; x <= 2; x++) {
    let r = textureLoad(tO, clamp(p + vec2i(x, y), vec2i(0), mx), 0);
    let w = (1. - .1 * f32(x * x + y * y)) / (.02 + abs(r.y - c.y) / c.y);
    acc += r.x * w; ws += w; ga += textureLoad(tG, clamp(p + vec2i(x, y), vec2i(0), mx), 0).rgb * w;
  } }
  return BOut(vec4f(acc / ws, c.y, 0., 0.), vec4f(ga / ws, 0.));
}
`;
// ---------------------------------------------------------------- temporal anti-aliasing (full res)
// AO is applied to the ambient share here; then the frame is blended with last frame's result, reprojected by
// depth, with the history clipped to the 3x3 neighbourhood's colour range so moving fronds do not ghost.
const W_TAA = S_G + W_FS + /*wgsl*/`
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(1) var sC: sampler;
@group(0) @binding(2) var tS: texture_2d<f32>;
@group(0) @binding(3) var tA: texture_2d<f32>;
@group(0) @binding(4) var tO: texture_2d<f32>;
@group(0) @binding(5) var tDp: texture_depth_multisampled_2d;
@group(0) @binding(6) var tH: texture_2d<f32>;
@group(0) @binding(7) var tGI: texture_2d<f32>;
// the gather only reaches the AO radius, so it under-counts the bounce from larger nearby surfaces
const GI = 3.;
fn tm(c: vec3f) -> vec3f { return c / (1. + dot(c, LUMA)); }
fn itm(c: vec3f) -> vec3f { return c / max(1. - dot(c, LUMA), 1e-3); }
// depth-aware upsample of the half-res AO (x) and bounce (yzw)
fn aoUp(p: vec2i, z: f32) -> vec4f {
  let h = (vec2f(p) + .5) * .5 - .5; let b = floor(h); let f = h - b; let bi = vec2i(b);
  let mx = vec2i(textureDimensions(tO)) - 1;
  var acc = vec4f(0.); var ws = 0.;
  for (var k = 0; k < 4; k++) {
    let o = vec2i(k & 1, k >> 1); let q = clamp(bi + o, vec2i(0), mx);
    let r = textureLoad(tO, q, 0);
    let w = (mix(1. - f.x, f.x, f32(o.x)) * mix(1. - f.y, f.y, f32(o.y)) + .01) / (.01 + abs(r.y - z) / z);
    acc += vec4f(r.x, textureLoad(tGI, q, 0).rgb) * w; ws += w;
  }
  return acc / ws;
}
// 5-tap Catmull-Rom history fetch: sharper than bilinear, so the image does not soften as frames accumulate
fn hs5(uv: vec2f) -> vec3f {
  let sz = vec2f(textureDimensions(tH)); let p = uv * sz; let tc = floor(p - .5) + .5; let f = p - tc;
  let w0 = f * (-.5 + f * (1. - .5 * f)); let w1 = 1. + f * f * (-2.5 + 1.5 * f); let w2 = f * (.5 + f * (2. - 1.5 * f)); let w3 = f * f * (-.5 + .5 * f);
  let w12 = w1 + w2; let t0 = (tc - 1.) / sz; let t3 = (tc + 2.) / sz; let t12 = (tc + w2 / w12) / sz;
  let a = w12.x * w0.y; let b = w0.x * w12.y; let c = w12.x * w12.y; let d = w3.x * w12.y; let e = w12.x * w3.y;
  let r = textureSampleLevel(tH, sC, vec2f(t12.x, t0.y), 0.).rgb * a + textureSampleLevel(tH, sC, vec2f(t0.x, t12.y), 0.).rgb * b
    + textureSampleLevel(tH, sC, t12, 0.).rgb * c + textureSampleLevel(tH, sC, vec2f(t3.x, t12.y), 0.).rgb * d + textureSampleLevel(tH, sC, vec2f(t12.x, t3.y), 0.).rgb * e;
  return max(r / (a + b + c + d + e), vec3f(0.));
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let px = vec2i(fc.xy); let mx = vec2i(g.res.xy) - 1;
  var m1 = vec3f(0.); var m2 = vec3f(0.); var lo = vec3f(1e9); var hi = vec3f(-1e9); var cur = vec3f(0.);
  var zmin = 1e9; var dpn = 0.; var pn = px;
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let q = clamp(px + vec2i(x, y), vec2i(0), mx);
    let dp = textureLoad(tDp, q, 0); let z = g.fwd.w / max(dp, 1e-7);
    let a = aoUp(q, z); let sa = textureLoad(tA, q, 0);
    let c = tm(textureLoad(tS, q, 0).rgb * (1. - (1. - a.x) * sa.r) + sa.gba * a.yzw * GI);
    m1 += c; m2 += c * c; lo = min(lo, c); hi = max(hi, c);
    if (x == 0 && y == 0) { cur = c; }
    if (z < zmin) { zmin = z; dpn = dp; pn = q; }
  } }
  // reproject the nearest surface in the neighbourhood, so thin foreground edges do not trail
  let uv = (vec2f(pn) + .5) * g.res.zw; let nd = vec2f(uv.x * 2. - 1., 1. - uv.y * 2.) - g.jit.xy;
  let rv = g.fwd.xyz + g.right.xyz * (nd.x * g.right.w) + g.up.xyz * (nd.y * g.up.w);
  let pc = select(g.pvp * vec4f(g.cam.xyz + rv * zmin, 1.), g.pvp * vec4f(rv, 0.), dpn < 1e-7);
  let pu = vec2f(pc.x / pc.w * .5 + .5, .5 - pc.y / pc.w * .5) - uv + (vec2f(px) + .5) * g.res.zw;
  let mean = m1 / 9.; let sg = sqrt(max(m2 / 9. - mean * mean, vec3f(0.)));
  let blo = max(lo, mean - sg * 1.25); let bhi = min(hi, mean + sg * 1.25);
  let hist = clamp(tm(hs5(pu)), blo, bhi);
  let off = any(pu < vec2f(0.)) || any(pu > vec2f(1.)) || pc.w <= 0.;
  let a = select(max(g.jit.z, .1), 1., off);
  var o = itm(mix(hist, cur, a));
  if (any(o != o)) { o = itm(cur); }
  return vec4f(min(o, vec3f(60.)), 1.);
}
`;
