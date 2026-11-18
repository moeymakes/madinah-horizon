import json, math, base64, sys
# Pack OSM roads + hotel footprints around the Prophet's Mosque into a compact base64 blob for world.js.
# Coordinates: metres relative to the Haram centre (24.4672 N, 39.6111 E), x east, z south (world axes).
LAT0, LON0 = 24.4672, 39.6111
KX = math.cos(math.radians(LAT0)) * 111320.0; KZ = 110574.0
R = 1350.0
WID = {'trunk': 7, 'trunk_link': 4, 'primary': 6, 'primary_link': 4, 'secondary': 5, 'secondary_link': 4, 'tertiary': 4,
       'residential': 3, 'pedestrian': 3, 'unclassified': 3, 'living_street': 3}
d = json.load(open(sys.argv[1]))
def xy(p): return ((p['lon'] - LON0) * KX, -(p['lat'] - LAT0) * KZ)
def dp(pts, eps):
    if len(pts) < 3: return pts
    a, b = pts[0], pts[-1]; dx, dz = b[0]-a[0], b[1]-a[1]; L = math.hypot(dx, dz) or 1e-9
    best, bi = -1, 0
    for i in range(1, len(pts)-1):
        p = pts[i]; dd = abs((p[0]-a[0])*dz - (p[1]-a[1])*dx) / L
        if dd > best: best, bi = dd, i
    if best < eps: return [a, b]
    return dp(pts[:bi+1], eps)[:-1] + dp(pts[bi:], eps)
out = bytearray(); nroad = npt = 0
for e in d['elements']:
    t = e.get('tags', {}); hw = t.get('highway')
    if hw not in WID or 'geometry' not in e: continue
    pts = [xy(p) for p in e['geometry']]
    if not any(math.hypot(*p) < R for p in pts): continue
    pts = dp(pts, 3.5)
    pts = [(max(-2047, min(2047, round(x))), max(-2047, min(2047, round(z)))) for x, z in pts]
    if len(pts) < 2 or len(pts) > 255: continue
    # first point int16 x,z; then int8 deltas, or -128 followed by an int16 pair when a step exceeds 127 m
    out += bytes([WID[hw], len(pts)]) + int(pts[0][0]).to_bytes(2, 'little', signed=True) + int(pts[0][1]).to_bytes(2, 'little', signed=True)
    for (x0, z0), (x1, z1) in zip(pts, pts[1:]):
        dx, dz = x1 - x0, z1 - z0
        if -127 <= dx <= 127 and -127 <= dz <= 127: out += dx.to_bytes(1, 'little', signed=True) + dz.to_bytes(1, 'little', signed=True)
        else: out += (-128).to_bytes(1, 'little', signed=True) + int(x1).to_bytes(2, 'little', signed=True) + int(z1).to_bytes(2, 'little', signed=True)
    nroad += 1; npt += len(pts)
roads = bytes(out)
# hotels and tall buildings: oriented box from the footprint's principal axes
hb = bytearray(); nh = 0
for e in d['elements']:
    t = e.get('tags', {})
    if t.get('building') not in ('hotel', 'commercial') or 'geometry' not in e: continue
    pts = [xy(p) for p in e['geometry']][:-1]
    cx = sum(p[0] for p in pts) / len(pts); cz = sum(p[1] for p in pts) / len(pts)
    if math.hypot(cx, cz) > R: continue
    sxx = sum((p[0]-cx)**2 for p in pts); szz = sum((p[1]-cz)**2 for p in pts); sxz = sum((p[0]-cx)*(p[1]-cz) for p in pts)
    ang = 0.5 * math.atan2(2*sxz, sxx - szz); ca, sa = math.cos(ang), math.sin(ang)
    us = [(p[0]-cx)*ca + (p[1]-cz)*sa for p in pts]; vs = [-(p[0]-cx)*sa + (p[1]-cz)*ca for p in pts]
    w, dd = max(us)-min(us), max(vs)-min(vs)
    if w < 8 or dd < 8: continue
    hb += int(round(cx)).to_bytes(2, 'little', signed=True) + int(round(cz)).to_bytes(2, 'little', signed=True)
    hb += bytes([min(255, round(w)), min(255, round(dd)), round((ang % math.pi) / math.pi * 255)])
    nh += 1
blob = roads + b'\0\0' + bytes(hb)
print(f'roads {nroad} ways {npt} pts {len(roads)} B; hotels {nh} {len(hb)} B; total b64 {len(base64.b64encode(blob))} chars', file=sys.stderr)
open(sys.argv[2], 'w').write(base64.b64encode(blob).decode())
