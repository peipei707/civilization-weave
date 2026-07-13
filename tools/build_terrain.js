/* 地形浮雕烘焙:data/earth-topology.png(高程)→ data/terrain_shade.jpg(灰度叠加层)
 * 山体阴影(方位315°/高度45°经典参数)+ 高程提亮,灰度以128为中性——
 * 运行时以 overlay 混合叠在陆地上:>128 提亮(向阳坡/高原),<128 压暗(背阴坡),海洋=128 不动。
 * 用法:node tools/build_terrain.js   (依赖 pngjs/jpeg-js,npm i 已装)
 */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const ROOT = path.join(__dirname, '..');

const src = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'data', 'earth-topology.png')));
const SW = src.width, SH = src.height;
console.log(`高程源 ${SW}×${SH}`);
const H = (x, y) => { // 环绕经度、钳制纬度的灰度采样
  x = ((x % SW) + SW) % SW;
  y = y < 0 ? 0 : y >= SH ? SH - 1 : y;
  return src.data[(y * SW + x) * 4];
};

const OW = 2048, OH = 1024;
const out = Buffer.alloc(OW * OH * 4);
const kx = SW / OW, ky = SH / OH;
// 光源:方位315°(西北)、高度45°;梯度做垂直夸张让丘陵可读
const EXAG = 4.2;
const Lx = -0.5, Ly = -0.5, Lz = 0.707;

let min = 255, max = 0;
for (let oy = 0; oy < OH; oy++) {
  for (let ox = 0; ox < OW; ox++) {
    const sx = Math.round(ox * kx), sy = Math.round(oy * ky);
    const h = H(sx, sy);
    let v = 128; // 中性
    if (h > 2) { // 陆地(海洋在高程图里是黑)
      const step = Math.max(1, Math.round(kx));
      const dzdx = (H(sx + step, sy) - H(sx - step, sy)) / (2 * step) * EXAG;
      const dzdy = (H(sx, sy + step) - H(sx, sy - step)) / (2 * step) * EXAG;
      const len = Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
      const shade = (-dzdx * Lx - dzdy * Ly + Lz) / len; // 0..~1
      v = 128 + (shade - 0.707) * 160 + (h / 255) * 26;
      v = v < 30 ? 30 : v > 210 ? 210 : v;
    }
    if (v < min) min = v; if (v > max) max = v;
    const i = (oy * OW + ox) * 4;
    out[i] = out[i + 1] = out[i + 2] = v; out[i + 3] = 255;
  }
}
const jpg = jpeg.encode({ data: out, width: OW, height: OH }, 80);
const dst = path.join(ROOT, 'data', 'terrain_shade.jpg');
fs.writeFileSync(dst, jpg.data);
console.log(`✓ ${dst} — ${OW}×${OH},${(jpg.data.length / 1024).toFixed(0)} KB,灰度范围 ${Math.round(min)}~${Math.round(max)}(128=中性)`);

// —— 纯高程图(顶点位移用):1024×512,海洋=0,轻度高斯让顶点位移不毛刺 ——
const HW = 1024, HH = 512;
const hbuf = Buffer.alloc(HW * HH * 4);
const hkx = SW / HW, hky = SH / HH;
for (let oy = 0; oy < HH; oy++) {
  for (let ox = 0; ox < HW; ox++) {
    const sx = Math.round(ox * hkx), sy = Math.round(oy * hky);
    // 3×3 均值:JPEG 噪点和阶梯在位移里会变成毛刺
    let sum = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += H(sx + dx * 2, sy + dy * 2);
    const v = Math.round(sum / 9);
    const i = (oy * HW + ox) * 4;
    hbuf[i] = hbuf[i + 1] = hbuf[i + 2] = v; hbuf[i + 3] = 255;
  }
}
const hjpg = jpeg.encode({ data: hbuf, width: HW, height: HH }, 82);
const hdst = path.join(ROOT, 'data', 'terrain_height.jpg');
fs.writeFileSync(hdst, hjpg.data);
console.log(`✓ ${hdst} — ${HW}×${HH},${(hjpg.data.length / 1024).toFixed(0)} KB(纯高程,位移贴图)`);
