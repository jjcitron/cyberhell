import os
import glob
import struct
import math
import json
from collections import defaultdict


# --------------------------------------------------------------------------
# Sector boundary polygons
#
# A Doom sector is an arbitrary polygon (often concave, often with holes, and
# often several disjoint rooms sharing one sector number).  The old converter
# stored one axis-aligned bounding rectangle per sector, so neighbouring
# sectors overlapped, getFloorAt picked the wrong one and the player fell
# through floors / stood on nothing.  These helpers recover the real boundary.
#
# Doom convention: a linedef's FRONT sidedef is on the right of v1->v2, so
# walking v1->v2 keeps the front sector's interior on the right.  For the back
# sector the same is true of v2->v1.  Collect those directed edges per sector
# and chain them head-to-tail into closed loops.
# --------------------------------------------------------------------------

NO_SIDEDEF = 0xFFFF


def sector_directed_edges(linedefs, sidedefs, verts, nsectors):
    """{sector_id: [((x1,y1),(x2,y2)), ...]} of directed boundary edges,
    in raw Doom map coordinates."""
    edges = defaultdict(list)
    nv = len(verts)
    for ld in linedefs:
        v1, v2 = ld[0], ld[1]
        if v1 >= nv or v2 >= nv or v1 == v2:
            continue
        s1, s2 = ld[5], ld[6]
        front = sidedefs[s1][5] if s1 != NO_SIDEDEF and s1 < len(sidedefs) else None
        back = sidedefs[s2][5] if s2 != NO_SIDEDEF and s2 < len(sidedefs) else None
        if front is not None and front == back:
            continue  # self-referencing line: not a boundary of anything
        a, b = verts[v1], verts[v2]
        if a == b:
            continue
        if front is not None and 0 <= front < nsectors:
            edges[front].append((a, b))
        if back is not None and 0 <= back < nsectors:
            edges[back].append((b, a))
    return edges


def _pick_turn(a, b, cands, elist):
    """At a junction, keep hugging the same face: take the sharpest right
    turn (interior is on the right).  A full reversal is the last resort."""
    ang_in = math.atan2(b[1] - a[1], b[0] - a[0])
    best, best_t = cands[0], 10.0
    for j in cands:
        c = elist[j][1]
        t = math.atan2(c[1] - b[1], c[0] - b[0]) - ang_in
        t = (t + math.pi) % (2 * math.pi) - math.pi
        if t <= -math.pi + 1e-9:
            t = math.pi  # 180 degree reversal
        if t < best_t:
            best, best_t = j, t
    return best


def chain_loops(elist):
    """Directed edges -> (loops as vertex lists, count_of_unclosed_chains).

    A chain that never returns to its start means the sector's boundary is
    malformed in the WAD (or uses a trick this walker does not model). Closing
    it by joining its ends approximates the real shape far better than falling
    back to a bounding rectangle, which is the overlap bug this whole change
    exists to remove -- so keep it, and count it."""
    adj = defaultdict(list)
    for i, (a, _b) in enumerate(elist):
        adj[a].append(i)
    used = [False] * len(elist)
    loops, dropped = [], 0
    for i in range(len(elist)):
        if used[i]:
            continue
        start = elist[i][0]
        cur, pts, closed = i, [], False
        while True:
            used[cur] = True
            a, b = elist[cur]
            pts.append(a)
            if b == start:
                closed = True
                break
            cands = [j for j in adj[b] if not used[j]]
            if not cands:
                break
            cur = cands[0] if len(cands) == 1 else _pick_turn(a, b, cands, elist)
            if len(pts) > 50000:
                break
        if len(pts) >= 3:
            loops.append(pts)
            if not closed:
                dropped += 1
        elif pts:
            dropped += 1
    return loops, dropped


def to_engine_loop(pts, scale):
    """Doom (x, y) -> engine (x, z) with the y->-z flip, deduped and rounded."""
    out = []
    for (x, y) in pts:
        p = [round(x * scale, 2), round(-y * scale, 2)]
        if out and out[-1] == p:
            continue
        out.append(p)
    while len(out) > 1 and out[0] == out[-1]:
        out.pop()
    return out if len(out) >= 3 else None


def directed_area(elist, scale):
    """Signed area straight from the directed edges -- independent of the loop
    chaining, so tests can use it to catch a chaining bug."""
    acc = 0.0
    for (a, b) in elist:
        ax, az = a[0] * scale, -a[1] * scale
        bx, bz = b[0] * scale, -b[1] * scale
        acc += ax * bz - bx * az
    return abs(acc) / 2.0


