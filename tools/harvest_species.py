# -*- coding: utf-8 -*-
"""全球物种库采集:GBIF 分类主干 + 真实观测记录 → 带完整分类阶元的物种数据库

不靠模型「想」物种,全部来自 GBIF 真实观测记录的统计——每条都有 GBIF key、
完整分类阶元(界门纲目科属种)、IUCN 等级、真实观测坐标中位数、记录数(代表性权重)。

三阶段(各自可断点续跑):
  python tools/harvest_species.py harvest   # 采集候选:国家×纲 的高记录物种 + 海域网格
  python tools/harvest_species.py enrich    # 富集:分类阶元 + IUCN + 观测坐标中位数
  python tools/harvest_species.py zh        # 中文名:Wikidata 批量(200个/次)
  python tools/harvest_species.py stats     # 统计体检

产出 research/bio/species_db.json:
  { "<gbifKey>": {sci, k,p,c,o,f,g, zh,en, iucn, lat,lon, n, areas:[...]} }
"""
import os, sys, json, time, subprocess, argparse, statistics
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'research' / 'bio' / 'species_db.json'
RAW = ROOT / 'research' / 'bio' / '_harvest_raw.json'
OUT.parent.mkdir(parents=True, exist_ok=True)

# —— 采集网格 ——
# 国家:覆盖七大生物地理界 + 各大生物群系(热带雨林/沙漠/苔原/草原/高山/岛屿特有区)
COUNTRIES = {
    # 新北界
    'US': '美国', 'CA': '加拿大', 'MX': '墨西哥', 'GL': '格陵兰',
    # 新热带界
    'BR': '巴西', 'PE': '秘鲁', 'CO': '哥伦比亚', 'EC': '厄瓜多尔', 'AR': '阿根廷',
    'CL': '智利', 'CR': '哥斯达黎加', 'VE': '委内瑞拉', 'BO': '玻利维亚', 'PA': '巴拿马',
    # 古北界
    'CN': '中国', 'RU': '俄罗斯', 'JP': '日本', 'MN': '蒙古', 'KZ': '哈萨克斯坦',
    'GB': '英国', 'FR': '法国', 'DE': '德国', 'ES': '西班牙', 'IT': '意大利',
    'NO': '挪威', 'SE': '瑞典', 'FI': '芬兰', 'IS': '冰岛', 'PL': '波兰',
    'TR': '土耳其', 'IR': '伊朗', 'MA': '摩洛哥', 'EG': '埃及', 'SA': '沙特阿拉伯',
    # 埃塞俄比亚界
    'ZA': '南非', 'KE': '肯尼亚', 'TZ': '坦桑尼亚', 'CD': '刚果金', 'NG': '尼日利亚',
    'ET': '埃塞俄比亚', 'MG': '马达加斯加', 'NA': '纳米比亚', 'BW': '博茨瓦纳',
    'CM': '喀麦隆', 'GH': '加纳', 'UG': '乌干达', 'ZW': '津巴布韦',
    # 东洋界
    'IN': '印度', 'ID': '印度尼西亚', 'MY': '马来西亚', 'TH': '泰国', 'VN': '越南',
    'PH': '菲律宾', 'LK': '斯里兰卡', 'NP': '尼泊尔', 'MM': '缅甸', 'BD': '孟加拉国',
    # 澳新界
    'AU': '澳大利亚', 'NZ': '新西兰', 'PG': '巴布亚新几内亚', 'FJ': '斐济', 'NC': '新喀里多尼亚',
    # 南极界 + 岛屿
    'AQ': '南极洲', 'MU': '毛里求斯', 'SC': '塞舌尔', 'CU': '古巴', 'JM': '牙买加',
}

