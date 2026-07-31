# -*- coding: utf-8 -*-
"""生物图标素材管线:物种清单 → 照片抓取 → AI 抠图 → 透明 PNG + 署名清单

用法:
  python tools/fetch_bio_img.py                    # 跑全量(断点续传)
  python tools/fetch_bio_img.py --limit 10         # 只跑前 10 个(试水)
  python tools/fetch_bio_img.py --only tiger,panda # 只跑指定 id
  python tools/fetch_bio_img.py --silhouette       # 额外抓 PhyloPic 剪影

输入:research/bio/species_draft.json  [{id, zh, sci, group, ...}]
输出:data/bio_img/<id>.png            透明 PNG(已裁边、长边 512)
      data/bio_img/sil_<id>.png        PhyloPic 剪影(可选)
      data/bio_credits.json            {id: {src, url, author, license, sci}}

图源优先级:iNaturalist(按许可择优) → Wikimedia Commons 首图
许可择优:cc0 > cc-by > cc-by-sa > cc-by-nc > 其它(全部记录在案,便于事后筛)
"""
import os, sys, json, time, argparse, subprocess, io, hashlib
from pathlib import Path

# Windows 控制台默认 GBK,打印 ✓/中文会抛 UnicodeEncodeError 中断整轮
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
SPECIES = ROOT / 'research' / 'bio' / 'species_draft.json'
OUTDIR = ROOT / 'data' / 'bio_img'
CREDITS = ROOT / 'data' / 'bio_credits.json'
OUTDIR.mkdir(parents=True, exist_ok=True)
os.environ.setdefault('U2NET_HOME', str(ROOT / 'data' / '.rembg_models'))

# 系统代理(大陆直连维基不通;iNaturalist/PhyloPic 实测可直连)
PROXY = None
try:
    out = subprocess.run(['reg', 'query',
        r'HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings', '/v', 'ProxyServer'],
        capture_output=True, text=True, timeout=10).stdout
    for line in out.splitlines():
        if 'ProxyServer' in line:
            PROXY = 'http://' + line.split()[-1].replace('http://', '')
except Exception:
    pass

LICENSE_RANK = {'cc0': 0, 'cc-by': 1, 'cc-by-sa': 2, 'cc-by-nc': 3, 'cc-by-nc-sa': 4, 'cc-by-nd': 5}


def curl(url, binary=False, use_proxy=False, timeout=40):
    """走 curl:Python requests 不认系统代理,且 curl 重试更稳。"""
    args = ['curl', '-sL', '--max-time', str(timeout),
            '-H', 'User-Agent: CivilizationWeave-Bio/1.0 (github.com/peipei707)']
    if use_proxy and PROXY:
        args += ['--proxy', PROXY]
    args.append(url)
    r = subprocess.run(args, capture_output=True, timeout=timeout + 15)
    if r.returncode != 0:
        return None
    return r.stdout if binary else r.stdout.decode('utf-8', 'replace')


def pick_inat(sci):
    """iNaturalist:按学名查物种 → 在 taxon_photos 里挑许可最优的一张。
    **必须校验学名完全一致**:iNat 的 q= 是模糊搜索且按观测数排序,
    查 Bison bison 会把茅香草(Anthoxanthum odoratum)排在第一位——不校验就张冠李戴。
    同义名(iNat 把野牛记作 Bos bison)对不上就返回 None,交给维基按精确条目名兜底。"""
    j = curl('https://api.inaturalist.org/v1/taxa?rank=species&per_page=8&q=' + sci.replace(' ', '%20'))
    if not j:
        return None
    try:
        d = json.loads(j)
    except Exception:
        return None
    want = sci.lower().strip()
    hit = None
    for r in d.get('results', []):
        names = [(r.get('name') or '').lower()]
        names += [(s or '').lower() for s in (r.get('synonyms') or [])]
        if want in names or (r.get('matched_term') or '').lower() == want:
            hit = r
            break
    if not hit:
        return None
    t = hit
    cands = []
    for tp in (t.get('taxon_photos') or [])[:12]:
        p = tp.get('photo') or {}
        url = p.get('large_url') or p.get('medium_url')
        if not url:
            continue
        lic = (p.get('license_code') or 'unknown').lower()
        cands.append((LICENSE_RANK.get(lic, 9), url, lic, p.get('attribution', '')))
    dp = t.get('default_photo') or {}
    if dp.get('medium_url'):
        lic = (dp.get('license_code') or 'unknown').lower()
        cands.append((LICENSE_RANK.get(lic, 9), dp.get('large_url') or dp['medium_url'], lic, dp.get('attribution', '')))
    if not cands:
        return None
    cands.sort(key=lambda x: x[0])
    rank, url, lic, attr = cands[0]
    return {'src': 'iNaturalist', 'url': url, 'license': lic, 'author': attr, 'matched': t.get('name')}


