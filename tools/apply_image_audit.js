/* 图文错配审计落地:node tools/apply_image_audit.js
 * 读 data/seed/image_audit.json({id:{drop:[序号],why,better_src?}}):
 *   1) 删掉被标记的图;删空的条目从 images.json 移除(无图优雅降级);
 *   2) 有 better_src 的,经代理批量拉新条目主图顶上(curl+系统代理,同 fetch_images);
 *   3) 报告统计。幂等可重跑。 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const ROOT = path.join(__dirname, '..');
const UA = 'CivilizationWeave/2.2 (personal knowledge-map project; contact: github.com/peipei707)';

// 系统代理(注册表),与 fetch_images.js 同源
function sysProxy() {
  try {
    const { execSync } = require('child_process');
    const out = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer', { encoding: 'utf8' });
    const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    if (m) return m[1].includes('=') ? (m[1].match(/https?=([^;]+)/) || [])[1] : m[1];
  } catch (e) { }
  return null;
}
const PROXY = sysProxy();
function getJSON(url) {
  return new Promise((resolve, reject) => {
    const args = ['-s', '--max-time', '25'];
    if (PROXY) args.push('--proxy', 'http://' + PROXY);
    args.push('-H', 'User-Agent: ' + UA, '-H', 'Accept: application/json', url);
    execFile('curl', args, { maxBuffer: 20e6, windowsHide: true, timeout: 30000 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('非JSON响应: ' + stdout.slice(0, 60))); }
    });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const audit = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'seed', 'image_audit.json'), 'utf8'));
const imgPath = path.join(ROOT, 'data', 'images.json');
const img = JSON.parse(fs.readFileSync(imgPath, 'utf8'));

(async () => {
  let dropped = 0, emptied = 0, refetched = 0;
  const want = {}; // better_src 标题 → [ids]
  for (const [id, v] of Object.entries(audit)) {
    if (img[id] && Array.isArray(v.drop) && v.drop.length) {
      img[id] = img[id].filter((_, i) => !v.drop.includes(i));
      dropped += v.drop.length;
      if (!img[id].length) { delete img[id]; emptied++; }
    }
    if (v.better_src) (want[v.better_src] = want[v.better_src] || []).push(id);
  }
  const titles = Object.keys(want);
  console.log(`删图 ${dropped} 张;删空条目 ${emptied} 个;待换源标题 ${titles.length} 个`);
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    try {
      const j = await getJSON('https://zh.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=pageimages&piprop=thumbnail|name&pithumbsize=480&titles=' + encodeURIComponent(batch.join('|')));
      const map = {}; // 规范/重定向后 → 原
      batch.forEach(t => map[t] = t);
      (j.query.normalized || []).forEach(n => { if (map[n.from] !== undefined) { map[n.to] = map[n.from]; } });
      (j.query.redirects || []).forEach(r => { if (map[r.from] !== undefined) { map[r.to] = map[r.from]; } });
      Object.values(j.query.pages || {}).forEach(p => {
        const orig = map[p.title];
        if (orig && p.thumbnail) {
          for (const id of want[orig]) {
            img[id] = [{ u: p.thumbnail.source, f: p.pageimage ? 'File:' + p.pageimage : null }, ...(img[id] || [])].slice(0, 3);
            refetched++;
          }
        }
      });
    } catch (e) { console.log('换源批失败: ' + e.message.slice(0, 50)); }
    await sleep(1200);
  }
  fs.writeFileSync(imgPath, JSON.stringify(img));
  console.log(`✓ 换源补图 ${refetched} 个条目;最终配图条目 ${Object.keys(img).length} 个,共 ${Object.values(img).reduce((a, l) => a + l.length, 0)} 张`);
})();
