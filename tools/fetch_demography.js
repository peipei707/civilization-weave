/* 世界人口学指标预装:node tools/fetch_demography.js
 * 出生率/死亡率(‰)+ 五年龄段占比(0-4幼年 5-14少年 15-24青年 25-64壮年 65+老年),世界层面。
 * 1950 起用联合国《世界人口展望》(UN WPP 2024,经 OWID grapher CSV 接口);
 * 1950 前锚点取人口史学界通用估算:Livi-Bacci《世界人口简史》(2017) 的前工业出生/死亡率区间,
 * 年龄结构按 Coale & Demeny (1966) West 模型稳定人口(e0≈30)近似,面板脚注注明。
 * 产出 data/demography.json。 */
const fs = require('fs');
const path = require('path');
const { execFile, execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

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
    const args = ['-sL', '--max-time', '120', '-o', dest];
    if (PROXY) args.push('--proxy', PROXY);
    args.push('-H', 'User-Agent: CivilizationWeave/2.7 (github.com/peipei707)', url);
    const t = setTimeout(() => { try { c.kill(); } catch (e) { } reject(new Error('硬超时')); }, 130000);
    const c = execFile('curl', args, err => { clearTimeout(t); err ? reject(err) : resolve(); });
  });
}

function worldRows(csv) { // 只取 World 行;OWID grapher 头行的指标名含" - "不含逗号,直接 split 安全
  const lines = csv.split('\n');
  const head = lines[0].split(',');
  const rows = [];
  for (const ln of lines) {
    if (!ln.startsWith('World,')) continue;
    rows.push(ln.split(','));
  }
  return { head, rows };
}

