# Madinah Horizon: build notes

Built with the `worldsmith` skill (`~/.shared/skills/worldsmith`). Brief: `prompt.txt`.

## State (update after every phase)

- Phase: 5 (critic loop), iteration 07 captured at 2560x1440
- Last good capture: verify/iter-07 (6 poses, 18 flight frames, perf.txt); minified index.html checked: 0 errors
- Perf (iter-07, RTX 3070, 2560x1440, 60 s flight): GPU avg 5.50 ms, p99 7.27, max 8.50 -> gate passes
- Critic: iter-04 blocker; iter-06 major (no blockers); iter-07 running
- Next step: save the iter-07 review to verify/iter-07/critic.md; fix; repeat until highest severity <= minor
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
