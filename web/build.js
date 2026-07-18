// 构建自包含 index.html:内联 three + globe.gl + 底图 + 疆界 + 数据 + 样式 + 引擎。零外部请求。
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const read = f => fs.readFileSync(path.join(dir, f), 'utf8');

const land = fs.readFileSync(path.join(dir, '..', 'data', 'land_compact.json'), 'utf8');
const css = read('style.css');
const data = read('data.js');
const app = read('app.js');
const globeMod = read('globe.js');
const globeLib = read(path.join('vendor', 'globe.gl.min.js'));

const bordersPath = path.join(dir, '..', 'data', 'borders_compact.json');
const borders = fs.existsSync(bordersPath) ? fs.readFileSync(bordersPath, 'utf8') : 'null';

// 地形浮雕(灰度 hillshade JPEG → dataURL)与政权名汉化词典,均为可选资产
const terrainPath = path.join(dir, '..', 'data', 'terrain_shade.jpg');
const terrain = fs.existsSync(terrainPath)
  ? "'data:image/jpeg;base64," + fs.readFileSync(terrainPath).toString('base64') + "'"
  : 'null';
const heightPath = path.join(dir, '..', 'data', 'terrain_height.jpg');
const terrainH = fs.existsSync(heightPath)
  ? "'data:image/jpeg;base64," + fs.readFileSync(heightPath).toString('base64') + "'"
  : 'null';
const zhPath = path.join(dir, '..', 'data', 'terr_zh.json');
const terrZh = fs.existsSync(zhPath) ? fs.readFileSync(zhPath, 'utf8') : 'null';
const popCPath = path.join(dir, '..', 'data', 'pop_countries.json');
const popCountries = fs.existsSync(popCPath) ? fs.readFileSync(popCPath, 'utf8') : 'null';
const tiPath = path.join(dir, '..', 'data', 'terr_info.json');
const terrInfo = fs.existsSync(tiPath) ? fs.readFileSync(tiPath, 'utf8') : 'null';
const imgPath = path.join(dir, '..', 'data', 'images.json');
const images = fs.existsSync(imgPath) ? fs.readFileSync(imgPath, 'utf8') : 'null';

// —— 数据校验 ——
global.window = {}; eval(data); const D = global.window.DATA;
const all = [...D.nodes, ...D.arcs];
const seen = new Set(); const dup = [];
all.forEach(it => { if (seen.has(it.id)) dup.push(it.id); seen.add(it.id); });
const dangling = [];
all.forEach(it => (it.links || []).forEach(t => { if (!seen.has(t)) dangling.push(it.id + ' → ' + t); }));
console.log('节点', D.nodes.length, '| 迁徙弧', D.arcs.length, '| 领域', D.domains.length);
if (dup.length) { console.error('✗ 重复 id: ' + dup.join(', ')); process.exit(1); }
console.log(dangling.length ? '⚠ 断链: ' + dangling.slice(0, 10).join(', ') + (dangling.length > 10 ? ` …共${dangling.length}` : '') : '✓ 影响关系无断链');
if (borders !== 'null') {
  const B = JSON.parse(borders);
  console.log('疆界快照', B.years.length, '个年份 (' + B.years[0] + ' ~ ' + B.years[B.years.length - 1] + ')');
}

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>文明星图 · Civilization Weave</title>
<style>${css}</style>
</head>
<body>
<canvas id="scene"></canvas>
<div id="globe"></div>
<canvas id="fg"></canvas>
<div class="vignette"></div>

<header class="topbar">
  <div class="brand">
    <span class="eyebrow">Civilization Weave</span>
    <h1>文明星图</h1>
    <span class="sub">人类迁徙 × 七大领域 · 走出非洲至今</span>
  </div>
  <div class="modes" role="group" aria-label="视图切换">
    <button data-mode="map" aria-pressed="true">地图</button>
    <button data-mode="net" aria-pressed="false">网络</button>
  </div>
</header>

<aside class="legend"><div class="lg-head"><span class="lg-title">领域</span><button class="lg-toggle" aria-label="收起/展开图例">⌃</button></div></aside>

<aside class="popbox" role="button" aria-label="世界人口,点击展开分布" tabindex="0">
  <div class="pb-main"><span class="pb-lb">世界人口</span><b class="pb-num">—</b></div>
  <canvas class="pb-spark" width="164" height="30"></canvas>
  <div class="pb-detail">
    <div class="pb-bars"></div>
    <div class="pb-note">HYDE / McEvedy 估算 · 远古为数量级</div>
  </div>
</aside>

<section class="timeline">
  <button class="play" aria-label="播放"></button>
  <div class="tl-main">
    <div class="tl-readout">
      <span class="tl-year">2026</span>
      <span class="tl-era">全球化 · 信息时代</span>
      <span class="tl-ev"></span>
    </div>
    <div class="tl-track">
      <div class="tl-rail"></div>
      <div class="tl-fill"></div>
      <div class="tl-ticks"></div>
      <div class="tl-head0" title="拖我截取时间段起点"></div>
      <div class="tl-head"></div>
    </div>
  </div>
  <button class="tl-speed">1×</button>
</section>

<div class="microcard">
  <div class="mc-top"><span class="mc-dot"></span><span class="mc-t"></span><span class="mc-meta"></span></div>
  <div class="mc-g"></div>
</div>

<aside class="detail" aria-live="polite"></aside>

<div class="attrib">疆界:historical-basemaps · 示意性重建,存在争议与简化</div>
<div class="hint">▶ 点「播放」看文明演化 · 拖动旋转地球,滚轮缩放 · 点亮节点读其一生 · 切「网络」看影响星座</div>

<script>${globeLib}</script>
<script>window.LAND=${land};window.BORDERS=${borders};window.TERRAIN=${terrain};window.TERRAIN_H=${terrainH};window.TERR_ZH=${terrZh};window.TERR_INFO=${terrInfo};window.IMAGES=${images};window.POP_DATA=${popCountries};</script>
<script>${data}</script>
<script>${globeMod}</script>
<script>${app}</script>
</body>
</html>`;

fs.writeFileSync(path.join(dir, 'index.html'), html);
// 政权缩略图本地资产:拷进 web/img/terr(预览)与 docs/img/terr(Pages 发布)
const terrImgSrc = path.join(dir, '..', 'data', 'terr_img');
if (fs.existsSync(terrImgSrc)) {
  for (const outDir of [path.join(dir, 'img', 'terr'), path.join(dir, '..', 'docs', 'img', 'terr')]) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of fs.readdirSync(terrImgSrc)) fs.copyFileSync(path.join(terrImgSrc, f), path.join(outDir, f));
  }
  console.log('政权缩略图本地资产:' + fs.readdirSync(terrImgSrc).length + ' 张已同步 web/img/terr 与 docs/img/terr');
}
// GitHub Pages 发布副本(Pages 源=main 分支 /docs 目录)
const docsDir = path.join(dir, '..', 'docs');
if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir);
fs.writeFileSync(path.join(docsDir, 'index.html'), html);
const parts = { 'globe.gl': globeLib.length, borders: borders.length, data: data.length, land: land.length, 'app+globe': app.length + globeMod.length, css: css.length };
console.log('体积分解: ' + Object.entries(parts).map(([k, v]) => k + ' ' + (v / 1024).toFixed(0) + 'K').join(' | '));
console.log('✓ 生成 web/index.html （' + (html.length / 1048576).toFixed(2) + ' MB,自包含)');
