/* 子类落库:data/seed/subcat_patch.json({id:sub})→ 写进 web/data.js 各条目的 sub 字段。
 * 用法:node tools/apply_subcats.js。合法性由分类代理自检保证,这里再兜一层:
 * 未知 id 跳过并报告;领域-子类不匹配跳过并报告。幂等,可重复跑。 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DATAJS = path.join(ROOT, 'web', 'data.js');

const LEGAL = {
  art: 'painting sculpture arch music lit stage craft',
  sci: 'math phys chem bio astro tech info earth',
  eco: 'money trade agri industry inst transport',
  pol: 'empire law rev treaty org war',
  rel: 'christ islam dharma eastasia judaism indigenous',
  phi: 'classical ethics logic mind modern social',
  ren: 'evo lang migr identity refuge settle',
};

global.window = {};
eval(fs.readFileSync(DATAJS, 'utf8'));
const D = global.window.DATA;
// 吃 data/seed/ 下所有 subcat_*.json(单文件或按领域分片皆可),后读覆盖先读
const SEED = path.join(ROOT, 'data', 'seed');
const patch = {};
for (const f of fs.readdirSync(SEED).filter(f => /^subcat_.*\.json$/.test(f)).sort()) {
  Object.assign(patch, JSON.parse(fs.readFileSync(path.join(SEED, f), 'utf8')));
  console.log('  读入 ' + f);
}

let ok = 0, skip = [];
for (const it of [...D.nodes, ...D.arcs]) {
  const sub = patch[it.id];
  if (!sub) { skip.push(it.id + ' 无标签'); continue; }
  if (!LEGAL[it.d] || !LEGAL[it.d].split(' ').includes(sub)) { skip.push(`${it.id} 非法 ${it.d}:${sub}`); continue; }
  it.sub = sub; ok++;
}

const ser = it => {
  const o = {};
  for (const k of ['id', 't', 'd', 'y', 'sub', 'lat', 'lon', 'from', 'to', 'dur', 'w', 'gist', 'detail', 'links', 'src']) {
    if (it[k] !== undefined && !(k === 'links' && (!it[k] || !it[k].length))) o[k] = it[k];
  }
  delete o.kind;
  return '  ' + JSON.stringify(o);
};
const out = `/* 文明星图 · 知识库(自动合并生成,勿手改;源=data/seed/*.json + archive/data_v1_seed60.js)
 * 重新生成:node tools/merge_seed.js && node web/build.js;子类:node tools/apply_subcats.js
 * 字段:id/t标题/d领域/y年份(负=公元前)/sub子类/lat/lon/w权重1-3/gist一句/detail展开/links影响到谁/src维基条目
 */
window.DATA = {
  domains: ${JSON.stringify(D.domains, null, 2).replace(/\n/g, '\n  ')},

  nodes: [
${D.nodes.map(ser).join(',\n')}
  ],

  arcs: [
${D.arcs.map(ser).join(',\n')}
  ],
};
`;
fs.writeFileSync(DATAJS, out);
console.log(`✓ 子类落库:${ok} 条打上标签,跳过 ${skip.length} 条`);
skip.slice(0, 10).forEach(s => console.log('  ✗ ' + s));
