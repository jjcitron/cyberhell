import struct
import math
import json

def convert_dv_map05():
    wad_path = 'DV.wad'
    with open(wad_path, 'rb') as f:
        header = f.read(12)
        _, numlumps, infotableofs = struct.unpack('<4sII', header)
        f.seek(infotableofs)
        lumps = [struct.unpack('<II8s', f.read(16)) for _ in range(numlumps)]
        lumps = [(name.rstrip(b'\x00').decode('ascii', errors='ignore'), pos, size) for pos, size, name in lumps]

    map05_idx = [i for i, l in enumerate(lumps) if l[0] == 'MAP05'][0]
    
    map_lumps = {}
    for j in range(map05_idx + 1, min(map05_idx + 12, len(lumps))):
        sub_name, sub_pos, sub_size = lumps[j]
        if sub_name.startswith('MAP') or sub_name.startswith('E'):
            break
        map_lumps[sub_name] = (sub_pos, sub_size)

    with open(wad_path, 'rb') as f:
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

    SCALE = 0.05

    # 1. Process Sectors
    # Group vertices by sector to calculate bounding boxes
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

    sectors_json = []
    for sec_id, sec in enumerate(sectors_raw):
        floor_h, ceil_h, floor_tex, ceil_tex, light, special, tag = sec
        f_tex_str = floor_tex.rstrip(b'\x00').decode('ascii', errors='ignore').upper()
        c_tex_str = ceil_tex.rstrip(b'\x00').decode('ascii', errors='ignore').upper()

        is_sky = ('F_SKY' in c_tex_str or 'SKY' in c_tex_str)

        # Floor texture mapping
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
            ys = [-v[1] * SCALE for v in sv] # invert Y to Z
            min_x, max_x = round(min(xs), 2), round(max(xs), 2)
            min_z, max_z = round(min(ys), 2), round(max(ys), 2)
            w = round(max_x - min_x, 2)
            d = round(max_z - min_z, 2)
            cx = round((min_x + max_x) / 2, 2)
            cz = round((min_z + max_z) / 2, 2)
        else:
            w, d, cx, cz = 20, 20, 0, 0

        sector_obj = {
            'id': f'sec_{sec_id}',
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
        }
        sectors_json.append(sector_obj)

    # 2. Process Walls
    walls_json = []
    for idx, ld in enumerate(linedefs):
        v1_idx, v2_idx, flags, special, tag, s1_idx, s2_idx = ld
        p1 = verts[v1_idx]
        p2 = verts[v2_idx]
        
        is_single = (s2_idx == 65535)
        is_door = special in [1, 26, 27, 28, 31, 32, 117, 118]
        is_switch = special in [9, 11, 14, 18, 42, 63, 103]

        if s1_idx >= len(sidedefs):
            continue

        sec1_id = sidedefs[s1_idx][5]
        sec1 = sectors_raw[sec1_id]
        
        if is_single:
            h = max(64, sec1[1] - sec1[0]) * SCALE
            raw_tex = sidedefs[s1_idx][4].rstrip(b'\x00').decode('ascii', errors='ignore').upper()
        else:
            if s2_idx >= len(sidedefs):
                continue
            sec2_id = sidedefs[s2_idx][5]
            sec2 = sectors_raw[sec2_id]
            h_diff = abs(sec1[0] - sec2[0])
            if h_diff < 32 and not is_door and not is_switch:
                continue
            h = max(48, h_diff) * SCALE
            raw_tex = sidedefs[s1_idx][3].rstrip(b'\x00').decode('ascii', errors='ignore').upper()

        x1, z1 = round(p1[0] * SCALE, 2), round(-p1[1] * SCALE, 2)
        x2, z2 = round(p2[0] * SCALE, 2), round(-p2[1] * SCALE, 2)

        length = math.hypot(x2 - x1, z2 - z1)
        if length < 0.3 and not is_door and not is_switch:
            continue

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
            'h': round(h, 2),
            'tex': tex,
            'solid': True
        }
        if is_door:
            w['isDoor'] = True
            w['doorId'] = f'door_{tag or idx}'
            w['closed'] = True
        if is_switch:
            w['isSwitch'] = True
            w['switchId'] = f'sw_{tag or idx}'

        walls_json.append(w)

    # 3. Process Entities & Player Spawn
    player_spawn = {'pos': [73.6, 1.2, 272.0], 'rot': 0.785}
    entities_json = []

    for t in things_raw:
        tx, ty, angle, ttype, flags = t
        world_x = round(tx * SCALE, 2)
        world_z = round(-ty * SCALE, 2)
        rot_rad = round((360 - angle) * math.pi / 180.0, 3)

        if ttype == 1: # Player 1 start
            player_spawn = {
                'pos': [world_x, 1.2, world_z],
                'rot': rot_rad
            }
        # Weapons
        elif ttype == 2005:
            entities_json.append({'type': 'weapon', 'name': 'chainsaw', 'pos': [world_x, 0.5, world_z]})
        elif ttype in [2001, 82]:
            entities_json.append({'type': 'weapon', 'name': 'shotgun', 'pos': [world_x, 0.5, world_z]})
        elif ttype in [2002, 2003, 2004, 2006]:
            entities_json.append({'type': 'weapon', 'name': 'shotgun', 'pos': [world_x, 0.5, world_z]}) # maps to shotgun/available weapon
        # Ammo
        elif ttype in [2007, 2048]:
            entities_json.append({'type': 'ammo_bullets', 'amount': 20 if ttype == 2007 else 50, 'pos': [world_x, 0.5, world_z]})
        elif ttype in [2008, 2049]:
            entities_json.append({'type': 'ammo_shells', 'amount': 8 if ttype == 2008 else 20, 'pos': [world_x, 0.5, world_z]})
        # Health & Armor
        elif ttype in [2011, 2012, 2014, 2015]:
            entities_json.append({'type': 'health_stim', 'amount': 15 if ttype == 2011 else 25, 'pos': [world_x, 0.5, world_z]})
        elif ttype in [2018, 2019]:
            entities_json.append({'type': 'armor', 'amount': 50 if ttype == 2018 else 100, 'pos': [world_x, 0.5, world_z]})
        # Barrels
        elif ttype == 2035:
            entities_json.append({'type': 'barrel', 'pos': [world_x, 0.0, world_z]})
        # Soldiers
        elif ttype in [3004, 9, 65]:
            entities_json.append({'type': 'soldier', 'pos': [world_x, 0.0, world_z], 'rot': rot_rad})
        # Monsters
        elif ttype in [3001, 3002, 58, 3003, 3005, 64, 66, 67, 68, 69, 16, 7]:
            entities_json.append({'type': 'monster', 'pos': [world_x, 0.0, world_z], 'rot': rot_rad})

    map_data = {
        "name": "Deus Vult (MAP05 - The Complete Megamap)",
        "skyColor": 526613,
        "fogColor": 724248,
        "fogDensity": 0.008,
        "ambientLight": 4478310,
        "sunLight": {
            "color": 7838173,
            "intensity": 1.0,
            "pos": [50, 120, -50]
        },
        "playerSpawn": player_spawn,
        "sectors": sectors_json,
        "walls": walls_json,
        "entities": entities_json
    }

    out_file = 'deus_vult.json'
    with open(out_file, 'w', encoding='utf-8') as out:
        json.dump(map_data, out, indent=2)

    print(f'Successfully exported {out_file} with {len(sectors_json)} sectors, {len(walls_json)} walls, {len(entities_json)} entities.')

if __name__ == '__main__':
    convert_dv_map05()
