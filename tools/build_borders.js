/* 历史疆界管线:data/raw_borders/*.geojson → mapshaper 精简 → data/borders_compact.json
 * 结构:{ attribution, years:[升序], sets:{ year: [ {n:名, s:宗主|null, g:[多边形…]} ] } }
 * g = MultiPolygon;每个多边形 = [环…];每个环 = 扁平 [lon,lat,lon,lat,…](2 位小数)。
 * 用法:node tools/build_borders.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const RAW = path.join(ROOT, 'data', 'raw_borders');
const TMP = path.join(RAW, '_tmp');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP);

const files = fs.readdirSync(RAW).filter(f => /^world_(bc)?\d+\.geojson$/.test(f));
const yearOf = f => { const m = f.match(/^world_(bc)?(\d+)\.geojson$/); return (m[1] ? -1 : 1) * Number(m[2]); };
files.sort((a, b) => yearOf(a) - yearOf(b));

const sets = {}, years = [];
let total = 0;

for (const f of files) {
  const y = yearOf(f);
  const out = path.join(TMP, 'simp_' + f.replace('.geojson', '.json'));
  // 越古老的地图越"示意",精简可以更狠一点
  const pct = y < -3000 ? 3 : 4;
  if (!fs.existsSync(out)) {
    const cmd = `npx -y mapshaper "${path.join(RAW, f)}" -simplify weighted ${pct}% keep-shapes -clean -filter-islands min-area=2500km2 -filter-fields NAME,SUBJECTO -o precision=0.01 format=geojson "${out}"`;
    execSync(cmd, { stdio: 'pipe' });
  }
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  const feats = [];
  for (const ft of j.features || []) {
    const geom = ft.geometry;
    if (!geom) continue;
    const polys = geom.type === 'MultiPolygon' ? geom.coordinates : geom.type === 'Polygon' ? [geom.coordinates] : [];
    // three-globe(ConicPolygonGeometry)按 D3 球面语义取顺时针外环;RFC7946 的逆时针外环会被填成"全球补集"。
    // 强制:外环顺时针(shoelace 面积>0 即逆时针,翻转),内环(洞)逆时针。
    const shoelace = flat => {
      let a = 0;
      for (let i = 0; i < flat.length - 2; i += 2) a += flat[i] * flat[i + 3] - flat[i + 2] * flat[i + 1];
      return a / 2;
    };
    const reverseFlat = flat => {
      const out = new Array(flat.length);
      for (let i = 0, j = flat.length - 2; i < flat.length; i += 2, j -= 2) { out[i] = flat[j]; out[i + 1] = flat[j + 1]; }
      return out;
    };
    const g = [];
    for (const poly of polys) {
      const rings = [];
      for (let r = 0; r < poly.length; r++) {
        const ring = poly[r];
        if (!ring || ring.length < 4) continue;
        let flat = new Array(ring.length * 2);
        for (let i = 0; i < ring.length; i++) { flat[i * 2] = Math.round(ring[i][0] * 100) / 100; flat[i * 2 + 1] = Math.round(ring[i][1] * 100) / 100; }
        const area = shoelace(flat);
        const isOuter = rings.length === 0;
        if ((isOuter && area > 0) || (!isOuter && area < 0)) flat = reverseFlat(flat);
        rings.push(flat);
      }
      if (rings.length) g.push(rings);
    }
    if (!g.length) continue;
    const p = ft.properties || {};
    feats.push({ n: p.NAME || null, s: p.SUBJECTO || null, g });
  }
  // —— 控制要素数:只保留面积前 KEEP 名的政权单独成块(可悬停),其余合并为"小邦与部落地带" ——
  // 目的:three-globe 每个多边形要素 = 多个 mesh/draw call,快照切换与逐帧渲染都吃要素数。
  const KEEP = 120;
  const areaOf = f => {
    let A = 0;
    for (const poly of f.g) {
      const r = poly[0]; // 外环
      let a = 0, latSum = 0;
      for (let i = 0; i < r.length - 2; i += 2) a += r[i] * r[i + 3] - r[i + 2] * r[i + 1];
      for (let i = 1; i < r.length; i += 2) latSum += r[i];
      const cos = Math.cos((latSum / (r.length / 2)) * Math.PI / 180);
      A += Math.abs(a / 2) * Math.max(cos, 0.08);
    }
    return A;
  };
  feats.forEach(f => f._area = areaOf(f));
  feats.sort((a, b) => b._area - a._area);
  const kept = [], restG = [];
  for (const f of feats) {
    if (f.n && kept.length < KEEP) kept.push(f);
    else restG.push(...f.g);
  }
  kept.forEach(f => delete f._area);
  // 命名政权走矢量多边形层(可悬停);无名/小邦合并块(b)烘进球面纹理——
  // 它若做成单个巨型 MultiPolygon,球面细分后的百万级三角形会拖垮逐帧射线检测。
  sets[y] = { f: kept, b: restG };
  years.push(y);
  const kb = Math.round(JSON.stringify(sets[y]).length / 1024);
  total += kb;
  console.log(`${String(y).padStart(8)} : ${kept.length} 政权 + 合并块${restG.length}片, ${kb} KB`);
}

const result = {
  attribution: 'historical-basemaps (aourednik) · 疆界为示意性重建,存在争议与简化',
  years,
  sets,
};
const outPath = path.join(ROOT, 'data', 'borders_compact.json');
fs.writeFileSync(outPath, JSON.stringify(result));
console.log(`\n✓ ${outPath} — ${years.length} 个年份快照,共 ${(fs.statSync(outPath).size / 1048576).toFixed(2)} MB`);
