/* 国家人口数据管线:node tools/fetch_population.js
 * 源 = OWID「Population (Gapminder, HYDE & UN)」合并数据集(含公元前至2021,国家级,历史段稀疏);
 * 压缩:每国只保留 [-1000,1,500,1000,1500,1600,1700,1800,1850,1900,1950,1980,2000,2021] 采样点,
 * 按大洲分组,产出 data/pop_countries.json(目标 ≤60KB):
 *   { "亚洲": { "China": {n:"中国", s:[[年,百万],...]}, ... }, ... }
 * 中文名:复用 terr_zh.json + 内置现代国名补充表;没有的保留英文。 */
const fs = require('fs');
const path = require('path');
const { execFile, execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

let PROXY = null;
try {
  const reg = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer', { encoding: 'utf8' });
  const m = reg.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
  const en = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable', { encoding: 'utf8' });
  if (m && /0x1/.test(en)) PROXY = 'http://' + m[1].replace(/^https?:\/\//, '');
} catch (e) { }
console.log('代理:', PROXY || '直连');

function fetchText(url, dest) {
  return new Promise((resolve, reject) => {
    const args = ['-sL', '--max-time', '180', '-o', dest];
    if (PROXY) args.push('--proxy', PROXY);
    args.push(url);
    const t = setTimeout(() => { try { c.kill(); } catch (e) { } reject(new Error('硬超时')); }, 200000);
    const c = execFile('curl', args, err => { clearTimeout(t); err ? reject(err) : resolve(); });
  });
}

// 大洲归属(OWID 实体名 → 大洲);只列主要国家+历史常见实体,面板只展示各洲 top8,长尾无需全收
const CONT = {
  亚洲: 'China India Indonesia Pakistan Bangladesh Japan Philippines Vietnam Iran Turkey Thailand Myanmar South Korea Iraq Afghanistan Saudi Arabia Uzbekistan Malaysia Yemen Nepal North Korea Sri Lanka Kazakhstan Syria Cambodia Jordan Azerbaijan United Arab Emirates Israel Laos Singapore Lebanon Mongolia Armenia Georgia Kuwait Qatar Oman Taiwan',
  欧洲: 'Russia Germany United Kingdom France Italy Spain Ukraine Poland Romania Netherlands Belgium Czechia Greece Portugal Sweden Hungary Austria Belarus Switzerland Bulgaria Serbia Denmark Finland Norway Slovakia Ireland Croatia Bosnia and Herzegovina Albania Lithuania Slovenia Latvia Estonia',
  非洲: 'Nigeria Ethiopia Egypt Democratic Republic of Congo Tanzania South Africa Kenya Uganda Algeria Sudan Morocco Angola Mozambique Ghana Madagascar Cameroon Ivory Coast Niger Burkina Faso Mali Malawi Zambia Somalia Senegal Chad Zimbabwe Guinea Rwanda Benin Tunisia Burundi Libya',
  美洲: 'United States Brazil Mexico Colombia Argentina Canada Peru Venezuela Chile Ecuador Guatemala Bolivia Cuba Haiti Dominican Republic Honduras Paraguay Nicaragua El Salvador Costa Rica Panama Uruguay Jamaica',
  大洋洲: 'Australia Papua New Guinea New Zealand Fiji Solomon Islands Vanuatu Samoa Tonga',
};
const ZH_EXTRA = {
  China: '中国', India: '印度', Indonesia: '印度尼西亚', Pakistan: '巴基斯坦', Bangladesh: '孟加拉国', Japan: '日本',
  Philippines: '菲律宾', Vietnam: '越南', Iran: '伊朗', Turkey: '土耳其', Thailand: '泰国', Myanmar: '缅甸',
  'South Korea': '韩国', Iraq: '伊拉克', Afghanistan: '阿富汗', 'Saudi Arabia': '沙特阿拉伯', Uzbekistan: '乌兹别克斯坦',
  Malaysia: '马来西亚', Yemen: '也门', Nepal: '尼泊尔', 'North Korea': '朝鲜', 'Sri Lanka': '斯里兰卡',
  Kazakhstan: '哈萨克斯坦', Syria: '叙利亚', Cambodia: '柬埔寨', Jordan: '约旦', Azerbaijan: '阿塞拜疆',
  'United Arab Emirates': '阿联酋', Israel: '以色列', Laos: '老挝', Singapore: '新加坡', Lebanon: '黎巴嫩',
  Mongolia: '蒙古', Armenia: '亚美尼亚', Georgia: '格鲁吉亚', Kuwait: '科威特', Qatar: '卡塔尔', Oman: '阿曼', Taiwan: '台湾地区',
  Russia: '俄罗斯', Germany: '德国', 'United Kingdom': '英国', France: '法国', Italy: '意大利', Spain: '西班牙',
  Ukraine: '乌克兰', Poland: '波兰', Romania: '罗马尼亚', Netherlands: '荷兰', Belgium: '比利时', Czechia: '捷克',
  Greece: '希腊', Portugal: '葡萄牙', Sweden: '瑞典', Hungary: '匈牙利', Austria: '奥地利', Belarus: '白俄罗斯',
  Switzerland: '瑞士', Bulgaria: '保加利亚', Serbia: '塞尔维亚', Denmark: '丹麦', Finland: '芬兰', Norway: '挪威',
  Slovakia: '斯洛伐克', Ireland: '爱尔兰', Croatia: '克罗地亚', 'Bosnia and Herzegovina': '波黑', Albania: '阿尔巴尼亚',
  Lithuania: '立陶宛', Slovenia: '斯洛文尼亚', Latvia: '拉脱维亚', Estonia: '爱沙尼亚',
  Nigeria: '尼日利亚', Ethiopia: '埃塞俄比亚', Egypt: '埃及', 'Democratic Republic of Congo': '刚果(金)',
  Tanzania: '坦桑尼亚', 'South Africa': '南非', Kenya: '肯尼亚', Uganda: '乌干达', Algeria: '阿尔及利亚',
  Sudan: '苏丹', Morocco: '摩洛哥', Angola: '安哥拉', Mozambique: '莫桑比克', Ghana: '加纳', Madagascar: '马达加斯加',
  Cameroon: '喀麦隆', 'Ivory Coast': '科特迪瓦', Niger: '尼日尔', 'Burkina Faso': '布基纳法索', Mali: '马里',
  Malawi: '马拉维', Zambia: '赞比亚', Somalia: '索马里', Senegal: '塞内加尔', Chad: '乍得', Zimbabwe: '津巴布韦',
  Guinea: '几内亚', Rwanda: '卢旺达', Benin: '贝宁', Tunisia: '突尼斯', Burundi: '布隆迪', Libya: '利比亚',
  'United States': '美国', Brazil: '巴西', Mexico: '墨西哥', Colombia: '哥伦比亚', Argentina: '阿根廷',
  Canada: '加拿大', Peru: '秘鲁', Venezuela: '委内瑞拉', Chile: '智利', Ecuador: '厄瓜多尔', Guatemala: '危地马拉',
  Bolivia: '玻利维亚', Cuba: '古巴', Haiti: '海地', 'Dominican Republic': '多米尼加', Honduras: '洪都拉斯',
  Paraguay: '巴拉圭', Nicaragua: '尼加拉瓜', 'El Salvador': '萨尔瓦多', 'Costa Rica': '哥斯达黎加', Panama: '巴拿马',
  Uruguay: '乌拉圭', Jamaica: '牙买加',
  Australia: '澳大利亚', 'Papua New Guinea': '巴布亚新几内亚', 'New Zealand': '新西兰', Fiji: '斐济',
  'Solomon Islands': '所罗门群岛', Vanuatu: '瓦努阿图', Samoa: '萨摩亚', Tonga: '汤加',
};
const SAMPLE_YEARS = [-1000, 1, 500, 1000, 1500, 1600, 1700, 1800, 1850, 1900, 1950, 1980, 2000, 2021];

(async () => {
  const csvPath = path.join(ROOT, 'data', '_owid_population.csv');
  if (!fs.existsSync(csvPath) || fs.statSync(csvPath).size < 1000000) {
    console.log('下载 OWID 人口数据集…');
    await fetchText('https://ourworldindata.org/grapher/population.csv?csvType=full&useColumnShortNames=true', csvPath);
    console.log('下载完成', Math.round(fs.statSync(csvPath).size / 1024), 'KB');
  } else console.log('用本地缓存 CSV');

  const wanted = {};
  for (const [cont, list] of Object.entries(CONT)) for (const c of list.split(' ').join('').split('')) { }
  const contOf = {};
  for (const [cont, list] of Object.entries(CONT)) {
    // 名单里有含空格的国名,按已知全名匹配
    let rest = list;
    const known = Object.keys(ZH_EXTRA).sort((a, b) => b.length - a.length);
    for (const k of known) {
      if (rest.includes(k)) { contOf[k] = cont; rest = rest.replace(k, '').replace(/\s+/g, ' '); }
    }
  }
  console.log('目标国家', Object.keys(contOf).length, '个');

  // CSV 表头动态识别(grapher 格式:entity,code,year,population…)
  const lines = fs.readFileSync(csvPath, 'utf8').split('\n');
  const head = lines[0].toLowerCase().split(',');
  const iEnt = head.findIndex(h => /entity/.test(h));
  const iYear = head.findIndex(h => /year/.test(h));
  const iPop = head.findIndex(h => /pop/.test(h));
  if (iEnt < 0 || iYear < 0 || iPop < 0) { console.error('表头不认识:', lines[0].slice(0, 120)); process.exit(1); }
  const series = {}; // entity -> {year: pop}
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]; if (!line) continue;
    const parts = line.split(',');
    if (parts.length <= iPop) continue;
    const ent = parts[iEnt].replace(/^"|"$/g, '');
    if (!(ent in contOf)) continue;
    const y = +parts[iYear], p = +parts[iPop];
    if (!Number.isFinite(y) || !Number.isFinite(p) || p <= 0) continue;
    (series[ent] = series[ent] || {})[y] = p;
  }
  console.log('命中实体', Object.keys(series).length, '个');

  const out = {};
  for (const [ent, byYear] of Object.entries(series)) {
    const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);
    const s = [];
    for (const sy of SAMPLE_YEARS) {
      // 取 ≤sy 的最近实际数据点(避免伪造插值);距离超过该档一半间隔就跳过
      let best = null;
      for (const y of years) { if (y <= sy) best = y; else break; }
      if (best == null) continue;
      const gapOK = sy <= 1800 ? (sy - best) <= 250 : (sy - best) <= 15;
      if (!gapOK) continue;
      const m = Math.round(byYear[best] / 1e4) / 100; // 百万,两位小数
      if (s.length && s[s.length - 1][0] === best) continue;
      s.push([best, m]);
    }
    if (s.length < 2) continue;
    const cont = contOf[ent];
    (out[cont] = out[cont] || {})[ent] = { n: ZH_EXTRA[ent] || ent, s };
  }
  const dst = path.join(ROOT, 'data', 'pop_countries.json');
  fs.writeFileSync(dst, JSON.stringify(out));
  const kb = Math.round(fs.statSync(dst).size / 1024);
  const nC = Object.values(out).reduce((a, c) => a + Object.keys(c).length, 0);
  console.log(`✓ ${dst} — ${nC} 国,${kb} KB`);
  for (const [c, m] of Object.entries(out)) console.log('  ' + c + ':', Object.keys(m).length, '国');
})();
