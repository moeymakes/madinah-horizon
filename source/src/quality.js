// ============================================================================
// quality level, chosen before anything is built (pattern from Abyssal Garden, MIT)
// ============================================================================
// LV: 0 High, 1 Medium, 2 Low. Medium and Low keep every 2nd / 4th frond, grass blade and pebble and bake fewer
// shadows; Low also drops anti-aliasing and uses coarser meshes and fewer light shaft steps.
// localStorage.madinah = "level,pixels,detail". madinahLoad is set while the world is built: still set on the
// next visit means that load crashed the tab, so this one runs a level lower.
const mob = matchMedia('(pointer:coarse)').matches, mem = navigator.deviceMemory;
const keep = (k, v) => { try { localStorage[k] = v; } catch {} };
let SV = [], LV, bad;
try { SV = (localStorage.madinah || '').split(','); bad = localStorage.madinahLoad; } catch {}
LV = SV[0] ? +SV[0] : mob ? (mem > 7 ? 1 : 2) : mem <= 4 ? 2 : 0;
if (bad && LV < 2) { SV = [++LV]; keep('madinah', LV); }
const THIN = 1 << LV, SHADOW = LV ? 2048 : 4096, AA = LV > 1 ? 1 : 4, RAYN = LV > 1 ? 10 : 24;
// time of day (worldsmith references/time-of-day.md): 0 dawn after Fajr, 1 golden hour, 2 night with lights.
// Every bake depends on the sun, so changing it reloads the page.
let TOD = 1;
try { const t = localStorage.madinahTime; if (t === '0' || t === '1' || t === '2') TOD = +t; } catch {}
const TP = [
  { sun: [.93, .105, -.36], sunc: [2.2, 1.55, 1.15], band: [1, .55, .45], bounce: [.60, .46, .36], amb: [.10, .085, .08], expo: .8, rays: .8, lights: .2, litf: .95, night: 0, birds: 1.4 },
  { sun: [-.93, .158, .37], sunc: [2.9, 2.1, 1.35], band: [1, .5, .2], bounce: [.66, .46, .30], amb: [.10, .08, .065], expo: .64, rays: .75, lights: 1, litf: .86, night: 0, birds: 1 },
  { sun: [.45, .62, .64], sunc: [.17, .2, .29], band: [.32, .17, .07], bounce: [.035, .035, .045], amb: [.01, .011, .016], expo: 2.6, rays: 0, lights: 6, litf: .3, night: 1, birds: .15 },
][TOD];