# 分类纲:强制覆盖各大类群,避免全是鸟和被子植物
CLASSES = [
    ('Mammalia', '哺乳纲'), ('Aves', '鸟纲'), ('Squamata', '有鳞目(蜥蜴蛇)'),
    ('Testudines', '龟鳖目'), ('Crocodylia', '鳄目'), ('Amphibia', '两栖纲'),
    ('Actinopterygii', '辐鳍鱼纲'), ('Chondrichthyes', '软骨鱼纲(鲨鳐)'),
    ('Insecta', '昆虫纲'), ('Arachnida', '蛛形纲'), ('Malacostraca', '软甲纲(虾蟹)'),
    ('Gastropoda', '腹足纲'), ('Bivalvia', '双壳纲'), ('Cephalopoda', '头足纲'),
    ('Anthozoa', '珊瑚纲'), ('Scyphozoa', '钵水母纲'), ('Echinoidea', '海胆纲'),
    ('Asteroidea', '海星纲'), ('Magnoliopsida', '木兰纲(双子叶)'), ('Liliopsida', '百合纲(单子叶)'),
    ('Pinopsida', '松柏纲'), ('Polypodiopsida', '真蕨纲'), ('Bryopsida', '真藓纲'),
    ('Agaricomycetes', '伞菌纲(蘑菇)'), ('Lecanoromycetes', '茶渍纲(地衣)'),
    ('Phaeophyceae', '褐藻纲(海带)'), ('Florideophyceae', '真红藻纲'),
]

# 海域网格(GBIF 无国家归属的海洋物种):[名称, 西, 南, 东, 北]
SEAS = [
    ['北太平洋', 140, 20, -130, 55], ['南太平洋', 160, -45, -80, -5],
    ['北大西洋', -70, 25, -10, 60], ['南大西洋', -50, -50, 15, -5],
    ['印度洋', 45, -40, 105, 20], ['北冰洋', -180, 66, 180, 88],
    ['南大洋', -180, -70, 180, -50], ['地中海', -5, 30, 36, 45],
    ['加勒比海', -88, 9, -60, 23], ['珊瑚三角区', 115, -12, 155, 8],
    ['红海与阿拉伯海', 32, 5, 78, 30], ['东亚陆架海', 105, 20, 145, 45],
]

TOP_PER_CELL = 22   # 每个「地区×纲」格子取记录数前 N 的物种
UA = 'CivilizationWeave-Bio/1.0 (github.com/peipei707; personal knowledge map)'


def curl_json(url, timeout=45, retries=2):
    for attempt in range(retries + 1):
        r = subprocess.run(['curl', '-sL', '--max-time', str(timeout), '-H', f'User-Agent: {UA}', url],
                           capture_output=True, timeout=timeout + 20)
        if r.returncode == 0 and r.stdout:
            try:
                return json.loads(r.stdout.decode('utf-8', 'replace'))
            except Exception:
                pass
        time.sleep(1.5 * (attempt + 1))
    return None


# GBIF 直连可达,用带连接池的会话:每次 curl 都要新建进程+重做 TLS 握手,
# 实测连 1KB 的响应都要 4 秒;换成 keep-alive 会话后同样三连查降到 1.95 秒。
import threading
_tl = threading.local()


def gbif_json(url, timeout=45, retries=2):
    try:
        import requests
    except ImportError:
        return curl_json(url, timeout, retries)
    s = getattr(_tl, 'sess', None)
    if s is None:
        import requests as rq
        s = rq.Session()
        s.headers.update({'User-Agent': UA})
        ad = rq.adapters.HTTPAdapter(pool_connections=4, pool_maxsize=4)
        s.mount('https://', ad)
        _tl.sess = s
    for attempt in range(retries + 1):
        try:
            r = s.get(url, timeout=timeout)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        time.sleep(1.0 * (attempt + 1))
    return None


def load(p, default):
    if p.exists():
        try:
            return json.loads(p.read_text(encoding='utf-8'))
        except Exception:
            pass
    return default


def save(p, obj):
    p.write_text(json.dumps(obj, ensure_ascii=False), encoding='utf-8')


