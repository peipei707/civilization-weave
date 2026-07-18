/* 政权缩略图本地化:node tools/fetch_terr_img.js
 * 把 terr_info.json 里每个预装政权的维基缩略图(国旗/地图等)下载到 data/terr_img/,
 * 并给对应词条写入 l 字段(本地文件名)。构建时拷进 docs/img/terr,页面本地引用零外网。
 * 断点续传:文件已存在即跳过;失败保留远程 URL 兜底。约 415 张 × ~15KB ≈ 6MB。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const IMG = path.join(ROOT, 'data', 'terr_img');
if (!fs.existsSync(IMG)) fs.mkdirSync(IMG, { recursive: true });

let PROXY = null;
try {
  const reg = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer', { encoding: 'utf8' });
  const m = reg.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
  const en = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable', { encoding: 'utf8' });
  if (m && /0x1/.test(en)) PROXY = 'http://' + m[1].replace(/^https?:\/\//, '');
} catch (e) { }
console.log('代理:', PROXY || '直连');

function dl(url, dest) {
  return new Promise((resolve, reject) => {
    const args = ['-sL', '--max-time', '30', '-o', dest];
    if (PROXY) args.push('--proxy', PROXY);
    args.push('-H', 'User-Agent: CivilizationWeave/2.5 (github.com/peipei707)', url);
    const t = setTimeout(() => { try { c.kill(); } catch (e) { } reject(new Error('硬超时')); }, 40000);
    const c = execFile('curl', args, err => { clearTimeout(t); err ? reject(err) : resolve(); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const infoPath = path.join(ROOT, 'data', 'terr_info.json');
  const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
  const entries = Object.entries(info).filter(([, v]) => v.u);
  console.log('待本地化', entries.length, '张');
  let ok = 0, fail = 0, skip = 0, done = 0;
  for (const [name, v] of entries) {
    const ext = /\.png(\?|$)/i.test(v.u) ? '.png' : '.jpg';
    const fn = crypto.createHash('md5').update(name).digest('hex').slice(0, 10) + ext;
    const dest = path.join(IMG, fn);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 500) { v.l = fn; skip++; }
    else {
      try {
        await dl(v.u, dest);
        if (fs.existsSync(dest) && fs.statSync(dest).size > 500) { v.l = fn; ok++; }
        else { fail++; try { fs.unlinkSync(dest); } catch (e) { } }
      } catch (e) { fail++; }
      await sleep(200);
    }
    if (++done % 40 === 0) {
      fs.writeFileSync(infoPath, JSON.stringify(info)); // 增量落盘
      process.stdout.write(`\r${done}/${entries.length}`);
    }
  }
  fs.writeFileSync(infoPath, JSON.stringify(info));
  const total = fs.readdirSync(IMG).length;
  const mb = (fs.readdirSync(IMG).reduce((a, f) => a + fs.statSync(path.join(IMG, f)).size, 0) / 1048576).toFixed(1);
  console.log(`\n✓ 本地化完成:新下 ${ok},续传跳过 ${skip},失败 ${fail}(失败的保留远程兜底);目录共 ${total} 张 ${mb}MB`);
})();
