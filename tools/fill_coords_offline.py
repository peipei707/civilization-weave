# -*- coding: utf-8 -*-
"""离线坐标兜底:不请求任何网络,用采集阶段已记录的分布地区推坐标。

背景:GBIF 对逐物种拉观测记录会限流到 429,10 万级请求跑不完。但采集阶段
每个物种已经记下了它在哪些国家/海域进入「记录数前 22」,这本身就是可靠的分布信息。
用本项目已有的 2010 年疆界多边形算国家质心、用海域网格算海域中心,即可零请求补全。

精度分层(字段 csrc 标记来源,便于日后择优覆盖):
  occurrence — GBIF 真实观测中位数(最准,已有 5395 条)
  country    — 分布国质心(多国分布取面积加权平均,±数百公里)
  sea        — 海域网格中心

  python tools/fill_coords_offline.py
"""
import json, sys, statistics
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / 'research' / 'bio' / 'species_db.json'
BORDERS = ROOT / 'data' / 'borders_compact.json'
TERR_ZH = ROOT / 'data' / 'terr_zh.json'

sys.path.insert(0, str(ROOT / 'tools'))
from harvest_species import COUNTRIES, SEAS   # 复用同一份地区定义,避免两处漂移

# 采集用的中文国名 → 疆界数据里的英文政权名(对不上的手工桥接)
NAME_FIX = {
    '美国': 'United States of America', '刚果金': 'Democratic Republic of the Congo',
    '英国': 'United Kingdom', '南极洲': 'Antarctica', '新喀里多尼亚': 'New Caledonia',
    '巴布亚新几内亚': 'Papua New Guinea', '斯里兰卡': 'Sri Lanka', '格陵兰': 'Greenland',
    '哈萨克斯坦': 'Kazakhstan', '沙特阿拉伯': 'Saudi Arabia', '南非': 'South Africa',
    '新西兰': 'New Zealand', '马达加斯加': 'Madagascar', '印度尼西亚': 'Indonesia',
    '菲律宾': 'Philippines', '孟加拉国': 'Bangladesh', '毛里求斯': 'Mauritius',
    '塞舌尔': 'Seychelles', '牙买加': 'Jamaica', '津巴布韦': 'Zimbabwe',
    '博茨瓦纳': 'Botswana', '纳米比亚': 'Namibia', '埃塞俄比亚': 'Ethiopia',
    '喀麦隆': 'Cameroon', '乌干达': 'Uganda', '坦桑尼亚': 'Tanzania', '肯尼亚': 'Kenya',
}


def main():
    db = json.loads(DB.read_text(encoding='utf-8'))
    borders = json.loads(BORDERS.read_text(encoding='utf-8'))
    zh = json.loads(TERR_ZH.read_text(encoding='utf-8'))
    zh2en = {}
    for en, c in zh.items():
        zh2en.setdefault(c, en)

    # 取最近代快照(2010)的政权多边形算质心
    latest = borders['sets'][str(borders['years'][-1])]['f']
    by_name = {f['n']: f for f in latest if f.get('n')}

    def centroid(feat):
        best, blen = None, 0
        for poly in feat['g']:
            ring = poly[0]
            if ring and len(ring) > blen:
                blen, best = len(ring), ring
        if not best:
            return None
        n = len(best) // 2
        return (sum(best[i + 1] for i in range(0, len(best), 2)) / n,
                sum(best[i] for i in range(0, len(best), 2)) / n)

    # 疆界数据里名字对不上的(命名差异/不在 2010 快照里),直接给定质心
    HARD = {
        '美国': (39.8, -98.6), '坦桑尼亚': (-6.4, 34.9), '刚果金': (-2.9, 23.6),
        '新喀里多尼亚': (-21.3, 165.5), '南极洲': (-80.0, 0.0),
        '毛里求斯': (-20.3, 57.6), '塞舌尔': (-4.6, 55.5),
    }
    # 中文国名 → 质心
    cc = dict(HARD)
    miss = []
    for code, cn in COUNTRIES.items():
        if cn in cc:
            continue
        en = NAME_FIX.get(cn) or zh2en.get(cn) or cn
        f = by_name.get(en)
        if f:
            p = centroid(f)
            if p:
                cc[cn] = p
                continue
        miss.append(cn)
    print(f'国家质心解析:{len(cc)}/{len(COUNTRIES)}' + (f',未解析:{miss}' if miss else ''))

    sea_c = {s[0]: ((s[2] + s[4]) / 2,
                    ((s[1] + s[3]) / 2 if s[1] < s[3] else (s[1] + s[3] + 360) / 2 % 360 - 180))
             for s in SEAS}

    filled_c = filled_s = still = 0
    for v in db.values():
        if v.get('lat') is not None:
            v.setdefault('csrc', 'occurrence')
            continue
        areas = v.get('areas') or []
        pts = [cc[a] for a in areas if a in cc]
        if pts:
            v['lat'] = round(statistics.median(p[0] for p in pts), 3)
            v['lon'] = round(statistics.median(p[1] for p in pts), 3)
            v['csrc'] = 'country'
            filled_c += 1
            continue
        spts = [sea_c[a] for a in areas if a in sea_c]
        if spts:
            v['lat'] = round(statistics.median(p[0] for p in spts), 3)
            v['lon'] = round(statistics.median(p[1] for p in spts), 3)
            v['csrc'] = 'sea'
            filled_s += 1
            continue
        still += 1
    DB.write_text(json.dumps(db, ensure_ascii=False), encoding='utf-8')
    has = sum(1 for v in db.values() if v.get('lat') is not None)
    print(f'✓ 国家质心补 {filled_c} | 海域中心补 {filled_s} | 仍缺 {still}')
    print(f'  坐标覆盖:{has}/{len(db)} = {has/len(db)*100:.1f}%')
    import collections
    print('  来源分布:', dict(collections.Counter(v.get('csrc') for v in db.values())))


if __name__ == '__main__':
    main()