# ———————————————————— 阶段一:采集候选 ————————————————————
def cmd_harvest(args):
    raw = load(RAW, {'cells': {}, 'species': {}})
    # 解析各纲的 GBIF key(一次,缓存)
    ckeys = raw.setdefault('classKeys', {})
    for name, zh in CLASSES:
        if name in ckeys:
            continue
        d = curl_json(f'https://api.gbif.org/v1/species/match?name={name}')
        k = (d or {}).get('usageKey') or (d or {}).get('classKey')
        if k:
            ckeys[name] = k
            print(f'  纲 {name}({zh}) → key {k}')
        time.sleep(0.2)
    save(RAW, raw)

    cells = []
    for cc, cn in COUNTRIES.items():
        for name, zh in CLASSES:
            if name in ckeys:
                cells.append(('country', cc, cn, name, zh))
    for sea in SEAS:
        for name, zh in CLASSES:
            if name in ckeys:
                cells.append(('sea', sea, sea[0], name, zh))

    print(f'采集格子共 {len(cells)} 个(已完成 {len(raw["cells"])})')
    done = 0
    for kind, area, area_zh, cname, czh in cells:
        cid = f'{area_zh}|{cname}'
        if cid in raw['cells']:
            continue
        ck = raw['classKeys'][cname]
        if kind == 'country':
            url = (f'https://api.gbif.org/v1/occurrence/search?country={area}&classKey={ck}'
                   f'&facet=speciesKey&facetLimit={TOP_PER_CELL}&limit=0&hasCoordinate=true'
                   f'&occurrenceStatus=PRESENT')
        else:
            w, s, e, n = area[1], area[2], area[3], area[4]
            poly = f'POLYGON(({w} {s},{e} {s},{e} {n},{w} {n},{w} {s}))'
            url = (f'https://api.gbif.org/v1/occurrence/search?geometry={poly.replace(" ", "%20")}'
                   f'&classKey={ck}&facet=speciesKey&facetLimit={TOP_PER_CELL}&limit=0'
                   f'&hasCoordinate=true&occurrenceStatus=PRESENT')
        d = curl_json(url, timeout=60)
        got = 0
        if d and d.get('facets'):
            for c in d['facets'][0].get('counts', []):
                key = c['name']
                rec = raw['species'].setdefault(key, {'n': 0, 'areas': [], 'class': cname})
                rec['n'] = max(rec['n'], c['count'])
                if area_zh not in rec['areas']:
                    rec['areas'].append(area_zh)
                got += 1
        raw['cells'][cid] = got
        done += 1
        if done % 20 == 0:
            save(RAW, raw)
            print(f'  {len(raw["cells"])}/{len(cells)} 格 | 累计物种 {len(raw["species"])}')
        time.sleep(0.25)
    save(RAW, raw)
    print(f'✓ 采集完成:{len(raw["cells"])} 格,候选物种 {len(raw["species"])} 个')


