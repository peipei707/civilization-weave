/* 大地水准面(重力土豆)烘焙:data/geoids/egm96-15.pgm → geoid_color.jpg + geoid_h.jpg
 * 数据:EGM96 全球重力模型 15' 网格(GeographicLib 分发,NGA 官方模型);
 * 起伏范围约 -107m(印度洋低)~ +85m(新几内亚高)。可视化按 GFZ Potsdam「重力土豆」惯例
 * 用发散色带 + 位移放大(真实起伏只有地球半径的 0.0017%,不放大肉眼不可见)。
 * 用法:node tools/build_geoid.js */
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');
const ROOT = path.join(__dirname, '..');

const buf = fs.readFileSync(path.join(ROOT, 'data', 'geoids', 'egm96-15.pgm'));
// PGM P5 头:魔数、注释(含 Offset/Scale)、宽高、maxval,随后 16 位大端数据
let pos = 0, tokens = [], offset = 0, scale = 1;
while (tokens.length < 4) {
  let line = '';
  while (buf[pos] !== 10) line += String.fromCharCode(buf[pos++]);
  pos++;
  if (line.startsWith('#')) {
    const m1 = line.match(/Offset\s+(-?[\d.]+)/i); if (m1) offset = +m1[1];
    const m2 = line.match(/Scale\s+([\d.]+)/i); if (m2) scale = +m2[1];
    continue;
  }
  tokens.push(...line.trim().split(/\s+/).filter(Boolean));
}
const W = +tokens[1], H = +tokens[2];
console.log(`PGM ${W}×${H}, offset=${offset}, scale=${scale}`);
const hAt = (col, row) => {
  col = ((col % W) + W) % W;
  row = Math.max(0, Math.min(H - 1, row));
  const i = pos + (row * W + col) * 2;
  return offset + scale * ((buf[i] << 8) | buf[i + 1]);
};
// 双线性采样:输出经度 -180..180(源网格 0..360,lat 90..-90)
const sample = (lon, lat) => {
  const gx = ((lon + 360) % 360) / 360 * W;
  const gy = (90 - lat) / 180 * (H - 1);
  const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
  return hAt(x0, y0) * (1 - fx) * (1 - fy) + hAt(x0 + 1, y0) * fx * (1 - fy) +
         hAt(x0, y0 + 1) * (1 - fx) * fy + hAt(x0 + 1, y0 + 1) * fx * fy;
};
// Potsdam 风格发散色带
const STOPS = [[-110, 25, 45, 160], [-50, 45, 95, 220], [-20, 65, 180, 220], [0, 75, 200, 125],
               [20, 230, 220, 85], [50, 240, 150, 55], [90, 220, 55, 40]];
const colOf = h => {
  if (h <= STOPS[0][0]) return STOPS[0].slice(1);
  for (let i = 1; i < STOPS.length; i++) if (h <= STOPS[i][0]) {
    const a = STOPS[i - 1], b = STOPS[i], t = (h - a[0]) / (b[0] - a[0]);
    return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
  }
  return STOPS[STOPS.length - 1].slice(1);
};
const OW = 2048, OH = 1024, A = 110;
const colorBuf = Buffer.alloc(OW * OH * 4), hBuf = Buffer.alloc(OW * OH * 4);
let mn = 1e9, mx = -1e9;
for (let y = 0; y < OH; y++) {
  const lat = 90 - (y + 0.5) / OH * 180;
  for (let x = 0; x < OW; x++) {
    const lon = (x + 0.5) / OW * 360 - 180;
    const h = sample(lon, lat);
    if (h < mn) mn = h; if (h > mx) mx = h;
    const i = (y * OW + x) * 4;
    const [r, g, b] = colOf(h);
    colorBuf[i] = r; colorBuf[i + 1] = g; colorBuf[i + 2] = b; colorBuf[i + 3] = 255;
    const v = Math.max(0, Math.min(255, Math.round(255 * (0.5 + h / (2 * A)))));
    hBuf[i] = v; hBuf[i + 1] = v; hBuf[i + 2] = v; hBuf[i + 3] = 255;
  }
}
const cJ = jpeg.encode({ data: colorBuf, width: OW, height: OH }, 85);
const hJ = jpeg.encode({ data: hBuf, width: OW, height: OH }, 92);
fs.writeFileSync(path.join(ROOT, 'data', 'geoid_color.jpg'), cJ.data);
fs.writeFileSync(path.join(ROOT, 'data', 'geoid_h.jpg'), hJ.data);
console.log(`✓ geoid_color.jpg ${(cJ.data.length / 1024).toFixed(0)}KB + geoid_h.jpg ${(hJ.data.length / 1024).toFixed(0)}KB;实测起伏 ${mn.toFixed(1)}m ~ +${mx.toFixed(1)}m`);
