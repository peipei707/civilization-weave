/* 织边质检:node tools/check_weave.js
 * 校验 data/seed/weave_links.json:id 存在、年代顺序(from.y ≤ to.y+30)、
 * 不与已有 links 重复、from 出边 ≤3、to 入边 ≤6、无自环。
 * 违规边直接剔除并报告,干净结果原地写回(merge_seed 只吃干净货)。 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

global.window = {};
eval(fs.readFileSync(path.join(ROOT, 'web', 'data.js'), 'utf8'));
const D = global.window.DATA;
const byId = {};
[...D.nodes, ...D.arcs].forEach(it => byId[it.id] = it);

const wp = path.join(ROOT, 'data', 'seed', 'weave_links.json');
const j = JSON.parse(fs.readFileSync(wp, 'utf8'));
const seen = new Set(), outCnt = {}, inCnt = {}, keep = [], drop = [];
[...D.nodes, ...D.arcs].forEach(it => (it.links || []).forEach(t => seen.add(it.id + '>' + t)));

for (const l of j.links || []) {
  const { from, to } = l, key = from + '>' + to;
  const A = byId[from], B = byId[to];
  const why =
    !A || !B ? 'id不存在' :
    from === to ? '自环' :
    seen.has(key) ? '与已有重复' :
    A.y > B.y + 30 ? `逆时序(${A.y}→${B.y})` :
    (outCnt[from] || 0) >= 3 ? 'from出边超3' :
    (inCnt[to] || 0) >= 6 ? 'to入边超6' : null;
  if (why) { drop.push(`${from}→${to} ${why}`); continue; }
  seen.add(key);
  outCnt[from] = (outCnt[from] || 0) + 1;
  inCnt[to] = (inCnt[to] || 0) + 1;
  keep.push({ from, to });
}

fs.writeFileSync(wp, JSON.stringify({ links: keep }, null, 1));
console.log(`✓ 织边质检:保留 ${keep.length} 条,剔除 ${drop.length} 条`);
drop.slice(0, 20).forEach(d => console.log('  ✗ ' + d));
if (drop.length > 20) console.log(`  …还有 ${drop.length - 20} 条`);
// 跨域占比统计
const cross = keep.filter(l => byId[l.from].d !== byId[l.to].d).length;
console.log(`  跨领域占比 ${(cross / (keep.length || 1) * 100).toFixed(0)}%`);