# ———————————————————— 阶段二:富集 ————————————————————
def cmd_enrich(args):
    raw = load(RAW, {'species': {}})
    db = load(OUT, {})
    # 按观测记录数降序富集:最具代表性的物种先落库,中途停也不亏
    keys = sorted((k for k in raw['species'] if k not in db),
                  key=lambda k: -raw['species'][k]['n'])
    if args.min_n:
        keys = [k for k in keys if raw['species'][k]['n'] >= args.min_n]
    if args.limit:
        keys = keys[:args.limit]
    print(f'待富集 {len(keys)} 个(已有 {len(db)}),并发 {args.workers}')

    def one(key):
        """单物种三连查:分类阶元 + IUCN + 观测坐标中位数。返回 (key, rec|None)"""
        sp = gbif_json(f'https://api.gbif.org/v1/species/{key}')
        if not sp or not sp.get('species'):
            return key, None
        rec = {
            'sci': sp.get('species') or sp.get('canonicalName'),
            'k': sp.get('kingdom'), 'p': sp.get('phylum'), 'c': sp.get('class'),
            'o': sp.get('order'), 'f': sp.get('family'), 'g': sp.get('genus'),
            'n': raw['species'][key]['n'], 'areas': raw['species'][key]['areas'],
        }
        iu = gbif_json(f'https://api.gbif.org/v1/species/{key}/iucnRedListCategory', timeout=30, retries=1)
        rec['iucn'] = (iu or {}).get('code')
        # 观测坐标中位数 = 真实分布中心(不是国家质心,也不怕离群的迷鸟记录)。
        # limit 是全局瓶颈:每条 occurrence 是完整记录,200 条约 500KB;80 条足够求稳健中位数。
        oc = gbif_json(f'https://api.gbif.org/v1/occurrence/search?speciesKey={key}'
                       f'&hasCoordinate=true&hasGeospatialIssue=false&limit=80', timeout=50, retries=1)
        pts = [(r['decimalLatitude'], r['decimalLongitude'])
               for r in (oc or {}).get('results', [])
               if r.get('decimalLatitude') is not None and r.get('decimalLongitude') is not None]
        if pts:
            rec['lat'] = round(statistics.median(p[0] for p in pts), 3)
            rec['lon'] = round(statistics.median(p[1] for p in pts), 3)
            rec['npts'] = len(pts)
        return key, rec

    from concurrent.futures import ThreadPoolExecutor
    ok = fail = done = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for key, rec in pool.map(one, keys):
            done += 1
            if rec:
                db[key] = rec
                ok += 1
            else:
                fail += 1
            if done % 100 == 0:
                save(OUT, db)   # 只在主线程落盘,并发安全
                rate = done / max(time.time() - t0, 1)
                eta = (len(keys) - done) / max(rate, 0.01) / 60
                print(f'  {done}/{len(keys)} | 成功 {ok} 失败 {fail} | {rate:.1f}个/秒 | 剩约 {eta:.0f} 分钟')
    save(OUT, db)
    print(f'✓ 富集完成:成功 {ok},失败 {fail},库内共 {len(db)}')


# ———————————————————— 补跑:缺失坐标 ————————————————————
def cmd_coords(args):
    """只补 lat/lon 缺失的。教训:enrich 用 10 并发各拉 500KB 观测响应会被 GBIF 限流,
    失败被静默吞掉(rec 照样入库,只是没坐标)。这里降并发 + 缩样本 + 失败显式计数。"""
    db = load(OUT, {})
    todo = [k for k, v in db.items() if v.get('lat') is None]
    if args.limit:
        todo = todo[:args.limit]
    print(f'待补坐标 {len(todo)} 个(库内 {len(db)}),并发 {args.workers}')

    def one(key):
        oc = gbif_json(f'https://api.gbif.org/v1/occurrence/search?speciesKey={key}'
                       f'&hasCoordinate=true&hasGeospatialIssue=false&limit=40',
                       timeout=60, retries=3)
        if not oc:
            return key, None
        pts = [(r['decimalLatitude'], r['decimalLongitude']) for r in oc.get('results', [])
               if r.get('decimalLatitude') is not None and r.get('decimalLongitude') is not None]
        if not pts:
            return key, 'empty'
        return key, (round(statistics.median(p[0] for p in pts), 3),
                     round(statistics.median(p[1] for p in pts), 3), len(pts))

    from concurrent.futures import ThreadPoolExecutor
    ok = netfail = empty = done = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for key, res in pool.map(one, todo):
            done += 1
            if res is None:
                netfail += 1
            elif res == 'empty':
                empty += 1
                db[key]['nocoord'] = True   # 确实没带坐标的记录,标记免得反复重试
            else:
                db[key]['lat'], db[key]['lon'], db[key]['npts'] = res
                ok += 1
            if done % 200 == 0:
                save(OUT, db)
                rate = done / max(time.time() - t0, 1)
                print(f'  {done}/{len(todo)} | 补上 {ok} 网络失败 {netfail} 真无坐标 {empty} | '
                      f'{rate:.1f}个/秒 | 剩约 {(len(todo)-done)/max(rate,0.01)/60:.0f} 分钟')
    save(OUT, db)
    print(f'✓ 补坐标完成:成功 {ok} | 网络失败 {netfail}(可再跑一次) | 真无坐标 {empty}')


