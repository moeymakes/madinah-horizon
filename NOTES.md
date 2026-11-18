# Madinah Horizon: build notes

Built with the `worldsmith` skill (`~/.shared/skills/worldsmith`). Brief: `prompt.txt`.

## State (update after every phase)

- Realism stage 2 SHIPPED 2026-11-18 ~16:45 AEDT (main 666dcce, live byte-identical; GPU 8.44 / p99 12.46 ms; 0 errors
  3 times x 3 levels; critic still major on out-of-scope items: grid city layout, strap-like fronds, Uhud relief,
  flat canal water; rock interior visible in flight frame 10 predates stage 2). Next: stage 3 (real DEM terrain,
  OSM layout, photo-calibrated colours) on branch `realism-s1`. Paused at 100% of the 5-hour window (resets 19:00).
- Realism stage 1 SHIPPED 2026-11-18 (main 11c25c5, live byte-identical). Stage 2 on branch `realism-s1` (same
  branch, continued): palms ac0180e, bounded GI + basalt 8246d13, clouds 02909b3, Prophet's Mosque layout 7439d0a.
  Stage-2 gate run (verify/s2-final-*): crop clip .07, flatwhite .92 (golden pose 5 2.90, sky glow), brightdetail 66.3;
  GPU 8.44 / p99 12.46 ms. Six other worlds run realism stages 1-3 in their own sessions (brief:
  ~/.config/Claude/side-session-notes/local_e46bf3a1-465b-49b7-b617-a09a30fa0fa1/realism-stages-brief.md); every GPU
  job goes through `flock /tmp/claude-1000/worldsmith-gpu.lock`.
- (history) Realism stage 1 built (branch `realism-s1`, 04d5a40; main untouched). 2026-11-18 13:59-15:37 AEDT.
  Features (one commit each): GTAO+TAA af664e0, Hillaire sky 83eccb1 (+fix 8977469), near-city massing + static
  city shadow map 62260d8, interior-mapped windows 77ae055 (+fix 156aabc), district tint 30d0e6e, exposure 04d5a40.
  Gates (city crop `--crop 0,.62,1,1`, poses 5+6, 3 times; verify/s1-final-*):
  - PASS clip: max .35% (base .59 mean, 1.85 max). PASS brightdetail: mean 66.8 vs base 52.3 (+28%).
  - FAIL flatwhite <2: golden pose 5 = 2.84% (dawn 1.69, night .93, pose 6 all ~0). The remainder is the sky
    glow beside the low sun inside the crop, not a surface; exposure/shafts/dust cuts stopped moving it.
  - FAIL critic: final round (Sonnet) highest major; majors are palms (repetition, lime colour), lava field
    crushed black, Uhud smooth, sand shimmer, grid city layout: stage-2 scope except the city layout.
  - PASS perf: GPU 6.98 avg / 9.96 p99 ms (2560x1440 High, 60 s flight). PASS errors: 0 at 3 times x High/Med/Low
    (index.html). PASS menu-preview (phone/tablet/desktop, 0 errors). PASS size: 118.9 KB.
  Decision needed from Moey: ship as is (gate exceptions above) or keep iterating. Contact sheet:
  /home/moey/Dev/reports/madinah-horizon-realism-stage1-2026-11-18.jpg.
  Capture flights with `--flight-key KeyP`; `--at x,y,z,yaw,pitch` gives free-camera close-ups.

