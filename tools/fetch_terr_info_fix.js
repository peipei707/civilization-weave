/* 定向补抓:node tools/fetch_terr_info_fix.js
 * 只抓「人口榜实体里还没预装」的那一小撮(约30个),不陪跑无条目的历史政权名。
 * 撞限流(非JSON响应)= 等 20 秒原批重试,最多 5 次;批间隔 3 秒。 */
const fs = require('fs');
const path = require('path');
const { execFile, execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const UA = 'CivilizationWeave/2.6 (personal knowledge-map; github.com/peipei707)';
const OUT = path.join(ROOT, 'data', 'terr_info.json');

let PROXY = null;
try {
  const reg = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer', { encoding: 'utf8' });
  const m = reg.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
  const en = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable', { encoding: 'utf8' });
  if (m && /0x1/.test(en)) PROXY = 'http://' + m[1].replace(/^https?:\/\//, '');
} catch (e) { }
console.log('代理:', PROXY || '直连');

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const args = ['-s', '--max-time', '25'];
    if (PROXY) args.push('--proxy', PROXY);
    args.push('-H', 'User-Agent: ' + UA, '-H', 'Accept: application/json', url);
    const child = execFile('curl', args, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      clearTimeout(t);
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('限流或非JSON: ' + String(stdout).slice(0, 60))); }
    });
    const t = setTimeout(() => { try { child.kill(); } catch (e) { } reject(new Error('硬超时')); }, 30000);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const QUERY_FIX = {
  '刚果(金)': '刚果民主共和国', '台湾地区': '台湾', '密克罗尼西亚': '密克罗尼西亚联邦',
  '北也门(1990前)': '阿拉伯也门共和国', '南也门(1990前)': '民主也门', '巴勒斯坦': '巴勒斯坦国',
  '荷属加勒比区': '荷兰加勒比区', '根西': '根西岛', '泽西': '泽西岛',
};
const out = JSON.parse(fs.readFileSync(OUT, 'utf8'));
const pop = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'pop_countries.json'), 'utf8'));
const byZh = {};
for (const m of Object.values(pop)) for (const [en, rec] of Object.entries(m)) {
  if (out[en]) continue;
  const zh = QUERY_FIX[rec.n] || rec.n.replace(/\(.*?\)\s*$/, '');
  (byZh[zh] = byZh[zh] || []).push(en);
}
const zhTitles = Object.keys(byZh);
console.log('定向补抓', zhTitles.length, '题:', zhTitles.join('、'));

(async () => {
  let hit = 0;
  for (let i = 0; i < zhTitles.length; i += 5) {
    const batch = zhTitles.slice(i, i + 5);
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const back = {};
        batch.forEach(t => back[t] = t);
        let cont = null, rounds = 0;
        do {
          const j = await getJSON('https://zh.wikipedia.org/w/api.php?action=query&format=json&redirects=1' +
            '&prop=extracts|pageimages&exintro=1&explaintext=1&exchars=260&exlimit=max&pithumbsize=320' +
            '&titles=' + encodeURIComponent(batch.join('|')) +
            (cont ? '&excontinue=' + encodeURIComponent(cont) : ''));
          (j.query.normalized || []).forEach(n => { back[n.to] = back[n.from] || n.from; });
          (j.query.redirects || []).forEach(r => { back[r.to] = back[r.from] || r.from; });
          Object.values(j.query.pages || {}).forEach(p => {
            const orig = back[p.title];
            if (!orig || !byZh[orig] || !p.pageid) return;
            const prev = out[byZh[orig][0]] || {};
            const rec = {
              e: (p.extract && p.extract.trim()) || prev.e,
              p: p.title,
              u: (p.thumbnail && p.thumbnail.source) || prev.u,
            };
            if (!rec.e) return;
            if (!rec.u) delete rec.u;
            byZh[orig].forEach(en => { if (!out[en]) hit++; out[en] = rec; });
          });
          cont = j.continue && j.continue.excontinue;
          if (cont) await sleep(1500);
        } while (cont && ++rounds < 8);
        break; // 本批成功
      } catch (e) {
        console.log(`批 ${i} 第 ${attempt} 次失败(${e.message.slice(0, 40)}),等 20 秒再试`);
        await sleep(20000);
      }
    }
    fs.writeFileSync(OUT, JSON.stringify(out));
    console.log(`批 ${Math.min(i + 5, zhTitles.length)}/${zhTitles.length} 落盘`);
    await sleep(3000);
  }
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`✓ 定向补抓完成:新增 ${hit};terr_info 共 ${Object.keys(out).length} 个`);
})();
