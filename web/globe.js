/* 文明星图 · 3D 地球视图(globe.gl,零跨实例依赖)
 * 分工:本模块只管三维原生层——球体(自发光纹理)/大气辉光/历史疆界多边形/迁徙弧流光/选中脉冲环/镜头;
 * 节点光点与标签由 app.js 画在 2D 覆盖层(每帧经 syncScreen 把球面投影写回节点)。
 * 约定:app 持有唯一状态,经 API 驱动;hover/click(弧、版图)经 callbacks 交还 app。 */
window.GlobeView = (function () {
  'use strict';

  let G = null, root = null, cb = null;
  let DATA, BORDERS, domById, fmtYear;
  let enabled = null, isOn = () => true; // isOn = app 注入的可见谓词(领域开关 × 子类开关)
  let yr = -70000, yr0 = -3300001, lastScanYr = null, lastScanYr0 = null, forceScan = true;
  const focus = { hover: null, sel: null };
  let liveArcEntries = [];
  let arcEntering = false;
  let active = true;

  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const RAD = Math.PI / 180;
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + clamp(a, 0, 1).toFixed(3) + ')';
  }

  function supported() {
    if (!window.Globe) return false;
    try {
      const c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
    } catch (e) { return false; }
  }

  // —— 球面纹理系统 ——
  // baseCv = 深空底 + 经纬网 + 辉光陆地(一次);texCv = baseCv + 当前时代"小邦与部落"底色(每次快照重烘)。
  // 合并块必须烘进纹理而不是走多边形层:巨型多边形经球面细分是百万级三角形,会拖垮逐帧射线检测。
  const TW = 4096, TH = 2048;
  let baseCv = null, texCv = null, texRef = null, pendingBlob = null, lastBlob = null;
  function px(lon) { return (lon + 180) / 360 * TW; }
  function py(lat) { return (90 - lat) / 180 * TH; }
  function traceLand(x, LAND) {
    x.beginPath();
    for (const feat of LAND) for (const ring of feat) {
      for (let i = 0; i < ring.length; i++) {
        i ? x.lineTo(px(ring[i][0]), py(ring[i][1])) : x.moveTo(px(ring[i][0]), py(ring[i][1]));
      }
      x.closePath();
    }
  }
  function buildBase(LAND) {
    baseCv = document.createElement('canvas'); baseCv.width = TW; baseCv.height = TH;
    const x = baseCv.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, TH);
    g.addColorStop(0, '#0B1224'); g.addColorStop(0.5, '#0C1428'); g.addColorStop(1, '#090F1E');
    x.fillStyle = g; x.fillRect(0, 0, TW, TH);
    x.strokeStyle = 'rgba(120,150,200,0.06)'; x.lineWidth = 2;
    for (let lon = -180; lon < 180; lon += 30) { x.beginPath(); x.moveTo(px(lon), 0); x.lineTo(px(lon), TH); x.stroke(); }
    for (let lat = -60; lat <= 60; lat += 30) { x.beginPath(); x.moveTo(0, py(lat)); x.lineTo(TW, py(lat)); x.stroke(); }
    traceLand(x, LAND);
    x.fillStyle = 'rgba(24,38,64,0.97)';
    x.shadowColor = 'rgba(76,128,200,0.6)'; x.shadowBlur = 12;
    x.fill('evenodd');
    x.shadowBlur = 0;
    x.lineWidth = 2.4; x.strokeStyle = 'rgba(100,152,220,0.55)'; x.stroke();
    drawSeaNames(x);
    // 地形浮雕(可选资产):灰度 hillshade 以 overlay 叠进陆地(128=中性),海洋不受影响;
    // 图像异步解码,落地后重描海岸辉光并重烘当前时代
    if (window.TERRAIN) {
      const img = new Image();
      img.onload = () => {
        x.save();
        traceLand(x, LAND);
        x.clip('evenodd');
        x.globalCompositeOperation = 'soft-light'; // overlay 会把高原顶成惨白,soft-light 保住深蓝底色
        x.globalAlpha = 0.75;
        x.drawImage(img, 0, 0, TW, TH);
        x.restore();
        traceLand(x, LAND);
        x.lineWidth = 2.4; x.strokeStyle = 'rgba(100,152,220,0.5)'; x.stroke();
        bakeBlob(lastBlob);
      };
      img.src = window.TERRAIN;
    }
    texCv = document.createElement('canvas'); texCv.width = TW; texCv.height = TH;
    texCv.getContext('2d').drawImage(baseCv, 0, 0);
  }
  function bakeBlob(blob) {
    lastBlob = blob;
    if (!texCv) { pendingBlob = blob; return; }
    const x = texCv.getContext('2d');
    x.clearRect(0, 0, TW, TH);
    x.drawImage(baseCv, 0, 0);
    if (blob && blob.length) {
      x.beginPath();
      for (const poly of blob) for (const flat of poly) {
        for (let i = 0; i < flat.length; i += 2) {
          i ? x.lineTo(px(flat[i]), py(flat[i + 1])) : x.moveTo(px(flat[i]), py(flat[i + 1]));
        }
        x.closePath();
      }
      x.fillStyle = 'rgba(104,134,186,0.085)';
      x.fill('evenodd');
      x.lineWidth = 1.6; x.strokeStyle = 'rgba(120,150,200,0.16)'; x.stroke();
    }
    if (texRef) texRef.needsUpdate = true;
  }
  // 纹理落地后:把内部材质改成自发光(贴图即光),得到均匀的"天鹅绒"平光;图像源换成 texCv 以便逐时代重烘
  let matWired = false;
  function wireFlatMaterial() {
    if (matWired || !G) return;
    const m = G.globeMaterial();
    if (!m || !m.map) return;
    m.map.image = texCv;
    m.map.colorSpace = 'srgb'; // 画布是 sRGB 颜色;不标注会被当线性数据、输出时二次编码提亮成灰
    m.map.needsUpdate = true;
    texRef = m.map;
    m.emissiveMap = m.map;
    if (m.emissive && m.emissive.set) m.emissive.set('#ffffff');
    m.emissiveIntensity = 1;
    if (m.color && m.color.set) m.color.set('#000000');
    m.shininess = 0;
    m.needsUpdate = true;
    matWired = true;
    wireDisplacement(m);
    if (pendingBlob) { const b = pendingBlob; pendingBlob = null; bakeBlob(b); }
  }
  // 真 3D 地形:高细分球面 + 顶点位移(位移贴图=纯高程 JPEG)。
  // 不引入第二份 three:高度纹理用 m.map.clone() 取同实例 Texture 类;
  // 球体几何用其自身构造器按参数重建更高分段。位移做的是轮廓与视差,明暗仍由烘焙 hillshade 承担。
  function wireDisplacement(m) {
    if (!window.TERRAIN_H) return;
    const img = new Image();
    img.onload = () => {
      try {
        let globeMesh = null;
        G.scene().traverse(o => { if (!globeMesh && o.isMesh && o.material === m) globeMesh = o; });
        if (!globeMesh) return;
        const geo = globeMesh.geometry, P = geo.parameters || {};
        if ((P.widthSegments || 0) < 256) {
          const hi = new geo.constructor(P.radius || 100, 512, 256);
          globeMesh.geometry = hi;
          geo.dispose();
        }
        // 不可用 m.map.clone():新版 three 克隆体与原纹理共享 source,
        // 改 image 会连球面贴图一起换成高程图(西藏变白斑的事故根源)。用构造器造独立纹理。
        const hTex = new (m.map.constructor)(img);
        hTex.colorSpace = '';        // 高程是数据不是颜色,禁掉 sRGB 解码
        hTex.needsUpdate = true;
        m.displacementMap = hTex;
        m.displacementScale = 2.2;   // 球半径 100 → 珠峰约凸起 2.2%,可读且不毁轮廓
        m.displacementBias = 0;
        m.needsUpdate = true;
      } catch (e) { /* 位移是增强项,失败静默退回平球 */ }
    };
    img.src = window.TERRAIN_H;
  }
  // —— 海洋/海域地名:烙进球面纹理(老地图册式,随球转动、永远退后)——
  // 双语两行:英文大写宽距在上,(中文)在下。tier: 0=大洋 1=海 2=小海湾
  const SEA_NAMES = [
    ['Pacific Ocean', '太平洋', 5, -150, 0], ['Atlantic Ocean', '大西洋', 26, -42, 0],
    ['South Atlantic', '南大西洋', -30, -12, 1], ['Indian Ocean', '印度洋', -22, 80, 0],
    ['Arctic Ocean', '北冰洋', 82, 5, 1], ['Southern Ocean', '南大洋', -60, 90, 1], ['Southern Ocean', '南大洋', -62, -120, 1],
    ['Mediterranean Sea', '地中海', 34.3, 18.5, 3], ['Caribbean Sea', '加勒比海', 14.5, -75, 2],
    ['Red Sea', '红海', 20.2, 38.6, 3, 58], ['Arabian Sea', '阿拉伯海', 14, 63, 2],
    ['Bay of Bengal', '孟加拉湾', 12, 87, 3], ['South China Sea', '南海', 12.5, 113.5, 3, -50],
    ['East China Sea', '东海', 29, 127.5, 3], ['Sea of Japan', '日本海', 40, 135, 3],
    ['Black Sea', '黑海', 43.3, 34, 3], ['Caspian Sea', '里海', 41.8, 50.4, 4, 80],
    ['Baltic Sea', '波罗的海', 57.8, 20, 4, -30], ['North Sea', '北海', 56, 3, 3],
    ['Bering Sea', '白令海', 58, -178, 3], ['Sea of Okhotsk', '鄂霍次克海', 54.5, 150, 3],
    ['Coral Sea', '珊瑚海', -16, 152, 3],
    ['Tasman Sea', '塔斯曼海', -39, 161, 3], ['Gulf of Mexico', '墨西哥湾', 25, -90, 3],
    ['Gulf of Guinea', '几内亚湾', 1, 1, 3],
  ];
  function drawSeaNames(x) {
    x.save();
    x.textAlign = 'center'; x.textBaseline = 'middle';
    for (const row of SEA_NAMES) {
      const [en, zh, lat, lon, tier] = row;
      const enSize = [52, 34, 23, 13, 11][tier]; // tier3=窄海小湾;tier4=瘦海(里海/波罗的海)
      const zhSize = [38, 27, 20, 12, 10][tier];
      const alpha = [0.30, 0.26, 0.24, 0.22, 0.20][tier];
      const enLS = [14, 8, 4, 1.5, 1][tier];
      const zhLS = [20, 10, 5, 2, 1.5][tier];
      const cx = px(lon), cy = py(lat), gap = enSize * 0.7;
      const rot = (row[5] || 0) * Math.PI / 180; // 窄长斜海沿水轴旋排,不压岸
      x.fillStyle = `rgba(148,174,214,${alpha})`;
      for (const dx of [0, -TW, TW]) { // ±TW:跨日界线的名字不被切断
        x.save();
        x.translate(cx + dx, cy); x.rotate(rot);
        if (rot) { // 窄长斜海:单行"EN 中文",垂直占位减半才塞得进水道
          x.font = `500 ${enSize}px 'Source Han Serif SC','Noto Serif SC',Georgia,serif`;
          try { x.letterSpacing = enLS + 'px'; } catch (e) { }
          x.fillText(en.toUpperCase() + ' ' + zh, 0, 0);
        } else {
          x.font = `500 ${enSize}px 'Source Han Serif SC','Noto Serif SC',Georgia,serif`;
          try { x.letterSpacing = enLS + 'px'; } catch (e) { }
          x.fillText(en.toUpperCase(), 0, -gap * 0.5);
          x.font = `500 ${zhSize}px 'Source Han Serif SC','Noto Serif SC',serif`;
          try { x.letterSpacing = zhLS + 'px'; } catch (e) { }
          x.fillText(zh, 0, gap * 0.7); // 中文不加括号
        }
        x.restore();
      }
    }
    try { x.letterSpacing = '0px'; } catch (e) { }
    x.restore();
  }

  // 1×1 深色占位图:只为让 globe.gl 的加载器创建 Texture 对象,随后图像源即被换成 texCv
  const TINY_DARK = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 2;
    const x = c.getContext('2d'); x.fillStyle = '#0B1324'; x.fillRect(0, 0, 2, 2);
    return c.toDataURL();
  })();

  // —— 历史疆界 ——
  const featCache = {};
  let curSnapIdx = -1, borderFade = null, hoverFeat = null;
  function hueOf(name) { let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360; return h; }
  function featuresOf(y) {
    if (featCache[y]) return featCache[y];
    const feats = ((BORDERS.sets[y] && BORDERS.sets[y].f) || []).map(f => {
      const coords = f.g.map(poly => poly.map(flat => {
        const ring = new Array(flat.length / 2);
        for (let i = 0; i < flat.length; i += 2) ring[i / 2] = [flat[i], flat[i + 1]];
        return ring;
      }));
      return {
        __y: y, __fa: 1,
        n: f.n, s: f.s, hue: f.n ? hueOf(f.n) : null,
        geometry: { type: 'MultiPolygon', coordinates: coords },
      };
    });
    return featCache[y] = feats;
  }
  function snapIdxOf(year) {
    const ys = BORDERS.years;
    let idx = -1;
    for (let i = 0; i < ys.length; i++) { if (ys[i] <= year) idx = i; else break; }
    return idx;
  }
  let hiName = null, hiTimer = null; // 人口榜跳转后的目标政权高亮(几秒后自动熄)
  function capCol(f) {
    const hi = hiName && f.n === hiName;
    const a = (f.n ? 0.16 : 0.055) * f.__fa * (hoverFeat === f ? 1.8 : 1) * (hi ? 2.6 : 1);
    return f.n ? `hsla(${f.hue},${hi ? 60 : 32}%,${hi ? 44 : 30}%,${Math.min(a, 0.6).toFixed(3)})` : `rgba(96,126,176,${a.toFixed(3)})`;
  }
  function strokeCol(f) {
    const hi = hiName && f.n === hiName;
    const a = (f.n ? 0.5 : 0.2) * f.__fa * (hoverFeat === f ? 1.7 : 1) * (hi ? 2 : 1);
    return f.n ? `hsla(${f.hue},${hi ? 70 : 45}%,${hi ? 78 : 64}%,${Math.min(a, 1).toFixed(3)})` : `rgba(120,150,200,${a.toFixed(3)})`;
  }
  function refreshBorderColors() {
    G.polygonCapColor(f => capCol(f));
    G.polygonStrokeColor(f => strokeCol(f));
  }
  function setSnapshot(idx) {
    if (idx === curSnapIdx) return;
    if (borderFade) { G.polygonsData(borderFade.to); borderFade = null; }
    const from = curSnapIdx >= 0 ? featuresOf(BORDERS.years[curSnapIdx]) : [];
    const to = idx >= 0 ? featuresOf(BORDERS.years[idx]) : [];
    curSnapIdx = idx;
    bakeBlob(idx >= 0 ? (BORDERS.sets[BORDERS.years[idx]] || {}).b : null);
    if (!from.length && !to.length) return;
    from.forEach(f => f.__fa = 1);
    to.forEach(f => f.__fa = 0);
    borderFade = { from, to, t: 0 };
    G.polygonsData([...from, ...to]);
    refreshBorderColors();
  }
  function tickBorders(dt) {
    if (!borderFade) return;
    borderFade.t = Math.min(1, borderFade.t + dt / 0.7);
    const t = borderFade.t, e = t * t * (3 - 2 * t);
    borderFade.from.forEach(f => f.__fa = 1 - e);
    borderFade.to.forEach(f => f.__fa = e);
    refreshBorderColors();
    if (t >= 1) { const to = borderFade.to; borderFade = null; G.polygonsData(to); }
  }

  // —— 迁徙弧:halo+core 两条目,入场用 dashInitialGap 从 1 收 0 = 沿线生长 ——
  function arcEntries() {
    const out = [];
    for (const a of DATA.arcs) {
      if (a.y > yr || a.y + (a.dur || 0) < yr0 || !isOn(a)) continue; // 流动期与时间窗相交才显示
      if (a.__enter == null) { a.__enter = 0; arcEntering = true; }
      if (!a.__pair) a.__pair = [{ a, halo: true }, { a, halo: false }];
      out.push(a.__pair[0], a.__pair[1]);
    }
    return out;
  }
  function arcCol(e) {
    const col = domById[e.a.d].color;
    const foc = focus.sel === e.a.id || focus.hover === e.a.id;
    const dimmed = (focus.sel || focus.hover) && !foc;
    const k = (e.halo ? 0.15 : 0.8) * (foc ? 1.3 : 1) * (dimmed ? 0.4 : 1);
    return [hexA(col, 0.02), hexA(col, k), hexA(col, k * 0.5)];
  }
  function refreshArcColors() { G.arcColor(e => arcCol(e)); }

  function rescan() {
    const entries = arcEntries();
    if (entries.length !== liveArcEntries.length) {
      liveArcEntries = entries;
      G.arcsData(entries.slice());
      refreshArcColors();
    }
    if (BORDERS) setSnapshot(snapIdxOf(yr));
  }

  // globe.gl 的默认灯在 init 之后才入场,得在 tick 里补刀直到灭干净(自发光贴图不需要任何灯)
  let lightsKilled = false;
  function killLights() {
    if (lightsKilled) return;
    let found = 0;
    G.scene().traverse(o => { if (o.isLight) { o.intensity = 0; found++; } });
    if (found >= 2) lightsKilled = true;
  }

  // —— 主时钟(app 的 RAF 每帧调用) ——
  function tick(dt) {
    if (!G) return;
    wireFlatMaterial();
    killLights();
    if (lastScanYr === null || Math.abs(yr - lastScanYr) >= 1 || Math.abs(yr0 - (lastScanYr0 == null ? yr0 : lastScanYr0)) >= 1 || lastScanYr0 == null || forceScan) {
      lastScanYr = yr; lastScanYr0 = yr0; forceScan = false; rescan();
    }
    if (arcEntering) {
      let still = false;
      for (const e of liveArcEntries) {
        if (e.halo) continue;
        const a = e.a;
        if (a.__enter < 1) { a.__enter = Math.min(1, a.__enter + dt / 1.6); still = true; }
      }
      G.arcDashInitialGap(e => 1 - (e.a.__enter == null ? 1 : e.a.__enter));
      if (!still) arcEntering = false;
    }
    tickBorders(dt);
  }

  // —— 节点投影同步:把球面坐标投到屏幕,写回 n._gx/_gy/_front(地平线剔除系数) ——
  function syncScreen(nodes) {
    if (!G) return;
    const pov = G.pointOfView();
    const cf = Math.cos(pov.lat * RAD), sf = Math.sin(pov.lat * RAD);
    const cl = Math.cos(pov.lng * RAD), sl = Math.sin(pov.lng * RAD);
    const cx = cf * cl, cy = sf, cz = cf * sl;
    const limit = 1 / (1 + pov.altitude) + 0.02;
    for (const n of nodes) {
      if (n.y > yr + 200) { n._front = 0; continue; } // 远未出生的不必投影(留 200 年余量给淡出)
      if (!n.__v3) {
        const f = n.lat * RAD, l = n.lon * RAD;
        n.__v3 = [Math.cos(f) * Math.cos(l), Math.sin(f), Math.cos(f) * Math.sin(l)];
      }
      const v = n.__v3;
      const dot = v[0] * cx + v[1] * cy + v[2] * cz;
      n._front = clamp((dot - limit) * 9, 0, 1);
      if (n._front <= 0) continue;
      const p = G.getScreenCoords(n.lat, n.lon, 0.03); // 抬到位移地形之上,山区节点不被山体吞掉
      if (p) { n._gx = p.x; n._gy = p.y; }
    }
  }

  // —— 镜头 ——
  let resumeTimer = null;
  function autoRotate(on) { if (G) G.controls().autoRotate = on; }
  function userInteracted() {
    autoRotate(false);
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => { resumeTimer = null; if (!focus.sel) autoRotate(true); }, 18000);
  }
  function flyTo(lat, lon, ms) {
    const pov = G.pointOfView();
    G.pointOfView({ lat, lng: lon, altitude: clamp(pov.altitude, 1.05, 1.9) }, ms || 1100);
  }
  function midLon(a, b) {
    let d = b - a;
    if (d > 180) d -= 360; if (d < -180) d += 360;
    let m = a + d / 2;
    if (m > 180) m -= 360; if (m < -180) m += 360;
    return m;
  }

  // —— API ——
  function init(opts) {
    if (!supported()) return false;
    DATA = opts.DATA; BORDERS = opts.BORDERS; domById = opts.domById;
    cb = opts.callbacks; fmtYear = opts.fmtYear;
    enabled = opts.enabled;
    if (opts.isOn) isOn = opts.isOn;
    root = opts.el;

    G = new Globe(root, {
      animateIn: false,
      rendererConfig: { antialias: true, alpha: true, powerPreference: 'high-performance' },
    });
    buildBase(opts.LAND);
    G.backgroundColor('rgba(0,0,0,0)')
      .width(window.innerWidth).height(window.innerHeight)
      .showAtmosphere(true).atmosphereColor('#4272C8').atmosphereAltitude(0.15)
      .globeImageUrl(TINY_DARK)
      .polygonsTransitionDuration(0)
      .polygonGeoJsonGeometry(f => f.geometry)
      .polygonAltitude(0.028)  // 抬到珠峰位移(2.2)之上,疆界不被山体戳穿
      .polygonSideColor(() => 'rgba(0,0,0,0)')
      .polygonLabel(f => {
        if (focus.hover) return null; // 正悬停节点/弧时,版图提示静默,不与微卡叠层
        const y = curSnapIdx >= 0 ? BORDERS.years[curSnapIdx] : null;
        // 双语:英文原名(中文);词典没收录或与原名相同时只显示原名
        const bi = s => {
          const z = window.TERR_ZH && window.TERR_ZH[s];
          return z && z !== s ? s + '(' + z + ')' : s;
        };
        const name = f.n ? bi(f.n) : '小邦与部落地带';
        const suzerain = f.s && f.s !== f.n ? bi(f.s) : null; // 宗主=自身时省略
        return `<div class="terr-tip"><b>${name}</b>` +
          (suzerain ? `<span>宗主:${suzerain}</span>` : '') +
          (y != null ? `<span>${fmtYear(y)} 快照 · 疆界为示意</span>` : '') + '</div>';
      })
      .onPolygonHover(f => {
        hoverFeat = f || null;
        refreshBorderColors();
        if (cb.onTerr) cb.onTerr(!!f);
      })
      .onPolygonClick(f => { // 点版图 → 该政权的历史面板(无名部落地带不响应)
        if (f && f.n && cb.onTerrClick) cb.onTerrClick(f.n);
      })
      .arcsTransitionDuration(0)
      .arcStartLat(e => e.a.from[0]).arcStartLng(e => e.a.from[1])
      .arcEndLat(e => e.a.to[0]).arcEndLng(e => e.a.to[1])
      .arcAltitudeAutoScale(0.32)
      .arcStroke(e => (0.42 + e.a.w * 0.18) * (e.halo ? 3.1 : 1))
      .arcCurveResolution(48)
      .arcDashLength(0.55).arcDashGap(0.22)
      .arcDashInitialGap(e => 1 - (e.a.__enter == null ? 1 : e.a.__enter))
      .arcDashAnimateTime(e => 5200 - e.a.w * 900)
      .onArcHover(e => cb.onHover(e ? e.a.id : null))
      .onArcClick(e => { if (e) cb.onClick(e.a.id); })
      .ringLat(r => r.lat).ringLng(r => r.lon).ringAltitude(0.03)
      .ringMaxRadius(4.6).ringPropagationSpeed(1.5).ringRepeatPeriod(1150)
      .ringColor(r => t => hexA(r.__c || domById[r.d].color, 0.55 * (1 - t)))
      .onGlobeClick(() => cb.onBg());

    refreshBorderColors();
    refreshArcColors();
    // 纹理落地前先自发光深空色 + 掐灭默认灯,避免闪灰
    const m0 = G.globeMaterial();
    if (m0) {
      if (m0.color && m0.color.set) m0.color.set('#000000');
      if (m0.emissive && m0.emissive.set) m0.emissive.set('#0B1324');
    }
    G.scene().traverse(o => {
      if (o.isDirectionalLight || o.isAmbientLight) o.intensity = 0;
    });
    window.__CIV_G = G; // 调试口:renderer().info / scene() 体检用

    G.pointOfView({ lat: 22, lng: 60, altitude: 2.1 }, 0);
    const c = G.controls();
    c.autoRotate = true; c.autoRotateSpeed = -0.32;
    c.enableDamping = true; c.dampingFactor = 0.08;
    c.rotateSpeed = 0.72; c.zoomSpeed = 0.6;
    c.minDistance = 128; c.maxDistance = 520;
    root.addEventListener('pointerdown', userInteracted);
    root.addEventListener('wheel', userInteracted, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) G.pauseAnimation(); else if (active) G.resumeAnimation();
    });
    return true;
  }

  return {
    supported,
    init,
    tick,
    syncScreen,
    setYear: (y, y0) => { yr = y; yr0 = y0 == null ? -3300001 : y0; },
    setEnabled: () => { forceScan = true; },
    altitude: () => G ? G.pointOfView().altitude : 2.1,
    setFocus: (hover, sel) => {
      const changed = focus.hover !== hover || focus.sel !== sel;
      focus.hover = hover; focus.sel = sel;
      if (!changed || !G) return;
      refreshArcColors();
      const selNode = sel && DATA.nodes.find(n => n.id === sel);
      G.ringsData(selNode ? [selNode] : []);
      if (sel) autoRotate(false);
      else if (!resumeTimer) autoRotate(true);
    },
    flyToItem: it => {
      if (!G || !it) return;
      if (it.kind === 'arc') flyTo((it.from[0] + it.to[0]) / 2, midLon(it.from[1], it.to[1]), 1200);
      else flyTo(it.lat, it.lon, 1100);
    },
    // 人口榜/资料面板跳国家:停自转、拉近到国家级视距、版图亮起、落点脉冲环
    focusCountry: o => {
      if (!G || !o) return;
      userInteracted(); // 停自转 + 18 秒后自动恢复,飞到不再被转走
      const pov = G.pointOfView();
      G.pointOfView({ lat: o.lat, lng: o.lon, altitude: clamp(Math.min(pov.altitude, 1.0), 0.72, 1.0) }, 1250);
      hiName = o.name || null;
      refreshBorderColors();
      if (hiTimer) clearTimeout(hiTimer);
      hiTimer = setTimeout(() => { hiName = null; hiTimer = null; refreshBorderColors(); }, 7000);
      G.ringsData([{ lat: o.lat, lon: o.lon, __c: '#8FB0E0' }]);
    },
    setActive: on => {
      active = on;
      if (!G) return;
      if (on) G.resumeAnimation(); else G.pauseAnimation();
    },
    resize: () => { if (G) G.width(window.innerWidth).height(window.innerHeight); },
  };
})();
