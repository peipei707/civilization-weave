# -*- coding: utf-8 -*-
"""实时天气格点采集:Open-Meteo → 紧凑格点 JSON(可直接喂给 3D 地球做温度场/风场)

数据源:Open-Meteo(api.open-meteo.com),免 API key、CORS 全开(`access-control-allow-origin: *`)、
非商用免费。底层是 ECMWF IFS + DWD ICON + NOAA GFS 等多模式融合,分辨率最细到 1~2km。

**架构结论(实测得出,别推翻)**:
- 单点查询适合运行时直接在浏览器里调(点一个地方看它的实时天气),CORS 允许、无需密钥。
- **全球格点不能每个访客都拉**:免费额度是分钟/小时/天三级限流,一次 1000 点的请求会按点数计费,
  几千点的全球格点每人一遍会瞬间打爆额度 → 必须**预烘**(GitHub Actions 定时跑本脚本),
  产物随站点分发,访客零 API 调用。
- GET 只能带约 400 点(再多 URL 超长报 414),**POST 可到 1000 点/次**(超过报错明示上限)。

用法:
  python tools/fetch_weather.py            # 4°格点全球快照
  python tools/fetch_weather.py --step 2   # 2°格点(更细,约4倍请求)
  python tools/fetch_weather.py --cities   # 另出主要城市点位天气

产出 data/weather_grid.json:
  {ts, step, lat0, lon0, nlat, nlon, vars:{t2m:[...], ws:[...], wd:[...], cc:[...], pr:[...]}}
  数组按 行优先(纬度从北到南 × 经度从西到东)展平,缺测为 null。
"""
import json, sys, time, argparse
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'data' / 'weather_grid.json'
CITY_OUT = ROOT / 'data' / 'weather_cities.json'
API = 'https://api.open-meteo.com/v1/forecast'
MAX_PER_REQ = 1000          # 实测上限,超过服务端直接报 "Only up to 1000 locations"
PAUSE = 12                  # 请求间隔:避开分钟级限流(实测连发大批量会被拒)

FIELDS = ['temperature_2m', 'wind_speed_10m', 'wind_direction_10m',
          'cloud_cover', 'precipitation', 'relative_humidity_2m']
SHORT = {'temperature_2m': 't2m', 'wind_speed_10m': 'ws', 'wind_direction_10m': 'wd',
         'cloud_cover': 'cc', 'precipitation': 'pr', 'relative_humidity_2m': 'rh'}

# 主要城市(经纬度),给「城市天气标签」用;覆盖各大洲人口/知名度靠前的点
CITIES = [
    ('北京', 39.90, 116.41), ('上海', 31.23, 121.47), ('香港', 22.32, 114.17),
    ('东京', 35.68, 139.69), ('首尔', 37.57, 126.98), ('新加坡', 1.35, 103.82),
    ('曼谷', 13.76, 100.50), ('雅加达', -6.21, 106.85), ('马尼拉', 14.60, 120.98),
    ('新德里', 28.61, 77.21), ('孟买', 19.08, 72.88), ('达卡', 23.81, 90.41),
    ('卡拉奇', 24.86, 67.01), ('德黑兰', 35.69, 51.39), ('迪拜', 25.20, 55.27),
    ('伊斯坦布尔', 41.01, 28.98), ('莫斯科', 55.76, 37.62), ('伦敦', 51.51, -0.13),
    ('巴黎', 48.86, 2.35), ('柏林', 52.52, 13.41), ('罗马', 41.90, 12.50),
    ('马德里', 40.42, -3.70), ('斯德哥尔摩', 59.33, 18.07), ('雷克雅未克', 64.15, -21.94),
    ('开罗', 30.04, 31.24), ('拉各斯', 6.52, 3.38), ('内罗毕', -1.29, 36.82),
    ('约翰内斯堡', -26.20, 28.05), ('开普敦', -33.92, 18.42), ('金沙萨', -4.44, 15.27),
    ('纽约', 40.71, -74.01), ('洛杉矶', 34.05, -118.24), ('芝加哥', 41.88, -87.63),
    ('墨西哥城', 19.43, -99.13), ('多伦多', 43.65, -79.38), ('温哥华', 49.28, -123.12),
    ('圣保罗', -23.55, -46.63), ('布宜诺斯艾利斯', -34.60, -58.38), ('利马', -12.05, -77.04),
    ('波哥大', 4.71, -74.07), ('圣地亚哥', -33.45, -70.67),
    ('悉尼', -33.87, 151.21), ('墨尔本', -37.81, 144.96), ('奥克兰', -36.85, 174.76),
    ('火奴鲁鲁', 21.31, -157.86), ('安克雷奇', 61.22, -149.90),
    ('乌兰巴托', 47.89, 106.91), ('拉萨', 29.65, 91.14), ('加德满都', 27.72, 85.32),
    ('麦加', 21.39, 39.86), ('耶路撒冷', 31.78, 35.22), ('雅典', 37.98, 23.73),
    ('麦克默多站', -77.85, 166.67), ('朗伊尔城', 78.22, 15.65), ('雅库茨克', 62.03, 129.68),
    ('廷巴克图', 16.77, -3.01), ('乌斯怀亚', -54.80, -68.30), ('复活节岛', -27.11, -109.35),
]