def pick_wiki(sci):
    """Wikimedia:英文维基条目首图(通常是该物种的代表照)。"""
    api = ('https://en.wikipedia.org/w/api.php?action=query&format=json&prop=pageimages'
           '&piprop=original&titles=' + sci.replace(' ', '%20'))
    j = curl(api, use_proxy=True)
    if not j:
        return None
    try:
        pages = json.loads(j)['query']['pages']
    except Exception:
        return None
    for p in pages.values():
        orig = (p.get('original') or {}).get('source')
        if orig:
            return {'src': 'Wikipedia', 'url': orig, 'license': 'see-commons',
                    'author': 'Wikimedia Commons contributors', 'matched': p.get('title')}
    return None


def gbif_keys(sci):
    """GBIF 学名匹配 → 返回 [种key, 属key, 科key](逐级兜底用)。"""
    j = curl('https://api.gbif.org/v1/species/match?name=' + sci.replace(' ', '%20'))
    if not j:
        return []
    try:
        d = json.loads(j)
    except Exception:
        return []
    return [k for k in (d.get('usageKey'), d.get('genusKey'), d.get('familyKey')) if k]


def phylopic(sci):
    """PhyloPic 剪影(天生透明、CC0 为主)。
    走 GBIF 桥接而非模糊搜索:filter_name 会把 Panthera tigris 匹配成雪豹/古豹。
    链路:GBIF match → resolve/gbif.org/species/<key> 重定向到节点 → images?filter_node。
    种级无剪影时逐级退到属/科(对植物、昆虫尤其常见)。"""
    for level, key in enumerate(gbif_keys(sci)):
        eff = curl_effective_url(f'https://api.phylopic.org/resolve/gbif.org/species/{key}')
        if not eff or '/nodes/' not in eff:
            continue
        node = eff.split('/nodes/')[1].split('?')[0]
        build = eff.split('build=')[1].split('&')[0] if 'build=' in eff else ''
        j = curl(f'https://api.phylopic.org/images?build={build}&page=0&embed_items=true&filter_node={node}')
        if not j:
            continue
        try:
            items = (json.loads(j).get('_embedded') or {}).get('items') or []
        except Exception:
            continue
        if not items:
            continue
        # 标题完全一致的优先(节点下可能混着亚种/近缘种)
        exact = [it for it in items
                 if ((it.get('_links') or {}).get('self') or {}).get('title', '').lower() == sci.lower()]
        it = (exact or items)[0]
        L = it.get('_links') or {}
        rasters = sorted((L.get('rasterFiles') or []),
                         key=lambda f: -int((f.get('sizes') or '0x0').split('x')[0]))
        if not rasters:
            continue
        return {'src': 'PhyloPic', 'url': rasters[0]['href'],
                'license': (L.get('license') or {}).get('href', ''),
                'author': it.get('attribution', ''),
                'matched': (L.get('self') or {}).get('title'),
                'level': ['species', 'genus', 'family'][min(level, 2)]}
    return None


def curl_effective_url(url, timeout=30):
    """只要最终重定向到的 URL(PhyloPic 的 resolve 端点靠 302 指向节点)。"""
    args = ['curl', '-sL', '-o', os.devnull, '-w', '%{url_effective}', '--max-time', str(timeout), url]
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout + 15)
    return r.stdout.strip() if r.returncode == 0 else None


