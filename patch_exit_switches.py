"""
Repair the exit switch on every converted pack level.

Why this exists
---------------
convert_all_wads.py folded Doom's exit linedef specials (11/51 switch exit,
52/124 walkover exit) into its generic `is_switch` bucket and named them
`sw_<tag or index>`.  The engine only ends a level for `switchId ==
"sw_exit_game"`, so no converted level had a working exit: 0 of 197 were
finishable.  Some exit linedefs were dropped entirely -- a two-sided line whose
two floors differ by less than 32 units is skipped by the converter -- and the
boss maps (MAP30, E?M8) never had an exit linedef to begin with, because in
Doom they end when the boss dies.

What it does
------------
For each level, in order of preference:

  1. Tag the walls that came from a real exit linedef, if the player can
     actually walk up to one.  This keeps the level's own exit.
  2. Otherwise designate a fallback: the wall bordering the reachable region
     that is furthest from spawn by walking distance, biased toward wherever
     the map's real exit linedefs were.  No geometry is invented -- an existing
     wall is re-flagged -- so the layout is untouched and the exit is reachable
     by construction.

Reachability uses the same rules as the engine (see tests/reachability.js):
floor rectangles are the collision authority, solid walls push the player out
to a radius of 0.55, and doors auto-open on approach so they never block.

Run:  python patch_exit_switches.py [--dry-run]
"""

import json
import math
import os
import struct
import sys

import numpy as np
from collections import deque

SCALE = 0.05
CELL = 0.25
P_RADIUS = 0.55
USE_RANGE = 4.0          # how close the player must get to press a switch
STEP_UP_MAX = 1.2        # Doom's 24-unit free auto-climb, at SCALE 0.05.
                         # Same constant as index.html and reachability.js:
                         # climbing more than this is blocked, dropping is not,
                         # so the walk graph is directed.
EXIT_SPECIALS = (11, 51, 52, 124)
EXIT_SWITCH_ID = 'sw_exit_game'

PACKS = [
    ('pack1.wad', 'pack1'), ('pack2.wad', 'pack2'), ('pack3.wad', 'pack3'),
    ('pack4.WAD', 'pack4'), ('pack5.WAD', 'pack5'), ('pack6.WAD', 'pack6'),
    ('DV.wad', 'dv'),
]


# --------------------------------------------------------------------------
# WAD reading: only what is needed to locate exit linedefs.
# --------------------------------------------------------------------------

