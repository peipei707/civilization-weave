/* 文明星图 · 主引擎(vanilla + 双画布 + GlobeView)
 * 层次:#scene(星空底,最下)→ #globe(3D 地球:球体/疆界/迁徙弧)→ #fg(节点光点/标签/影响线,最上,不截获指针)。
 * 节点永远画在 2D 前景层:地图模式下位置来自 GlobeView.syncScreen 的球面投影(带地平线剔除),
 * 网络模式 morph 到放射布局——同一套绘制与动画代码,两种世界。无 WebGL 时退回 v1 平面地图。
 * 依赖:window.DATA、window.LAND、window.BORDERS(可缺)、window.GlobeView。 */
(function () {
  'use strict';
  const DATA = window.DATA, LAND = window.LAND || [];
  const canvas = document.getElementById('scene');
  const ctx = canvas.getContext('2d');
  const fg = document.getElementById('fg');
  const fx = fg.getContext('2d');

  // —— 工具 ——
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (cur, tgt, k, dt) => lerp(cur, tgt, 1 - Math.pow(1 - k, dt * 60));
  const domById = {}; DATA.domains.forEach(d => domById[d.id] = d);

  // —— 领域子类(节点可带 sub 字段;图例展开分支可单独开关)——
  const SUBCATS = {
    art: [['painting', '绘画'], ['sculpture', '雕塑'], ['arch', '建筑'], ['music', '音乐'], ['lit', '文学'], ['stage', '戏剧影视'], ['craft', '工艺设计']],
    sci: [['math', '数学'], ['phys', '物理'], ['chem', '化学'], ['bio', '生物医学'], ['astro', '天文航天'], ['tech', '技术工程'], ['info', '信息计算'], ['earth', '地球环境']],
    eco: [['money', '货币金融'], ['trade', '贸易商路'], ['agri', '农业'], ['industry', '工业制造'], ['inst', '制度组织'], ['transport', '交通物流']],
    pol: [['empire', '帝国王朝'], ['law', '法律制度'], ['rev', '革命运动'], ['treaty', '条约体系'], ['org', '国际组织'], ['war', '战争冲突']],
    rel: [['christ', '基督教系'], ['islam', '伊斯兰系'], ['dharma', '印度诸教'], ['eastasia', '东亚信仰'], ['judaism', '犹太教系'], ['indigenous', '原生与新兴']],
    phi: [['classical', '古典源流'], ['ethics', '伦理政治'], ['logic', '逻辑认识论'], ['mind', '心性与修养'], ['modern', '近现代思潮'], ['social', '社会批判']],
    ren: [['evo', '古人群演化'], ['lang', '语系扩散'], ['migr', '移民浪潮'], ['identity', '身份认同'], ['refuge', '难民流动'], ['settle', '聚落定居']],
  };
  const SUBNAME = {};
  Object.entries(SUBCATS).forEach(([d, list]) => list.forEach(([slug, name]) => SUBNAME[d + ':' + slug] = name));

  // 统一条目索引(节点 + 迁徙弧)
  const ITEMS = {};
  DATA.nodes.forEach(n => { n.kind = 'node'; n._a = 0; ITEMS[n.id] = n; });
  DATA.arcs.forEach(a => { a.kind = 'arc'; a._g = 0; ITEMS[a.id] = a; });

  // 邻接(影响关系,双向用于高亮;有向 in/out 用于脉络树)
  const adj = {}, outAdj = {}, inAdj = {};
  const edges = [];
  Object.values(ITEMS).forEach(it => {
    (it.links || []).forEach(t => {
      if (!ITEMS[t]) return;
      (adj[it.id] = adj[it.id] || new Set()).add(t);
      (adj[t] = adj[t] || new Set()).add(it.id);
      (outAdj[it.id] = outAdj[it.id] || []).push(t);
      (inAdj[t] = inAdj[t] || []).push(it.id);
      if (it.kind === 'node') edges.push([it.id, t]);
    });
  });
  // 脉络:沿影响边向上/向下各追两级(去重、封顶,时间序排列)
  function lineageOf(id) {
    const byY = arr => arr.sort((a, b) => ITEMS[a].y - ITEMS[b].y);
    const seen = new Set([id]);
    const grab = (ids, map) => {
      const out = [];
      ids.forEach(u => (map[u] || []).forEach(g => { if (!seen.has(g)) { seen.add(g); out.push(g); } }));
      return byY(out);
    };
    const up1 = byY((inAdj[id] || []).filter(x => !seen.has(x) && seen.add(x)));
    const down1 = byY((outAdj[id] || []).filter(x => !seen.has(x) && seen.add(x)));
    const up2 = grab(up1, inAdj), down2 = grab(down1, outAdj);
    return { up2, up1, down1, down2 };
  }

  // —— 状态 ——
  const S = {
    W: 0, H: 0, dpr: 1,
    map: { x: 0, y: 0, w: 0, h: 0 },
    latMax: 84, latMin: -58,
    frac: 1, tFrac: 1,
    frac0: 0, tFrac0: 0,         // 左手柄:时间窗起点(0=不截取,即累积模式)
    playing: false, speed: 1,
    morph: 0, tMorph: 0,         // 0=地图,1=网络
    netZoom: 1, netPanX: 0, netPanY: 0,  // 网络模式的缩放与平移(光标锚定)
    hover: null, hover2d: null, hover3d: null, sel: null,
    terrHover: false, clickHandledAt: 0,
    enabled: new Set(DATA.domains.map(d => d.id)),
    subOff: new Set(),           // 关闭的子类("d:sub" 键)
    t: 0, mx: 0, my: 0,
  };
  let GLOBE3D = false;
  const globeEl = document.getElementById('globe');

  // —— 非线性时间刻度(前端延伸到最早石器;深史前占足轨道宽度,拖动可停在任意一段远古)——
  const STOPS = [
    [-3300000, 0], [-500000, .05], [-70000, .12], [-10000, .21], [-3000, .30], [0, .40],
    [1000, .50], [1500, .615], [1800, .72], [1900, .82], [2026, 1],
  ];
  function yearToFrac(y) {
    if (y <= STOPS[0][0]) return 0;
    if (y >= STOPS[STOPS.length - 1][0]) return 1;
    for (let i = 1; i < STOPS.length; i++) {
      if (y <= STOPS[i][0]) {
        const [y0, f0] = STOPS[i - 1], [y1, f1] = STOPS[i];
        return f0 + (f1 - f0) * (y - y0) / (y1 - y0);
      }
    }
    return 1;
  }
  function fracToYear(f) {
    f = clamp(f, 0, 1);
    for (let i = 1; i < STOPS.length; i++) {
      if (f <= STOPS[i][1]) {
        const [y0, f0] = STOPS[i - 1], [y1, f1] = STOPS[i];
        return y0 + (y1 - y0) * (f - f0) / (f1 - f0 || 1);
      }
    }
    return 2026;
  }
  const curYear = () => fracToYear(S.frac);
  const curYear0 = () => S.frac0 < 0.002 ? -3300001 : fracToYear(S.frac0); // 贴左端=全包含
  const itemOn = it => S.enabled.has(it.d) && !(it.sub && S.subOff.has(it.d + ':' + it.sub));

  function eraOf(y) {
    if (y < -70000) return '深史前 · 人类摇篮';
    if (y < -10000) return '旧石器时代';
    if (y < -3000) return '新石器 · 农业';
    if (y < -800) return '上古文明';
    if (y < -200) return '轴心时代';
    if (y < 500) return '古典帝国';
    if (y < 1400) return '中世纪';
    if (y < 1600) return '大航海与文艺复兴';
    if (y < 1780) return '科学革命';
    if (y < 1900) return '革命与工业';
    if (y < 1945) return '世界大战';
    if (y < 1991) return '冷战';
    return '全球化 · 信息时代';
  }
  function fmtYear(y) {
    y = Math.round(y);
    if (y <= -10000) { // 万年制:前7万 / 前1.3万 / 前330万
      const w = -y / 10000;
      const s = w >= 100 ? Math.round(w) : Math.round(w * 10) / 10;
      return '前' + s + '万';
    }
    if (y < 0) return '前' + (-y).toLocaleString();
    return '' + y;
  }

  // —— 投影与布局 ——
  function project(lat, lon, m) {
    return [m.x + (lon + 180) / 360 * m.w,
            m.y + (S.latMax - lat) / (S.latMax - S.latMin) * m.h];
  }
  let netCenter = { x: 0, y: 0, r: 0 };
  function computeLayout() {
    const W = S.W, H = S.H;
    const A = 360 / (S.latMax - S.latMin);
    const availW = W - 24, availH = H - 70 - 96;
    let mw, mh;
    if (availW / availH > A) { mh = availH; mw = mh * A; }
    else { mw = availW; mh = mw / A; }
    S.map = { x: (W - mw) / 2, y: 70 + (availH - mh) / 2, w: mw, h: mh };
    netCenter = { x: W / 2, y: S.map.y + mh / 2, r: Math.min(mw, mh) * 0.46 };
    if (!GLOBE3D) {
      DATA.nodes.forEach(n => { const p = project(n.lat, n.lon, S.map); n._gx = p[0]; n._gy = p[1]; });
    } else {
      GlobeView.syncScreen(DATA.nodes); // 窗口变化后立刻取一次新投影(网络模式下也要,当 morph 回程起点)
    }
    DATA.arcs.forEach(a => {
      a._f = project(a.from[0], a.from[1], S.map);
      a._t = project(a.to[0], a.to[1], S.map);
    });
    computeNetwork();
    renderStatic();
  }
  function computeNetwork() {
    const byDom = {}; DATA.domains.forEach(d => byDom[d.id] = []);
    DATA.nodes.forEach(n => byDom[n.d].push(n));
    const sw = 2 * Math.PI / DATA.domains.length;
    DATA.domains.forEach((d, di) => {
      const list = byDom[d.id].sort((a, b) => a.y - b.y);
      const center = -Math.PI / 2 + (di + 0.5) * sw;
      list.forEach((n, k) => {
        const off = list.length > 1 ? (k / (list.length - 1) - 0.5) * sw * 0.82 : 0;
        const ang = center + off;
        const r = lerp(netCenter.r * 0.26, netCenter.r, yearToFrac(n.y));
        n._nx = netCenter.x + Math.cos(ang) * r;
        n._ny = netCenter.y + Math.sin(ang) * r;
      });
    });
  }
  const netX = n => netCenter.x + (n._nx - netCenter.x) * S.netZoom + S.netPanX;
  const netY = n => netCenter.y + (n._ny - netCenter.y) * S.netZoom + S.netPanY;
  const nodePos = n => [lerp(n._gx || netCenter.x, netX(n), S.morph), lerp(n._gy || netCenter.y, netY(n), S.morph)];

  // —— 静态层(星空;fallback 再加经纬与陆地)——
  let staticCv = null;
  function seedRand(s) { return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; }
  function renderStatic() {
    const c = staticCv || (staticCv = document.createElement('canvas'));
    c.width = S.W * S.dpr; c.height = S.H * S.dpr;
    const x = c.getContext('2d'); x.scale(S.dpr, S.dpr);
    x.clearRect(0, 0, S.W, S.H);
    const rnd = seedRand(20260712);
    for (let i = 0; i < 260; i++) {
      const sx = rnd() * S.W, sy = rnd() * S.H, r = rnd() * 1.1 + 0.2, a = rnd() * 0.5 + 0.08;
      x.beginPath(); x.arc(sx, sy, r, 0, 7); x.fillStyle = 'rgba(200,214,240,' + a.toFixed(2) + ')'; x.fill();
    }
    if (GLOBE3D) return;
    const m = S.map;
    x.strokeStyle = 'rgba(120,150,200,.07)'; x.lineWidth = 1;
    for (let lon = -180; lon <= 180; lon += 30) { const p0 = project(S.latMax, lon, m), p1 = project(S.latMin, lon, m); x.beginPath(); x.moveTo(p0[0], p0[1]); x.lineTo(p1[0], p1[1]); x.stroke(); }
    for (let lat = -30; lat <= 60; lat += 30) { const p0 = project(lat, -180, m), p1 = project(lat, 180, m); x.beginPath(); x.moveTo(p0[0], p0[1]); x.lineTo(p1[0], p1[1]); x.stroke(); }
    x.save();
    x.beginPath();
    for (const feat of LAND) for (const ring of feat) {
      for (let i = 0; i < ring.length; i++) { const p = project(ring[i][1], ring[i][0], m); i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1]); }
      x.closePath();
    }
    x.fillStyle = 'rgba(20,32,54,.62)';
    x.shadowColor = 'rgba(70,120,190,.5)'; x.shadowBlur = 8;
    x.fill('evenodd');
    x.shadowBlur = 0;
    x.lineWidth = 0.8; x.strokeStyle = 'rgba(90,140,205,.5)'; x.stroke();
    x.restore();
  }

  // —— 尺寸 ——
  function resize() {
    S.W = window.innerWidth; S.H = window.innerHeight; S.dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const cv of [canvas, fg]) {
      cv.width = S.W * S.dpr; cv.height = S.H * S.dpr;
      cv.style.width = S.W + 'px'; cv.style.height = S.H + 'px';
    }
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    fx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    if (GLOBE3D) GlobeView.resize();
    computeLayout();
  }

  // —— 绘制 ——
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function bez(p0, p1, lift) {
    const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], len = Math.hypot(dx, dy) || 1;
    return [mx - dy / len * lift, my + dx / len * lift];
  }
  function qpt(p0, c, p1, t) {
    const u = 1 - t;
    return [u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0],
            u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]];
  }
  const frontOf = n => GLOBE3D ? lerp(n._front == null ? 0 : n._front, 1, S.morph) : 1;

  function drawArcs(dt) { // 仅 fallback 平面地图使用
    const yr = curYear(), yr0 = curYear0();
    const arcAlpha = 1 - S.morph;
    for (const a of DATA.arcs) {
      const active = (yr >= a.y && a.y + (a.dur || 0) >= yr0) ? 1 : 0; // 流动期与时间窗相交
      a._g = smooth(a._g, active, 0.10, dt);
      if (a._g < 0.01 || arcAlpha < 0.02) continue;
      if (!itemOn(a)) continue;
      const col = domById[a.d].color;
      const p0 = a._f, p1 = a._t, len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const c = bez(p0, p1, Math.min(len * 0.28, 130));
      const foc = S.sel === a.id || S.hover === a.id;
      const base = (foc ? 0.95 : 0.5) * a._g * arcAlpha;
      const N = 44, gg = a._g;
      fx.lineCap = 'round'; fx.lineJoin = 'round';
      for (let pass = 0; pass < 2; pass++) {
        fx.beginPath();
        for (let i = 0; i <= N; i++) { const t = i / N * gg; const p = qpt(p0, c, p1, t); i ? fx.lineTo(p[0], p[1]) : fx.moveTo(p[0], p[1]); }
        fx.strokeStyle = hexA(col, pass ? base : base * 0.4);
        fx.lineWidth = pass ? (1 + a.w * 0.5) : (5 + a.w * 1.5);
        fx.stroke();
      }
      if (gg < 0.999) { const h = qpt(p0, c, p1, gg); fx.beginPath(); fx.arc(h[0], h[1], 2.6, 0, 7); fx.fillStyle = hexA(col, base + .2); fx.shadowColor = col; fx.shadowBlur = 12; fx.fill(); fx.shadowBlur = 0; }
      const pulse = 0.5 + 0.5 * Math.sin(S.t * 2.2 + a.y);
      fx.beginPath(); fx.arc(p1[0], p1[1], 2 + pulse * 1.5, 0, 7); fx.fillStyle = hexA(col, base * 0.9); fx.fill();
    }
  }

  function drawEdges() {
    const focus = S.sel || S.hover;
    const showAll = S.morph > 0.03;
    if (!showAll && !focus) return;
    for (const [a, b] of edges) {
      const na = ITEMS[a], nb = ITEMS[b];
      const rel = focus && (a === focus || b === focus);
      let alpha;
      if (showAll) alpha = (rel ? 0.5 : 0.10) * S.morph + (rel ? 0.32 * (1 - S.morph) : 0);
      else alpha = rel ? 0.42 : 0;
      alpha *= Math.min(na._a * frontOf(na), nb._a * frontOf(nb));
      if (alpha < 0.02) continue;
      const pa = nodePos(na), pb = nodePos(nb);
      const c = bez(pa, pb, Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) * 0.16);
      fx.beginPath(); fx.moveTo(pa[0], pa[1]); fx.quadraticCurveTo(c[0], c[1], pb[0], pb[1]);
      fx.strokeStyle = hexA(rel ? '#E9B44C' : '#8FB0E0', alpha); fx.lineWidth = rel ? 1.3 : 0.7; fx.stroke();
    }
  }

  const FONT_LABEL = "12.5px 'Source Han Serif SC','Noto Serif SC',Georgia,serif";
  const FONT_LABEL_FOC = "600 13px 'Source Han Serif SC','Noto Serif SC',Georgia,serif";
  function drawNodes(dt) {
    const yr = curYear(), yr0 = curYear0();
    const focus = S.sel || S.hover;
    const neigh = focus ? (adj[focus] || new Set()) : null;
    const labels = [];
    for (const n of DATA.nodes) {
      const on = itemOn(n) ? 1 : 0;
      const born = (yr >= n.y && n.y >= yr0) ? 1 : 0;
      n._a = smooth(n._a, born * on, 0.09, dt);
      const front = frontOf(n);
      const isFoc = focus === n.id, isNb = neigh && neigh.has(n.id);
      const dim = focus && !isFoc && !isNb ? 0.28 : 1;
      const twinkle = 0.88 + 0.12 * Math.sin(S.t * 1.4 + n.lon);
      const a = n._a * twinkle * dim * front;
      n._vis = n._a * front;
      if (a < 0.01) continue;
      const [x, y] = nodePos(n);
      const col = domById[n.d].color;
      const R = (2.2 + n.w * 1.7) * (0.55 + 0.45 * n._a) * (isFoc ? 1.5 : 1);
      const g = fx.createRadialGradient(x, y, 0, x, y, R * 4.2);
      g.addColorStop(0, hexA(col, 0.5 * a)); g.addColorStop(0.5, hexA(col, 0.14 * a)); g.addColorStop(1, hexA(col, 0));
      fx.beginPath(); fx.arc(x, y, R * 4.2, 0, 7); fx.fillStyle = g; fx.fill();
      fx.beginPath(); fx.arc(x, y, R, 0, 7);
      fx.fillStyle = hexA('#F3F1EA', 0.9 * a); fx.shadowColor = col; fx.shadowBlur = 12 * a; fx.fill(); fx.shadowBlur = 0;
      fx.beginPath(); fx.arc(x, y, R, 0, 7); fx.lineWidth = 1.4; fx.strokeStyle = hexA(col, a); fx.stroke();
      n._x = x; n._y = y; n._r = R;
      if ((n.w >= 3 || isFoc || isNb) && n._a > 0.5) {
        const labA = (isFoc || isNb ? 0.96 : 0.7) * a;
        if (labA > 0.03) labels.push({ n, x, y, R, labA, isFoc, pri: (isFoc ? 4 : 0) + (isNb ? 2 : 0) + n.w });
      }
    }
    // 标签避让:按优先级贪心占格,重叠的让位(节点光点仍在,只是不出字)
    labels.sort((p, q) => q.pri - p.pri);
    const placed = [];
    fx.textBaseline = 'alphabetic';
    for (const L of labels) {
      fx.font = L.isFoc ? FONT_LABEL_FOC : FONT_LABEL;
      if (L.n._tw == null) L.n._tw = fx.measureText(L.n.t).width;
      const bx = L.x + L.R + 6, by = L.y - 9, bw = L.n._tw, bh = 15;
      let hit = false;
      for (const p of placed) {
        if (bx < p.x + p.w + 4 && bx + bw + 4 > p.x && by < p.y + p.h + 2 && by + bh + 2 > p.y) { hit = true; break; }
      }
      if (hit && !L.isFoc) continue;
      placed.push({ x: bx, y: by, w: bw, h: bh });
      fx.fillStyle = hexA('#ECEAE3', L.labA);
      fx.shadowColor = 'rgba(6,9,17,.9)'; fx.shadowBlur = 4;
      fx.fillText(L.n.t, bx, L.y + 4); fx.shadowBlur = 0;
    }
  }

  // —— 主循环 ——
  let lastGlobeOp = -1;
  function frame(now) {
    const dt = Math.min((now - (S._last || now)) / 1000, 0.05); S._last = now; S.t = now / 1000;
    if (S.playing) {
      S.tFrac += dt / 48 * S.speed;
      if (S.tFrac >= 1) { S.tFrac = 1; S.playing = false; syncPlay(); }
    }
    S.frac = smooth(S.frac, S.tFrac, 0.2, dt);
    S.frac0 = smooth(S.frac0, S.tFrac0, 0.2, dt);
    S.morph = smooth(S.morph, S.tMorph, 0.14, dt);

    if (GLOBE3D) {
      GlobeView.setYear(curYear(), curYear0());
      GlobeView.tick(dt);
      if (S.tMorph === 0) GlobeView.syncScreen(DATA.nodes);
      const op = clamp(1 - S.morph * 1.25, 0, 1);
      if (Math.abs(op - lastGlobeOp) > 0.01) {
        lastGlobeOp = op;
        globeEl.style.opacity = op.toFixed(3);
        globeEl.classList.toggle('off', op < 0.45);
      }
    }

    ctx.clearRect(0, 0, S.W, S.H);
    ctx.globalAlpha = GLOBE3D ? 1 : 1 - S.morph * 0.82;
    if (staticCv) ctx.drawImage(staticCv, 0, 0, S.W, S.H);
    ctx.globalAlpha = 1;

    fx.clearRect(0, 0, S.W, S.H);
    drawEdges();
    if (!GLOBE3D) drawArcs(dt);
    drawNodes(dt);
    // 地球自转/播放时鼠标不动,悬停会过期:低频在原地重拾取
    if ((S._hoverT = (S._hoverT || 0) + dt) > 0.25) {
      S._hoverT = 0;
      const id = pick(S.mx, S.my);
      if (id !== S.hover2d) { S.hover2d = id; applyHover(); }
    }
    updateReadout();
    requestAnimationFrame(frame);
  }

  // —— 命中检测(前景节点;fallback 下再查弧线)——
  function pick(mx, my) {
    let best = null, bd = 22 * 22;
    for (const n of DATA.nodes) {
      if ((n._vis || 0) < 0.3) continue;
      const dx = mx - n._x, dy = my - n._y, d = dx * dx + dy * dy;
      const rr = Math.max(14, n._r + 8); if (d < rr * rr && d < bd) { bd = d; best = n.id; }
    }
    if (best) return best;
    if (!GLOBE3D && S.morph < 0.5) {
      for (const a of DATA.arcs) {
        if (a._g < 0.3 || !S.enabled.has(a.d)) continue;
        const p0 = a._f, p1 = a._t, len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        const c = bez(p0, p1, Math.min(len * 0.28, 130));
        for (let i = 0; i <= 20; i++) { const p = qpt(p0, c, p1, i / 20); if ((mx - p[0]) ** 2 + (my - p[1]) ** 2 < 90) return a.id; }
      }
    }
    return null;
  }

  // —— UI ——
  const $ = s => document.querySelector(s);
  const microcard = $('.microcard'), detail = $('.detail'), hintEl = $('.hint');
  const UI_SEL = '.topbar,.legend,.timeline,.detail,.microcard,.hint,.attrib';

  function buildLegend() {
    const wrap = $('.legend');
    // 可简可详:迷你态只剩一排彩点(仍可点按开关领域);手机默认迷你,选择记进 localStorage
    const toggle = wrap.querySelector('.lg-toggle');
    let mini;
    try { mini = localStorage.getItem('cw_legend_mini'); } catch (e) { mini = null; }
    if (mini === null) mini = matchMedia('(max-width: 640px)').matches ? '1' : '0';
    const applyMini = () => {
      wrap.classList.toggle('mini', mini === '1');
      toggle.textContent = mini === '1' ? '⌄' : '⌃';
      toggle.setAttribute('aria-label', mini === '1' ? '展开图例' : '收起图例');
    };
    toggle.onclick = () => {
      mini = mini === '1' ? '0' : '1';
      try { localStorage.setItem('cw_legend_mini', mini); } catch (e) { }
      applyMini();
    };
    applyMini();
    const counts = {}, subCounts = {};
    DATA.domains.forEach(d => counts[d.id] = 0);
    [...DATA.nodes, ...DATA.arcs].forEach(it => {
      counts[it.d]++;
      if (it.sub) { const k = it.d + ':' + it.sub; subCounts[k] = (subCounts[k] || 0) + 1; }
    });
    DATA.domains.forEach(d => {
      const row = document.createElement('div'); row.className = 'lg-row';
      const b = document.createElement('button');
      b.setAttribute('aria-pressed', 'true'); b.style.setProperty('--c', d.color);
      b.innerHTML = '<span class="dot"></span><span class="nm">' + d.name + '</span><span class="ct">' + counts[d.id] + '</span>';
      b.onclick = () => {
        if (S.enabled.has(d.id)) S.enabled.delete(d.id); else S.enabled.add(d.id);
        b.setAttribute('aria-pressed', S.enabled.has(d.id));
        if (GLOBE3D) GlobeView.setEnabled();
      };
      row.appendChild(b);
      // 分支:该领域有带 sub 的条目才给展开箭头
      const subs = (SUBCATS[d.id] || []).filter(([slug]) => subCounts[d.id + ':' + slug]);
      if (subs.length) {
        const caret = document.createElement('button');
        caret.className = 'lg-caret'; caret.setAttribute('aria-label', d.name + ' 分支');
        caret.textContent = '▸';
        const subBox = document.createElement('div'); subBox.className = 'lg-subs';
        subs.forEach(([slug, name]) => {
          const key = d.id + ':' + slug;
          const c = document.createElement('button');
          c.className = 'lg-sub'; c.style.setProperty('--c', d.color);
          c.setAttribute('aria-pressed', 'true');
          c.innerHTML = '<span class="dot"></span>' + name + '<span class="ct">' + subCounts[key] + '</span>';
          c.onclick = () => {
            if (S.subOff.has(key)) S.subOff.delete(key); else S.subOff.add(key);
            c.setAttribute('aria-pressed', !S.subOff.has(key));
            if (GLOBE3D) GlobeView.setEnabled();
          };
          subBox.appendChild(c);
        });
        caret.onclick = () => {
          const open = subBox.classList.toggle('open');
          caret.textContent = open ? '▾' : '▸';
        };
        row.appendChild(caret);
        wrap.appendChild(row);
        wrap.appendChild(subBox);
      } else {
        wrap.appendChild(row);
      }
    });
  }

  function showMicro(id, mx, my) {
    const it = ITEMS[id]; if (!it) { microcard.classList.remove('on'); return; }
    const d = domById[it.d];
    microcard.style.setProperty('--c', d.color);
    microcard.querySelector('.mc-dot').style.background = d.color;
    microcard.querySelector('.mc-t').textContent = it.t;
    microcard.querySelector('.mc-meta').textContent = fmtYear(it.y);
    microcard.querySelector('.mc-g').textContent = it.gist;
    microcard.classList.add('on');
    const w = microcard.offsetWidth, h = microcard.offsetHeight;
    microcard.style.left = clamp(mx + 16, 8, S.W - w - 8) + 'px';
    microcard.style.top = clamp(my + 16, 8, S.H - h - 8) + 'px';
  }

  function applyHover() {
    const id = S.hover2d || S.hover3d;
    if (S.hover !== id) {
      S.hover = id;
      if (GLOBE3D) GlobeView.setFocus(S.hover, S.sel);
    }
    if (id) showMicro(id, S.mx, S.my); else microcard.classList.remove('on');
    const cur = id ? 'pointer' : (S.terrHover ? 'help' : 'default');
    globeEl.style.cursor = cur; document.body.style.cursor = GLOBE3D ? '' : cur;
  }

  function openDetail(id) {
    const it = ITEMS[id]; if (!it) return;
    S.sel = id; const d = domById[it.d];
    detail.style.setProperty('--c', d.color);
    const chip = (tid, sm) => {
      const t = ITEMS[tid]; if (!t) return '';
      const cd = domById[t.d];
      return '<button class="chip' + (sm ? ' chip-sm' : '') + '" data-id="' + t.id + '" style="--cc:' + cd.color + '"><span class="dot"></span>' + t.t + '</button>';
    };
    // —— 配图(维基百科主图+文内插图,热链;点击跳共享资源署名页)——
    const imgs = (window.IMAGES && window.IMAGES[id]) || [];
    const filePage = f => f ? 'https://commons.wikimedia.org/wiki/' + encodeURIComponent(String(f).replace(/^文件:/, 'File:')) : null;
    let media = '';
    if (imgs.length) {
      const im = (m, cls) => '<a class="' + cls + '" href="' + (filePage(m.f) || m.u) + '" target="_blank" rel="noopener">' +
        '<img src="' + m.u + '" loading="lazy" alt="" onerror="this.parentElement.style.display=\'none\'"></a>';
      media = '<figure class="dt-media">' + im(imgs[0], 'dm-hero') +
        (imgs.length > 1 ? '<div class="dm-thumbs">' + imgs.slice(1).map(m => im(m, 'dm-thumb')).join('') + '</div>' : '') +
        '<figcaption>图源:维基百科 / 维基共享资源(点击看原图与授权)</figcaption></figure>';
    }
    // —— 脉络树:源流(上游两级)→ 本条目 → 流变(下游两级)——
    const L = lineageOf(id);
    const row = (ids, label) => ids.length
      ? '<div class="tr-row">' + (label ? '<span class="tr-tag">' + label + '</span>' : '') + ids.slice(0, 6).map(x => chip(x, true)).join('') +
        (ids.length > 6 ? '<span class="tr-more">+' + (ids.length - 6) + '</span>' : '') + '</div>'
      : '';
    const arrow = '<div class="tr-link">↓</div>';
    let tree = '';
    if (L.up1.length || L.down1.length) {
      tree = '<div class="dt-sec">脉络 · 源流与流变</div><div class="dt-tree">' +
        row(L.up2, '远源') + (L.up2.length ? arrow : '') +
        row(L.up1, '源') + (L.up1.length ? arrow : '') +
        '<div class="tr-row tr-self"><span class="dot"></span>' + it.t + '</div>' +
        (L.down1.length ? arrow + row(L.down1, '流') : '') +
        (L.down2.length ? arrow + row(L.down2, '远流') : '') +
        '</div>';
    }
    const kind = it.kind === 'arc' ? '迁徙 · 流动' : d.name;
    const src = it.src ? '<div class="dt-src"><a href="https://zh.wikipedia.org/wiki/' + encodeURIComponent(it.src) + '" target="_blank" rel="noopener">维基百科:' + it.src + ' ↗</a></div>' : '';
    detail.innerHTML =
      '<button class="dt-close" aria-label="关闭">✕</button>' +
      '<span class="dt-domain"><span class="dot"></span>' + kind + '</span>' +
      '<h2>' + it.t + '</h2>' +
      '<p class="dt-gist">' + it.gist + '</p>' +
      media +
      '<div class="dt-meta"><span class="badge">' + fmtYear(it.y) + (it.y < 0 ? ' BCE' : ' CE') + '</span><span class="badge">' + eraOf(it.y) + '</span>' +
      (it.sub && SUBNAME[it.d + ':' + it.sub] ? '<span class="badge badge-sub">' + SUBNAME[it.d + ':' + it.sub] + '</span>' : '') + '</div>' +
      (it.detail ? '<p class="dt-detail">' + it.detail + '</p>' : '') +
      tree +
      src;
    detail.classList.add('on');
    detail.querySelector('.dt-close').onclick = closeDetail;
    detail.querySelectorAll('.chip[data-id]').forEach(c => c.onclick = () => selectAndReveal(c.dataset.id));
    if (GLOBE3D) {
      GlobeView.setFocus(S.hover, S.sel);
      if (S.morph < 0.5) GlobeView.flyToItem(it);
    }
    dismissHint();
  }
  function closeDetail() {
    S.sel = null; detail.classList.remove('on');
    if (GLOBE3D) GlobeView.setFocus(S.hover, S.sel);
  }

  // —— 版图历史面板:点任何政权 → 存续年代(本图快照)+ 实时维基摘要 ——
  let terrYears = null, terrReq = 0;
  function terrYearsOf(name) {
    if (!terrYears) {
      terrYears = {};
      const B = window.BORDERS;
      if (B) for (const y of B.years) for (const f of (B.sets[y].f || [])) {
        if (!f.n) continue;
        const arr = terrYears[f.n] = terrYears[f.n] || [];
        if (arr[arr.length - 1] !== y) arr.push(y); // 同年多块飞地只记一次
      }
    }
    return terrYears[name] || [];
  }
  function openTerr(name) {
    const zh = (window.TERR_ZH && window.TERR_ZH[name]) || name;
    const years = terrYearsOf(name);
    const chips = years.map(y =>
      '<button class="chip terr-y" data-y="' + y + '"><span class="dot"></span>' + fmtYear(y) + '</button>').join('');
    const span = years.length
      ? '<div class="dt-meta"><span class="badge">' + fmtYear(years[0]) + ' — ' + fmtYear(years[years.length - 1]) + '</span><span class="badge">' + years.length + ' 个快照在册</span></div>'
      : '';
    detail.style.setProperty('--c', '#8FB0E0');
    detail.innerHTML =
      '<button class="dt-close" aria-label="关闭">✕</button>' +
      '<span class="dt-domain"><span class="dot"></span>版图 · 历史政权</span>' +
      '<h2>' + zh + (zh !== name ? '<span class="dt-en">' + name + '</span>' : '') + '</h2>' +
      span +
      (chips ? '<div class="dt-sec">在册年代(点击跳转时间轴)</div><div class="dt-links">' + chips + '</div>' : '') +
      '<div class="dt-sec">沿革</div><p class="dt-detail terr-wiki">正在从维基百科取简介…</p>' +
      '<div class="dt-src terr-src"></div>' +
      '<div class="dt-note">疆界与年代为 historical-basemaps 示意性重建,存在争议与简化</div>';
    detail.classList.add('on');
    detail.querySelector('.dt-close').onclick = closeDetail;
    detail.querySelectorAll('.terr-y').forEach(c => c.onclick = () => {
      S.tFrac = clamp(yearToFrac(+c.dataset.y) + 0.004, 0, 1);
      S.playing = false; syncPlay(); dismissHint();
    });
    dismissHint();
    fetchTerrWiki(name, zh, ++terrReq);
  }
  async function fetchTerrWiki(name, zh, req) {
    const box = () => terrReq === req ? detail.querySelector('.terr-wiki') : null;
    const srcBox = () => terrReq === req ? detail.querySelector('.terr-src') : null;
    // 预装快路径:构建时已把简介/缩略图直链烙进页面,点开零等待、离线可用
    const baked = window.TERR_INFO && window.TERR_INFO[name];
    if (baked) {
      const el = box(); if (!el) return;
      el.textContent = baked.e;
      if (baked.u) {
        const fig = document.createElement('figure');
        fig.className = 'dt-media';
        fig.innerHTML = '<span class="dm-hero"><img loading="lazy" src="' + baked.u + '" onerror="this.parentNode.parentNode.style.display=\'none\'"></span>';
        el.parentNode.insertBefore(fig, el);
      }
      const s = srcBox();
      if (s) s.innerHTML = '<a href="https://zh.wikipedia.org/wiki/' + encodeURIComponent(baked.p) + '" target="_blank" rel="noopener">维基百科:' + baked.p + ' ↗</a>';
      return;
    }
    const trySummary = async (lang, title) => {
      const r = await fetch('https://' + lang + '.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title));
      if (!r.ok) throw 0;
      return r.json();
    };
    try {
      let j, lang = 'zh';
      try { j = await trySummary('zh', zh); }
      catch (e) { lang = 'en'; j = await trySummary('en', name); }
      const el = box(); if (!el) return;
      if (j.extract) {
        el.textContent = j.extract + (lang === 'en' ? '(中文维基未收录,以上为英文条目摘要)' : '');
        if (j.thumbnail && j.thumbnail.source) {
          const fig = document.createElement('figure');
          fig.className = 'dt-media';
          fig.innerHTML = '<span class="dm-hero"><img loading="lazy" src="' + j.thumbnail.source + '" onerror="this.parentNode.parentNode.style.display=\'none\'"></span>';
          el.parentNode.insertBefore(fig, el);
        }
        const s = srcBox();
        if (s && j.content_urls) s.innerHTML = '<a href="' + j.content_urls.desktop.page + '" target="_blank" rel="noopener">维基百科:' + (j.title || zh) + ' ↗</a>';
      } else { el.textContent = '维基百科暂无该政权的独立条目。'; }
    } catch (e) {
      const el = box(); if (el) el.textContent = '取不到维基摘要(离线或条目不存在),以上为本图快照信息。';
    }
  }

  function selectAndReveal(id) {
    const it = ITEMS[id]; if (!it) return;
    const f = yearToFrac(it.y);
    if (f > S.tFrac) { S.tFrac = Math.min(1, f + 0.01); S.playing = false; syncPlay(); }
    openDetail(id);
  }

  // —— 世界人口(HYDE/McEvedy/UN 标准估算混编;锚点间对数插值;远古为数量级)——
  const POP_CURVE = [ // [年份, 百万]
    [-3300000, 0.1], [-100000, 0.5], [-70000, 0.6], [-40000, 1.5], [-10000, 4],
    [-5000, 5], [-4000, 7], [-3000, 14], [-2000, 27], [-1000, 50], [-500, 100],
    [-200, 150], [1, 230], [200, 220], [500, 200], [800, 220], [1000, 265],
    [1200, 360], [1340, 440], [1400, 350], [1500, 460], [1600, 555], [1700, 600],
    [1750, 770], [1800, 950], [1850, 1240], [1900, 1650], [1930, 2070], [1950, 2520],
    [1970, 3690], [1990, 5320], [2000, 6140], [2010, 6960], [2020, 7840], [2026, 8200],
  ];
  const POP_REGIONS = [ // [年份, 亚, 欧, 非, 美洲, 大洋洲] 百分比(示意)
    [-1000, 68, 11, 14, 6, 1], [1, 69, 13, 11, 6, 1], [1000, 67, 14, 12, 6, 1],
    [1500, 60, 17, 12, 10, 1], [1700, 65, 20, 11, 3, 1], [1800, 66, 21, 9, 3, 1],
    [1900, 57, 25, 8, 9, 1], [1950, 55, 22, 9, 13, 1], [2000, 60.5, 12, 13, 14, 0.5],
    [2026, 58.5, 9.2, 18.6, 13.2, 0.5],
  ];
  const REGION_META = [['亚洲', '#3FC6E4'], ['欧洲', '#9A7BEA'], ['非洲', '#E9B44C'], ['美洲', '#35C08A'], ['大洋洲', '#EA6BB0']];
  function popAt(y) {
    const C = POP_CURVE;
    if (y <= C[0][0]) return C[0][1];
    if (y >= C[C.length - 1][0]) return C[C.length - 1][1];
    for (let i = 1; i < C.length; i++) if (y <= C[i][0]) {
      const [y0, p0] = C[i - 1], [y1, p1] = C[i];
      return Math.exp(lerp(Math.log(p0), Math.log(p1), (y - y0) / (y1 - y0)));
    }
    return C[C.length - 1][1];
  }
  function fmtPop(m) { // 百万 → 中文单位
    if (m >= 100) return (m / 100 >= 10 ? Math.round(m / 100) : (m / 100).toFixed(1)) + ' 亿';
    if (m >= 1) return Math.round(m * 100).toLocaleString() + ' 万';
    return '约 ' + Math.max(1, Math.round(m * 100)) + ' 万';
  }
  let pbNum = null, pbSpark = null, pbBars = null, lastPopTxt = '';
  function initPop() {
    const box = $('.popbox'); if (!box) return;
    pbNum = box.querySelector('.pb-num');
    pbSpark = box.querySelector('.pb-spark');
    pbBars = box.querySelector('.pb-bars');
    const toggle = () => { box.classList.toggle('open'); renderPopBars(curYear()); };
    box.addEventListener('click', toggle);
    box.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  }
  function renderPopBars(yr) {
    if (!pbBars) return;
    let row = POP_REGIONS[0];
    for (const r of POP_REGIONS) { if (r[0] <= yr) row = r; else break; }
    pbBars.innerHTML = REGION_META.map(([nm, c], i) => {
      const pc = row[i + 1];
      return '<div class="pb-row" style="--c:' + c + '"><span class="nm">' + nm + '</span><span class="bar"><i style="width:' + pc + '%"></i></span><span class="pc">' + pc + '%</span></div>';
    }).join('') + '<div class="pb-row" style="opacity:.55"><span class="nm"></span><span style="font-size:9.5px">' + fmtYear(row[0]) + ' 年样点</span></div>';
  }
  function updatePop(yr) {
    if (!pbNum) return;
    const txt = fmtPop(popAt(yr));
    if (txt !== lastPopTxt) {
      lastPopTxt = txt;
      pbNum.textContent = txt;
      if ($('.popbox').classList.contains('open')) renderPopBars(yr);
    }
    // 走势小图:x 轴复用时间轴的非线性刻度,与底部时间轴对齐直觉
    const c = pbSpark; if (!c) return;
    const x = c.getContext('2d'), W = c.width, H = c.height;
    x.clearRect(0, 0, W, H);
    const lnMin = Math.log(0.08), lnMax = Math.log(9000);
    x.beginPath();
    POP_CURVE.forEach(([y, p], i) => {
      const px = yearToFrac(y) * (W - 6) + 3;
      const py = H - 3 - (Math.log(p) - lnMin) / (lnMax - lnMin) * (H - 7);
      i ? x.lineTo(px, py) : x.moveTo(px, py);
    });
    x.strokeStyle = 'rgba(233,180,76,.55)'; x.lineWidth = 1.4; x.stroke();
    const mx = yearToFrac(yr) * (W - 6) + 3;
    const my = H - 3 - (Math.log(popAt(yr)) - lnMin) / (lnMax - lnMin) * (H - 7);
    x.beginPath(); x.arc(mx, my, 2.6, 0, 7); x.fillStyle = '#E9B44C'; x.fill();
    x.beginPath(); x.arc(mx, my, 5, 0, 7); x.fillStyle = 'rgba(233,180,76,.25)'; x.fill();
  }

  function updateReadout() {
    const yr = curYear(), yr0 = curYear0();
    const windowed = S.frac0 > 0.002;
    $('.tl-year').textContent = windowed ? fmtYear(yr0) + '~' + fmtYear(yr) : fmtYear(yr);
    $('.tl-era').textContent = eraOf(yr);
    const tk = $('.tl-track');
    tk.style.setProperty('--p', (S.frac * 100).toFixed(2) + '%');
    tk.style.setProperty('--p0', (S.frac0 * 100).toFixed(2) + '%');
    let recent = null;
    for (const it of Object.values(ITEMS)) if (it.y <= yr && it.y >= yr0 && (!recent || it.y > recent.y)) recent = it;
    $('.tl-ev').textContent = recent ? '　最新:' + recent.t : (windowed ? '　(窗内无事件)' : '');
    updatePop(yr);
  }

  // —— 时间轴交互 ——
  function trackFrac(clientX) {
    const r = $('.tl-track').getBoundingClientRect();
    return clamp((clientX - r.left) / r.width, 0, 1);
  }
  function syncPlay() {
    const btn = $('.play');
    btn.innerHTML = S.playing
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>';
    btn.setAttribute('aria-label', S.playing ? '暂停' : '播放');
  }
  function togglePlay() {
    if (!S.playing && S.tFrac >= 0.999) { S.tFrac = S.tFrac0; S.frac = S.tFrac0; } // 从窗起点重播
    S.playing = !S.playing; syncPlay(); dismissHint();
  }
  function dismissHint() { if (hintEl) hintEl.classList.add('off'); }

  // —— 事件(挂 window:前景画布不截获指针,地球在下层照常拖转)——
  function onMove(e) {
    S.mx = e.clientX; S.my = e.clientY;
    // 网络模式下按住左键拖动 = 平移星座(与地图模式拖转地球对位)
    if (pd && !pd.ui && S.morph > 0.5 && e.buttons === 1) {
      S.netPanX += e.clientX - pd.lx; S.netPanY += e.clientY - pd.ly;
      pd.lx = e.clientX; pd.ly = e.clientY;
      pd.panned = true;
      document.body.style.cursor = 'grabbing';
      microcard.classList.remove('on');
      return;
    }
    S.hover2d = e.target.closest && e.target.closest(UI_SEL) ? null : pick(S.mx, S.my);
    applyHover();
  }
  // 节点点击走 pointerup 捕获:globe.gl 在 pointerup(早于 click)就派发自己的点击,
  // 必须赶在它之前立好 clickHandled,否则它的"点空白=关详情"会吞掉我们的选中。
  let pd = null;
  function onPointerDown(e) {
    pd = {
      x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY,
      t: performance.now(), panned: false,
      ui: !!(e.target.closest && e.target.closest(UI_SEL)),
    };
  }
  function onPointerUp(e) {
    if (!pd) return;
    const moved = Math.hypot(e.clientX - pd.x, e.clientY - pd.y), dt = performance.now() - pd.t;
    const wasPan = pd.panned, wasUi = pd.ui;
    pd = null;
    if (wasPan) { document.body.style.cursor = ''; return; }  // 平移收尾不算点选
    if (moved > 5 || dt > 600) return;                        // 拖拽/长按不算点选
    if (wasUi) return;
    const id = pick(e.clientX, e.clientY);
    if (id) { S.clickHandledAt = performance.now(); openDetail(id); }
  }
  // 网络模式滚轮缩放(光标锚定);地图模式的滚轮由地球的轨道控制器自行消费
  function onWheel(e) {
    if (S.morph < 0.5) return;
    if (e.target.closest && e.target.closest(UI_SEL)) return;
    e.preventDefault();
    const z0 = S.netZoom, z1 = clamp(z0 * Math.exp(-e.deltaY * 0.0012), 0.5, 6);
    if (z1 === z0) return;
    const k = z1 / z0;
    S.netPanX = e.clientX - netCenter.x - (e.clientX - netCenter.x - S.netPanX) * k;
    S.netPanY = e.clientY - netCenter.y - (e.clientY - netCenter.y - S.netPanY) * k;
    S.netZoom = z1;
    dismissHint();
  }
  function onDblClick(e) { // 双击空白:网络视角复位
    if (S.morph < 0.5) return;
    if (e.target.closest && e.target.closest(UI_SEL)) return;
    if (pick(e.clientX, e.clientY)) return;
    S.netZoom = 1; S.netPanX = 0; S.netPanY = 0;
  }
  const clickGuard = () => performance.now() - S.clickHandledAt < 350; // globe.gl 会在 pointerup 与 click 各派发一次

  function initTrack() {
    const track = $('.tl-track'); let drag = null; // null | 'a'(左) | 'b'(右)
    const set = (x, which) => {
      const f = trackFrac(x);
      if (which === 'a') {
        S.tFrac0 = clamp(f, 0, S.tFrac - 0.005);
        if (S.tFrac0 < 0.012) S.tFrac0 = 0; // 贴边吸附=退出截取
      } else {
        S.tFrac = clamp(f, S.tFrac0 + 0.005, 1);
      }
      S.playing = false; syncPlay(); dismissHint();
    };
    track.addEventListener('pointerdown', e => {
      e.preventDefault();
      const f = trackFrac(e.clientX);
      // 就近抓手柄;左手柄贴 0 时偏向右手柄(免得每次点击都误抓截取点)
      drag = (Math.abs(f - S.tFrac0) < Math.abs(f - S.tFrac) && !(S.tFrac0 === 0 && f > 0.05)) ? 'a' : 'b';
      try { track.setPointerCapture(e.pointerId); } catch (_) {}
      set(e.clientX, drag);
    });
    track.addEventListener('pointermove', e => { if (drag) set(e.clientX, drag); });
    track.addEventListener('pointerup', () => drag = null);
    const ticks = $('.tl-ticks');
    [[-1000000, '前100万'], [-100000, '前10万'], [-10000, '前1万'], [-3000, '前3000'], [0, '公元'], [1000, '1000'], [1500, '1500'], [1800, '1800'], [1900, '1900'], [2000, '2000']].forEach(([y, lb]) => {
      const t = document.createElement('div'); t.className = 'tick'; t.style.left = (yearToFrac(y) * 100) + '%';
      t.innerHTML = '<span>' + lb + '</span>'; ticks.appendChild(t);
    });
  }

  function initModes() {
    document.querySelectorAll('.modes button').forEach(b => {
      b.onclick = () => {
        const net = b.dataset.mode === 'net';
        if (GLOBE3D) GlobeView.setActive(!net);
        S.tMorph = net ? 1 : 0;
        document.querySelectorAll('.modes button').forEach(x => x.setAttribute('aria-pressed', x === b));
        if (net) { closeDetail(); dismissHint(); }
      };
    });
  }

  function initKeys() {
    window.addEventListener('keydown', e => {
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight') { S.tFrac = clamp(S.tFrac + 0.02, 0, 1); S.playing = false; syncPlay(); }
      else if (e.key === 'ArrowLeft') { S.tFrac = clamp(S.tFrac - 0.02, 0, 1); S.playing = false; syncPlay(); }
      else if (e.key === 'Escape') closeDetail();
    });
  }

  // —— 启动 ——
  function init() {
    const want3d = !/force2d/.test(location.search) && window.GlobeView && GlobeView.supported();
    if (want3d) {
      GLOBE3D = GlobeView.init({
        el: globeEl,
        DATA, LAND, BORDERS: window.BORDERS || null,
        domById, fmtYear,
        enabled: S.enabled,
        isOn: itemOn,
        callbacks: {
          onHover: id => { S.hover3d = id; applyHover(); },
          onClick: id => { if (clickGuard()) return; openDetail(id); },
          onBg: () => { if (clickGuard()) return; closeDetail(); },
          onTerr: on => { S.terrHover = on; applyHover(); },
          onTerrClick: name => { if (clickGuard()) return; S.clickHandledAt = performance.now(); openTerr(name); },
        },
      }) === true;
    }
    if (!GLOBE3D) globeEl.style.display = 'none';

    resize();
    buildLegend(); initTrack(); initModes(); initKeys(); initPop(); syncPlay();
    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('dblclick', onDblClick);
    $('.play').onclick = togglePlay;
    $('.tl-speed').onclick = () => { S.speed = S.speed === 1 ? 2 : S.speed === 2 ? 4 : 1; $('.tl-speed').textContent = S.speed + '×'; };
    DATA.nodes.forEach(n => n._a = 0);
    if (GLOBE3D) GlobeView.setYear(curYear());
    window.CW = { openTerr, reveal: selectAndReveal }; // 公开入口:调试/未来 URL 直达
    requestAnimationFrame(frame);
  }
  init();
})();