# ———————————————————— 阶段三:中文名 ————————————————————
def cmd_zh(args):
    db = load(OUT, {})
    todo = [(k, v['sci']) for k, v in db.items() if v.get('sci') and not v.get('zh')]
    print(f'待查中文名 {len(todo)} 个')
    B = 150
    for i in range(0, len(todo), B):
        batch = todo[i:i + B]
        vals = ' '.join('"%s"' % s.replace('"', '') for _, s in batch)
        q = ('SELECT ?n ?zh ?en WHERE { VALUES ?n { %s } ?t wdt:P225 ?n. '
             'OPTIONAL{?t rdfs:label ?zh FILTER(LANG(?zh)="zh")} '
             'OPTIONAL{?t rdfs:label ?en FILTER(LANG(?en)="en")} }' % vals)
        r = subprocess.run(['curl', '-sL', '--max-time', '90', '-H', 'Accept: application/sparql-results+json',
                            '-H', f'User-Agent: {UA}', '--data-urlencode', f'query={q}',
                            'https://query.wikidata.org/sparql'], capture_output=True, timeout=120)
        got = 0
        if r.returncode == 0:
            try:
                res = json.loads(r.stdout.decode('utf-8', 'replace'))
                m = {}
                for b in res['results']['bindings']:
                    nm = b['n']['value']
                    m.setdefault(nm, {})
                    if 'zh' in b:
                        m[nm]['zh'] = b['zh']['value']
                    if 'en' in b:
                        m[nm]['en'] = b['en']['value']
                for key, sci in batch:
                    if sci in m:
                        db[key].update({kk: vv for kk, vv in m[sci].items() if vv})
                        got += 1
            except Exception as e:
                print('  解析失败:', str(e)[:60])
        save(OUT, db)
        print(f'  {min(i + B, len(todo))}/{len(todo)} | 本批命中 {got}')
        time.sleep(2)
    zh_n = sum(1 for v in db.values() if v.get('zh'))
    print(f'✓ 中文名完成:{zh_n}/{len(db)} 有中文名')


# ———————————————————— 体检 ————————————————————
def cmd_stats(args):
    db = load(OUT, {})
    import collections
    print(f'物种总数: {len(db)}')
    for field, label in [('k', '界'), ('c', '纲')]:
        cnt = collections.Counter(v.get(field) or '?' for v in db.values())
        print(f'{label}分布 (前12):', dict(cnt.most_common(12)))
    print('IUCN:', dict(collections.Counter(v.get('iucn') or '未评估' for v in db.values()).most_common()))
    print('有坐标:', sum(1 for v in db.values() if v.get('lat') is not None))
    print('有中文名:', sum(1 for v in db.values() if v.get('zh')))
    print('科数:', len({v.get('f') for v in db.values() if v.get('f')}),
          '| 属数:', len({v.get('g') for v in db.values() if v.get('g')}))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['harvest', 'enrich', 'coords', 'zh', 'stats'])
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--min-n', type=int, default=0, help='只富集观测记录数≥N的物种')
    ap.add_argument('--workers', type=int, default=10, help='并发数(GBIF 友好上限,别超12)')
    a = ap.parse_args()
    {'harvest': cmd_harvest, 'enrich': cmd_enrich, 'coords': cmd_coords,
     'zh': cmd_zh, 'stats': cmd_stats}[a.cmd](a)