(async () => {
  const cache = p => path.join(ROOT, 'data', p);

  // 1) 五年龄组人口(绝对数)→ 聚合成五段占比
  const ageCsv = cache('_owid_age5.csv');
  if (!fs.existsSync(ageCsv) || fs.statSync(ageCsv).size < 10000) {
    console.log('下载 population-by-five-year-age-group …');
    await dl('https://ourworldindata.org/grapher/population-by-five-year-age-group.csv?v=1&csvType=full', ageCsv);
  }
  let csv = fs.readFileSync(ageCsv, 'utf8');
  if (csv.length < 10000) throw new Error('五年龄组CSV异常: ' + csv.slice(0, 120));
  let { head, rows } = worldRows(csv);
  console.log('年龄组列数', head.length, '| World 行', rows.length);
  // 列→年龄下界;只认 estimates 列(投影列名含 medium)
  const bandOf = low => low < 5 ? 0 : low < 15 ? 1 : low < 25 ? 2 : low < 65 ? 3 : 4;
  const colBand = {};
  head.forEach((h, i) => {
    if (/medium/i.test(h)) return;
    const m = h.match(/Age:\s*(\d+)/i) || h.match(/(\d+)[\-–+]/);
    if (m) colBand[i] = bandOf(+m[1]);
  });
  if (!Object.keys(colBand).length) { console.log('表头样例:', head.slice(0, 8).join(' || ')); throw new Error('没识别出年龄列'); }
  const WANT_YEARS = new Set([1950, 1960, 1970, 1980, 1990, 2000, 2010, 2015, 2020, 2023]);
  const age = []; // [year, b0..b4 百分比]
  for (const r of rows) {
    const y = +r[2];
    if (!WANT_YEARS.has(y)) continue;
    const sums = [0, 0, 0, 0, 0];
    let tot = 0;
    for (const [i, b] of Object.entries(colBand)) {
      const v = +r[i] || 0; sums[b] += v; tot += v;
    }
    if (tot > 1e8) age.push([y, ...sums.map(s => +(s / tot * 100).toFixed(1))]);
  }
  age.sort((a, b) => a[0] - b[0]);
  console.log('年龄结构采样', age.length, '年;2020 =', JSON.stringify(age.find(a => a[0] === 2020)));

  // 2) 出生率 / 死亡率(‰)
  async function rateSeries(slug, cacheName) {
    const f = cache(cacheName);
    if (!fs.existsSync(f) || fs.statSync(f).size < 3000) {
      console.log('下载', slug, '…');
      await dl('https://ourworldindata.org/grapher/' + slug + '.csv?v=1&csvType=full', f);
    }
    const c = fs.readFileSync(f, 'utf8');
    if (c.length < 3000) throw new Error(slug + ' CSV异常: ' + c.slice(0, 120));
    const { head, rows } = worldRows(c);
    // 取第一个 estimates 数值列(无 estimates 字样就取第 4 列)
    let col = head.findIndex((h, i) => i >= 3 && !/medium/i.test(h));
    if (col < 0) col = 3;
    const out = [];
    for (const r of rows) {
      const y = +r[2], v = +r[col];
      if (Number.isFinite(y) && Number.isFinite(v) && v > 0 && (y % 5 === 0 || y >= 2020)) out.push([y, +v.toFixed(1)]);
    }
    out.sort((a, b) => a[0] - b[0]);
    return out;
  }
  const cbr = await rateSeries('crude-birth-rate', '_owid_cbr.csv');
  const cdr = await rateSeries('crude-death-rate', '_owid_cdr.csv');
  console.log('出生率点', cbr.length, '| 死亡率点', cdr.length, '| 2020:', JSON.stringify(cbr.find(x => x[0] === 2020)), JSON.stringify(cdr.find(x => x[0] === 2020)));

  // 3) 1950 前文献锚点(前工业社会;数值为区间中值)
  //    出生/死亡率:Livi-Bacci 2017《A Concise History of World Population》第1章(旧石器~工业化前 CBR/CDR≈30-40‰);
  //    1800-1913 过渡期:同书表+Maddison人口增长率反推。
  const preCbr = [[-10000, 38], [1, 37], [1000, 37], [1500, 38], [1700, 38], [1800, 40], [1850, 40], [1900, 38], [1913, 36], [1930, 34]];
  const preCdr = [[-10000, 37.5], [1, 36.5], [1000, 36.5], [1500, 37], [1700, 36], [1800, 34], [1850, 31], [1900, 28], [1913, 25], [1930, 22]];
  //    年龄结构:Coale & Demeny (1966) Regional Model Life Tables, West 模型稳定人口 e0≈30 的近似构成
  const preAge = [[-10000, 14, 23, 17.5, 41.5, 4], [1900, 14, 23, 17.5, 41.5, 4], [1930, 13, 22, 18, 42.5, 4.5]];

  // 4) 分国五段占比(1950 起采样;国家榜分段条用。历史政体等缺席者由前端退回世界值)
  const CY = new Set([1950, 1970, 1990, 2000, 2010, 2020, 2023]);
  const popC = JSON.parse(fs.readFileSync(cache('pop_countries.json'), 'utf8'));
  const wanted = new Set();
  for (const m of Object.values(popC)) for (const en of Object.keys(m)) wanted.add(en);
  const cage = {};
  for (const ln of csv.split('\n')) {
    let ent, rest;
    if (ln[0] === '"') { const q = ln.indexOf('"', 1); ent = ln.slice(1, q); rest = ln.slice(q + 2).split(','); }
    else { const c = ln.indexOf(','); ent = ln.slice(0, c); rest = ln.slice(c + 1).split(','); }
    if (!wanted.has(ent)) continue;
    const y = +rest[1];
    if (!CY.has(y)) continue;
    const sums = [0, 0, 0, 0, 0]; let tot = 0;
    for (const [i, b] of Object.entries(colBand)) { const v = +rest[i - 1] || 0; sums[b] += v; tot += v; }
    if (tot > 1000) (cage[ent] = cage[ent] || []).push([y, ...sums.map(s => +(s / tot * 100).toFixed(1))]);
  }
  for (const k of Object.keys(cage)) cage[k].sort((a, b) => a[0] - b[0]);
  console.log('分国年龄结构:', Object.keys(cage).length, '国;中国2020 =', JSON.stringify((cage['China'] || []).find(r => r[0] === 2020)));

  const out = {
    bands: ['幼年 0-4', '少年 5-14', '青年 15-24', '壮年 25-64', '老年 65+'],
    age: [...preAge, ...age],
    cbr: [...preCbr, ...cbr],
    cdr: [...preCdr, ...cdr],
    cage,
    src: {
      modern: '联合国《世界人口展望 2024》(UN WPP),经 Our World in Data grapher 接口',
      premodern: '1950 前:Livi-Bacci《A Concise History of World Population》(2017) 前工业生命率估算;年龄构成按 Coale & Demeny (1966) West 模型稳定人口(e0≈30)近似',
    },
  };
  const dest = cache('demography.json');
  fs.writeFileSync(dest, JSON.stringify(out));
  console.log('✓', dest, Math.round(fs.statSync(dest).size / 1024) + ' KB');
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