def loop_area(loop):
    acc = 0.0
    n = len(loop)
    for i in range(n):
        x1, z1 = loop[i]
        x2, z2 = loop[(i + 1) % n]
        acc += x1 * z2 - x2 * z1
    return acc / 2.0


def push_out_of_walls(x, z, walls, r=0.6, iters=3):
    """Nudge a thing out of any solid wall it was placed inside. Doom things
    are point-sized so WADs happily put them flush against (or inside) a wall;
    an engine that gives them a radius then has an enemy stuck in geometry
    with no way out. Same push-out the engine runs, done once at import."""
    for _ in range(iters):
        moved = False
        for w in walls:
            if not w.get('solid'):
                continue
            ax, az = w['p1']
            bx, bz = w['p2']
            vx, vz = bx - ax, bz - az
            seg2 = vx * vx + vz * vz
            t = 0.0 if seg2 < 1e-9 else max(0.0, min(1.0, ((x - ax) * vx + (z - az) * vz) / seg2))
            px, pz = ax + t * vx, az + t * vz
            dx, dz = x - px, z - pz
            d = math.hypot(dx, dz)
            if d >= r:
                continue
            if d < 1e-6:                      # dead centre: use the normal
                n = math.hypot(vx, vz) or 1.0
                dx, dz, d = -vz / n, vx / n, 1.0
            x += dx / d * (r - d)
            z += dz / d * (r - d)
            moved = True
        if not moved:
            break
    return round(x, 2), round(z, 2)


def point_in_polys(x, z, polys):
    """Even-odd test over every loop of a sector (holes cancel out)."""
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

