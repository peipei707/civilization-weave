# -*- coding: utf-8 -*-
"""生态地理标记:给物种库每条打上「生物地理界 / 生物群系 / 生态区」

数据源:RESOLVE Ecoregions 2017(Dinerstein et al. 2017, BioScience 67(6):534-545),
UNEP-WCMC 官方 ArcGIS FeatureServer,CC BY 4.0,847 个陆地生态区 / 14 大生物群系 / 7 大生物地理界。

关键参数 maxAllowableOffset:ArcGIS 服务端抽稀。只用 geometryPrecision 是四舍五入坐标、
不减顶点(全量 185MB);加上 maxAllowableOffset=0.05 后全量只有 4MB——46 倍差距。

  python tools/tag_ecoregion.py fetch   # 下载并缓存生态区多边形 → data/ecoregions.json
  python tools/tag_ecoregion.py tag     # 给 species_db.json 每条打标(陆地按点在面内,海洋按采集海域)
"""
import sys, json, time, argparse
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
ECO = ROOT / 'data' / 'ecoregions.json'
DB = ROOT / 'research' / 'bio' / 'species_db.json'
BASE = ('https://data-gis.unep-wcmc.org/server/rest/services/Bio-geographicalRegions'
        '/Resolve_Ecoregions/FeatureServer/0/query')

REALM_ZH = {
    'Afrotropic': '埃塞俄比亚界(非洲热带界)', 'Antarctica': '南极界', 'Australasia': '澳新界',
    'Indomalayan': '东洋界', 'Nearctic': '新北界', 'Neotropic': '新热带界',
    'Oceania': '大洋洲界', 'Palearctic': '古北界', 'N/A': '未定',
}
BIOME_ZH = {
    'Tropical & Subtropical Moist Broadleaf Forests': '热带亚热带湿润阔叶林',
    'Tropical & Subtropical Dry Broadleaf Forests': '热带亚热带干燥阔叶林',
    'Tropical & Subtropical Coniferous Forests': '热带亚热带针叶林',
    'Temperate Broadleaf & Mixed Forests': '温带阔叶混交林',
    'Temperate Conifer Forests': '温带针叶林',
    'Boreal Forests/Taiga': '北方针叶林(泰加林)',
    'Tropical & Subtropical Grasslands, Savannas & Shrublands': '热带亚热带草原与稀树草原',
    'Temperate Grasslands, Savannas & Shrublands': '温带草原与灌丛',
    'Flooded Grasslands & Savannas': '泛滥草原与湿地草原',
    'Montane Grasslands & Shrublands': '高山草甸与灌丛',
    'Tundra': '苔原',
    'Mediterranean Forests, Woodlands & Scrub': '地中海型森林与硬叶灌丛',
    'Deserts & Xeric Shrublands': '荒漠与旱生灌丛',
    'Mangroves': '红树林',
    'N/A': '未定',
}


def cmd_fetch(args):
    import requests
    s = requests.Session()
    s.headers.update({'User-Agent': 'CivilizationWeave-Bio/1.0'})
    feats, offset, step = [], 0, 60
    while True:
        url = (f'{BASE}?where=1%3D1&outFields=eco_name,biome_name,realm,eco_id'
               f'&maxAllowableOffset=0.05&geometryPrecision=3'
               f'&resultRecordCount={step}&resultOffset={offset}&f=geojson')
        r = s.get(url, timeout=180)
        if r.status_code != 200:
            print(f'  offset {offset} HTTP {r.status_code},重试一次')
            time.sleep(3)
            r = s.get(url, timeout=180)
        j = r.json()
        got = j.get('features') or []
        if not got:
            break
        feats.extend(got)
        offset += step
        print(f'  已取 {len(feats)} 个生态区')
        if len(got) < step:
            break
        time.sleep(0.5)
    # 只留标记需要的:名称三元组 + 简化几何 + 包围盒(加速点在面内判定)
    out = []
    for f in feats:
        g = f.get('geometry') or {}
        p = f.get('properties') or {}
        polys = []
        if g.get('type') == 'Polygon':
            polys = [g['coordinates']]
        elif g.get('type') == 'MultiPolygon':
            polys = g['coordinates']
        if not polys:
            continue
        xs = [c[0] for poly in polys for ring in poly for c in ring]
        ys = [c[1] for poly in polys for ring in poly for c in ring]
        out.append({
            'eco': p.get('eco_name'), 'biome': p.get('biome_name'), 'realm': p.get('realm'),
            'bbox': [min(xs), min(ys), max(xs), max(ys)],
            'g': [[ring for ring in poly] for poly in polys],
        })
    ECO.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    mb = ECO.stat().st_size / 1048576
    print(f'✓ {ECO} — {len(out)} 个生态区,{mb:.1f} MB')


def pinp(lon, lat, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def cmd_tag(args):
    if not ECO.exists():
        print('✗ 先跑 fetch 下载生态区'); sys.exit(1)
    eco = json.loads(ECO.read_text(encoding='utf-8'))
    db = json.loads(DB.read_text(encoding='utf-8'))
    print(f'生态区 {len(eco)} 个 | 物种 {len(db)} 条')
    land = sea = miss = 0
    for i, (key, v) in enumerate(db.items(), 1):
        if v.get('realm'):
            continue
        lat, lon = v.get('lat'), v.get('lon')
        if lat is None:
            miss += 1
            continue
        hit = None
        for e in eco:
            b = e['bbox']
            if not (b[0] <= lon <= b[2] and b[1] <= lat <= b[3]):
                continue
            for poly in e['g']:
                if poly and pinp(lon, lat, poly[0]):
                    # 洞:落在内环里就不算命中
                    if any(pinp(lon, lat, h) for h in poly[1:]):
                        continue
                    hit = e
                    break
            if hit:
                break
        if hit:
            v['realm'] = REALM_ZH.get(hit['realm'], hit['realm'])
            v['biome'] = BIOME_ZH.get(hit['biome'], hit['biome'])
            v['eco'] = hit['eco']
            land += 1
        else:
            # 陆地生态区没覆盖 = 海洋/极地冰盖;用采集阶段记下的海域名兜底
            seas = [a for a in (v.get('areas') or [])
                    if any(w in a for w in ('洋', '海', '珊瑚', '陆架'))]
            v['realm'] = '海洋' if seas else '未定(近海或冰盖)'
            v['biome'] = seas[0] if seas else '未定'
            sea += 1
        if i % 2000 == 0:
            DB.write_text(json.dumps(db, ensure_ascii=False), encoding='utf-8')
            print(f'  {i}/{len(db)} | 陆地 {land} 海洋 {sea} 无坐标 {miss}')
    DB.write_text(json.dumps(db, ensure_ascii=False), encoding='utf-8')
    import collections
    print(f'✓ 标记完成:陆地 {land} | 海洋 {sea} | 无坐标 {miss}')
    print('生物地理界:', dict(collections.Counter(v.get('realm') for v in db.values()).most_common()))
    print('生物群系前10:', dict(collections.Counter(v.get('biome') for v in db.values()).most_common(10)))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['fetch', 'tag'])
    a = ap.parse_args()
    {'fetch': cmd_fetch, 'tag': cmd_tag}[a.cmd](a)