- Phase: SHIPPED to GitHub Pages (https://moeymakes.github.io/madinah-horizon/) at Moey's request; iteration 14 adds city/facade/Masjid detail, smoother dynamic resolution, lava pulled out of the city
- Last good capture: verify/iter-14 (local only, verify/ is gitignored); minified index.html: 0 errors at High and Low
- Perf (iter-14, RTX 3070 shared with two other builds at ~29%, 2560x1440, 60 s flight): GPU avg 4.93 ms, p99 6.51, max 9.42
- Critic: iter-04 blocker; iter-06..13 major with run-to-run noise; Moey judged it ready to share
- Next step: none required. Optional: majority-of-3 critic gate before further polish.
- Smoke test passed: walking, F flight up, F back to walking lands under gravity (index.html, 0 errors)
- Not done yet: phase 6 polish checks (touch, quality levels on Low), README + screenshots, final critic pass
- Decisions locked with Moey (2026-11-15): land around the Masjid (not the courtyard close-up, not the
  7th-century city; those are later worlds); walk with gravity, F toggles flight.

## Geography (composed, not to scale)

Axes: +x east, -z north, y up, metres. Ground near 0.

| Feature | Real | Here |
|---|---|---|
| Masjid an-Nabawi | city centre; 10 minarets ~104-105 m; Green Dome SE of old mosque; 250 courtyard umbrellas | far set piece centred (0, 0, -1500); 10 minarets ~90 m; Green Dome SE of the old block |
| Mount Uhud | ~4-5 km N of the Masjid, ~7 km long, to 1077 m (~450 m above the city), red granite with dark bands | far heightmap ridge centred z = -4200, ~5 km long, ~380 m relief |
| Quba | ~3 km S of the Masjid, white, 4 minarets, many domes, palm orchards | near set piece at (-95, 0, -150), grove around the start |
| Harrat lava | basalt fields E and S; 1256 flow to within 4 km SE | black lava front in the near field's east third, black plain + scoria cones beyond |
| Wadi al-Aqiq | W/SW of the city | sandy wadi crossing the near field's west side |
| Jabal Ayr | S of the city | far ridge at z = +3800, dark |

Sources checked 2026-11-15: thepilgrim.co Mount Uhud page, saudipedia Jabal al-Rumat, Arab News on the
Prophet's Mosque expansions (umbrellas, minarets), madainproject minarets page, USGS northern Harrat Rahat
overview.

## Six poses (keys 1-6)

1. Grove: among palm trunks, sun shafts through fronds, the white mosque ahead, minarets far beyond.
2. Lava edge: standing on black basalt looking NW across the grove and city to the Masjid and Uhud.
3. Wadi: sandy bed with acacias and cobbles, looking north to the Masjid with Uhud behind.
4. Hilltop: granite knoll, the full northern panorama, Uhud lit red.
5. White mosque: by its garden wall, domes and minarets warm in the low sun, palms around.
6. Flight: 180 m up looking north over everything, harrat black to the east.

Fly path (60 s): 1 -> 5 -> 3 -> 4 -> 2 -> rise to 6.

## Palette (linear, golden hour)

Sun (2.9, 2.1, 1.35) HDR · sky zenith (.10, .22, .48) · horizon (.95, .62, .38) · haze (.80, .62, .48)
Accents: Green Dome (.05, .32, .14), date clusters (.75, .30, .04), palm green (.16, .22, .07).

## Critic intent paragraph

The land around Madinah in Saudi Arabia at golden hour. Warm, peaceful, reverent. A date-palm grove with
mud-brick walls and still irrigation water in the foreground, black volcanic lava rock and a sandy wadi
nearby, a white domed mosque at the grove's edge, a low cream-and-white city, and on the horizon the
Prophet's Mosque with its tall minarets and green dome, in front of the long red granite massif of Mount
Uhud. Long shadows, sun shafts through palm fronds, soft golden haze turning blue with distance. No people.

## Sun, movement, audio

- Sun static: elevation 9 degrees, azimuth west-south-west (comes from the left when facing north).
  One baked shadow map for the near field; far terrain gets a CPU-baked heightfield shadow.
- Walk: eye 1.7 m, gravity, slide collision on the density field, bound radius 240 m.
  Fly (F): free 6-DOF, max 260 m altitude, radius 600 m. Dev flight moved to key P, benchmark B.
- Audio: wind bed with gusts, palm-frond rustle tied to gusts, dove coos (FM), small-bird chirps, water
  trickle near the channel, a soft drone. Nothing recited.
- Time of day: DONE 2026-11-16 - Dawn / Golden hour / Night row (localStorage madinahTime, reload on change, default golden hour); night has lamp pools on the plaza, lit Masjid, windows, moon and stars. 0 errors at High and Low for all three.