def convert_wad(wad_filename, pack_id, pack_title):
    out_dir = os.path.join('levelPacks', pack_id)
    os.makedirs(out_dir, exist_ok=True)

    with open(wad_filename, 'rb') as f:
        header = f.read(12)
        if len(header) < 12:
            return None
        _, numlumps, infotableofs = struct.unpack('<4sII', header)
        f.seek(infotableofs)
        lumps = [struct.unpack('<II8s', f.read(16)) for _ in range(numlumps)]
        lumps = [(name.rstrip(b'\x00').decode('ascii', errors='ignore'), pos, size) for pos, size, name in lumps]

    map_indices = []
    for idx, (name, pos, size) in enumerate(lumps):
        if name.startswith('MAP') or (len(name) == 4 and name[0] == 'E' and name[2] == 'M'):
            map_indices.append((idx, name))

    print(f"\nProcessing {wad_filename} ({pack_title}): Found {len(map_indices)} maps")

    SCALE = 0.05
    manifest = []

    with open(wad_filename, 'rb') as f:
        for map_num, (map_idx, map_name) in enumerate(map_indices, start=1):
            map_lumps = {}
            for j in range(map_idx + 1, min(map_idx + 12, len(lumps))):
                sub_name, sub_pos, sub_size = lumps[j]
                if sub_name.startswith('MAP') or (len(sub_name) == 4 and sub_name[0] == 'E' and sub_name[2] == 'M'):
                    break
                map_lumps[sub_name] = (sub_pos, sub_size)

            if 'VERTEXES' not in map_lumps or 'LINEDEFS' not in map_lumps or 'SECTORS' not in map_lumps:
                print(f"Skipping incomplete map {map_name}")
                continue

            f.seek(map_lumps['VERTEXES'][0])
            verts = [struct.unpack('<hh', f.read(4)) for _ in range(map_lumps['VERTEXES'][1] // 4)]
            
            f.seek(map_lumps['LINEDEFS'][0])
            linedefs = [struct.unpack('<HHHHHHH', f.read(14)) for _ in range(map_lumps['LINEDEFS'][1] // 14)]

            f.seek(map_lumps['SIDEDEFS'][0])
            sidedefs = [struct.unpack('<hh8s8s8sH', f.read(30)) for _ in range(map_lumps['SIDEDEFS'][1] // 30)]

            f.seek(map_lumps['SECTORS'][0])
            sectors_raw = [struct.unpack('<hh8s8shhh', f.read(26)) for _ in range(map_lumps['SECTORS'][1] // 26)]

            f.seek(map_lumps['THINGS'][0])
            things_raw = [struct.unpack('<hhhhh', f.read(10)) for _ in range(map_lumps['THINGS'][1] // 10)]

            # Sector Vertices Bounding
            sector_verts = {i: [] for i in range(len(sectors_raw))}
            for ld in linedefs:
                v1, v2, _, _, _, s1_idx, s2_idx = ld
                if s1_idx != 65535 and s1_idx < len(sidedefs):
                    sec_id = sidedefs[s1_idx][5]
                    if sec_id < len(sectors_raw):
                        sector_verts[sec_id].append(verts[v1])
                        sector_verts[sec_id].append(verts[v2])
                if s2_idx != 65535 and s2_idx < len(sidedefs):
                    sec_id = sidedefs[s2_idx][5]
                    if sec_id < len(sectors_raw):
                        sector_verts[sec_id].append(verts[v1])
                        sector_verts[sec_id].append(verts[v2])

            # Real sector boundaries (see helpers at the top of this file).
            sec_edges = sector_directed_edges(linedefs, sidedefs, verts, len(sectors_raw))
            sec_polys, sec_area, poly_fallbacks = {}, {}, 0
            for sec_id in range(len(sectors_raw)):
                elist = sec_edges.get(sec_id, [])
                sec_area[sec_id] = round(directed_area(elist, SCALE), 2)
                loops_raw, dropped = chain_loops(elist)
                loops = [l for l in (to_engine_loop(pts, SCALE) for pts in loops_raw) if l]
                if dropped:
                    poly_fallbacks += dropped
                sec_polys[sec_id] = loops

            poly_bb = {}
            for s_id, loops in sec_polys.items():
                if not loops:
                    continue
                pts = [p for l in loops for p in l]
                poly_bb[s_id] = (min(p[0] for p in pts), min(p[1] for p in pts),
                                 max(p[0] for p in pts), max(p[1] for p in pts))

            def poly_floor_at(x, z):
                for s_id, bb in poly_bb.items():
                    if x < bb[0] or x > bb[2] or z < bb[1] or z > bb[3]:
                        continue
                    if point_in_polys(x, z, sec_polys[s_id]):
                        return round(sectors_raw[s_id][0] * SCALE, 2)
                return None

            sectors_json = []
            rect_fallbacks = []
            for sec_id, sec in enumerate(sectors_raw):
                floor_h, ceil_h, floor_tex, ceil_tex, light, special, tag = sec
                f_tex_str = floor_tex.rstrip(b'\x00').decode('ascii', errors='ignore').upper()
                c_tex_str = ceil_tex.rstrip(b'\x00').decode('ascii', errors='ignore').upper()

                is_sky = ('F_SKY' in c_tex_str or 'SKY' in c_tex_str)

                f_tex = 'tech_floor'
                if 'GRID' in f_tex_str or 'BLUE' in f_tex_str: f_tex = 'blue_grid'
                elif 'NUKAGE' in f_tex_str or 'SLIME' in f_tex_str or 'LAVA' in f_tex_str or 'BLOOD' in f_tex_str: f_tex = 'toxic_ooze'
                elif 'FLAT' in f_tex_str or 'GRATE' in f_tex_str or 'METAL' in f_tex_str: f_tex = 'metal_grate'
                elif 'ROCK' in f_tex_str or 'RIVER' in f_tex_str or 'MUD' in f_tex_str: f_tex = 'toxic_rock'
                elif 'CEIL' in f_tex_str or 'DARK' in f_tex_str: f_tex = 'dark_metal'

                c_tex = 'tech_panel' if not is_sky else 'sky'

                sv = sector_verts[sec_id]
                if sv:
                    xs = [v[0] * SCALE for v in sv]
                    ys = [-v[1] * SCALE for v in sv]
                    min_x, max_x = round(min(xs), 2), round(max(xs), 2)
                    min_z, max_z = round(min(ys), 2), round(max(ys), 2)
                    w = round(max_x - min_x, 2)
                    d = round(max_z - min_z, 2)
                    cx = round((min_x + max_x) / 2, 2)
                    cz = round((min_z + max_z) / 2, 2)
                else:
                    w, d, cx, cz = 20, 20, 0, 0

                loops = sec_polys[sec_id]
                if not loops and sec_area[sec_id] > 0.5:
                    # Boundary walk produced nothing usable for a sector that
                    # does enclose area: fall back to its bounding rectangle
                    # so the floor exists, and accept that it may overlap a
                    # neighbour. Logged by the caller.
                    hw, hd = max(0.5, w) / 2, max(0.5, d) / 2
                    loops = [[[cx - hw, cz - hd], [cx + hw, cz - hd],
                              [cx + hw, cz + hd], [cx - hw, cz + hd]]]
                    rect_fallbacks.append(sec_id)

                sectors_json.append({
                    'id': f'sec_{sec_id}',
                    # Real boundary loops (outer + holes, even-odd). The x/z/
                    # width/depth rectangle below is only a fallback for
                    # consumers that predate this field.
                    'polys': loops,
                    'area': sec_area[sec_id],
                    'floorY': round(floor_h * SCALE, 2),
                    'ceilY': round(ceil_h * SCALE, 2),
                    'floorTex': f_tex,
                    'ceilTex': c_tex,
                    'light': round(min(1.0, max(0.3, light / 255.0)), 2),
                    'isSky': is_sky,
                    'x': cx,
                    'z': cz,
                    'width': max(1.0, w),
                    'depth': max(1.0, d)
                })

            # Doom movement rules this encodes:
            #   - auto-climb a floor step up to 24 map units, no jump needed
            #   - a two-sided line is passable only if the gap between the
            #     higher floor and the lower ceiling is tall enough to fit
            #   - ML_BLOCKING (flag 1) blocks regardless of geometry
            # Floor risers are never solid walls: climbing is gated by floor
            # height, not by geometry. Both the engine (updatePhysics) and the
            # offline model (tests/reachability.js) refuse a step that raises
            # the floor by more than STEP_LIMIT, and allow any drop.
            STEP_LIMIT = 24   # Doom map units
            MIN_GAP = 32      # can't squeeze through anything shorter
            ML_BLOCKING = 0x0001

            walls_json = []
            for idx, ld in enumerate(linedefs):
                v1_idx, v2_idx, flags, special, tag, s1_idx, s2_idx = ld
                if v1_idx >= len(verts) or v2_idx >= len(verts): continue
                p1 = verts[v1_idx]
                p2 = verts[v2_idx]

                is_single = (s2_idx == 65535 or s2_idx >= len(sidedefs))
                is_door = special in [1, 26, 27, 28, 31, 32, 117, 118]
                # Exit specials: 11/51 are switch exits, 52/124 walkover exits.
                is_exit = special in [11, 51, 52, 124]
                is_switch = is_exit or special in [9, 14, 18, 42, 63, 103]

                if s1_idx >= len(sidedefs): continue
                sec1_id = sidedefs[s1_idx][5]
                if sec1_id >= len(sectors_raw): continue
                sec1 = sectors_raw[sec1_id]

                solid = True
                is_step_up = False
                is_ledge = False
                if is_single:
                    bottom_y = sec1[0] * SCALE
                    top_y = sec1[1] * SCALE
                    h = max(0.5, top_y - bottom_y)
                    raw_tex = sidedefs[s1_idx][4].rstrip(b'\x00').decode('ascii', errors='ignore').upper()
                else:
                    sec2_id = sidedefs[s2_idx][5]
                    if sec2_id >= len(sectors_raw): continue
                    sec2 = sectors_raw[sec2_id]
                    f_lo, f_hi = min(sec1[0], sec2[0]), max(sec1[0], sec2[0])
                    gap = min(sec1[1], sec2[1]) - f_hi
                    raw_tex = sidedefs[s1_idx][3].rstrip(b'\x00').decode('ascii', errors='ignore').upper()
                    if is_door or is_switch:
                        # Doors/switches need floor-to-ceiling geometry to act
                        # as a panel, regardless of any floor step.
                        bottom_y = min(sec1[0], sec2[0]) * SCALE
                        top_y = max(sec1[1], sec2[1]) * SCALE
                        h = max(0.5, top_y - bottom_y)
                    elif (flags & ML_BLOCKING) or 0 < gap < MIN_GAP:
                        # Impassable line, or a window/overhang too tight to
                        # walk through: a real wall, full height. gap <= 0 is
                        # NOT blocked -- that is a closed door sector or a
                        # lowered lift, and this engine has no moving sectors,
                        # so sealing them would wall off half of every map.
                        bottom_y = min(sec1[0], sec2[0]) * SCALE
                        top_y = max(sec1[1], sec2[1]) * SCALE
                        h = max(0.5, top_y - bottom_y)
                        raw_tex = sidedefs[s1_idx][4].rstrip(b'\x00').decode('ascii', errors='ignore').upper() or raw_tex
                    else:
                        h_diff = f_hi - f_lo
                        if h_diff < 1:
                            continue  # flat floor, fully open, no geometry
                        # The riser spans the floor step only, so the space
                        # above it stays walkable.
                        bottom_y = f_lo * SCALE
                        top_y = f_hi * SCALE
                        h = max(0.1, top_y - bottom_y)
                        is_step_up = h_diff <= STEP_LIMIT
                        is_ledge = not is_step_up
                        solid = False

                x1, z1 = round(p1[0] * SCALE, 2), round(-p1[1] * SCALE, 2)
                x2, z2 = round(p2[0] * SCALE, 2), round(-p2[1] * SCALE, 2)

                length = math.hypot(x2 - x1, z2 - z1)
                if length < 0.05: continue

                tex = 'tech_wall'
                if 'DOOR' in raw_tex or is_door: tex = 'door_blast'
                elif 'SW' in raw_tex or is_switch: tex = 'switch_off'
                elif 'METAL' in raw_tex or 'STEEL' in raw_tex or 'BRONZE' in raw_tex: tex = 'metal_grate'
                elif 'COMP' in raw_tex or 'PANEL' in raw_tex or 'TEK' in raw_tex: tex = 'mainframe'
                elif 'RUST' in raw_tex or 'WOOD' in raw_tex or 'RED' in raw_tex: tex = 'cyber_rust'
                elif 'CITY' in raw_tex or 'BRICK' in raw_tex or 'STONE' in raw_tex: tex = 'city_ruins'
                elif 'WARN' in raw_tex or 'HAZ' in raw_tex: tex = 'hazard'

                w = {
                    'p1': [x1, z1],
                    'p2': [x2, z2],
                    'bottomY': round(bottom_y, 2),
                    'topY': round(top_y, 2),
                    'h': round(h, 2),
                    'tex': tex,
                    'solid': solid
                }
                if is_door:
                    w['isDoor'] = True
                    w['doorId'] = f'door_{tag or idx}'
                    w['closed'] = True
                if is_switch:
                    w['isSwitch'] = True
                    w['switchId'] = 'sw_exit_game' if is_exit else f'sw_{tag or idx}'
                    if is_exit:
                        w['isExit'] = True
                if is_step_up:
                    # Free auto-climb in both directions.
                    w['stepUp'] = True
                elif is_ledge:
                    # Too tall to climb; the floor-height rule blocks it from
                    # below and lets the player walk off the top.
                    w['ledge'] = True
                    w['loFloor'] = round(bottom_y, 2)
                    w['hiFloor'] = round(top_y, 2)

                walls_json.append(w)

            player_spawn = {'pos': [0, 1.2, 0], 'rot': 0}
            for t in things_raw:
                if t[3] == 1:
                    world_x = round(t[0] * SCALE, 2)
                    world_z = round(-t[1] * SCALE, 2)
                    rot_rad = round((360 - t[2]) * math.pi / 180.0, 3)
                    
                    spawn_floor = poly_floor_at(world_x, world_z)
                    if spawn_floor is None:
                        spawn_floor = 0.0
                    
                    sx, sz = push_out_of_walls(world_x, world_z, walls_json)
                    if poly_floor_at(sx, sz) is None:
                        sx, sz = world_x, world_z
                    player_spawn = {'pos': [sx, spawn_floor + 1.5, sz], 'rot': rot_rad}
                    break

            entities_json = []
            nudged = 0
            for t in things_raw:
                tx, ty, angle, ttype, flags = t
                world_x = round(tx * SCALE, 2)
                world_z = round(-ty * SCALE, 2)
                rot_rad = round((360 - angle) * math.pi / 180.0, 3)

                nx, nz = push_out_of_walls(world_x, world_z, walls_json)
                if poly_floor_at(nx, nz) is not None:
                    if (nx, nz) != (world_x, world_z):
                        nudged += 1
                    world_x, world_z = nx, nz

                ent_floor = poly_floor_at(world_x, world_z)
                if ent_floor is None:
                    ent_floor = 0.0

                if ttype == 2005:
                    entities_json.append({'type': 'weapon', 'name': 'chainsaw', 'pos': [world_x, ent_floor + 0.5, world_z]})
                elif ttype in [2001, 82]:
                    entities_json.append({'type': 'weapon', 'name': 'shotgun', 'pos': [world_x, ent_floor + 0.5, world_z]})
                elif ttype in [2002, 2003, 2004, 2006]:
                    entities_json.append({'type': 'weapon', 'name': 'shotgun', 'pos': [world_x, ent_floor + 0.5, world_z]})
                elif ttype in [2007, 2048]:
                    entities_json.append({'type': 'ammo_bullets', 'amount': 20 if ttype == 2007 else 50, 'pos': [world_x, ent_floor + 0.5, world_z]})
                elif ttype in [2008, 2049]:
                    entities_json.append({'type': 'ammo_shells', 'amount': 8 if ttype == 2008 else 20, 'pos': [world_x, ent_floor + 0.5, world_z]})
                elif ttype in [2011, 2012, 2014, 2015]:
                    entities_json.append({'type': 'health_stim', 'amount': 15 if ttype == 2011 else 25, 'pos': [world_x, ent_floor + 0.5, world_z]})
                elif ttype in [2018, 2019]:
                    entities_json.append({'type': 'armor', 'amount': 50 if ttype == 2018 else 100, 'pos': [world_x, ent_floor + 0.5, world_z]})
                elif ttype == 2035:
                    entities_json.append({'type': 'barrel', 'pos': [world_x, ent_floor, world_z]})
                elif ttype in [3004, 9, 65, 84]:
                    entities_json.append({'type': 'soldier', 'enemyType': ttype, 'pos': [world_x, ent_floor, world_z], 'rot': rot_rad})
                elif ttype in [3001, 3002, 58, 3003, 3005, 64, 66, 67, 68, 69, 16, 7]:
                    entities_json.append({'type': 'monster', 'enemyType': ttype, 'pos': [world_x, ent_floor, world_z], 'rot': rot_rad})

            map_data = {
                "name": f"{pack_title} - Level {map_num} ({map_name})",
                "skyColor": 526613,
                "fogColor": 724248,
                "fogDensity": 0.015,
                "ambientLight": 4478310,
                "sunLight": {"color": 7838173, "intensity": 1.0, "pos": [30, 80, -30]},
                "playerSpawn": player_spawn,
                "sectors": sectors_json,
                "walls": walls_json,
                "entities": entities_json
            }

            json_filename = f"json{map_num}.json"
            json_file_path = os.path.join(out_dir, json_filename)
            with open(json_file_path, 'w', encoding='utf-8') as out_f:
                json.dump(map_data, out_f, separators=(',', ':'))

            manifest.append({
                "id": f"json{map_num}",
                "name": map_data["name"],
                "file": f"levelPacks/{pack_id}/{json_filename}",
                "sectors": len(sectors_json),
                "walls": len(walls_json),
                "entities": len(entities_json)
            })

            print(f"[{pack_id}] Converted Level {map_num} ({map_name}) -> {json_file_path}"
                  f"  [{poly_fallbacks} unclosed chain(s), "
                  f"{len(rect_fallbacks)} rectangle fallback(s), "
                  f"{nudged} thing(s) nudged out of walls]")

    manifest_path = os.path.join(out_dir, 'manifest.json')
    with open(manifest_path, 'w', encoding='utf-8') as mf:
        json.dump(manifest, mf, indent=2)

    print(f"--> [{pack_id}] Manifest created with {len(manifest)} levels.")
    return {
        "id": pack_id,
        "name": pack_title,
        "manifest": f"levelPacks/{pack_id}/manifest.json",
        "levelCount": len(manifest)
    }

def convert_all():
    packs = [
        ('pack1.wad', 'pack1', 'Pack 1 (Doom II)'),
        ('pack2.wad', 'pack2', 'Pack 2 (Ultimate Doom)'),
        ('pack3.wad', 'pack3', 'Pack 3 (Final Doom TNT)'),
        ('pack4.WAD', 'pack4', 'Pack 4 (Final Doom Plutonia)'),
        ('pack5.WAD', 'pack5', 'Pack 5 (Master Levels)'),
        ('pack6.WAD', 'pack6', 'Pack 6 (Custom Campaign)'),
        ('DV.wad', 'dv', 'Deus Vult Megamap')
    ]

    master_manifest = []
    for wad, pack_id, pack_title in packs:
        if os.path.exists(wad):
            res = convert_wad(wad, pack_id, pack_title)
            if res:
                master_manifest.append(res)

    master_path = os.path.join('levelPacks', 'packs.json')
    with open(master_path, 'w', encoding='utf-8') as f:
        json.dump(master_manifest, f, indent=2)

    print(f"\nALL WADs CONVERTED SUCCESSFUL! Master manifest saved to {master_path}")
    print("Sectors now carry real boundary polygons; the bounding rectangle is")
    print("kept only as a fallback for consumers that predate `polys`.")
    print("Run  python patch_exit_switches.py  then  node tests/check-exits.js")
    print("to place a reachable exit on every level and prove it.")

if __name__ == '__main__':
    convert_all()
