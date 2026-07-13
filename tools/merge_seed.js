/* 合并种子批次 → web/data.js。用法:node tools/merge_seed.js
 * 前置:先跑 node tools/validate_seed.js 确认 0 ERROR。
 * 行为:现有 data.js 条目保序在前,seed 新条目按年份排序续后;
 *       id/标题查重(后到者丢弃并报告)、links 解析(悬空丢弃并报告);
 *       可选 data/seed/weave_links.json({"links":[{"from":,"to":}...]})作为跨批影响边补织;
 *       原 data.js 首次合并前备份到 archive/。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SEED = path.join(ROOT, 'data', 'seed');
const DATAJS = path.join(ROOT, 'web', 'data.js');

global.window = {};
eval(fs.readFileSync(DATAJS, 'utf8'));
const BASE = global.window.DATA;

const normTitle = s => String(s).replace(/[\s·。,、'"“”‘’()()—\-]/g, '');
const ids = new Set(), titles = new Map();
BASE.nodes.forEach(n => { ids.add(n.id); titles.set(normTitle(n.t), n.id); });
BASE.arcs.forEach(a => { ids.add(a.id); titles.set(normTitle(a.t), a.id); });

const newNodes = [], newArcs = [], dropped = [];
const files = fs.readdirSync(SEED).filter(f => f.endsWith('.json') && f !== 'weave_links.json').sort();
for (const f of files) {
  let txt = fs.readFileSync(path.join(SEED, f), 'utf8');
  if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
  const j = JSON.parse(txt);
  for (const [kind, list] of [['node', j.nodes || []], ['arc', j.arcs || []]]) {
    for (const it of list) {
      if (ids.has(it.id)) { dropped.push(`${f}:${it.id} id重复`); continue; }
      const nt = normTitle(it.t);
      if (titles.has(nt)) { dropped.push(`${f}:${it.id} 标题与 ${titles.get(nt)} 重复`); continue; }
      ids.add(it.id); titles.set(nt, it.id);
      (kind === 'node' ? newNodes : newArcs).push(it);
    }
  }
}

// 跨批补织影响边(可选)
const weavePath = path.join(SEED, 'weave_links.json');
let wove = 0, woveDrop = 0;
const allById = {};
[...BASE.nodes, ...BASE.arcs, ...newNodes, ...newArcs].forEach(it => allById[it.id] = it);
if (fs.existsSync(weavePath)) {
  const w = JSON.parse(fs.readFileSync(weavePath, 'utf8'));
  for (const { from, to } of w.links || []) {
    const src = allById[from];
    if (!src || !allById[to] || from === to) { woveDrop++; continue; }
    src.links = src.links || [];
    if (!src.links.includes(to)) { src.links.push(to); wove++; }
  }
}

// links 悬空清理
let cutLinks = 0;
Object.values(allById).forEach(it => {
  if (!it.links) return;
  const before = it.links.length;
  it.links = it.links.filter(t => allById[t]);
  cutLinks += before - it.links.length;
});

newNodes.sort((a, b) => a.y - b.y);
newArcs.sort((a, b) => a.y - b.y);

// 备份原 data.js(仅一次)
const bak = path.join(ROOT, 'archive', 'data_v1_seed60.js');
if (!fs.existsSync(bak)) fs.copyFileSync(DATAJS, bak);

const ser = it => {
  const o = {};
  for (const k of ['id', 't', 'd', 'y', 'sub', 'lat', 'lon', 'from', 'to', 'dur', 'w', 'gist', 'detail', 'links', 'src']) {
    if (it[k] !== undefined && !(k === 'links' && (!it[k] || !it[k].length))) o[k] = it[k];
  }
  delete o.kind;
  return '  ' + JSON.stringify(o);
};

const out = `/* 文明星图 · 知识库(自动合并生成,勿手改;源=data/seed/*.json + archive/data_v1_seed60.js)
 * 重新生成:node tools/merge_seed.js && node web/build.js
 * 字段:id/t标题/d领域/y年份(负=公元前)/lat/lon/w权重1-3/gist一句/detail展开/links影响到谁/src维基条目
 */
window.DATA = {
  domains: ${JSON.stringify(BASE.domains, null, 2).replace(/\n/g, '\n  ')},

  nodes: [
${[...BASE.nodes, ...newNodes].map(ser).join(',\n')}
  ],

  arcs: [
${[...BASE.arcs, ...newArcs].map(ser).join(',\n')}
  ],
};
`;
fs.writeFileSync(DATAJS, out);

console.log(`✓ 合并完成:节点 ${BASE.nodes.length}+${newNodes.length}=${BASE.nodes.length + newNodes.length},弧 ${BASE.arcs.length}+${newArcs.length}=${BASE.arcs.length + newArcs.length}`);
console.log(`  补织影响边 ${wove} 条(丢弃 ${woveDrop});清理悬空 links ${cutLinks} 条`);
if (dropped.length) console.log('  丢弃重复条目 ' + dropped.length + ' 个:\n    ' + dropped.slice(0, 15).join('\n    '));
