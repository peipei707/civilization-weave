/* 政权资料预装:node tools/fetch_terr_info.js
 * 把 1021 个政权的中文维基「首段简介(≤260字)+缩略图直链+条目名」一次性抓回本地,
 * 产出 data/terr_info.json:{ "<英文原名>": {e:简介, u:缩略图URL, p:条目名} }。
 * 页面预装后点国家零 API 等待;中文维基没有的条目留给运行时实时兜底。
 * TextExtracts 限制 exintro 模式每请求 ≤20 题;走系统代理;增量落盘可断点续跑。 */
const fs = require('fs');
const path = require('path');
const { execFile, execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const UA = 'CivilizationWeave/2.2 (personal knowledge-map; github.com/peipei707)';
const OUT = path.join(ROOT, 'data', 'terr_info.json');

// 代理:注册表读系统代理(大陆直连维基不通)
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
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('非JSON响应: ' + String(stdout).slice(0, 80))); }
    });
    const t = setTimeout(() => { try { child.kill(); } catch (e) { } reject(new Error('硬超时')); }, 30000);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const names = fs.readFileSync(path.join(ROOT, 'data', 'terr_names.txt'), 'utf8').trim().split('\n');
const zhMap = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'terr_zh.json'), 'utf8'));
const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};

// 英文名 → 中文标题;同中文题合并查询;断点续传跳过已装
const byZh = {};
for (const en of names) {
  if (out[en]) continue;
  const zh = zhMap[en];
  if (!zh || zh === '无名地带') continue;
  (byZh[zh] = byZh[zh] || []).push(en);
}
const zhTitles = Object.keys(byZh);
console.log('待查中文条目', zhTitles.length, '个(已装', Object.keys(out).length, ')');

(async () => {
  let hit = 0;
  for (let i = 0; i < zhTitles.length; i += 20) {
    const batch = zhTitles.slice(i, i + 20);
    try {
      const j = await getJSON('https://zh.wikipedia.org/w/api.php?action=query&format=json&redirects=1' +
        '&prop=extracts|pageimages&exintro=1&explaintext=1&exchars=260&exlimit=max&pithumbsize=320' +
        '&titles=' + encodeURIComponent(batch.join('|')));
      const back = {};
      batch.forEach(t => back[t] = t);
      (j.query.normalized || []).forEach(n => { back[n.to] = back[n.from] || n.from; });
      (j.query.redirects || []).forEach(r => { back[r.to] = back[r.from] || r.from; });
      Object.values(j.query.pages || {}).forEach(p => {
        const orig = back[p.title];
        if (!orig || !byZh[orig] || !p.extract || p.pageid == null) return;
        const rec = { e: p.extract.trim(), p: p.title };
        if (p.thumbnail && p.thumbnail.source) rec.u = p.thumbnail.source;
        byZh[orig].forEach(en => { out[en] = rec; hit++; });
      });
    } catch (e) { console.log(`\n批 ${i} 失败: ${e.message.slice(0, 60)}`); }
    const done = Math.min(i + 20, zhTitles.length);
    process.stdout.write(`\r简介批次 ${done}/${zhTitles.length}`);
    if (done % 100 < 20) fs.writeFileSync(OUT, JSON.stringify(out)); // 增量落盘=心跳
    await sleep(1200);
  }
  fs.writeFileSync(OUT, JSON.stringify(out));
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`\n✓ data/terr_info.json — ${Object.keys(out).length}/${names.length} 个政权预装(本轮新增 ${hit}),${kb} KB`);
})();
