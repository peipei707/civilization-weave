/* 条目配图管线:node tools/fetch_images.js
 * 数据源 = 中文维基百科(每条目的 src 字段):
 *   1) w/api.php pageimages 批量(50题/请求)拿主图(信息框配图,480px 缩略);
 *   2) REST media-list 逐条补最多 2 张文内插图(过滤 svg 图标/地图定位钉等杂物)。
 * 产出 data/images.json:{ "<id>": [{u:缩略URL, f:"File:原名"}...] },URL 热链维基媒体 CDN。
 * 礼仪:自定义 UA + 间隔节流;失败条目列入报告,不重试轰炸。 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const UA = 'CivilizationWeave/2.2 (personal knowledge-map project; contact: github.com/peipei707)';

global.window = {};
eval(fs.readFileSync(path.join(ROOT, 'web', 'data.js'), 'utf8'));
const D = global.window.DATA;
const items = [...D.nodes, ...D.arcs].filter(it => it.src);
console.log('条目', items.length, '个(含 src)');

const sleep = ms => new Promise(r => setTimeout(r, ms));
// 维基百科大陆直连不通,走本机代理(HTTPS_PROXY 环境变量);Node fetch 不认系统代理,改用 curl
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:33210';
const { execFile } = require('child_process');
function curlOnce(url) {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-s', '--max-time', '25', '--proxy', PROXY, '-H', 'User-Agent: ' + UA, '-H', 'Accept: application/json', url],
      { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('非JSON响应: ' + String(stdout).slice(0, 80))); }
      });
  });
}
const hardTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('硬超时')), ms))]);
async function getJSON(url) { // 代理抖动重试一次;35s 硬超时兜底(Windows 偶发丢 execFile 回调,不能让它吊死整条管线)
  try { return await hardTimeout(curlOnce(url), 35000); }
  catch (e) { await sleep(2000); return hardTimeout(curlOnce(url), 35000); }
}

// —— 第一轮:pageimages 批量主图 ——
const bySrc = {};   // src → [items](同名 src 可能多条目共用)
items.forEach(it => (bySrc[it.src] = bySrc[it.src] || []).push(it));
const titles = Object.keys(bySrc);
const heroByTitle = {};   // 规范化后标题 → {u,f}
const titleMap = {};      // 原始标题 → 规范化标题(redirects/normalized)

const CACHE = path.join(ROOT, 'data', '_img_hero_cache.json');
const OUT = path.join(ROOT, 'data', 'images.json');

(async () => {
  // 断点续传:第一阶段有缓存就直接跳过
  if (fs.existsSync(CACHE)) {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    Object.assign(heroByTitle, c.heroByTitle); Object.assign(titleMap, c.titleMap);
    console.log('主图缓存命中,跳过第一阶段(' + Object.keys(heroByTitle).length + ' 张)');
  } else
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const url = 'https://zh.wikipedia.org/w/api.php?action=query&format=json&redirects=1' +
      '&prop=pageimages&piprop=thumbnail|name&pithumbsize=480' +
      '&titles=' + encodeURIComponent(batch.join('|'));
    try {
      const j = await getJSON(url);
      (j.query.normalized || []).forEach(n => { if (n.from !== n.to) titleMap[n.from] = n.to; });
      (j.query.redirects || []).forEach(r => { if (r.from !== r.to) titleMap[titleMap[r.from] ? titleMap[r.from] : r.from] = r.to; });
      // 双跳解析(normalized→redirect),限 8 跳防环;严禁写入自环——
      // 上一版 titleMap[t]=t 的自环让 while 同步死循环,整条管线两次吊死在同一批次
      for (const t of batch) {
        let c = t, hops = 0;
        while (titleMap[c] && titleMap[c] !== c && hops++ < 8) c = titleMap[c];
        if (c !== t) titleMap[t] = c;
      }
      Object.values(j.query.pages || {}).forEach(p => {
        if (p.thumbnail) heroByTitle[p.title] = { u: p.thumbnail.source, f: p.pageimage ? 'File:' + p.pageimage : null };
      });
      process.stdout.write(`\r主图批次 ${Math.min(i + 50, titles.length)}/${titles.length}`);
    } catch (e) { console.log(`\n批次 ${i} 失败: ${e.message.slice(0, 60)}`); }
    await sleep(1200); // 上一轮 350ms 在批尾撞了 too many requests,放慢
  }
  console.log();

  if (!fs.existsSync(CACHE)) fs.writeFileSync(CACHE, JSON.stringify({ heroByTitle, titleMap }));

  // —— 第二轮:media-list 每条目补最多 2 张文内插图(断点续传:已有结果的条目跳过)——
  const JUNK = /(icon|logo|flag_of|coat_of_arms|locator|location_map|globe|wiki|commons-|edit-|magnify|symbol|pog\.svg|_map\.|banner)/i;
  const OK_EXT = /\.(jpe?g|png|svg|gif)$/i; // svg/gif 的 srcset 缩略是已栅格化的 png,可用;垃圾图靠 JUNK 名单挡
  const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  let missing = [];
  let done = 0;
  const skipped = titles.filter(t => (bySrc[t] || []).every(it => out[it.id])).length;
  if (skipped) console.log(`断点续传:${skipped}/${titles.length} 个标题已有配图,跳过`);
  for (const t of titles) {
    if ((bySrc[t] || []).every(it => out[it.id])) { done++; continue; }
    if (done % 40 === 0) fs.writeFileSync(OUT, JSON.stringify(out)); // 增量落盘,进程死了也不清零
    const canon = titleMap[t] || t;
    const hero = heroByTitle[canon];
    const list = [];
    if (hero) list.push(hero);
    try {
      const ml = await getJSON('https://zh.wikipedia.org/api/rest_v1/page/media-list/' + encodeURIComponent(canon.replace(/ /g, '_')));
      for (const m of ml.items || []) {
        if (list.length >= 3) break;
        if (m.type !== 'image' || !m.srcset || !m.srcset[0]) continue;
        const src = m.srcset[0].src;
        const fname = (m.title || '').replace(/^文件:|^File:/, '');
        if (!OK_EXT.test(fname) || JUNK.test(fname)) continue;
        const u = (src.startsWith('//') ? 'https:' + src : src);
        if (hero && hero.u && u.split('/').pop().slice(-24) === hero.u.split('/').pop().slice(-24)) continue;
        list.push({ u, f: m.title || null });
      }
    } catch (e) { /* media-list 缺失不致命,主图仍可用 */ }
    if (list.length) bySrc[t].forEach(it => out[it.id] = list);
    else missing.push(t);
    if (++done % 25 === 0) process.stdout.write(`\r插图进度 ${done}/${titles.length}`);
    await sleep(150);
  }
  console.log();

  // —— 第三阶段:中文维基无图的条目,经 langlinks 跨到英文维基捞主图(抽象概念条目 en 版几乎都有图)——
  if (missing.length) {
    console.log(`英文维基救援:${missing.length} 个中文无图标题`);
    const en = {}; // zh标题 → en标题
    for (let i = 0; i < missing.length; i += 50) {
      const batch = missing.slice(i, i + 50);
      try {
        const j = await getJSON('https://zh.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=langlinks&lllang=en&lllimit=500&titles=' + encodeURIComponent(batch.join('|')));
        const back = {}; // 规范化标题 → 原标题
        batch.forEach(t => back[titleMap[t] || t] = t);
        (j.query.normalized || []).forEach(n => { if (back[n.to] === undefined) back[n.to] = back[n.from] !== undefined ? back[n.from] : n.from; });
        (j.query.redirects || []).forEach(r => { if (back[r.to] === undefined && back[r.from] !== undefined) back[r.to] = back[r.from]; });
        Object.values(j.query.pages || {}).forEach(p => {
          const zh = back[p.title];
          if (zh && p.langlinks && p.langlinks[0]) en[zh] = p.langlinks[0]['*'];
        });
      } catch (e) { console.log('langlinks 批失败: ' + e.message.slice(0, 50)); }
      await sleep(1200);
    }
    const enTitles = Object.entries(en);
    console.log(`  映射到英文条目 ${enTitles.length} 个`);
    let rescued = 0;
    for (let i = 0; i < enTitles.length; i += 50) {
      const batch = enTitles.slice(i, i + 50);
      try {
        const j = await getJSON('https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=pageimages&piprop=thumbnail|name&pithumbsize=480&titles=' + encodeURIComponent(batch.map(([, e]) => e).join('|')));
        const zhByEn = {}; batch.forEach(([z, e]) => zhByEn[e] = z);
        (j.query.normalized || []).forEach(n => { if (zhByEn[n.from]) { zhByEn[n.to] = zhByEn[n.from]; } });
        (j.query.redirects || []).forEach(r => { if (zhByEn[r.from]) { zhByEn[r.to] = zhByEn[r.from]; } });
        Object.values(j.query.pages || {}).forEach(p => {
          const zh = zhByEn[p.title];
          if (zh && p.thumbnail) {
            const rec = [{ u: p.thumbnail.source, f: p.pageimage ? 'File:' + p.pageimage : null }];
            (bySrc[zh] || []).forEach(it => { if (!out[it.id]) { out[it.id] = rec; rescued++; } });
          }
        });
      } catch (e) { console.log('en批失败: ' + e.message.slice(0, 50)); }
      await sleep(1200);
    }
    console.log(`  英文维基救回 ${rescued} 个条目`);
    missing = missing.filter(t => (bySrc[t] || []).some(it => !out[it.id]));
  }

  fs.writeFileSync(path.join(ROOT, 'data', 'images.json'), JSON.stringify(out));
  const withImg = Object.keys(out).length;
  const total = items.length;
  console.log(`✓ data/images.json — ${withImg} 个条目配图(共 ${Object.values(out).reduce((a, l) => a + l.length, 0)} 张),无图条目 ${total - withImg} 个`);
  if (missing.length) {
    fs.writeFileSync(path.join(ROOT, 'data', 'images_missing.txt'), missing.join('\n'));
    console.log('  无图标题清单 → data/images_missing.txt(前10:' + missing.slice(0, 10).join('、') + ')');
  }
})();
