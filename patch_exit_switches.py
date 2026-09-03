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

SCALE = 0.05
CELL = 0.25
P_RADIUS = 0.55
USE_RANGE = 4.0          # how close the player must get to press a switch
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
    rects = []
    for sec in level.get('sectors', []):
        if sec.get('floors'):
            rects.extend(sec['floors'])
        elif sec.get('width') is not None:
            rects.append({'x': sec['x'], 'z': sec['z'],
                          'width': sec['width'], 'depth': sec['depth']})
    return rects


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
        if not rects:
            raise ValueError('level has no floor rectangles')

        min_x = min(r['x'] - r['width'] / 2 for r in rects) - 1
        max_x = max(r['x'] + r['width'] / 2 for r in rects) + 1
        min_z = min(r['z'] - r['depth'] / 2 for r in rects) - 1
        max_z = max(r['z'] + r['depth'] / 2 for r in rects) + 1

        self.min_x, self.min_z = min_x, min_z
        self.w = max(1, int(math.ceil((max_x - min_x) / CELL)))
        self.h = max(1, int(math.ceil((max_z - min_z) / CELL)))

        free = np.zeros((self.h, self.w), dtype=bool)
        for r in rects:
            i0, i1 = self.ci(r['x'] - r['width'] / 2), self.ci(r['x'] + r['width'] / 2)
            j0, j1 = self.cj(r['z'] - r['depth'] / 2), self.cj(r['z'] + r['depth'] / 2)
            free[max(0, j0):min(self.h, j1 + 1), max(0, i0):min(self.w, i1 + 1)] = True

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
        """4-connected BFS. CELL is fine enough that a 1.1-wide wall band
        cannot be crossed, so the fill cannot leak through geometry."""
        dist = np.full((self.h, self.w), -1, dtype=np.int32)
        dist[sj, si] = 0
        frontier = np.zeros((self.h, self.w), dtype=bool)
        frontier[sj, si] = True
        d = 0
        while frontier.any():
            d += 1
            nxt = np.zeros_like(frontier)
            nxt[1:, :] |= frontier[:-1, :]
            nxt[:-1, :] |= frontier[1:, :]
            nxt[:, 1:] |= frontier[:, :-1]
            nxt[:, :-1] |= frontier[:, 1:]
            nxt &= self.free & (dist == -1)
            dist[nxt] = d
            frontier = nxt
        self.dist = dist
        return dist

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
    for w in walls:
        ax, az, bx, bz = wall_pts(w)
        if (round(ax, 2), round(az, 2), round(bx, 2), round(bz, 2)) not in wad_keys:
            continue
        d, _gap = reach.wall_access(ax, az, bx, bz)
        if d is not None:
            native.append(w)
    if native:
        return native, 'native-exit-linedef'

    # 2. Fall back to the furthest wall the player can actually walk up to,
    #    pulled toward where the map's real exit used to be.
    span = max(1.0, float(reach.dist.max()))
    best, best_score = None, -1.0
    for w in walls:
        if not w.get('solid') or w.get('isDoor'):
            continue
        ax, az, bx, bz = wall_pts(w)
        if math.hypot(bx - ax, bz - az) < 1.0:
            continue                      # too short to reliably raycast onto
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
    if best is None:
        return [], 'no-candidate-wall'
    return [best], 'relocated-to-reachable-frontier'


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
                    json.dump(level, f, indent=2)
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