def post_batch(lats, lons, session):
    body = {'latitude': lats, 'longitude': lons, 'current': FIELDS}
    for attempt in range(4):
        try:
            r = session.post(API, json=body, timeout=90)
            if r.status_code == 200:
                return r.json()
            reason = ''
            try:
                reason = r.json().get('reason', '')
            except Exception:
                reason = r.text[:120]
            print(f'    HTTP {r.status_code}: {reason}')
            # 限流就多等一会儿再试(免费额度是分钟/小时/天三级)
            time.sleep(65 if 'limit' in reason.lower() else 8 * (attempt + 1))
        except Exception as e:
            print(f'    异常 {type(e).__name__},重试')
            time.sleep(10 * (attempt + 1))
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--step', type=float, default=4.0, help='格点间隔(度)')
    ap.add_argument('--latmax', type=float, default=80.0, help='纬度上下限(极区模式数据稀疏)')
    ap.add_argument('--cities', action='store_true', help='另出城市点位天气')
    args = ap.parse_args()

    import requests
    s = requests.Session()
    s.headers.update({'User-Agent': 'CivilizationWeave-Weather/1.0 (github.com/peipei707)'})

    if args.cities:
        print(f'城市天气:{len(CITIES)} 个')
        d = post_batch([c[1] for c in CITIES], [c[2] for c in CITIES], s)
        if not d:
            print('✗ 城市天气获取失败'); sys.exit(1)
        arr = d if isinstance(d, list) else [d]
        out = []
        for (name, la, lo), rec in zip(CITIES, arr):
            c = rec.get('current') or {}
            out.append({'n': name, 'lat': la, 'lon': lo,
                        **{SHORT[f]: c.get(f) for f in FIELDS}})
        stamp = (arr[0].get('current') or {}).get('time')
        CITY_OUT.write_text(json.dumps({'ts': stamp, 'cities': out}, ensure_ascii=False),
                            encoding='utf-8')
        print(f'✓ {CITY_OUT} — {len(out)} 城,数据时刻 {stamp}')
        return

    # —— 全球格点 ——
    step = args.step
    lats_axis = [round(args.latmax - i * step, 3)
                 for i in range(int(args.latmax * 2 / step) + 1)]
    lons_axis = [round(-180 + j * step, 3) for j in range(int(360 / step))]
    pts = [(la, lo) for la in lats_axis for lo in lons_axis]
    nlat, nlon = len(lats_axis), len(lons_axis)
    print(f'格点 {nlat}×{nlon} = {len(pts)} 点,{step}° 间隔')
    print(f'需 {(len(pts) + MAX_PER_REQ - 1)//MAX_PER_REQ} 次请求,间隔 {PAUSE} 秒(避开限流)')

    vals = {SHORT[f]: [None] * len(pts) for f in FIELDS}
    stamp = None
    for i in range(0, len(pts), MAX_PER_REQ):
        chunk = pts[i:i + MAX_PER_REQ]
        d = post_batch([p[0] for p in chunk], [p[1] for p in chunk], s)
        if not d:
            print(f'  批 {i} 失败,该批留空')
            continue
        arr = d if isinstance(d, list) else [d]
        for k, rec in enumerate(arr):
            c = rec.get('current') or {}
            stamp = stamp or c.get('time')
            for f in FIELDS:
                vals[SHORT[f]][i + k] = c.get(f)
        got = sum(1 for v in vals['t2m'][i:i + len(chunk)] if v is not None)
        print(f'  {min(i+MAX_PER_REQ, len(pts))}/{len(pts)} | 本批有效 {got}/{len(chunk)}')
        if i + MAX_PER_REQ < len(pts):
            time.sleep(PAUSE)

    OUT.write_text(json.dumps({
        'ts': stamp, 'src': 'Open-Meteo (ECMWF IFS / DWD ICON / NOAA GFS 融合)',
        'step': step, 'lat0': lats_axis[0], 'lon0': lons_axis[0],
        'nlat': nlat, 'nlon': nlon, 'vars': vals,
    }, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    ok = sum(1 for v in vals['t2m'] if v is not None)
    kb = OUT.stat().st_size / 1024
    ts_list = [v for v in vals['t2m'] if v is not None]
    print(f'✓ {OUT} — {ok}/{len(pts)} 有效,{kb:.0f} KB,数据时刻 {stamp}')
    if ts_list:
        print(f'  气温范围 {min(ts_list):.1f} ~ {max(ts_list):.1f} °C')


if __name__ == '__main__':
    main()
