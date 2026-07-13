/* 种子知识库校验器。用法:
 *   node tools/validate_seed.js                 # 校验 data/seed/ 下全部 .json
 *   node tools/validate_seed.js data/seed/nodes_sci.json [...]
 * 通过 = exit 0 且输出 "OK";任何 ERROR = exit 1。WARN 不拦截但质检会看。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SEED = path.join(ROOT, 'data', 'seed');

// —— 现有知识库(web/data.js)——
global.window = {};
eval(fs.readFileSync(path.join(ROOT, 'web', 'data.js'), 'utf8'));
const BASE = global.window.DATA;
const DOMS = new Set(BASE.domains.map(d => d.id));

const normTitle = s => String(s).replace(/[\s·。,、'"“”‘’()()—\-]/g, '');

// —— 收集全部 seed 文件(用于跨文件 id/标题解析)——
const allSeedFiles = fs.existsSync(SEED)
  ? fs.readdirSync(SEED).filter(f => f.endsWith('.json')).map(f => path.join(SEED, f))
  : [];
const target = process.argv.slice(2).length
  ? process.argv.slice(2).map(f => path.resolve(f))
  : allSeedFiles;

function loadJson(fp) {
  let txt = fs.readFileSync(fp, 'utf8');
  if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1); // BOM
  return JSON.parse(txt);
}

// 目标条数(低于下限 WARN)
const COUNT_MIN = { ren: 45, eco: 62, pol: 70, phi: 54, art: 66, sci: 78, rel: 54, arcs: 36 };

const knownIds = new Set();
const titleOwner = new Map();
BASE.nodes.forEach(n => { knownIds.add(n.id); titleOwner.set(normTitle(n.t), n.id); });
BASE.arcs.forEach(a => { knownIds.add(a.id); titleOwner.set(normTitle(a.t), a.id); });

// 先把所有 seed 的 id 注册进 knownIds(links 允许指向任何已存在 id)
const parsed = new Map();
for (const fp of allSeedFiles) {
  try {
    const j = loadJson(fp);
    parsed.set(fp, j);
    [...(j.nodes || []), ...(j.arcs || [])].forEach(it => it && it.id && knownIds.add(it.id));
  } catch (e) { parsed.set(fp, e); }
}

const uLen = s => [...String(s)].length;
let totalErr = 0;

for (const fp of target) {
  const name = path.basename(fp);
  const errs = [], warns = [];
  const E = m => errs.push(m), W = m => warns.push(m);
  const j = parsed.has(fp) ? parsed.get(fp) : (fs.existsSync(fp) ? (() => { try { return loadJson(fp); } catch (e) { return e; } })() : null);
  if (!j) { console.log(`✗ ${name}: 文件不存在`); totalErr++; continue; }
  if (j instanceof Error) { console.log(`✗ ${name}: JSON 解析失败 — ${j.message}`); totalErr++; continue; }

  const isArcFile = /^arcs_/.test(name);
  const domMatch = name.match(/^nodes_(\w+)\.json$/);
  const fileDom = domMatch ? domMatch[1] : null;
  const nodes = j.nodes || [], arcs = j.arcs || [];
  const items = [...nodes.map(n => ['node', n]), ...arcs.map(a => ['arc', a])];
  if (!items.length) E('空文件:没有 nodes 也没有 arcs');

  const seenIds = new Set();
  const NODE_KEYS = new Set(['id', 't', 'd', 'y', 'lat', 'lon', 'w', 'gist', 'detail', 'links', 'src', 'sub']);
  const ARC_KEYS = new Set(['id', 't', 'd', 'y', 'from', 'to', 'dur', 'w', 'gist', 'detail', 'links', 'src', 'sub']);

  items.forEach(([kind, it], i) => {
    const tag = `${kind}[${i}]${it && it.id ? ' ' + it.id : ''}`;
    if (!it || typeof it !== 'object') return E(`${tag}: 不是对象`);
    Object.keys(it).forEach(k => { if (!(kind === 'node' ? NODE_KEYS : ARC_KEYS).has(k)) E(`${tag}: 未知字段 ${k}`); });
    // id
    const idRe = kind === 'node' ? /^(ren|eco|pol|phi|art|sci|rel)_[a-z0-9_]{2,28}$/ : /^arc_[a-z0-9_]{2,28}$/;
    if (typeof it.id !== 'string' || !idRe.test(it.id)) E(`${tag}: id 不合规范(${kind === 'node' ? '<领域>_小写slug' : 'arc_小写slug'})`);
    else {
      if (seenIds.has(it.id)) E(`${tag}: 文件内 id 重复`);
      seenIds.add(it.id);
      if (BASE.nodes.some(n => n.id === it.id) || BASE.arcs.some(a => a.id === it.id)) E(`${tag}: id 与现有库冲突`);
    }
    // 标题
    if (typeof it.t !== 'string' || uLen(it.t) < 2 || uLen(it.t) > 24) E(`${tag}: 标题缺失或长度不在 2..24`);
    else {
      const nt = normTitle(it.t);
      const owner = titleOwner.get(nt);
      if (owner && owner !== it.id) E(`${tag}: 标题与 ${owner} 重复(同一事件不要重复收录)`);
      else titleOwner.set(nt, it.id);
    }
    // 领域
    if (!DOMS.has(it.d)) E(`${tag}: 领域 d=${it.d} 不存在`);
    if (kind === 'node' && fileDom && it.d !== fileDom) E(`${tag}: d=${it.d} 与文件领域 ${fileDom} 不符`);
    // 年份
    if (!Number.isInteger(it.y) || it.y < -3500000 || it.y > 2026) E(`${tag}: y 必须是 -3500000..2026 的整数(负=公元前;时间轴前端=洛迈奎石器 -330万)`);
    // 坐标
    if (kind === 'node') {
      if (typeof it.lat !== 'number' || it.lat < -85 || it.lat > 85) E(`${tag}: lat 越界`);
      if (typeof it.lon !== 'number' || it.lon < -180 || it.lon > 180) E(`${tag}: lon 越界`);
    } else {
      for (const k of ['from', 'to']) {
        const p = it[k];
        if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number'
          || p[0] < -85 || p[0] > 85 || p[1] < -180 || p[1] > 180) E(`${tag}: ${k} 必须是 [lat,lon] 且在范围内`);
      }
      if (!Number.isInteger(it.dur) || it.dur < 5 || it.dur > 3000) E(`${tag}: dur(持续年数)必须是 5..3000 整数`);
    }
    // 权重
    if (![1, 2, 3].includes(it.w)) E(`${tag}: w 必须是 1/2/3`);
    // 文案
    if (typeof it.gist !== 'string' || uLen(it.gist) < 8 || uLen(it.gist) > 48) E(`${tag}: gist 长度需 8..48 字`);
    if (kind === 'node') {
      if (typeof it.detail !== 'string' || uLen(it.detail) < 40 || uLen(it.detail) > 170) E(`${tag}: detail 长度需 40..170 字`);
    } else if (it.detail != null && (typeof it.detail !== 'string' || uLen(it.detail) > 170)) E(`${tag}: arc detail 若给则 ≤170 字`);
    if (/维基|百科|Wikipedia/i.test(String(it.gist) + String(it.detail || ''))) W(`${tag}: 文案里别提维基/百科`);
    // links
    if (it.links != null) {
      if (!Array.isArray(it.links) || it.links.length > 5) E(`${tag}: links 需为数组且 ≤5 条`);
      else it.links.forEach(l => {
        if (l === it.id) E(`${tag}: links 指向自己`);
        else if (!knownIds.has(l)) E(`${tag}: links 指向不存在的 id "${l}"(只能指向现有库或本批内 id)`);
      });
    }
    // src
    if (typeof it.src !== 'string' || uLen(it.src) < 2 || uLen(it.src) > 40) E(`${tag}: src 需为 2..40 字的中文维基条目名`);
  });

  // —— 分布 WARN ——
  const ns = isArcFile ? arcs : nodes;
  if (ns.length) {
    const key = isArcFile ? 'arcs' : fileDom;
    if (COUNT_MIN[key] && ns.length < COUNT_MIN[key]) W(`条数 ${ns.length} 低于目标下限 ${COUNT_MIN[key]}`);
    const w3 = ns.filter(n => n.w === 3).length / ns.length;
    if (w3 > 0.2) W(`w=3 占比 ${(w3 * 100).toFixed(0)}%(应 ≤15%,重要度要克制)`);
    const pre1000 = ns.filter(n => n.y < 1000).length / ns.length;
    const post1800 = ns.filter(n => n.y >= 1800).length / ns.length;
    if (pre1000 < 0.25) W(`公元1000年前占比仅 ${(pre1000 * 100).toFixed(0)}%(应 ≥25%,别扎堆近代)`);
    if (post1800 > 0.45) W(`1800年后占比 ${(post1800 * 100).toFixed(0)}%(应 ≤45%)`);
    const buck = p => { const lon = p.lon != null ? p.lon : (p.from ? p.from[1] : 0), lat = p.lat != null ? p.lat : (p.from ? p.from[0] : 0); return lon < -30 ? '美洲' : lon < 60 ? (lat > 36 ? '欧洲' : '非洲中东') : lon < 92 ? '南亚中亚' : '东亚太平洋'; };
    const regions = new Set(ns.map(buck));
    if (regions.size < 4) W(`地域只覆盖 ${[...regions].join('/')}(应 ≥4 大区,全球视野)`);
  }

  totalErr += errs.length;
  const head = errs.length ? '✗' : '✓';
  console.log(`${head} ${name}: ${nodes.length} 节点 / ${arcs.length} 弧` +
    (errs.length ? `,${errs.length} 个 ERROR` : ' — OK') + (warns.length ? `,${warns.length} 个 WARN` : ''));
  errs.slice(0, 25).forEach(m => console.log('   ERROR ' + m));
  if (errs.length > 25) console.log(`   …还有 ${errs.length - 25} 个 ERROR`);
  warns.forEach(m => console.log('   WARN  ' + m));
}

if (!target.length) console.log('（data/seed/ 下暂无 json）');
process.exit(totalErr ? 1 : 0);