def read_exit_lines(wad_path):
    """{map_number: [(x1, z1, x2, z2), ...]} in engine world coordinates."""
    with open(wad_path, 'rb') as f:
        _, numlumps, infotableofs = struct.unpack('<4sII', f.read(12))
        f.seek(infotableofs)
        raw = [struct.unpack('<II8s', f.read(16)) for _ in range(numlumps)]
    lumps = [(n.rstrip(b'\x00').decode('ascii', 'ignore'), p, s) for p, s, n in raw]

    def is_map(n):
        return n.startswith('MAP') or (len(n) == 4 and n[0] == 'E' and n[2] == 'M')

    map_idx = [(i, n) for i, (n, _, _) in enumerate(lumps) if is_map(n)]

    out = {}
    with open(wad_path, 'rb') as f:
        for map_num, (mi, _name) in enumerate(map_idx, start=1):
            ml = {}
            for j in range(mi + 1, min(mi + 12, len(lumps))):
                n, p, s = lumps[j]
                if is_map(n):
                    break
                ml[n] = (p, s)
            if 'VERTEXES' not in ml or 'LINEDEFS' not in ml or 'SECTORS' not in ml:
                continue
            f.seek(ml['VERTEXES'][0])
            verts = [struct.unpack('<hh', f.read(4)) for _ in range(ml['VERTEXES'][1] // 4)]
            f.seek(ml['LINEDEFS'][0])
            lds = [struct.unpack('<HHHHHHH', f.read(14)) for _ in range(ml['LINEDEFS'][1] // 14)]

            lines = []
            for ld in lds:
                if ld[3] not in EXIT_SPECIALS:
                    continue
                if ld[0] >= len(verts) or ld[1] >= len(verts):
                    continue
                a, b = verts[ld[0]], verts[ld[1]]
                lines.append((round(a[0] * SCALE, 2), round(-a[1] * SCALE, 2),
                              round(b[0] * SCALE, 2), round(-b[1] * SCALE, 2)))
            out[map_num] = lines
    return out


# --------------------------------------------------------------------------
# Reachability, mirroring the engine's movement rules.
# --------------------------------------------------------------------------

def wall_pts(w):
    return float(w['p1'][0]), float(w['p1'][1]), float(w['p2'][0]), float(w['p2'][1])


def floor_rects(level):
    # Only the hand-built MAP01 still uses rectangles; converted levels carry
    # real sector boundary loops (see convert_all_wads.py).
    if any(sec.get('polys') for sec in level.get('sectors', [])):
        return []
    rects = []
    for sec in level.get('sectors', []):
        if sec.get('floors'):
            rects.extend(sec['floors'])
        elif sec.get('width') is not None:
            rects.append({'x': sec['x'], 'z': sec['z'],
                          'width': sec['width'], 'depth': sec['depth']})
    return rects


def all_loops(level):
    return [loop for sec in level.get('sectors', []) for loop in (sec.get('polys') or [])]


def loops_bounds(loops):
    xs = [q[0] for l in loops for q in l]
    zs = [q[1] for l in loops for q in l]
    return min(xs), min(zs), max(xs), max(zs)


def point_in_polys(x, z, polys):
    inside = False
    for loop in polys:
        n = len(loop)
        j = n - 1
        for i in range(n):
            xi, zi = loop[i]
            xj, zj = loop[j]
            if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi) + xi:
                inside = not inside
            j = i
    return inside


def seg_dist_grid(px, pz, ax, az, bx, bz):
    """Distance from every point in the px/pz meshgrid to segment a->b."""
    vx, vz = bx - ax, bz - az
    seg2 = vx * vx + vz * vz
    if seg2 < 1e-9:
        return np.hypot(px - ax, pz - az)
    t = ((px - ax) * vx + (pz - az) * vz) / seg2
    np.clip(t, 0.0, 1.0, out=t)
    return np.hypot(px - (ax + t * vx), pz - (az + t * vz))


class Reach:
    """Free-space grid plus BFS distances from the player spawn."""

    def __init__(self, level):
        rects = floor_rects(level)
        loops = all_loops(level)
        if not rects and not loops:
            raise ValueError('level has no floor geometry')

        if rects:
            min_x = min(r['x'] - r['width'] / 2 for r in rects) - 1
            max_x = max(r['x'] + r['width'] / 2 for r in rects) + 1
            min_z = min(r['z'] - r['depth'] / 2 for r in rects) - 1
            max_z = max(r['z'] + r['depth'] / 2 for r in rects) + 1
        else:
            a, b, c, d = loops_bounds(loops)
            min_x, min_z, max_x, max_z = a - 1, b - 1, c + 1, d + 1

        self.min_x, self.min_z = min_x, min_z
        self.w = max(1, int(math.ceil((max_x - min_x) / CELL)))
        self.h = max(1, int(math.ceil((max_z - min_z) / CELL)))

        free = np.zeros((self.h, self.w), dtype=bool)
        for r in rects:
            i0, i1 = self.ci(r['x'] - r['width'] / 2), self.ci(r['x'] + r['width'] / 2)
            j0, j1 = self.cj(r['z'] - r['depth'] / 2), self.cj(r['z'] + r['depth'] / 2)
            free[max(0, j0):min(self.h, j1 + 1), max(0, i0):min(self.w, i1 + 1)] = True
        self.fy = np.zeros((self.h, self.w), dtype=np.float32)
        for sec in level.get('sectors', []):
            if sec.get('polys'):
                # Scanline per sector so every cell carries its floor height.
                self.fill_loops(free, sec['polys'], sec['floorY'])
        for sec in level.get('sectors', []):
            if sec.get('polys'):
                continue
            srects = sec.get('floors') or ([{'x': sec['x'], 'z': sec['z'],
                                             'width': sec['width'], 'depth': sec['depth']}]
                                           if sec.get('width') is not None else [])
            for r in srects:
                i0, i1 = self.ci(r['x'] - r['width'] / 2), self.ci(r['x'] + r['width'] / 2)
                j0, j1 = self.cj(r['z'] - r['depth'] / 2), self.cj(r['z'] + r['depth'] / 2)
                self.fy[max(0, j0):min(self.h, j1 + 1),
                        max(0, i0):min(self.w, i1 + 1)] = sec.get('floorY', 0.0)

        xs = self.min_x + np.arange(self.w) * CELL
        zs = self.min_z + np.arange(self.h) * CELL
        self.px, self.pz = np.meshgrid(xs, zs)

        pad = int(math.ceil(P_RADIUS / CELL)) + 1
        for ax, az, bx, bz in self.blocking(level):
            i0 = max(0, self.ci(min(ax, bx)) - pad)
            i1 = min(self.w, self.ci(max(ax, bx)) + pad + 1)
            j0 = max(0, self.cj(min(az, bz)) - pad)
            j1 = min(self.h, self.cj(max(az, bz)) + pad + 1)
            if i0 >= i1 or j0 >= j1:
                continue
            sub = free[j0:j1, i0:i1]
            if not sub.any():
                continue
            d = seg_dist_grid(self.px[j0:j1, i0:i1], self.pz[j0:j1, i0:i1], ax, az, bx, bz)
            sub &= ~(d < P_RADIUS)
        self.free = free

    def fill_loops(self, free, loops, floor_y=None):
        buckets = {}
        edges = []
        for loop in loops:
            n = len(loop)
            for i in range(n):
                (x1, z1), (x2, z2) = loop[i - 1], loop[i]
                if z1 == z2:
                    continue
                e = len(edges)
                edges.append((x1, z1, x2, z2))
                r0 = max(0, int(math.ceil((min(z1, z2) - self.min_z) / CELL)))
                r1 = min(self.h - 1, int(math.floor((max(z1, z2) - self.min_z) / CELL)))
                for r in range(r0, r1 + 1):
                    buckets.setdefault(r, []).append(e)
        for j, b in buckets.items():
            z = self.min_z + j * CELL
            xs = []
            for e in b:
                ax, az, bx, bz = edges[e]
                if (az > z) == (bz > z):
                    continue
                xs.append(ax + (z - az) / (bz - az) * (bx - ax))
            if len(xs) < 2:
                continue
            xs.sort()
            for k in range(0, len(xs) - 1, 2):
                i0 = max(0, int(math.ceil((xs[k] - self.min_x) / CELL)))
                i1 = min(self.w - 1, int(math.floor((xs[k + 1] - self.min_x) / CELL)))
                if i1 >= i0:
                    free[j, i0:i1 + 1] = True
                    if floor_y is not None:
                        self.fy[j, i0:i1 + 1] = floor_y

    @staticmethod
    def blocking(level):
        # Doors auto-open within 1.35 units, so they never stop the player.
        # Switch walls have no `closed` flag and do stay solid.
        return [wall_pts(w) for w in level.get('walls', [])
                if w.get('solid') and not w.get('isDoor')]

    def ci(self, x):
        return int(round((x - self.min_x) / CELL))

    def cj(self, z):
        return int(round((z - self.min_z) / CELL))

    def snap(self, x, z, max_r=60):
        i, j = self.ci(x), self.cj(z)
        if 0 <= i < self.w and 0 <= j < self.h and self.free[j, i]:
            return i, j
        for r in range(1, max_r + 1):
            for d in range(-r, r + 1):
                for ci, cj in ((i + d, j - r), (i + d, j + r), (i - r, j + d), (i + r, j + d)):
                    if 0 <= ci < self.w and 0 <= cj < self.h and self.free[cj, ci]:
                        return ci, cj
        return None

    def bfs(self, si, sj):
        """4-connected BFS, directed by the climb rule: a step may drop any
        distance but may only rise by STEP_UP_MAX. CELL is fine enough that a
        1.1-wide wall band cannot be crossed, so it cannot leak through
        geometry.

        Queue-based rather than whole-array numpy passes: the array form costs
        one pass per BFS ring, which on the Deus Vult megamaps is thousands of
        passes over millions of cells."""
        w, h = self.w, self.h
        free = self.free.reshape(-1)
        fy = self.fy.reshape(-1)
        dist = np.full(h * w, -1, dtype=np.int32)
        start = sj * w + si
        dist[start] = 0
        queue = deque([start])
        dl = dist.tolist()          # python lists: ~5x faster than numpy item access
        fl = fy.tolist()
        fr = free.tolist()
        while queue:
            k = queue.popleft()
            d = dl[k] + 1
            here = fl[k]
            i = k % w
            if i + 1 < w:
                n = k + 1
                if fr[n] and dl[n] < 0 and fl[n] - here <= STEP_UP_MAX + 1e-3:
                    dl[n] = d
                    queue.append(n)
            if i > 0:
                n = k - 1
                if fr[n] and dl[n] < 0 and fl[n] - here <= STEP_UP_MAX + 1e-3:
                    dl[n] = d
                    queue.append(n)
            n = k + w
            if n < h * w and fr[n] and dl[n] < 0 and fl[n] - here <= STEP_UP_MAX + 1e-3:
                dl[n] = d
                queue.append(n)
            n = k - w
            if n >= 0 and fr[n] and dl[n] < 0 and fl[n] - here <= STEP_UP_MAX + 1e-3:
                dl[n] = d
                queue.append(n)
        self.dist = np.array(dl, dtype=np.int32).reshape(h, w)
        return self.dist

    def wall_access(self, ax, az, bx, bz):
        """(best walking distance, min gap) for reachable cells near a wall."""
        pad = int(math.ceil(USE_RANGE / CELL)) + 1
        i0 = max(0, self.ci(min(ax, bx)) - pad)
        i1 = min(self.w, self.ci(max(ax, bx)) + pad + 1)
        j0 = max(0, self.cj(min(az, bz)) - pad)
        j1 = min(self.h, self.cj(max(az, bz)) + pad + 1)
        if i0 >= i1 or j0 >= j1:
            return None, float('inf')
        sub_d = self.dist[j0:j1, i0:i1]
        ok = sub_d >= 0
        if not ok.any():
            return None, float('inf')
        gap = seg_dist_grid(self.px[j0:j1, i0:i1], self.pz[j0:j1, i0:i1], ax, az, bx, bz)
        usable = ok & (gap <= USE_RANGE)
        if not usable.any():
            return None, float(gap[ok].min())
        return int(sub_d[usable].max()), float(gap[usable].min())


# --------------------------------------------------------------------------
# Exit selection
# --------------------------------------------------------------------------

def floor_at(reach, x, z):
    """Mirrors the engine's getFloorAt, read off the rasterised grid the Reach
    object already built (point-in-polygon per query was this script's entire
    runtime). None where there is no floor."""
    i, j = reach.ci(x), reach.cj(z)
    if not (0 <= i < reach.w and 0 <= j < reach.h):
        return None
    if not reach.free[j, i]:
        return None
    return float(reach.fy[j, i])


FLOOR_TOLERANCE = 2.0  # engine units (~40 Doom map units)


def standoff_floor_ok(reach, w):
    """A candidate exit wall is only usable if the floor the player will
    actually be standing on in front of it matches the sector height that
    wall was built from. Bounding-box sector overlap can otherwise place the
    switch's usable standoff point over a wildly different (and wrong)
    floor -- the player would end up too far below/above the switch for
    interact()'s raycast to ever hit it, an unusable exit that looks fine to
    the height-ignorant 2D reachability model."""
    ax, az, bx, bz = wall_pts(w)
    dx, dz = bx - ax, bz - az
    length = math.hypot(dx, dz) or 1.0
    nx, nz = -dz / length, dx / length
    mx, mz = (ax + bx) / 2, (az + bz) / 2
    expected = w.get('bottomY')
    if expected is None:
        return True
    for side in (1, -1):
        for back in (1.6, 2.4, 3.2):
            px, pz = mx + nx * side * back, mz + nz * side * back
            fy = floor_at(reach, px, pz)
            if fy is not None and abs(fy - expected) <= FLOOR_TOLERANCE:
                return True
    return False


def mark_exit(w):
    w['isSwitch'] = True
    w['switchId'] = EXIT_SWITCH_ID
    w['tex'] = 'switch_off'
    w['isExit'] = True


def choose_exit(level, wad_exit_lines):
    """Returns (list_of_walls_to_mark, strategy). Empty list means failure."""
    reach = Reach(level)
    sp = level['playerSpawn']['pos']
    start = reach.snap(sp[0], sp[2])
    if start is None:
        return [], 'spawn-off-floor'
    reach.bfs(*start)

    walls = level['walls']

    # 1. Prefer the level's own exit linedefs, matched by coordinates.
    wad_keys = set()
    for a, b, c, d in wad_exit_lines:
        wad_keys.add((round(a, 2), round(b, 2), round(c, 2), round(d, 2)))
        wad_keys.add((round(c, 2), round(d, 2), round(a, 2), round(b, 2)))
    native = []
    native_unsafe = []
    for w in walls:
        ax, az, bx, bz = wall_pts(w)
        if (round(ax, 2), round(az, 2), round(bx, 2), round(bz, 2)) not in wad_keys:
            continue
        d, _gap = reach.wall_access(ax, az, bx, bz)
        if d is None:
            continue
        (native if standoff_floor_ok(reach, w) else native_unsafe).append(w)
    if native:
        return native, 'native-exit-linedef'

    # 2. Fall back to the furthest wall the player can actually walk up to,
    #    pulled toward where the map's real exit used to be. Ranked twice:
    #    once requiring a sane standoff floor, once without, so an ambiguous
    #    bounding-box overlap never leaves a map with no exit at all.
    span = max(1.0, float(reach.dist.max()))

    def rank(require_safe):
        best, best_score = None, -1.0
        for w in walls:
            if not w.get('solid') or w.get('isDoor'):
                continue
            ax, az, bx, bz = wall_pts(w)
            if math.hypot(bx - ax, bz - az) < 1.0:
                continue                      # too short to reliably raycast onto
            if require_safe and not standoff_floor_ok(reach, w):
                continue
            d, _gap = reach.wall_access(ax, az, bx, bz)
            if d is None:
                continue
            score = d / span
            if wad_exit_lines:
                mx, mz = (ax + bx) / 2, (az + bz) / 2
                near = min(math.hypot(mx - (a + c) / 2, mz - (b + e) / 2)
                           for a, b, c, e in wad_exit_lines)
                score += 0.6 * math.exp(-near / 12.0)   # bias, never a veto
            if score > best_score:
                best, best_score = w, score
        return best

    best = rank(require_safe=True)
    if best is not None:
        return [best], 'relocated-to-reachable-frontier'
    if native_unsafe:
        return native_unsafe, 'native-exit-linedef-ambiguous-floor'
    best = rank(require_safe=False)
    if best is None:
        return [], 'no-candidate-wall'
    return [best], 'relocated-to-reachable-frontier-ambiguous-floor'


def patch_level(json_path, wad_exit_lines):
    with open(json_path, 'r', encoding='utf-8') as f:
        level = json.load(f)

    # Clear any previous run of this script so it is idempotent.
    for w in level['walls']:
        if w.get('switchId') == EXIT_SWITCH_ID:
            w.pop('isExit', None)
            w['switchId'] = 'sw_reset'

    chosen, strategy = choose_exit(level, wad_exit_lines)
    for w in chosen:
        mark_exit(w)
    return level, strategy, len(chosen)


def main():
    dry = '--dry-run' in sys.argv
    quiet = '--quiet' in sys.argv
    summary = {}
    for wad, pack_id in PACKS:
        if not os.path.exists(wad):
            print('  skip %s: %s not present' % (pack_id, wad))
            continue
        exits_by_map = read_exit_lines(wad)
        man_path = os.path.join('levelPacks', pack_id, 'manifest.json')
        if not os.path.exists(man_path):
            print('  skip %s: no manifest' % pack_id)
            continue
        with open(man_path, encoding='utf-8') as f:
            manifest = json.load(f)

        counts = {}
        for n, entry in enumerate(manifest, start=1):
            path = entry['file']
            level, strategy, k = patch_level(path, exits_by_map.get(n, []))
            counts[strategy] = counts.get(strategy, 0) + 1
            if not dry:
                with open(path, 'w', encoding='utf-8') as f:
                    json.dump(level, f, separators=(',', ':'))
            if not quiet:
                print('  [%s] %7s  %s  (%d wall(s))' % (pack_id, entry['id'], strategy, k))
        summary[pack_id] = counts

    print('\nSummary')
    for pack_id, counts in summary.items():
        print('  %s: %s' % (pack_id, ', '.join('%dx %s' % (v, k) for k, v in sorted(counts.items()))))
    if dry:
        print('\n(dry run - nothing written)')


if __name__ == '__main__':
    main()
