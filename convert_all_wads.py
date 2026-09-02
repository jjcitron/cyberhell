import os
import glob
import struct
import math
import json

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

            sectors_json = []
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

                sectors_json.append({
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
                })

            walls_json = []
            for idx, ld in enumerate(linedefs):
                v1_idx, v2_idx, flags, special, tag, s1_idx, s2_idx = ld
                p1 = verts[v1_idx]
                p2 = verts[v2_idx]
                
                is_single = (s2_idx == 65535)
                is_door = special in [1, 26, 27, 28, 31, 32, 117, 118]
                is_switch = special in [9, 11, 14, 18, 42, 63, 103]

                if s1_idx >= len(sidedefs): continue
                sec1_id = sidedefs[s1_idx][5]
                sec1 = sectors_raw[sec1_id]
                
                if is_single:
                    bottom_y = sec1[0] * SCALE
                    top_y = sec1[1] * SCALE
                    h = max(8.0, top_y - bottom_y)
                    raw_tex = sidedefs[s1_idx][4].rstrip(b'\x00').decode('ascii', errors='ignore').upper()
                else:
                    if s2_idx >= len(sidedefs): continue
                    sec2_id = sidedefs[s2_idx][5]
                    sec2 = sectors_raw[sec2_id]
                    bottom_y = min(sec1[0], sec2[0]) * SCALE
                    top_y = max(sec1[1], sec2[1]) * SCALE
                    h_diff = abs(sec1[0] - sec2[0])
                    if h_diff < 32 and not is_door and not is_switch: continue
                    h = max(8.0, top_y - bottom_y)
                    raw_tex = sidedefs[s1_idx][3].rstrip(b'\x00').decode('ascii', errors='ignore').upper()

                x1, z1 = round(p1[0] * SCALE, 2), round(-p1[1] * SCALE, 2)
                x2, z2 = round(p2[0] * SCALE, 2), round(-p2[1] * SCALE, 2)

                length = math.hypot(x2 - x1, z2 - z1)
                if length < 0.3 and not is_door and not is_switch: continue

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

            player_spawn = {'pos': [0, 1.2, 0], 'rot': 0}
            for t in things_raw:
                if t[3] == 1:
                    world_x = round(t[0] * SCALE, 2)
                    world_z = round(-t[1] * SCALE, 2)
                    rot_rad = round((360 - t[2]) * math.pi / 180.0, 3)
                    
                    spawn_floor = 0.0
                    for s in sectors_json:
                        if abs(world_x - s['x']) <= s['width']/2 and abs(world_z - s['z']) <= s['depth']/2:
                            spawn_floor = s['floorY']
                            break
                    
                    player_spawn = {'pos': [world_x, spawn_floor + 1.5, world_z], 'rot': rot_rad}
                    break

            entities_json = []
            for t in things_raw:
                tx, ty, angle, ttype, flags = t
                world_x = round(tx * SCALE, 2)
                world_z = round(-ty * SCALE, 2)
                rot_rad = round((360 - angle) * math.pi / 180.0, 3)

                ent_floor = 0.0
                for s in sectors_json:
                    if abs(world_x - s['x']) <= s['width']/2 and abs(world_z - s['z']) <= s['depth']/2:
                        ent_floor = s['floorY']
                        break

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
                json.dump(map_data, out_f, indent=2)

            manifest.append({
                "id": f"json{map_num}",
                "name": map_data["name"],
                "file": f"levelPacks/{pack_id}/{json_filename}",
                "sectors": len(sectors_json),
                "walls": len(walls_json),
                "entities": len(entities_json)
            })

            print(f"[{pack_id}] Converted Level {map_num} ({map_name}) -> {json_file_path}")

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

if __name__ == '__main__':
    convert_all()