def cutout(raw_bytes, dest, session, max_side=512, is_silhouette=False):
    """抠图 → 裁掉透明边 → 等比缩到长边 max_side → 存 PNG。剪影已透明,跳过抠图。"""
    from PIL import Image
    im = Image.open(io.BytesIO(raw_bytes))
    if is_silhouette:
        out = im.convert('RGBA')
    else:
        from rembg import remove
        out = remove(im.convert('RGB'), session=session)
    bbox = out.getbbox()
    if bbox:
        out = out.crop(bbox)
    w, h = out.size
    if max(w, h) > max_side:
        k = max_side / max(w, h)
        out = out.resize((max(1, int(w * k)), max(1, int(h * k))), Image.LANCZOS)
    out.save(dest, optimize=True)
    import numpy as np
    a = np.array(out)[:, :, 3]
    return out.size, float((a > 245).mean())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--only', default='')
    ap.add_argument('--silhouette', action='store_true', help='额外抓 PhyloPic 剪影')
    ap.add_argument('--model', default='isnet-general-use')
    args = ap.parse_args()

    if not SPECIES.exists():
        print('✗ 物种清单还没生成:', SPECIES)
        sys.exit(1)
    species = json.loads(SPECIES.read_text(encoding='utf-8'))
    if args.only:
        keep = set(args.only.split(','))
        species = [s for s in species if s['id'] in keep]
    if args.limit:
        species = species[:args.limit]
    print(f'代理: {PROXY or "直连"} | 物种 {len(species)} 个 | 模型 {args.model}')

    credits = json.loads(CREDITS.read_text(encoding='utf-8')) if CREDITS.exists() else {}
    from rembg import new_session
    session = new_session(args.model)

    ok = skip = fail = 0
    for i, sp in enumerate(species, 1):
        sid, sci = sp['id'], sp.get('sci', '')
        dest = OUTDIR / f'{sid}.png'
        tag = f"[{i}/{len(species)}] {sp.get('zh', sid)}"
        if dest.exists() and dest.stat().st_size > 2000:
            skip += 1
        else:
            # 双源依次尝试;主体占比过低 = 抠错了(风景照/远景),换下一个源
            best = None
            for getter in (pick_inat, pick_wiki):
                info = getter(sci)
                if not info:
                    continue
                raw = curl(info['url'], binary=True,
                           use_proxy=('wikimedia' in info['url'] or 'wikipedia' in info['url']), timeout=60)
                if not raw or len(raw) < 3000:
                    continue
                try:
                    size, opaque = cutout(raw, dest, session)
                except Exception:
                    continue
                info['size'], info['opaque'], info['sci'] = list(size), round(opaque, 3), sci
                if opaque >= 0.08:      # 主体够大,采用
                    best = info
                    break
                best = best or info     # 都不合格时留最后一张,并标记待人工复核
            if not best:
                print(f'{tag} ✗ 无可用图源 ({sci})')
                fail += 1
                continue
            if best['opaque'] < 0.08:
                best['review'] = '主体占比过低,疑似抠错'
            credits[sid] = best
            ok += 1
            flag = ' ⚠待复核' if best.get('review') else ''
            print(f'{tag} ✓ {best["src"]} {best["size"][0]}×{best["size"][1]} '
                  f'主体{best["opaque"]*100:.0f}% [{best["license"]}]{flag}')
            CREDITS.write_text(json.dumps(credits, ensure_ascii=False, indent=1), encoding='utf-8')
            time.sleep(0.6)

        if args.silhouette:
            sdest = OUTDIR / f'sil_{sid}.png'
            if not (sdest.exists() and sdest.stat().st_size > 1000):
                pinfo = phylopic(sci)
                if pinfo:
                    raw = curl(pinfo['url'], binary=True, timeout=45)
                    if raw and len(raw) > 1000:
                        try:
                            cutout(raw, sdest, session, max_side=384, is_silhouette=True)
                            credits.setdefault(sid, {})['silhouette'] = pinfo
                            CREDITS.write_text(json.dumps(credits, ensure_ascii=False, indent=1), encoding='utf-8')
                            print(f'      ↳ 剪影 ✓ {pinfo["author"][:30]}')
                        except Exception:
                            pass
                time.sleep(0.4)

    total_mb = sum(f.stat().st_size for f in OUTDIR.glob('*.png')) / 1048576
    print(f'\n✓ 新增 {ok} | 续传跳过 {skip} | 失败 {fail} | 目录共 {len(list(OUTDIR.glob("*.png")))} 张 {total_mb:.1f}MB')
    print(f'  署名清单:{CREDITS}')


if __name__ == '__main__':
    main()
