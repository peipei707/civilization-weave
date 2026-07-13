/* 海名压岸审计:node tools/check_seanames.js
 * 从 web/globe.js 提取 SEA_NAMES,按字号/字距/旋转估算两行文字的包围盒,
 * 采样点对 data/land_compact.json 做点在多边形检测,输出每个名字的"压岸率"。
 * 目标:大洋(tier0/1)允许少量压岸(名字大是常态),海/湾(tier2/3)应≈0。 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const LAND = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'land_compact.json'), 'utf8'));
const src = fs.readFileSync(path.join(ROOT, 'web', 'globe.js'), 'utf8');
const m = src.match(/const SEA_NAMES = \[([\s\S]*?)\];/);
if (!m) { console.error('找不到 SEA_NAMES'); process.exit(1); }
const NAMES = eval('[' + m[1] + ']');

// 与 drawSeaNames 同步的字号表
const EN_SIZE = [52, 34, 23, 13, 11], ZH_SIZE = [38, 27, 20, 12, 10];
const EN_LS = [14, 8, 4, 1.5, 1], ZH_LS = [20, 10, 5, 2, 1.5];
const TW = 4096, TH = 2048;
const degPerPxX = 360 / TW, degPerPxY = 180 / TH;

function onLand(lon, lat) {
  // evenodd:统计所有环的射线穿越
  let inside = false;
  for (const feat of LAND) for (const ring of feat) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// 白名单:里海=NE陆地数据不挖湖,"压岸"实为湖面(假阳性);波罗的海=压哥特兰等海中岛,地图册惯例允许
const ALLOW = new Set(['Caspian Sea', 'Baltic Sea']);
console.log('名称'.padEnd(20) + 'tier  压岸率  采样细节');
let bad = 0;
for (const row of NAMES) {
  const [en, zh, lat, lon, tier, rot] = row;
  const enW = en.length * (EN_SIZE[tier] * 0.62 + EN_LS[tier]);
  const zhW = zh.length * (ZH_SIZE[tier] + ZH_LS[tier]);
  const gap = EN_SIZE[tier] * 0.7;
  const rad = (rot || 0) * Math.PI / 180;
  const pts = [];
  // 旋转标签=单行"EN 中文";水平标签=两行(与 drawSeaNames 同步)
  const lines = rot
    ? [[enW + EN_SIZE[tier] * 0.62 + zh.length * EN_SIZE[tier], 0]]
    : [[enW, -gap * 0.5], [zhW, gap * 0.7]];
  for (const [w, dy] of lines) {
    const h = (dy < 0 ? EN_SIZE : ZH_SIZE)[tier];
    for (let i = 0; i <= 8; i++) {
      const along = (i / 8 - 0.5) * w;
      for (const dv of [-h / 2, h / 2]) {
        // 行内坐标 → 旋转 → 纹理像素 → 经纬
        const rx = along * Math.cos(rad) - (dy + dv) * Math.sin(rad);
        const ry = along * Math.sin(rad) + (dy + dv) * Math.cos(rad);
        pts.push([lon + rx * degPerPxX, lat - ry * degPerPxY]);
      }
    }
  }
  const hits = pts.filter(([lo, la]) => onLand(lo, la)).length;
  const pct = hits / pts.length;
  const allowed = ALLOW.has(en);
  const flag = !allowed && ((tier >= 2 && pct > 0.08) || (tier <= 1 && pct > 0.35));
  if (flag) bad++;
  console.log((flag ? '✗ ' : allowed && pct > 0.08 ? '○ ' : '  ') + (en + '/' + zh).padEnd(24).slice(0, 24) + '  t' + tier + (rot ? '/r' + rot : '') + '  ' + (pct * 100).toFixed(0).padStart(3) + '%' + (allowed && pct > 0.08 ? '(白名单:湖面/岛屿)' : ''));
}
console.log(bad ? `\n${bad} 个需要调整` : '\n✓ 全部达标');
