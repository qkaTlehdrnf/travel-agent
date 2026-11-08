/* 여행 Agent — 화면과 빠른 경로(LLM 없음) 로직.
   구조: 버튼/키워드 라우터 → 캐시(미리 조사) → 공개 API(OSM, 선택: Google Places) → 그래도 안 되면 Claude(선택, API 키 있을 때만). */
(function () {
'use strict';
const A = window.Android || null;
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const P = window.PACKS;
const BUILD = window.__BUILD__ || 0;

/* ---------------- 저장소 ---------------- */
const KEY = 'ta.v1';
const DEF = {
  legs: [], saved: [], done: {}, cache: {}, geo: {}, research: null, reqs: [], seenReq: {},
  prefs: { repo: 'qkaTlehdrnf/travel-agent', ghToken: '', gkey: '', akey: '', model: 'claude-haiku-5-5', tts: true, homeCC: 'KR', ccOverride: '' },
  lastFix: null, apk: null,
};
let DB;
try { DB = Object.assign({}, DEF, JSON.parse(localStorage.getItem(KEY) || '{}')); DB.prefs = Object.assign({}, DEF.prefs, DB.prefs || {}); }
catch (e) { DB = JSON.parse(JSON.stringify(DEF)); }
let saveT;
function save() { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(DB)); } catch (e) { pruneCache(); } }, 150); }
function pruneCache() {
  const ks = Object.keys(DB.cache).sort((a, b) => DB.cache[a].at - DB.cache[b].at);
  ks.slice(0, Math.ceil(ks.length / 2)).forEach((k) => delete DB.cache[k]);
  try { localStorage.setItem(KEY, JSON.stringify(DB)); } catch (e) { }
}

/* ---------------- 상태 ---------------- */
const S = { view: 'home', q: null, filter: null, res: null, last: null, here: null, cc: null, city: '', xfer: null, luggage: false };
try { const v = sessionStorage.getItem('ta.view'); if (v) Object.assign(S, JSON.parse(v)); } catch (e) { }

/* ---------------- 유틸 ---------------- */
const pad = (n) => String(n).padStart(2, '0');
const hm = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes());
const seoul = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const t = (s) => new Date(s).getTime();
function mins(ms) { return Math.round(ms / 60000); }
function dur(m) { m = Math.max(0, Math.round(m)); return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`; }
function dist(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dl = (b.lat - a.lat) * r, dn = (b.lon - a.lon) * r;
  const x = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const fmtD = (m) => m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
const walk = (m) => `도보 ${Math.max(1, Math.round(m / 75))}분`;
let tt;
function toast(m, ms) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); $('#app').appendChild(el); }
  el.textContent = m; el.hidden = false; clearTimeout(tt); tt = setTimeout(() => (el.hidden = true), ms || 2800);
}
function open(url) {
  if (A) { if (!A.openUrl(url)) toast('열 수 있는 앱이 없어요'); }
  else window.open(url, '_blank');
}
function openMap(url, web) {
  if (A && /^(nmap|amapuri|androidamap):/.test(url) && !A.canOpen(url)) { if (web) return open(web); toast('지도 앱이 설치돼 있지 않아요'); return; }
  open(url);
}
function speak(s) { if (!DB.prefs.tts) return; if (A) A.speak(s); else if (window.speechSynthesis) { const u = new SpeechSynthesisUtterance(s); u.lang = 'ko-KR'; speechSynthesis.cancel(); speechSynthesis.speak(u); } }
async function fetchJSON(url, opt, ms) {
  const c = new AbortController(); const tm = setTimeout(() => c.abort(), ms || 9000);
  try { const r = await fetch(url, Object.assign({ signal: c.signal }, opt || {})); if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200)); return await r.json(); }
  finally { clearTimeout(tm); }
}
function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h) % 100000; }

/* ---------------- 위치 ---------------- */
function locate(maxAge) {
  maxAge = maxAge == null ? 60000 : maxAge;
  if (DB.lastFix && Date.now() - DB.lastFix.at < maxAge) return Promise.resolve(DB.lastFix);
  return new Promise((res) => {
    if (!navigator.geolocation) return res(DB.lastFix);
    navigator.geolocation.getCurrentPosition((p) => {
      DB.lastFix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() }; save(); res(DB.lastFix);
    }, () => res(DB.lastFix), { enableHighAccuracy: false, timeout: 6000, maximumAge: maxAge });
  });
}
function watch() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition((p) => {
    DB.lastFix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() }; save();
    S.here = DB.lastFix; whereAmI(); contextNudge();
  }, () => { }, { enableHighAccuracy: false, maximumAge: 30000, timeout: 20000 });
}
const TZCC = { 'Asia/Seoul': 'KR', 'Asia/Shanghai': 'CN', 'Asia/Tokyo': 'JP', 'Europe/Zurich': 'CH', 'Europe/Berlin': 'DE', 'Europe/Vienna': 'AT', 'Europe/Rome': 'IT', 'Europe/Paris': 'FR', 'Europe/Madrid': 'ES', 'Europe/London': 'GB', 'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE', 'Europe/Prague': 'CZ' };
function tzCC() { try { return TZCC[Intl.DateTimeFormat().resolvedOptions().timeZone] || ''; } catch (e) { return ''; } }
async function revGeo(f) {
  const k = f.lat.toFixed(2) + ',' + f.lon.toFixed(2);
  if (DB.geo[k]) return DB.geo[k];
  try {
    const j = await fetchJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=ko&lat=${f.lat}&lon=${f.lon}`, null, 6000);
    const a = j.address || {};
    const v = { cc: (a.country_code || '').toUpperCase(), city: a.city || a.town || a.village || a.county || a.state || '' };
    DB.geo[k] = v; save(); return v;
  } catch (e) { return null; }
}
async function whereAmI() {
  const f = S.here || DB.lastFix;
  S.cc = DB.prefs.ccOverride || S.cc || tzCC() || DB.prefs.homeCC;
  if (f) { const g = await revGeo(f); if (g) { if (!DB.prefs.ccOverride && g.cc) S.cc = g.cc; S.city = g.city; } }
  header();
}
async function geocode(name) {
  const k = 'q:' + name.toLowerCase();
  if (DB.geo[k]) return DB.geo[k];
  try {
    const j = await fetchJSON(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=ko&addressdetails=1&q=${encodeURIComponent(name)}`, null, 7000);
    if (!j[0]) return null;
    const v = { lat: +j[0].lat, lon: +j[0].lon, cc: ((j[0].address || {}).country_code || '').toUpperCase() };
    DB.geo[k] = v; save(); return v;
  } catch (e) { return null; }
}

/* ---------------- 장소 검색 (빠른 경로) ---------------- */
const CATS = {
  food: { label: '맛집', osm: '["amenity"~"^(restaurant|cafe|fast_food|food_court|biergarten)$"]["name"]', g: ['restaurant', 'cafe'], r: 900 },
  sight: { label: '관광지', osm: '["tourism"~"^(attraction|museum|viewpoint|gallery|zoo|theme_park)$"]["name"]', g: ['tourist_attraction', 'museum', 'park'], r: 2000 },
  wc: { label: '화장실', osm: '["amenity"="toilets"]', r: 800 },
  locker: { label: '짐 보관', osm: '["amenity"~"^(luggage_locker|left_luggage|locker)$"]', r: 1200 },
};
const CUISINE = { korean: '한식', japanese: '일식', sushi: '스시', ramen: '라멘', chinese: '중식', thai: '태국', vietnamese: '베트남', indian: '인도', italian: '이탈리아', pizza: '피자', pasta: '파스타', french: '프랑스', german: '독일', swiss: '스위스', austrian: '오스트리아', czech: '체코', spanish: '스페인', tapas: '타파스', mexican: '멕시코', burger: '버거', kebab: '케밥', regional: '현지식', coffee_shop: '카페', cake: '디저트', ice_cream: '젤라토', seafood: '해산물', steak_house: '스테이크', vegetarian: '채식', vegan: '비건', asian: '아시안', sandwich: '샌드위치', bakery: '베이커리', fondue: '퐁듀' };
const GTYPE = { korean_restaurant: '한식', japanese_restaurant: '일식', chinese_restaurant: '중식', thai_restaurant: '태국', italian_restaurant: '이탈리아', pizza_restaurant: '피자', french_restaurant: '프랑스', seafood_restaurant: '해산물', steak_house: '스테이크', vegetarian_restaurant: '채식', fast_food_restaurant: '빠른 식사', cafe: '카페', coffee_shop: '카페', bakery: '베이커리', fine_dining_restaurant: '파인다이닝', bar: '바', brunch_restaurant: '브런치', ramen_restaurant: '라멘', sushi_restaurant: '스시', mexican_restaurant: '멕시코', indian_restaurant: '인도', vietnamese_restaurant: '베트남', spanish_restaurant: '스페인' };

function osmItem(e, here, cat) {
  const tg = e.tags || {}; const lat = e.lat || (e.center && e.center.lat); const lon = e.lon || (e.center && e.center.lon);
  const tags = [];
  if (cat === 'food') {
    (tg.cuisine || '').split(';').forEach((c) => { c = c.trim(); if (CUISINE[c]) tags.push(CUISINE[c]); });
    if (tg.amenity === 'fast_food') tags.push('빠른 식사');
    if (tg.amenity === 'cafe' && !tags.includes('카페')) tags.push('카페');
    if (tg['diet:vegetarian'] === 'yes') tags.push('채식 메뉴');
    if (tg.outdoor_seating === 'yes') tags.push('야외석');
  }
  if (cat === 'wc') {
    if (tg.fee === 'no') tags.push('무료'); else if (tg.fee === 'yes') tags.push('유료' + (tg.charge ? ' ' + tg.charge : ''));
    if (tg.wheelchair === 'yes') tags.push('휠체어');
    if (tg.changing_table === 'yes') tags.push('기저귀 교환대');
    if (tg.access && tg.access !== 'yes') tags.push(tg.access === 'customers' ? '손님만' : tg.access);
  }
  if (cat === 'sight') { if (tg.tourism) tags.push({ attraction: '명소', museum: '박물관', viewpoint: '전망', gallery: '갤러리', zoo: '동물원', theme_park: '테마파크' }[tg.tourism] || tg.tourism); if (tg.fee === 'no') tags.push('무료'); }
  const name = tg['name:ko'] || tg.name || (cat === 'wc' ? '공중화장실' : cat === 'locker' ? '짐 보관함' : '이름 없음');
  const it = { id: 'osm' + e.id, name, sub: tg['name:ko'] && tg.name !== tg['name:ko'] ? tg.name : '', lat, lon, tags, hours: tg.opening_hours || '', src: 'OSM' };
  if (here) it.d = dist(here, it);
  return it;
}
async function overpass(cat, c) {
  const C = CATS[cat];
  const q = `[out:json][timeout:12];(node${C.osm}(around:${C.r},${c.lat},${c.lon});way${C.osm}(around:${C.r},${c.lat},${c.lon}););out center 60;`;
  const hosts = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  let err;
  for (const h of hosts) {
    try { return (await fetchJSON(h, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 12000)).elements || []; }
    catch (e) { err = e; }
  }
  throw err;
}
async function places(cat, c) {
  const C = CATS[cat];
  const j = await fetchJSON('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': DB.prefs.gkey, 'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.rating,places.userRatingCount,places.priceLevel,places.currentOpeningHours.openNow,places.currentOpeningHours.nextCloseTime,places.types,places.primaryType' },
    body: JSON.stringify({ includedTypes: C.g, maxResultCount: 20, rankPreference: 'POPULARITY', languageCode: 'ko', locationRestriction: { circle: { center: { latitude: c.lat, longitude: c.lon }, radius: C.r } } }),
  }, 8000);
  return (j.places || []).map((p) => {
    const tags = [];
    (p.types || []).forEach((ty) => { if (GTYPE[ty] && !tags.includes(GTYPE[ty])) tags.push(GTYPE[ty]); });
    if (p.priceLevel === 'PRICE_LEVEL_INEXPENSIVE') tags.unshift('가성비');
    if (p.priceLevel === 'PRICE_LEVEL_EXPENSIVE') tags.unshift('고급');
    if (p.priceLevel === 'PRICE_LEVEL_VERY_EXPENSIVE' && !tags.includes('파인다이닝')) tags.unshift('파인다이닝');
    if (p.rating >= 4.5 && p.userRatingCount >= 500) tags.unshift('평점 높음');
    const oh = p.currentOpeningHours;
    let open = null;
    if (oh && oh.openNow != null) open = oh.openNow ? ['ok', '영업 중' + (oh.nextCloseTime ? ' · ' + hm(new Date(oh.nextCloseTime)) + '까지' : '')] : ['bad', '지금 닫힘'];
    return { id: 'g' + p.id, gid: p.id, name: (p.displayName || {}).text || '?', lat: p.location.latitude, lon: p.location.longitude, rating: p.rating, rc: p.userRatingCount, tags, open, src: 'Google' };
  });
}
/** 캐시 → 네트워크. Google 결과는 약관상 저장하지 않고 OSM 결과만 100m 격자로 6시간 저장. */
async function search(cat, c, opt) {
  opt = opt || {};
  const t0 = performance.now();
  const key = `${cat}:${c.lat.toFixed(3)}:${c.lon.toFixed(3)}`;
  const useG = DB.prefs.gkey && CATS[cat].g;
  const hit = DB.cache[key];
  if (!useG && hit && Date.now() - hit.at < 6 * 3600e3 && !opt.fresh) {
    return { items: hit.items.map((e) => osmItem(e, c, cat)), src: hit.pre ? '미리 조사' : '캐시', at: hit.at, ms: performance.now() - t0 };
  }
  let items, src;
  if (useG) {
    try { items = await places(cat, c); src = 'Google Places'; } catch (e) { console.warn(e); }
  }
  if (!items) {
    const els = await overpass(cat, c);
    DB.cache[key] = { at: Date.now(), items: els.slice(0, 60), pre: !!opt.pre }; save();
    items = els.map((e) => osmItem(e, c, cat)); src = 'OpenStreetMap';
  }
  items.forEach((i) => (i.d = dist(c, i)));
  return { items, src, at: Date.now(), ms: performance.now() - t0 };
}
function rank(cat, items, filter) {
  let arr = items.slice();
  if (filter) arr = arr.filter(filter);
  if (cat === 'food' && arr.some((i) => i.rating)) {
    arr.sort((a, b) => score(b) - score(a));
  } else arr.sort((a, b) => a.d - b.d);
  return arr.slice(0, cat === 'wc' || cat === 'locker' ? 6 : 8);
}
function score(i) { return (i.rating || 3.5) * Math.log10(10 + (i.rc || 0)) - i.d / 600 + (i.open && i.open[0] === 'bad' ? -5 : 0); }

/* ---------------- 일정(구간) ---------------- */
function legs() { return DB.legs.slice().sort((a, b) => t(a.dep) - t(b.dep)); }
function nowLeg() {
  const n = Date.now(), L = legs();
  const cur = L.find((l) => t(l.dep) <= n && n < t(l.arr || l.dep));
  const next = L.find((l) => t(l.dep) > n);
  return { cur, next, L };
}
function sameSt(a, b) { return a && b && a.trim().toLowerCase() === b.trim().toLowerCase(); }
function connection(a) { const L = legs(); const i = L.indexOf(a); const b = L[i + 1]; if (b && sameSt(a.to, b.from) && t(b.dep) - t(a.arr) < 4 * 3600e3) return b; return null; }
function platInfo(l, which) {
  const p = P.plat(l.cc || S.cc, l.region);
  const num = which === 'arr' ? l.arrPlat : l.depPlat;
  return { p, num, zone: which === 'arr' ? l.arrZone : l.depZone, label: num ? (p.numFirst ? `${num}${p.word}` : `${p.word} ${num}`) : '' };
}
const MODE = { train: '기차', bus: '버스', flight: '비행', metro: '지하철', ferry: '배', booking: '예약' };

/* ---------------- 헤더 ---------------- */
function header() {
  const d = new Date();
  $('#clock').textContent = `현지 ${hm(d)} · 한국 ${seoul.format(d)}`;
  const { cur, next } = nowLeg();
  $('#where').textContent = cur ? `${MODE[cur.mode] || ''} ${cur.no || ''} · ${cur.from} → ${cur.to}`.trim() : (S.city ? `${S.city} · ${P.countryName(S.cc)}` : P.countryName(S.cc) || '여행 Agent');
  const nf = $('#nextfix');
  if (next) {
    const pi = platInfo(next, 'dep');
    nf.innerHTML = `<span class="lk">다음 고정</span> <span class="num">${hm(new Date(next.dep))}</span> ${esc(next.no || MODE[next.mode] || '')} ${next.mode === 'booking' ? '' : '출발'} · ${esc(next.from)}${pi.num ? ' ' + esc(pi.num) + '번' : ''} · <span class="num">${dur(mins(t(next.dep) - Date.now()))} 뒤</span>`;
    nf.hidden = false;
  } else nf.hidden = true;
}

/* ---------------- 화면들 ---------------- */
const ICON = {
  food: '<path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 3c-2 2-3 5-3 8h3v10"/>',
  sight: '<path d="M3 20l6-10 4 6 3-4 5 8z"/><circle cx="17" cy="6" r="2"/>',
  route: '<path d="M6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 16V9a3 3 0 0 1 3-3h7"/>',
  locker: '<rect x="5" y="7" width="14" height="13" rx="2"/><path d="M9 7V5a3 3 0 0 1 6 0v2M12 12v3"/>',
};
function signBtn(l, which) {
  const pi = platInfo(l, which);
  if (!pi.num) return '';
  return `<button class="signbtn" data-sign="${l.id}:${which}"><span class="th"><small>${esc(pi.p.numFirst ? '' : pi.p.word)}</small><b>${esc(pi.num)}</b></span><span class="tx"><b>표지판엔 "${esc(pi.label)}"</b> · 영어 "${esc(pi.p.en)} ${esc(pi.num)}"${pi.p.confirmed ? '' : ' <span style="opacity:.7">(영어 표기 미확인)</span>'}<br><span style="opacity:.75">${pi.zone ? '탈 구역 ' + esc(pi.zone) + ' · ' : ''}사진 보기</span></span></button>`;
}
function home() {
  const { cur, next } = nowLeg();
  let now;
  if (cur) {
    const b = connection(cur);
    const left = mins(t(cur.arr) - Date.now());
    const pi = b ? platInfo(b, 'dep') : null;
    now = `<div class="now"><div class="eb">지금 · ${esc(MODE[cur.mode] || '이동')} ${esc(cur.no || '')}</div>
      <div class="big">${esc(cur.to)} 도착까지 <span class="num">${left}</span>분.${b ? `<br>내려서 <span class="num">${esc(pi.num || '?')}</span>번으로 환승` : ''}</div>
      <div class="cells"><div class="cell"><small>${esc(cur.to)} 도착</small><div>${hm(new Date(cur.arr))}</div></div>${b ? `<div class="cell"><small>${esc(b.no || '다음')} 출발</small><div>${hm(new Date(b.dep))}</div></div><div class="cell"><small>승강장</small><div>${esc(pi.num || '미정')}</div></div>` : `<div class="cell"><small>도착 승강장</small><div>${esc(cur.arrPlat || '-')}</div></div><div class="cell"><small>클래스</small><div>${esc(cur.cls || '-')}</div></div>`}</div>
      ${b ? signBtn(b, 'dep') : ''}
      ${cur.note ? `<div class="note bad" style="margin:0">${esc(cur.note)}</div>` : ''}
      <div class="src" style="color:inherit;opacity:.8">${esc([cur.cls, cur.ticket].filter(Boolean).join(' · ') || '클래스·티켓 미입력')} · 입력한 시간표 기준(실시간 아님)</div>
      <div class="row"><button class="btn ${cur.alarm ? 'on' : ''}" data-alarm="${cur.id}">${cur.alarm ? '하차 5분 전 진동 켜짐' : '하차 알람 꺼짐'}</button><button class="btn" data-go="move">구간 전체 보기</button>${b ? `<button class="btn" data-xfer="${cur.id}">환승 길 보기</button>` : ''}</div></div>`;
  } else if (next) {
    const left = t(next.dep) - Date.now();
    const pi = platInfo(next, 'dep');
    now = `<div class="now"><div class="eb">다음 이동 · ${esc(MODE[next.mode] || '')} ${esc(next.no || '')}</div>
      <div class="big">${esc(next.from)} 출발까지 <span class="num">${dur(mins(left))}</span>${pi.num ? `<br><span class="num">${esc(pi.num)}</span>번 승강장` : '<br>승강장 아직 모름'}</div>
      <div class="cells"><div class="cell"><small>출발</small><div>${hm(new Date(next.dep))}</div></div><div class="cell"><small>${esc(next.to || '')} 도착</small><div>${next.arr ? hm(new Date(next.arr)) : '-'}</div></div><div class="cell"><small>클래스</small><div>${esc(next.cls || '-')}</div></div></div>
      ${signBtn(next, 'dep')}
      ${next.note ? `<div class="note bad" style="margin:0">${esc(next.note)}</div>` : ''}
      <div class="row"><button class="btn" data-go="move">구간 전체 보기</button>${next.fromGeo ? `<button class="btn" data-navgeo="${next.id}">역까지 길안내</button>` : ''}</div></div>`;
  } else {
    now = `<div class="now"><div class="eb">지금</div><div class="big">등록된 이동이 없어요</div><div class="src" style="color:inherit;opacity:.8">기차·버스·예약을 넣으면 여기 "지금 할 일"과 승강장·환승이 뜹니다.</div><div class="row"><button class="btn on" data-addleg>일정 추가</button></div></div>`;
  }
  const r = DB.research;
  const pend = pendingCount();
  return `${now}
  <div class="h"><h2>원탭 찾기</h2><span class="src">${S.city ? esc(S.city) + ' · ' : ''}${esc(P.mapName(S.cc))}로 안내</span></div>
  <div class="quick">${['food', 'sight', 'route', 'locker'].map((k) => `<button class="q" data-q="${k}"><svg viewBox="0 0 24 24">${ICON[k]}</svg>${k === 'route' ? '길찾기' : CATS[k].label}</button>`).join('')}</div>
  <div id="nudge"></div>
  <div class="card h" style="align-items:center"><div><div class="src">미리 조사 ${r ? esc(new Date(r.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })) : '아직 안 함'}</div><b>${r ? `${r.lines.length}건 준비됨` : '와이파이에서 자동으로 조사해요'}${pend ? ` · 직접 할 일 ${pend}건` : ''}</b></div><button class="btn pri sm" data-go="inbox">할 일 열기</button></div>`;
}
function contextNudge() {
  const el = $('#nudge'); if (!el || S.view !== 'home') return;
  const f = DB.lastFix; if (!f) return;
  const { cur, next, L } = nowLeg();
  let html = '';
  for (const l of L) {
    const b = connection(l);
    if (b && l.toGeo && dist(f, l.toGeo) < 600 && Date.now() < t(b.dep) && Date.now() > t(l.arr) - 20 * 60000) {
      html = `<div class="card" style="border-color:var(--accent)"><b>환승역 ${esc(l.to)} 근처예요</b><div class="src">${esc(b.no || '')} ${hm(new Date(b.dep))} 출발 · ${esc(platInfo(b, 'dep').label || '승강장 미정')} · 남은 ${mins(t(b.dep) - Date.now())}분</div><button class="btn pri sm" data-xfer="${l.id}" style="margin-top:6px">환승 길 보기</button></div>`;
      break;
    }
  }
  if (!html && !cur && next && next.fromGeo && t(next.dep) - Date.now() < 90 * 60000) {
    const d = dist(f, next.fromGeo);
    if (d > 300) html = `<div class="card"><b>${esc(next.from)}까지 ${fmtD(d)}</b><div class="src">${hm(new Date(next.dep))} 출발까지 ${mins(t(next.dep) - Date.now())}분</div><button class="btn pri sm" data-navgeo="${next.id}" style="margin-top:6px">역까지 길안내</button></div>`;
  }
  el.innerHTML = html; bind(el);
}

let map;
function mapInit(el, c, items) {
  if (!window.L) { el.innerHTML = '<div class="empty" style="padding:12px">지도 라이브러리를 못 불러왔어요</div>'; return; }
  if (map) { map.remove(); map = null; }
  map = L.map(el, { zoomControl: false, attributionControl: true }).setView([c.lat, c.lon], 15);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  L.marker([c.lat, c.lon], { icon: L.divIcon({ className: '', html: '<div class="mk me"></div>', iconSize: [16, 16] }) }).addTo(map);
  const pts = [[c.lat, c.lon]];
  items.forEach((it, i) => { pts.push([it.lat, it.lon]); L.marker([it.lat, it.lon], { icon: L.divIcon({ className: '', html: `<div class="mk">${i + 1}</div>`, iconSize: [22, 22] }) }).addTo(map).on('click', () => { const e = $(`[data-item="${i}"]`); if (e) e.scrollIntoView({ behavior: 'smooth', block: 'center' }); }); });
  if (pts.length > 1) map.fitBounds(pts, { padding: [24, 24], maxZoom: 16 });
}
function resultView() {
  const q = S.q, R = S.res;
  const lbl = q === 'route' ? '길찾기' : CATS[q].label;
  if (!R) return `<button class="back" data-go="home">← 홈</button><div class="card"><b>${lbl}</b><div class="skel" style="margin-top:10px"></div><div class="skel" style="margin-top:8px;width:70%"></div><div class="src" style="margin-top:8px">위치 확인 중…</div></div>`;
  if (R.err) return `<button class="back" data-go="home">← 홈</button><div class="card"><b>${lbl}</b><div class="note bad">${esc(R.err)}</div><div class="row" style="display:flex;gap:6px;margin-top:8px"><button class="btn pri" data-q="${q}">다시 시도</button><button class="btn" data-mapsearch="${esc(lbl)}">지도 앱에서 찾기</button></div></div>`;
  const items = R.items;
  const pack = P.map(S.cc);
  return `<button class="back" data-go="home">← 홈</button>
  <div class="card" style="display:flex;flex-direction:column;gap:8px">
    <div class="h"><b>${lbl}${S.city ? ' · ' + esc(S.city) : ''}</b><span class="chip ${R.src === '미리 조사' || R.src === '캐시' ? 'ok' : 'acc'} num">${(R.ms / 1000).toFixed(1)}초 · ${esc(R.src)}</span></div>
    ${S.filterLabel ? `<div><span class="chip">${esc(S.filterLabel)}</span></div>` : ''}
    ${q === 'wc' ? wcNote() : ''}
    <div class="map" id="map"></div>
    <div>${items.length ? items.map((it, i) => `<div class="item" data-item="${i}"><span class="pin">${i + 1}</span><div style="min-width:0"><h3>${esc(it.name)}</h3>${it.sub ? `<div class="src">${esc(it.sub)}</div>` : ''}${it.rating ? `<div class="rate"><span class="g">Google</span> <b class="num">★ ${it.rating.toFixed(1)}</b> <span class="src num">(${(it.rc || 0).toLocaleString()})</span></div>` : ''}<div class="kv"><span class="num">${fmtD(it.d)}</span><span>${walk(it.d)}</span>${it.hours ? `<span>${esc(it.hours)}</span>` : ''}</div><div class="tags">${it.open ? `<span class="chip ${it.open[0]}">${esc(it.open[1])}</span>` : ''}${(it.tags || []).map((x) => `<span class="chip tagc">${esc(x)}</span>`).join('')}</div></div>
      <div class="acts"><button class="btn line sm" data-nav="${i}">길안내</button><button class="btn sm" data-save="${i}">${DB.saved.some((s) => s.id === it.id) ? '저장됨' : '저장'}</button></div></div>`).join('') : '<div class="empty">근처에서 못 찾았어요. 지도 앱 검색을 열어 보세요.</div>'}</div>
    <div class="h"><span class="src">출처 ${esc(R.src)} · ${hm(new Date(R.at))} 확인${R.src !== 'Google Places' && q === 'food' ? ' · 평점은 설정에 Google 키를 넣으면 표시' : ''}</span><button class="btn line sm" data-mapsearch="${esc(lbl)}">${esc(pack.name)}에서 보기</button></div>
  </div>`;
}
function wcNote() {
  const { cur, next } = nowLeg();
  if (cur && cur.mode === 'train') return `<div class="note warn" style="margin:0">지금 열차 안이에요. 열차 화장실이 가장 빠릅니다.</div>`;
  if (next) return `<div class="note warn" style="margin:0">다음 고정 일정 ${hm(new Date(next.dep))}까지 ${dur(mins(t(next.dep) - Date.now()))}.</div>`;
  return '';
}
async function openQ(q, filter, filterLabel) {
  S.q = q; S.res = null; S.filter = filter || null; S.filterLabel = filterLabel || ''; go('result');
  if (q === 'route') return routeView();
  try {
    const c = await locate(90000);
    if (!c) throw new Error('위치를 못 받았어요. 위치 권한과 GPS를 확인해 주세요.');
    S.here = c;
    const r = await search(q, c);
    const items = rank(q, r.items, filter);
    S.res = Object.assign(r, { items }); S.last = { q, items };
    if (S.view === 'result' && S.q === q) { render(); mapInit($('#map'), c, items); }
    if (r.src === '캐시' || r.src === '미리 조사') search(q, c, { fresh: true }).catch(() => { });
  } catch (e) {
    S.res = { err: e.name === 'AbortError' ? '응답이 늦어요(네트워크). 지도 앱에서 찾아 보세요.' : String(e.message || e) };
    if (S.view === 'result') render();
  }
}
function routeView() {
  const dests = [];
  const lodg = DB.saved.filter((s) => s.tag === '숙소');
  lodg.forEach((s) => dests.push(s));
  const { next } = nowLeg();
  if (next && next.fromGeo) dests.push({ id: 'leg' + next.id, name: next.from + ' (다음 출발역)', lat: next.fromGeo.lat, lon: next.fromGeo.lon });
  DB.saved.filter((s) => s.tag !== '숙소').slice(0, 6).forEach((s) => dests.push(s));
  S.res = { items: dests, src: '저장 목록', at: Date.now(), ms: 0 }; S.last = { q: 'route', items: dests };
  $('#screen').innerHTML = `<button class="back" data-go="home">← 홈</button>
  <div class="card"><div class="h"><b>어디로 갈까요</b><span class="chip acc">${esc(P.mapName(S.cc))}</span></div>
  ${dests.length ? dests.map((d, i) => `<div class="item" style="grid-template-columns:24px 1fr auto"><span class="pin">${i + 1}</span><div><h3>${esc(d.name)}</h3><div class="kv">${d.tag ? esc(d.tag) : ''}${DB.lastFix ? ' · ' + fmtD(dist(DB.lastFix, d)) : ''}</div></div><div class="acts"><button class="btn pri sm" data-nav="${i}" data-mode="transit">대중교통</button><button class="btn line sm" data-nav="${i}" data-mode="walking">도보</button></div></div>`).join('') : '<div class="empty" style="margin-top:6px">저장한 곳이 없어요. 맛집·관광지 결과에서 "저장"하거나, 저장 탭에서 숙소를 추가하세요.</div>'}
  </div>`;
  bind($('#screen'));
}
function navTo(it, mode) {
  const pk = P.map(S.cc);
  const url = pk.dir(it, mode || (it.d && it.d < 1500 ? 'walking' : 'transit'));
  openMap(url, pk.web ? pk.web(it) : P.google.dir(it, mode));
  S.lastNav = it;
}

function moveView() {
  const L = legs();
  const now = Date.now();
  const up = L.filter((l) => t(l.arr || l.dep) > now - 3600e3);
  const past = L.length - up.length;
  let html = `<div class="h"><h2>이동·예약</h2><button class="btn pri sm" data-addleg>추가</button></div>`;
  if (!up.length) html += `<div class="card empty">앞으로의 일정이 없어요. "추가"로 기차·버스·비행·예약을 넣어 주세요.${DB.prefs.akey ? ' 예약 메일·시간표 텍스트를 붙여넣으면 자동으로 나눠 드려요.' : ''}</div>`;
  let day = '';
  up.forEach((l, i) => {
    const d = new Date(l.dep).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
    if (d !== day) { html += `<div class="src" style="margin-top:4px;font-weight:600">${d}</div>`; day = d; }
    const b = connection(l);
    const slack = b ? mins(t(b.dep) - t(l.arr)) : null;
    if (l.mode === 'booking') {
      html += `<div class="card h"><div><span class="chip warn">예약</span> <b>${esc(l.no || l.from)}</b><div class="src">${hm(new Date(l.dep))} · ${esc(l.from)}${l.note ? ' · ' + esc(l.note) : ''}</div></div><button class="btn line sm" data-editleg="${l.id}">수정</button></div>`;
      return;
    }
    html += `<div class="card"><div class="h" style="margin-bottom:8px"><b>${esc(MODE[l.mode])} ${esc(l.no || '')}</b><span><span class="src">${l.arr ? dur(mins(t(l.arr) - t(l.dep))) : ''}</span> <button class="btn line sm" data-editleg="${l.id}">수정</button></span></div>
     <div class="leg">
      <div class="t">${hm(new Date(l.dep))}</div><div class="r"><i></i></div><div class="w"><b>${esc(l.from)} 출발</b> ${l.depPlat ? `<span class="plat">${esc(l.depPlat)}</span>` : '<span class="chip warn">승강장 미정</span>'}${l.depZone ? ` <span class="src">${esc(l.depZone)} 구역</span>` : ''}${signBtn(l, 'dep')}</div>
      <div class="t">${l.arr ? hm(new Date(l.arr)) : ''}</div><div class="r end"><i></i></div><div class="w" style="padding-bottom:0"><b>${esc(l.to)} 도착</b> ${l.arrPlat ? `<span class="plat">${esc(l.arrPlat)}</span>` : ''}
        ${l.note ? `<div class="note bad">${esc(l.note)}</div>` : ''}
        ${b ? `<div class="note ${slack < 5 ? 'bad' : slack < 10 ? 'warn' : 'ok'}">환승 필요 · ${esc(b.no || '')} ${esc(platInfo(b, 'dep').label || '승강장 미정')}까지 여유 ${slack}분</div><button class="btn line full sm" data-xfer="${l.id}" style="margin-top:6px">환승 길 입체로 보기 (층 구조, 짐 보관)</button>` : ''}
      </div></div>
     <div class="h" style="margin-top:8px"><span class="src">${esc([l.cls ? l.cls + '만' : '클래스 미입력', l.ticket].filter(Boolean).join(' · '))}</span><button class="btn sm ${l.alarm ? 'pri' : 'line'}" data-alarm="${l.id}">${l.alarm ? '하차 5분 전 진동 켜짐' : '하차 알람'}</button></div></div>`;
  });
  if (past) html += `<div class="src">지난 일정 ${past}건은 숨김</div>`;
  return html;
}

function legForm(l) {
  l = l || { id: 'l' + Date.now(), mode: 'train', cc: S.cc || '', region: 'de' };
  const v = (k) => esc(l[k] || '');
  const sh = sheet(l.from ? '일정 수정' : '일정 추가', `
   ${DB.prefs.akey && !l.from ? `<div class="card"><label class="f">예약 메일·시간표 붙여넣기 (Claude가 구간으로 나눠요)<textarea id="paste" placeholder="예: 11/9 Zürich HB 12:56 IC 8 Gleis 31 → Bern 13:58 Gleis 7, 14:04 IC 61 Gleis 4 → Interlaken Ost 14:56, 2등석"></textarea></label><button class="btn pri full" id="parseBtn" style="margin-top:8px">자동으로 나누기</button></div>` : ''}
   <div class="card" style="display:flex;flex-direction:column;gap:10px">
    <div class="seg" id="modeSeg">${Object.keys(MODE).map((m) => `<button type="button" data-m="${m}" aria-pressed="${l.mode === m}">${MODE[m]}</button>`).join('')}</div>
    <label class="f">번호·이름 (예: IC 61, 식당 이름)<input id="f_no" value="${v('no')}"></label>
    <div class="grid2"><label class="f">출발역 / 장소<input id="f_from" value="${v('from')}"></label><label class="f">도착역<input id="f_to" value="${v('to')}"></label></div>
    <div class="grid2"><label class="f">출발 (현지 시각)<input id="f_dep" type="datetime-local" value="${v('dep')}"></label><label class="f">도착 (현지 시각)<input id="f_arr" type="datetime-local" value="${v('arr')}"></label></div>
    <div class="grid2"><label class="f">출발 승강장<input id="f_depPlat" value="${v('depPlat')}" placeholder="4"></label><label class="f">탈 구역<input id="f_depZone" value="${v('depZone')}" placeholder="B"></label></div>
    <div class="grid2"><label class="f">도착 승강장<input id="f_arrPlat" value="${v('arrPlat')}"></label><label class="f">클래스<input id="f_cls" value="${v('cls')}" placeholder="2등석"></label></div>
    <label class="f">티켓 (예: Saver Day Pass, SBB 앱 QR)<input id="f_ticket" value="${v('ticket')}"></label>
    <label class="f">주의 (예: 동명 역 Interlaken West에서 내리지 말 것)<input id="f_note" value="${v('note')}"></label>
    <div class="grid2"><label class="f">나라 (승강장 표기)<select id="f_cc">${['', ...P.list].map((c) => `<option value="${c}" ${l.cc === c ? 'selected' : ''}>${c ? P.countryName(c) : '자동'}</option>`).join('')}</select></label>
    <label class="f">스위스 언어권<select id="f_region">${[['de', '독일어권 Gleis'], ['fr', '프랑스어권 Voie'], ['it', '이탈리아어권 Binario']].map(([k, n]) => `<option value="${k}" ${l.region === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div>
    <div class="grid2"><button class="btn pri" id="saveLeg">저장</button>${DB.legs.some((x) => x.id === l.id) ? '<button class="btn bad" id="delLeg">삭제</button>' : ''}</div>
   </div>`);
  let mode = l.mode;
  $$('#modeSeg button', sh).forEach((b) => (b.onclick = () => { mode = b.dataset.m; $$('#modeSeg button', sh).forEach((x) => x.setAttribute('aria-pressed', x === b)); }));
  $('#saveLeg', sh).onclick = async () => {
    const g = (k) => $('#f_' + k, sh).value.trim();
    const n = Object.assign(l, { mode, no: g('no'), from: g('from'), to: g('to'), dep: g('dep'), arr: g('arr'), depPlat: g('depPlat'), depZone: g('depZone'), arrPlat: g('arrPlat'), cls: g('cls'), ticket: g('ticket'), note: g('note'), cc: g('cc'), region: g('region') });
    if (!n.from || !n.dep) { toast('출발 장소와 출발 시각은 꼭 넣어 주세요'); return; }
    upsertLeg(n); sh.remove(); render();
  };
  const del = $('#delLeg', sh);
  if (del) del.onclick = () => { DB.legs = DB.legs.filter((x) => x.id !== l.id); if (A) A.cancelAlarm(hash(l.id)); save(); sh.remove(); render(); };
  const pb = $('#parseBtn', sh);
  if (pb) pb.onclick = async () => {
    const txt = $('#paste', sh).value.trim(); if (!txt) return;
    pb.disabled = true; pb.textContent = 'Claude가 나누는 중…';
    try {
      const out = await claude(`아래 여행 일정 텍스트를 구간 JSON 배열로만 답해. 필드: mode(train|bus|flight|metro|ferry|booking), no, from, to, dep, arr(YYYY-MM-DDTHH:MM 현지 시각, 연도 모르면 ${new Date().getFullYear()}), depPlat, depZone, arrPlat, cls, ticket, note, cc(ISO 국가코드). 텍스트에 없는 값은 빈 문자열. 추측 금지.\n\n${txt}`, { json: true });
      const arr = JSON.parse(out.match(/\[[\s\S]*\]/)[0]);
      arr.forEach((x, i) => upsertLeg(Object.assign({ id: 'l' + Date.now() + i, region: 'de' }, x)));
      toast(`${arr.length}개 구간을 추가했어요. 꼭 한 번 확인해 주세요`); sh.remove(); go('move');
    } catch (e) { toast('나누기 실패: ' + e.message, 5000); pb.disabled = false; pb.textContent = '자동으로 나누기'; }
  };
}
async function upsertLeg(n) {
  const i = DB.legs.findIndex((x) => x.id === n.id);
  if (i >= 0) DB.legs[i] = n; else DB.legs.push(n);
  save();
  if (n.alarm) setAlarm(n, true);
  // 역 좌표 (환승 감지·길안내·짐 보관 검색용)
  if (n.from && !n.fromGeo) { const g = await geocode(n.from + (n.mode === 'train' ? ' station' : '')) || await geocode(n.from); if (g) { n.fromGeo = g; if (!n.cc) n.cc = g.cc; } }
  if (n.to && !n.toGeo) { const g = await geocode(n.to + (n.mode === 'train' ? ' station' : '')) || await geocode(n.to); if (g) n.toGeo = g; }
  save();
}
function setAlarm(l, on) {
  l.alarm = on; save();
  const at = t(l.arr || l.dep) - 5 * 60000;
  if (!A) { toast(on ? '(브라우저에서는 알람이 울리지 않아요)' : '알람 끔'); return; }
  if (on) {
    if (at < Date.now()) { toast('도착 5분 전이 이미 지났어요'); return; }
    A.setAlarm(hash(l.id), at, `${l.to} 도착 5분 전`, `${hm(new Date(l.arr))} 도착 · 내릴 준비하세요${l.note ? ' · ' + l.note : ''}`);
    toast(`${hm(new Date(at))}에 진동합니다. 시간표 기준이라 연착은 반영 안 돼요`, 4000);
  } else { A.cancelAlarm(hash(l.id)); toast('하차 알람을 껐어요'); }
}

/* ---------------- 표지판 / 환승 ---------------- */
async function commons(q) {
  const k = 'c:' + q;
  if (DB.cache[k] && Date.now() - DB.cache[k].at < 14 * 86400e3) return DB.cache[k].items;
  const j = await fetchJSON(`https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrnamespace=6&gsrlimit=6&gsrsearch=${encodeURIComponent(q)}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=480`, null, 8000);
  const items = Object.values((j.query || {}).pages || {}).map((p) => { const ii = (p.imageinfo || [])[0] || {}; const md = ii.extmetadata || {}; return { thumb: ii.thumburl, page: ii.descriptionurl, title: p.title.replace(/^File:/, '').replace(/\.\w+$/, ''), lic: (md.LicenseShortName || {}).value || '', by: ((md.Artist || {}).value || '').replace(/<[^>]+>/g, '').slice(0, 40) }; }).filter((x) => x.thumb);
  DB.cache[k] = { at: Date.now(), items }; save();
  return items;
}
function signQueries(l, which) { const st = which === 'arr' ? l.to : l.from; const pi = platInfo(l, which); return [`${st} ${pi.p.word.split(' ')[0]} ${pi.num}`, `${st} station platform`]; }
async function openSign(id) {
  const [lid, which] = id.split(':'); const l = DB.legs.find((x) => x.id === lid); if (!l) return;
  const pi = platInfo(l, which); const st = which === 'arr' ? l.to : l.from;
  const zones = (pi.p.zones || '').match(/[A-Z]/g) ? 'ABCDEF'.slice(0, Math.max(4, 'ABCDEF'.indexOf((pi.p.zones.match(/[A-Z]/g) || ['D']).pop()) + 1)).split('') : [];
  const sh = sheet(`${st} ${pi.num}번 승강장은 이렇게 써 있어요`, `
    <div class="card" style="padding:0;overflow:hidden"><svg viewBox="0 0 300 150" class="iso" role="img" aria-label="표지판 모양 예시"><rect width="300" height="150" fill="var(--surface2)"/><rect x="70" y="12" width="160" height="94" rx="6" fill="var(--sign)"/><text x="150" y="36" text-anchor="middle" font-size="14" fill="#fff">${esc(pi.p.numFirst ? '' : pi.p.word)}</text><text x="150" y="94" text-anchor="middle" font-size="54" font-weight="600" fill="#fff" font-family="monospace">${esc(pi.num)}${pi.p.numFirst ? `<tspan font-size="20">${esc(pi.p.word)}</tspan>` : ''}</text>${zones.map((c, i) => `<rect x="${150 - zones.length * 28 + i * 56}" y="114" width="52" height="26" rx="4" fill="${c === pi.zone ? 'var(--signal)' : 'var(--sign)'}"/><text x="${176 - zones.length * 28 + i * 56}" y="132" text-anchor="middle" font-size="14" font-weight="600" fill="${c === pi.zone ? '#1A1400' : '#fff'}" font-family="monospace">${c}</text>`).join('')}</svg><div class="src" style="padding:8px 12px">모양 예시예요. 실제 디자인은 아래 사진으로 확인하세요.</div></div>
    <div class="card"><dl class="kvt"><dt>현지 표기</dt><dd>${esc(pi.label)} (${esc(pi.p.lang)})</dd><dt>영어 표기</dt><dd>${esc(pi.p.en)} ${esc(pi.num)} ${pi.p.confirmed ? '<span class="chip ok">확인</span>' : '<span class="chip warn">미확인</span>'}</dd>${pi.zone ? `<dt>탈 위치</dt><dd>${esc(pi.zone)} 구역</dd>` : ''}${pi.p.tip ? `<dt>헷갈리는 점</dt><dd style="font-weight:400">${esc(pi.p.tip)}</dd>` : ''}<dt>열차</dt><dd>${esc(l.no || '')} · ${hm(new Date(which === 'arr' ? l.arr : l.dep))} · ${esc(l.cls || '클래스 미입력')}</dd></dl></div>
    <div class="h"><h2>실제 사진 (Wikimedia Commons)</h2><span class="src" id="phSt">불러오는 중…</span></div>
    <div class="photos" id="photos"></div>
    <div class="src">구글 지도 사진은 약관상 미리 저장할 수 없어서, 재사용이 허락된 Commons 사진을 씁니다. 와이파이일 때 미리 받아 둬요.</div>
    <button class="btn line" data-open="https://www.google.com/search?tbm=isch&q=${encodeURIComponent(st + ' ' + pi.label)}">구글 이미지에서 더 보기 (온라인)</button>`);
  bind(sh);
  try {
    let items = [];
    for (const q of signQueries(l, which)) { items = await commons(q); if (items.length) break; }
    $('#phSt', sh).textContent = items.length ? `${items.length}장` : '찾은 사진 없음';
    $('#photos', sh).innerHTML = items.map((p) => `<a class="photo" href="${esc(p.page)}" data-open="${esc(p.page)}"><img loading="lazy" src="${esc(p.thumb)}" alt="${esc(p.title)}"><div>${esc(p.title)}${p.lic ? ' · ' + esc(p.lic) : ''}</div></a>`).join('');
    bind(sh);
  } catch (e) { $('#phSt', sh).textContent = '오프라인이라 못 불러왔어요'; }
}
function iso(x, y, z) { const s = 18; return [130 + (x - y) * 0.86 * s, 110 + (x + y) * 0.5 * s - z].map((v) => v.toFixed(1)); }
function poly(p, f, ex) { return `<polygon points="${p.map((q) => iso(...q).join(',')).join(' ')}" fill="${f}" ${ex || ''}/>`; }
function pline(p, s, w, d) { return `<polyline points="${p.map((q) => iso(...q).join(',')).join(' ')}" fill="none" stroke="${s}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" ${d ? `stroke-dasharray="${d}"` : ''}/>`; }
function txt(p, s, o) { o = o || {}; const [x, y] = iso(...p); return `<text x="${x}" y="${y}" font-size="${o.fs || 10}" text-anchor="middle" fill="${o.fill || 'var(--ink)'}" font-weight="${o.fw || 500}">${s}</text>`; }
function pinAt(p, n) { const [x, y] = iso(...p); return `<circle cx="${x}" cy="${y}" r="9" fill="var(--path)"/><text x="${x}" y="${+y + 4}" text-anchor="middle" font-size="10" font-weight="600" fill="#fff">${n}</text>`; }
function xferSVG(a, b, lug) {
  const T = 80; let g = '';
  g += poly([[0, 0, 0], [10, 0, 0], [10, 4, 0], [0, 4, 0]], 'var(--lvl-low)', 'stroke="var(--line)"');
  g += txt([3.4, 5.2, 0], '연결 통로 (지하 또는 위층)', { fill: 'var(--slow)', fw: 600 });
  if (lug) { g += poly([[8.2, 1.7, 0], [9, 1.7, 0], [9, 2.3, 0], [8.2, 2.3, 0]], 'var(--warn)'); g += txt([8.6, 2, 14], '짐 보관', { fill: 'var(--warn)', fw: 700 }); }
  g += poly([[0, 0, T], [10, 0, T], [10, 4, T], [0, 4, T]], 'var(--lvl-top)', 'stroke="var(--line)" opacity=".93"');
  g += poly([[0, 0.6, T], [10, 0.6, T], [10, 1.4, T], [0, 1.4, T]], 'var(--surface)');
  g += poly([[0, 2.6, T], [10, 2.6, T], [10, 3.4, T], [0, 3.4, T]], 'var(--surface)');
  g += txt([-0.4, 1, T], esc(a.arrPlat || '?') + '번', { fw: 700 }); g += txt([-0.4, 3, T], esc(b.depPlat || '?') + '번', { fw: 700 });
  g += txt([10.6, -0.2, T], '승강장층', { fill: 'var(--accent)', fw: 600 });
  let path = [[6.25, 1, T], [6, 1, T], [6, 1, 0]];
  if (lug) path = path.concat([[6, 2, 0], [8.6, 2, 0], [6, 2, 0]]);
  path = path.concat([[6, 3, 0], [6, 3, T], [3.75, 3, T]]);
  g += pline(path, 'var(--path)', 3.5);
  g += pinAt([6.25, 1, T], 1); g += pinAt([6, 2, 0], 2); g += pinAt([6, 3, T], 3); g += pinAt([3.75, 3, T], 4);
  return `<svg class="iso" viewBox="40 10 300 240" role="img" aria-label="환승 경로 모식도">${g}</svg>`;
}
async function xferView() {
  const a = DB.legs.find((x) => x.id === S.xfer); const b = a && connection(a);
  if (!a || !b) { go('move'); return; }
  const slack = mins(t(b.dep) - t(a.arr));
  const lug = S.luggage;
  const pb = platInfo(b, 'dep');
  $('#screen').innerHTML = `<button class="back" data-go="move">← 구간</button>
  <div class="card"><div class="h"><b>${esc(a.to)} 환승 · ${esc(a.arrPlat || '?')} → ${esc(b.depPlat || '?')}번</b><span class="chip ${slack - (lug ? 5 : 0) < 3 ? 'bad' : slack < 10 ? 'warn' : 'ok'} num">여유 ${slack - (lug ? 5 : 0)}분</span></div>
   <div class="src">${hm(new Date(a.arr))} 도착 → ${hm(new Date(b.dep))} ${esc(b.no || '')} 출발</div>
   ${xferSVG(a, b, lug)}
   <div class="src">모식도예요. 실제 층 구조·통로 위치는 역 안내도로 확인하세요.</div>
   <div class="tg" style="border-top:1px solid var(--line);padding-top:8px;margin-top:6px"><div><b style="font-size:13.5px">짐 맡기고 가기</b><div class="src">근처 보관함을 찾아 경로에 넣어요(약 +5분)</div></div><button class="sw" id="lugSw" aria-pressed="${lug}" aria-label="짐 맡기기 포함"></button></div>
  </div>
  ${lug && slack < 15 ? `<div class="card" style="border-color:var(--bad)"><b style="color:var(--bad)">${slack}분 환승에 짐 보관은 빠듯해요</b><div class="src">도착역에서 맡기는 걸 권해요.</div></div>` : ''}
  <div class="card"><div class="h" style="margin-bottom:8px"><h2>이렇게 움직이세요</h2><span class="src">그림의 번호</span></div>
  <ol class="steps">
   <li><span class="pin">1</span><div><b>${esc(a.arrPlat || '?')}번에 내리면 계단·엘리베이터 쪽으로</b><div class="src">짐이 많으면 엘리베이터 표시(♿/🛗)를 따라가세요</div></div></li>
   <li><span class="pin">2</span><div><b>연결 통로로 이동</b><div class="src">표지판 "${esc(pb.label)}" 방향${lug ? ' · 보관함 들르기' : ''}</div></div></li>
   <li><span class="pin">3</span><div><b>${esc(pb.label || b.depPlat + '번')} 계단으로 올라가기</b><div class="src">같은 승강장 반대편 번호와 헷갈리지 않게 번호판 확인</div></div></li>
   <li><span class="pin">4</span><div><b>${pb.zone ? esc(pb.zone) + ' 구역에서 기다리기' : '열차 칸 위치는 전광판 확인'}</b><div class="src">${esc(b.cls || '')} ${esc(b.no || '')}</div></div></li>
  </ol></div>
  <div class="card" id="lockers"><div class="h"><h2>${esc(a.to)} 근처 짐 보관</h2><span class="src" id="lkSt">${a.toGeo ? '찾는 중…' : '역 위치 모름'}</span></div><div id="lkList"></div></div>
  ${signBtn(b, 'dep') ? `<div class="card">${signBtn(b, 'dep')}</div>` : ''}
  <button class="btn line" data-open="https://www.google.com/search?q=${encodeURIComponent(a.to + ' station map')}">${esc(a.to)} 역 안내도 검색</button>`;
  bind($('#screen'));
  $('#lugSw').onclick = () => { S.luggage = !S.luggage; xferView(); };
  if (a.toGeo) {
    try {
      const r = await search('locker', a.toGeo);
      const items = rank('locker', r.items);
      $('#lkSt').textContent = items.length ? `${items.length}곳 · ${r.src}` : '데이터 없음';
      $('#lkList').innerHTML = items.map((it, i) => `<div class="item" style="grid-template-columns:24px 1fr auto"><span class="pin">${i + 1}</span><div><h3>${esc(it.name)}</h3><div class="kv">역에서 ${fmtD(it.d)}${it.hours ? ' · ' + esc(it.hours) : ''}</div></div><button class="btn line sm" data-navitem='${esc(JSON.stringify({ name: it.name, lat: it.lat, lon: it.lon }))}'>길안내</button></div>`).join('') || '<div class="empty">OSM에 등록된 보관함이 없어요. 역 안내도에서 "Gepäck / Consigne / Deposito / Left luggage"를 찾아 보세요.</div>';
      bind($('#lockers'));
    } catch (e) { $('#lkSt').textContent = '못 불러왔어요'; }
  }
}

/* ---------------- 할 일(미리 조사 + 직접 할 일) ---------------- */
function todoItems() {
  const out = [];
  if (DB.apk) out.push({ id: 'apk' + DB.apk.versionCode, t: `새 앱 버전 ${DB.apk.versionName || ''} 설치`, d: DB.apk.note || '화면 말고 앱 껍데기가 바뀐 업데이트라 한 번 설치가 필요해요', k: '설치', url: DB.apk.url });
  const cc = S.cc;
  P.apps(cc).forEach(([n, why]) => out.push({ id: 'app:' + cc + ':' + n, t: `${n} 설치`, d: `${P.countryName(cc)} · ${why}${A && A.isUnmetered() ? ' · 지금 와이파이' : ' · 와이파이에서 권장'}`, k: '앱', url: `https://play.google.com/store/search?q=${encodeURIComponent(n)}&c=apps` }));
  const n = Date.now();
  legs().filter((l) => l.mode !== 'booking' && !l.depPlat && t(l.dep) > n && t(l.dep) - n < 36 * 3600e3).forEach((l) => out.push({ id: 'plat:' + l.id, t: `${l.from} ${hm(new Date(l.dep))} ${l.no || ''} 승강장 확인`, d: '아직 승강장 미정. 국가 철도 앱이나 역 전광판에서 확인 후 입력', k: '확인', edit: l.id }));
  (DB.reqs || []).filter((r) => r.state === 'closed' && !DB.seenReq[r.n]).forEach((r) => out.push({ id: 'req:' + r.n, t: `요청 반영됨: ${r.title}`, d: r.note || '앱이 자동으로 업데이트됐어요', k: '반영', req: r.n }));
  return out;
}
function pendingCount() { return todoItems().filter((x) => !DB.done[x.id]).length; }
function inboxView() {
  const r = DB.research;
  const items = todoItems();
  return `<div class="card"><div class="h"><h2>미리 조사한 것</h2><span class="src num">${r ? new Date(r.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</span></div>
   ${r ? `<div style="display:flex;flex-direction:column;gap:3px;margin-top:6px;font-size:13.5px">${r.lines.map((x) => `<div>✓ ${esc(x)}</div>`).join('')}</div>` : '<div class="empty" style="margin-top:6px">아직 없어요. 와이파이에 연결되면 앱을 열 때 다음 목적지 맛집·화장실·짐 보관·표지판 사진을 미리 받아 둬요.</div>'}
   <button class="btn line full sm" id="resBtn" style="margin-top:8px">지금 조사하기${A && !A.isUnmetered() ? ' (모바일 데이터)' : ''}</button>
   <div class="src" style="margin-top:6px">밤사이 클라우드 조사는 아직 연결 전이에요. 지금은 폰이 와이파이일 때 직접 받아 둡니다.</div></div>
  <div class="h"><h2>직접 눌러야 할 일</h2><span class="src">설치·결제는 직접</span></div>
  ${items.map((a) => { const d = DB.done[a.id]; return `<div class="card" style="${d ? 'opacity:.55' : ''}"><div class="h"><b>${esc(a.t)}</b><span class="chip ${a.k === '반영' ? 'ok' : a.k === '확인' ? 'warn' : 'acc'}">${a.k}</span></div><div class="src" style="margin:2px 0 8px">${esc(a.d)}</div><div style="display:flex;gap:6px">${d ? '<span class="chip ok">완료</span>' : `${a.url ? `<button class="btn pri sm" data-open="${esc(a.url)}">열기</button>` : ''}${a.edit ? `<button class="btn pri sm" data-editleg="${a.edit}">입력</button>` : ''}${a.req ? `<button class="btn pri sm" data-reqseen="${a.req}">확인</button>` : ''}<button class="btn line sm" data-done="${esc(a.id)}">완료 표시</button>`}</div></div>`; }).join('')}`;
}
let researching = false;
async function research(manual) {
  if (researching) return; if (!manual && A && !A.isUnmetered()) return;
  if (!manual && DB.research && Date.now() - DB.research.at < 6 * 3600e3) return;
  researching = true; if (manual) toast('미리 조사 시작…');
  const lines = []; const n = Date.now();
  try {
    const targets = [];
    const here = await locate(300000); if (here) targets.push({ name: S.city || '현재 위치', g: here });
    for (const l of legs().filter((x) => t(x.dep) > n - 3600e3 && t(x.dep) - n < 48 * 3600e3)) {
      if (!l.toGeo || !l.fromGeo) await upsertLeg(l);
      if (l.toGeo) targets.push({ name: l.to, g: l.toGeo, leg: l });
    }
    const seen = new Set();
    for (const tg of targets) {
      const k = tg.g.lat.toFixed(2) + tg.g.lon.toFixed(2); if (seen.has(k)) continue; seen.add(k);
      for (const cat of ['food', 'wc', 'locker', 'sight']) {
        try {
          const r = await search(cat, tg.g, { fresh: true, pre: true });
          lines.push(`${tg.name} ${CATS[cat].label} ${r.items.length}곳`);
        } catch (e) { lines.push(`${tg.name} ${CATS[cat].label} 실패`); }
      }
    }
    for (const l of legs().filter((x) => x.depPlat && t(x.dep) > n && t(x.dep) - n < 48 * 3600e3)) {
      try { let c = 0; for (const q of signQueries(l, 'dep')) { const it = await commons(q); c = it.length; it.forEach((p) => { const im = new Image(); im.src = p.thumb; }); if (c) break; } lines.push(`${l.from} ${platInfo(l, 'dep').label} 표지판 사진 ${c}장`); } catch (e) { }
    }
    DB.research = { at: Date.now(), lines: lines.length ? lines : ['조사할 위치가 없어요'] }; save();
    if (manual) toast('미리 조사 끝');
  } finally { researching = false; if (S.view === 'inbox' || S.view === 'home') render(); }
}

/* ---------------- 저장 ---------------- */
function savedView() {
  const tags = ['숙소', '맛집', '관광', '기타'];
  return `<div class="card"><div class="h"><h2>저장한 곳</h2><span class="src">${DB.saved.length}곳</span></div>
   ${DB.saved.length ? DB.saved.map((s, i) => `<div class="item" style="grid-template-columns:24px 1fr auto"><span class="pin">${i + 1}</span><div style="min-width:0"><h3>${esc(s.name)}</h3><div class="seg" style="margin-top:4px">${tags.map((tg) => `<button data-tag="${i}:${tg}" aria-pressed="${s.tag === tg}">${tg}</button>`).join('')}</div></div><div class="acts"><button class="btn line sm" data-nav="${i}" data-from="saved">길안내</button><button class="btn sm" data-unsave="${i}">삭제</button></div></div>`).join('') : '<div class="empty" style="margin-top:6px">결과 화면에서 "저장"을 누르거나, 마이크로 "1번 저장해 줘"라고 말하세요.</div>'}
  </div>
  <div class="card" style="display:flex;flex-direction:column;gap:8px"><b>구글 지도에서 한눈에 보기</b><div class="src">구글 지도 "저장 목록"에 직접 쓰는 공개 기능이 없어서, KML 파일로 내보내 Google My Maps(내 지도)에 가져오면 지도에 한꺼번에 보입니다.</div>
   <div class="grid2"><button class="btn pri" id="kmlBtn">KML 내보내기</button><button class="btn" id="mymapsBtn">My Maps 열기</button></div>
   <button class="btn line" id="shareBtn">목록 공유(카톡 등)</button>
   <label class="f">숙소 직접 추가 (주소나 이름)<div style="display:flex;gap:6px"><input id="lodg" placeholder="예: Hotel Alpenblick Interlaken"><button class="btn pri" id="lodgBtn">추가</button></div></label></div>`;
}
function saveItem(it, tag) {
  if (DB.saved.some((s) => s.id === it.id)) { toast('이미 저장돼 있어요'); return; }
  DB.saved.push({ id: it.id, name: it.name, lat: it.lat, lon: it.lon, gid: it.gid || '', tag: tag || (S.q === 'food' ? '맛집' : S.q === 'sight' ? '관광' : '기타'), at: Date.now() }); save();
  toast(`"${it.name}" 저장`);
}
function kml() {
  const pm = DB.saved.map((s) => `<Placemark><name>${esc(s.name)}</name><description>${esc(s.tag)}</description><Point><coordinates>${s.lon},${s.lat},0</coordinates></Point></Placemark>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>여행 Agent 저장</name>${pm}</Document></kml>`;
}

/* ---------------- 요청함 (앱 고치기) ---------------- */
function reqSheet(prefill) {
  const repo = DB.prefs.repo;
  const sh = sheet('앱 고쳐 달라고 요청하기', `
   <div class="card" style="display:flex;flex-direction:column;gap:8px">
    <div class="src">여기 적은 내용은 GitHub 이슈로 올라가고, Claude가 주기적으로 읽어서 앱에 반영합니다. 화면 수정은 앱이 자동으로 받아요(재설치 불필요).</div>
    <textarea id="reqText" placeholder="예: 맛집 결과에 '지금 영업 중'만 보이게 해줘">${esc(prefill || '')}</textarea>
    <label class="tg"><span class="src">지금 화면 정보 같이 보내기 (${esc(S.view)} · build ${BUILD})</span><input type="checkbox" id="reqCtx" checked style="width:auto"></label>
    <button class="btn pri full" id="reqSend">보내기${DB.prefs.ghToken ? '' : ' (GitHub 화면이 열려요)'}</button>
    <button class="btn line full sm" id="updBtn">지금 업데이트 확인</button>
   </div>
   <div class="card"><div class="h"><h2>보낸 요청</h2><span class="src" id="reqSt"></span></div><div id="reqList">${reqList()}</div></div>`);
  $('#reqSend', sh).onclick = async () => {
    const text = $('#reqText', sh).value.trim(); if (!text) return;
    const title = text.split('\n')[0].slice(0, 70);
    const ctx = $('#reqCtx', sh).checked ? `\n\n---\n앱 정보: view=${S.view}, build=${BUILD}, apk=${A ? JSON.parse(A.info()).versionName : 'browser'}, 나라=${S.cc}, 시각=${new Date().toISOString()}` : '';
    const body = text + ctx;
    if (DB.prefs.ghToken) {
      try {
        const j = await fetchJSON(`https://api.github.com/repos/${repo}/issues`, { method: 'POST', headers: { Authorization: 'Bearer ' + DB.prefs.ghToken, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify({ title, body, labels: ['app-request'] }) });
        DB.reqs.unshift({ n: j.number, title, state: 'open', at: Date.now(), url: j.html_url }); save();
        toast(`요청 #${j.number} 접수. Claude가 반영하면 할 일 탭에 알려 드려요`, 4000); $('#reqText', sh).value = ''; $('#reqList', sh).innerHTML = reqList();
      } catch (e) { toast('보내기 실패: ' + e.message, 5000); }
    } else {
      open(`https://github.com/${repo}/issues/new?labels=app-request&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`);
      DB.reqs.unshift({ n: 0, title, state: 'draft', at: Date.now() }); save();
    }
  };
  $('#updBtn', sh).onclick = () => { if (A) { A.checkUpdate(); toast('확인 중…'); } else location.reload(); };
  syncReqs().then(() => { const el = $('#reqList', sh); if (el) { el.innerHTML = reqList(); bind(el); } const st = $('#reqSt', sh); if (st) st.textContent = '방금 갱신'; });
  bind(sh);
}
function reqList() {
  const rs = DB.reqs || [];
  if (!rs.length) return '<div class="empty">아직 없어요</div>';
  return rs.slice(0, 30).map((r) => `<div class="req"><div class="h"><b style="font-size:13.5px">${r.n ? '#' + r.n + ' ' : ''}${esc(r.title)}</b><span class="chip ${r.state === 'closed' ? 'ok' : r.state === 'draft' ? '' : r.label === 'in-progress' ? 'slow' : 'warn'}">${r.state === 'closed' ? '반영됨' : r.state === 'draft' ? '작성만 함' : r.label === 'in-progress' ? '작업 중' : '대기'}</span></div>${r.note ? `<p class="src">${esc(r.note)}</p>` : ''}${r.url ? `<button class="btn line sm" data-open="${esc(r.url)}" style="align-self:flex-start">GitHub에서 보기</button>` : ''}</div>`).join('');
}
async function syncReqs() {
  try {
    const h = { Accept: 'application/vnd.github+json' }; if (DB.prefs.ghToken) h.Authorization = 'Bearer ' + DB.prefs.ghToken;
    const j = await fetchJSON(`https://api.github.com/repos/${DB.prefs.repo}/issues?labels=app-request&state=all&per_page=30&sort=updated`, { headers: h }, 8000);
    DB.reqs = j.map((i) => {
      const prev = (DB.reqs || []).find((r) => r.n === i.number) || {};
      return { n: i.number, title: i.title, state: i.state, at: t(i.created_at), url: i.html_url, label: (i.labels || []).map((l) => l.name).includes('in-progress') ? 'in-progress' : '', note: prev.note || '' };
    });
    // 닫힌 요청의 마지막 댓글(반영 내용) 한 줄
    for (const r of DB.reqs.filter((r) => r.state === 'closed' && !r.note).slice(0, 5)) {
      try { const cs = await fetchJSON(`https://api.github.com/repos/${DB.prefs.repo}/issues/${r.n}/comments?per_page=5`, { headers: h }, 6000); const last = cs[cs.length - 1]; if (last) r.note = last.body.split('\n').find((x) => x.trim() && !x.startsWith('---') && !x.startsWith('_Generated')) || ''; } catch (e) { }
    }
    save(); badge();
  } catch (e) { }
}

/* ---------------- 설정 ---------------- */
function settingsSheet() {
  const p = DB.prefs;
  const info = A ? JSON.parse(A.info()) : { versionName: '브라우저', webBuild: BUILD };
  const sh = sheet('설정', `
   <div class="card" style="display:flex;flex-direction:column;gap:10px">
    <div class="tg"><div><b>음성 답변</b><div class="src">말로 물으면 답을 읽어 줘요</div></div><button class="sw" id="s_tts" aria-pressed="${p.tts}"></button></div>
    <label class="f">나라 고정 (비우면 위치로 자동)<select id="s_cc">${['', ...P.list].map((c) => `<option value="${c}" ${p.ccOverride === c ? 'selected' : ''}>${c ? P.countryName(c) + ' · ' + P.mapName(c) : '자동 (지금: ' + P.countryName(S.cc) + ')'}</option>`).join('')}</select></label>
   </div>
   <div class="card" style="display:flex;flex-direction:column;gap:10px"><b>연결 (선택)</b>
    <label class="f">Google Places API 키 — 맛집 구글 평점·리뷰 수·영업 중 표시<input id="s_gkey" value="${esc(p.gkey)}" placeholder="AIza…" autocomplete="off"></label>
    <label class="f">Anthropic API 키 — 버튼에 없는 질문, 일정 텍스트 자동 정리<input id="s_akey" value="${esc(p.akey)}" placeholder="sk-ant-…" autocomplete="off"></label>
    <label class="f">Claude 모델<input id="s_model" value="${esc(p.model)}"></label>
    <label class="f">요청을 받을 GitHub 저장소<input id="s_repo" value="${esc(p.repo)}"></label>
    <label class="f">GitHub 토큰 — 있으면 앱 안에서 바로 요청 접수 (Issues 쓰기 권한만)<input id="s_gh" value="${esc(p.ghToken)}" placeholder="github_pat_…" autocomplete="off"></label>
    <div class="src">키는 이 폰 안에만 저장되고 각 서비스로만 보내져요.</div>
    <button class="btn pri" id="s_save">저장</button>
   </div>
   <div class="card" style="display:flex;flex-direction:column;gap:8px"><b>백업</b><div class="grid2"><button class="btn" id="s_exp">내보내기</button><button class="btn" id="s_imp">가져오기</button></div></div>
   <div class="src">앱 ${esc(info.versionName)} · 화면 build ${info.webBuild}</div>`);
  $('#s_tts', sh).onclick = (e) => { p.tts = !p.tts; e.currentTarget.setAttribute('aria-pressed', p.tts); save(); };
  $('#s_save', sh).onclick = () => {
    p.gkey = $('#s_gkey', sh).value.trim(); p.akey = $('#s_akey', sh).value.trim(); p.model = $('#s_model', sh).value.trim() || DEF.prefs.model;
    p.repo = $('#s_repo', sh).value.trim() || DEF.prefs.repo; p.ghToken = $('#s_gh', sh).value.trim(); p.ccOverride = $('#s_cc', sh).value;
    S.cc = null; save(); whereAmI(); toast('저장했어요'); sh.remove(); render();
  };
  $('#s_exp', sh).onclick = () => { const data = JSON.stringify(Object.assign({}, DB, { cache: {} })); if (A) { const r = A.saveDownload('travel-agent-backup.json', data, 'application/json'); toast(r === 'ok' ? 'Download 폴더에 저장했어요' : r); } else { navigator.clipboard.writeText(data); toast('복사했어요'); } };
  $('#s_imp', sh).onclick = () => { const s = prompt('백업 내용을 붙여넣으세요'); if (!s) return; try { DB = Object.assign({}, DEF, JSON.parse(s)); save(); toast('가져왔어요'); sh.remove(); render(); } catch (e) { toast('형식이 맞지 않아요'); } };
}

/* ---------------- Claude (선택, 느린 경로) ---------------- */
async function claude(prompt, opt) {
  opt = opt || {};
  if (!DB.prefs.akey) throw new Error('설정에 Anthropic API 키가 없어요');
  const { cur, next } = nowLeg();
  const ctx = `현지 시각 ${new Date().toLocaleString('ko-KR')} (한국 ${seoul.format(new Date())}). 위치: ${S.city || '?'}, ${P.countryName(S.cc)}${DB.lastFix ? ` (${DB.lastFix.lat.toFixed(4)}, ${DB.lastFix.lon.toFixed(4)})` : ''}. 지금 이동: ${cur ? JSON.stringify({ no: cur.no, from: cur.from, to: cur.to, arr: cur.arr }) : '없음'}. 다음 일정: ${next ? JSON.stringify({ no: next.no, from: next.from, dep: next.dep, plat: next.depPlat }) : '없음'}.`;
  const sys = '너는 여행 중인 사용자의 비서다. 한국어로 3~5문장, 결론과 숫자를 먼저 말한다. 확인하지 못한 스펙(와이파이, 샤워, 운행 여부 등)은 단정하지 말고 "확인 필요"라고 한다. 현지 시각을 고려한다. 할 수 없는 일(깨워주기, 결제 등)은 약속하지 않는다. 웹 검색을 했다면 출처 이름을 짧게 붙인다.';
  const body = { model: DB.prefs.model, max_tokens: opt.json ? 2000 : 700, system: sys, messages: [{ role: 'user', content: (opt.json ? '' : ctx + '\n\n') + prompt }] };
  const call = (b) => fetchJSON('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': DB.prefs.akey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify(b) }, 45000);
  let j;
  if (!opt.json) { try { j = await call(Object.assign({}, body, { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }] })); } catch (e) { j = null; } }
  if (!j) j = await call(body);
  return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
}

/* ---------------- 라우터 (LLM 없음) ---------------- */
function route(text) {
  const s = text.trim(); const l = s.toLowerCase();
  const { cur, next } = nowLeg();
  let m;
  if (/화장실|toilet|restroom|\bwc\b|토일렛/.test(l)) return { fast: 1, spoken: '근처 화장실을 가까운 순으로 띄울게요.', then: () => openQ('wc') };
  if (/(짐|캐리어|보관함|락커|코인\s*로커|locker|luggage)/.test(l)) return { fast: 1, spoken: '근처 짐 보관함을 찾을게요.', then: () => openQ('locker') };
  if (/(승강장|플랫폼|몇\s*번\s*(에서|으로)?\s*타|gleis|binario|voie|platform|타는\s*곳)/.test(l)) {
    const lg = cur ? connection(cur) || cur : next;
    if (!lg) return { fast: 1, spoken: '등록된 다음 열차가 없어요. 이동 탭에서 추가해 주세요.', then: () => go('move') };
    const pi = platInfo(lg, 'dep');
    return { fast: 1, spoken: `${lg.from}에서 ${hm(new Date(lg.dep))} ${lg.no || ''}, ${pi.num ? pi.num + '번 승강장이에요. 표지판에는 ' + pi.label + '라고 써 있어요' : '승강장은 아직 입력되지 않았어요. 전광판을 확인해 주세요'}.${pi.zone ? ' ' + pi.zone + ' 구역에서 타세요.' : ''}${lg.cls ? ' ' + lg.cls + '이에요.' : ''}`, facts: [['출발', `${lg.from} ${hm(new Date(lg.dep))}`], ['승강장', pi.label || '미정'], ['영어', pi.num ? `${pi.p.en} ${pi.num}` : '-'], ['클래스', lg.cls || '미입력']], then: () => go('move') };
  }
  if (/(깨워|알람|하차)/.test(l)) {
    const lg = cur || next;
    if (!lg) return { fast: 1, spoken: '알람을 걸 이동이 없어요.' };
    return { fast: 1, spoken: `${lg.to} 도착 5분 전, ${hm(new Date(t(lg.arr) - 300000))}쯤 폰이 진동해요. 시간표 기준이라 연착은 반영되지 않으니, 깊이 잠들 거면 폰 알람도 같이 맞추세요.`, then: () => { setAlarm(lg, true); render(); } };
  }
  if ((m = l.match(/(\d+)\s*번.*(안내|가자|길|데려)/))) { const i = +m[1] - 1; const it = S.last && S.last.items[i]; if (it) return { fast: 1, spoken: `${it.name}까지 안내를 시작할게요.`, then: () => navTo(it) }; }
  if (/저장/.test(l)) { const n = (l.match(/(\d+)\s*번/) || [])[1] || 1; const it = S.last && S.last.items[n - 1]; if (it) return { fast: 1, spoken: `${it.name}을 저장했어요.`, then: () => saveItem(it) }; }
  if (/(맛집|밥|식당|점심|저녁|아침|먹을|먹고|레스토랑|카페|커피|배고)/.test(l)) {
    let f = null, fl = '';
    if (/한식\s*(말고|빼고|제외|아닌)/.test(l)) { f = (i) => !i.tags.includes('한식'); fl = '한식 제외'; }
    else if (/한식|한국/.test(l)) { f = (i) => i.tags.includes('한식'); fl = '한식만'; }
    else if (/카페|커피/.test(l)) { f = (i) => i.tags.includes('카페'); fl = '카페'; }
    if (/(영업|열린|문\s*연)/.test(l)) { const pf = f; f = (i) => (!pf || pf(i)) && !(i.open && i.open[0] === 'bad'); fl = (fl ? fl + ' · ' : '') + '영업 중'; }
    return { fast: 1, spoken: `근처 ${fl ? fl + ' ' : ''}식당을 띄울게요.`, then: () => openQ('food', f, fl) };
  }
  if (/(관광|볼거리|구경|명소|가볼|뭐\s*하)/.test(l)) return { fast: 1, spoken: '근처 볼거리를 띄울게요.', then: () => openQ('sight') };
  if (/(숙소|호텔|길찾|가는\s*길|어떻게\s*가)/.test(l)) return { fast: 1, spoken: '갈 곳을 고르면 바로 안내할게요.', then: () => openQ('route') };
  if ((m = s.match(/^(?:번역|translate)\s*[:：]?\s*(.+)$/i) || s.match(/^(.+?)\s*(?:번역해\s*줘|번역해|번역)$/))) {
    const q = m[1]; const tl = /[가-힣]/.test(q) ? 'en' : 'ko';
    return { fast: 1, spoken: '번역 앱으로 열게요. 오프라인 언어팩이 있으면 폰에서 바로 번역돼요.', then: () => open(`https://translate.google.com/?sl=auto&tl=${tl}&text=${encodeURIComponent(q)}&op=translate`) };
  }
  if (/(몇\s*시|시간\s*알려|지금\s*시간)/.test(l)) { const d = new Date(); return { fast: 1, spoken: `현지 ${hm(d)}, 한국은 ${seoul.format(d)}예요.` }; }
  if (/(앱|화면|버튼).*(고쳐|바꿔|추가해|만들어)|요청/.test(l)) return { fast: 1, spoken: '요청함을 열게요. 그대로 보내면 Claude가 반영해요.', then: () => reqSheet(s) };
  return null;
}
function handle(text) {
  const r = route(text);
  if (r) { answer(text, r); return; }
  answer(text, { fast: 0 });
}

/* ---------------- 음성 / 답 카드 ---------------- */
let vEl = null;
function voiceUI(state, heard, extra) {
  if (!vEl) {
    vEl = document.createElement('div'); vEl.className = 'voice';
    vEl.innerHTML = `<div class="vh"><span id="vState"></span><button class="x" id="vClose">닫기</button></div><button class="orb" id="vOrb" aria-label="다시 말하기"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button><div class="heard" id="vHeard"></div><div id="vBody" style="display:flex;flex-direction:column;gap:10px"></div>`;
    $('#app').appendChild(vEl);
    $('#vClose', vEl).onclick = closeVoice;
    $('#vOrb', vEl).onclick = startVoice;
  }
  vEl.dataset.s = state;
  $('#vState', vEl).textContent = { listen: '듣고 있어요… 말을 마치면 자동으로 처리해요', think: '처리 중', answer: '답', idle: '' }[state] || '';
  const h = $('#vHeard', vEl); h.textContent = heard || (state === 'listen' ? '말해 보세요' : ''); h.className = 'heard' + (heard ? '' : ' dim');
  $('#vBody', vEl).innerHTML = extra || '';
  bind(vEl);
}
function closeVoice() { if (A) { A.stopVoice(); A.stopSpeak(); } else if (window.speechSynthesis) speechSynthesis.cancel(); if (vEl) vEl.remove(); vEl = null; }
let webRec = null;
function startVoice() {
  voiceUI('listen');
  if (A) { A.startVoice('ko-KR'); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { voiceUI('idle', '', '<div class="ans"><div>이 브라우저는 음성 인식을 지원하지 않아요. 아래 입력줄에 적어 주세요.</div></div>'); return; }
  webRec = new SR(); webRec.lang = 'ko-KR'; webRec.interimResults = true;
  webRec.onresult = (e) => { const r = e.results[e.results.length - 1]; window.onVoice({ type: r.isFinal ? 'final' : 'partial', text: r[0].transcript }); };
  webRec.onerror = (e) => window.onVoice({ type: 'error', msg: e.error });
  webRec.start();
}
window.onVoice = (e) => {
  if (!vEl) return;
  if (e.type === 'partial') { $('#vHeard', vEl).textContent = e.text; $('#vHeard', vEl).className = 'heard'; }
  else if (e.type === 'final') { if (e.text) answer(e.text, route(e.text) || { fast: 0 }, true); else voiceUI('idle', '', '<div class="ans">못 알아들었어요. 가운데 버튼을 눌러 다시 말해 주세요.</div>'); }
  else if (e.type === 'error') { const msg = e.msg || ({ 7: '말소리를 못 들었어요', 6: '말소리가 없었어요', 9: '마이크 권한이 필요해요', 2: '네트워크 문제로 인식 실패' })[e.code] || '음성 인식 오류'; voiceUI('idle', '', `<div class="ans">${esc(msg)}. 가운데 버튼을 눌러 다시 말하거나 아래에 적어 주세요.</div>`); }
};
async function answer(text, r, viaVoice) {
  const t0 = performance.now();
  if (r.fast) {
    const facts = r.facts ? `<dl class="kvt">${r.facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '';
    if (viaVoice || r.facts) {
      voiceUI('answer', text, `<span class="route">빠른 경로 · LLM 없음 · ${Math.max(1, Math.round(performance.now() - t0))}ms</span><div class="ans"><div class="spoken">${esc(r.spoken)}</div>${facts}<button class="btn pri" id="vThen">${r.then ? '화면으로' : '닫기'}</button></div>`);
      $('#vThen', vEl).onclick = () => { closeVoice(); };
      if (viaVoice) speak(r.spoken);
      if (r.then) r.then();
    } else { if (r.then) r.then(); toast(r.spoken); }
    return;
  }
  // 느린 경로
  if (!DB.prefs.akey) {
    voiceUI('answer', text, `<div class="ans"><div class="spoken">버튼 기능으로는 처리 못 하는 말이에요.</div><div class="src">설정에 Anthropic 키를 넣으면 Claude가 답해요. 지금은 아래로 바로 찾을 수 있어요.</div><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn pri sm" data-open="https://www.google.com/search?q=${encodeURIComponent(text)}">구글 검색</button><button class="btn sm" data-mapsearch="${esc(text)}">지도에서 찾기</button><button class="btn line sm" data-req="${esc(text)}">이 기능 만들어 달라고 요청</button></div></div>`);
    return;
  }
  voiceUI('think', text, '<span class="route">Agent 경로 · Claude · 수 초</span>');
  try {
    const out = await claude(text);
    if (!vEl) return;
    voiceUI('answer', text, `<span class="route">Agent 경로 · ${((performance.now() - t0) / 1000).toFixed(1)}초</span><div class="ans"><div class="spoken">${esc(out)}</div><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn line sm" data-req="${esc(text)}">자주 묻는 거면 버튼으로 만들어 달라고 요청</button></div></div>`);
    speak(out.replace(/\[[^\]]*\]\([^)]*\)/g, '').slice(0, 400));
  } catch (e) {
    voiceUI('answer', text, `<div class="ans"><div class="spoken">Claude 호출 실패</div><div class="src">${esc(e.message)}</div><button class="btn pri sm" data-open="https://www.google.com/search?q=${encodeURIComponent(text)}">구글 검색</button></div>`);
  }
}

/* ---------------- 시트 ---------------- */
function sheet(title, html) {
  const el = document.createElement('div'); el.className = 'sheet';
  el.innerHTML = `<div class="sh"><b>${esc(title)}</b><button class="btn sm" data-close>닫기</button></div><div class="sb">${html}</div>`;
  $('[data-close]', el).onclick = () => el.remove();
  $('#app').appendChild(el); return el;
}

/* ---------------- 렌더 / 이벤트 ---------------- */
function go(v) { S.view = v; render(); }
function render() {
  const sc = $('#screen');
  if (map && S.view !== 'result') { map.remove(); map = null; }
  const v = S.view;
  if (v === 'xfer') { xferView(); }
  else if (v === 'result' && S.q === 'route') { routeView(); }
  else {
    sc.innerHTML = v === 'home' ? home() : v === 'move' ? moveView() : v === 'inbox' ? inboxView() : v === 'saved' ? savedView() : v === 'result' ? resultView() : home();
    bind(sc);
    if (v === 'home') contextNudge();
    if (v === 'result' && S.res && S.res.items && S.here) mapInit($('#map'), S.here, S.res.items);
    if (v === 'inbox') { const b = $('#resBtn'); if (b) b.onclick = () => research(true); }
    if (v === 'saved') bindSaved();
  }
  sc.scrollTop = 0;
  $$('.tab').forEach((tb) => tb.setAttribute('aria-current', tb.dataset.tab === ({ result: 'home', xfer: 'move' }[v] || v)));
  header(); badge();
  try { sessionStorage.setItem('ta.view', JSON.stringify({ view: v === 'result' || v === 'xfer' ? 'home' : v })); } catch (e) { }
}
function badge() { const p = pendingCount(); const b = $('#badge'); b.textContent = p; b.hidden = !p; }
function bindSaved() {
  $('#kmlBtn').onclick = () => { if (!DB.saved.length) return toast('저장한 곳이 없어요'); if (A) { const r = A.saveDownload(`travel-agent-${new Date().toISOString().slice(0, 10)}.kml`, kml(), 'application/vnd.google-earth.kml+xml'); toast(r === 'ok' ? 'Download 폴더에 저장. My Maps에서 "가져오기"로 올리세요' : r, 4500); } else { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([kml()])); a.download = 'travel-agent.kml'; a.click(); } };
  $('#mymapsBtn').onclick = () => open('https://www.google.com/maps/d/');
  $('#shareBtn').onclick = () => { const s = DB.saved.map((x, i) => `${i + 1}. [${x.tag}] ${x.name}\nhttps://www.google.com/maps/search/?api=1&query=${x.lat},${x.lon}`).join('\n'); if (A) A.share(s); else navigator.clipboard.writeText(s).then(() => toast('복사했어요')); };
  $('#lodgBtn').onclick = async () => { const q = $('#lodg').value.trim(); if (!q) return; const g = await geocode(q); if (!g) return toast('위치를 못 찾았어요. 더 자세히 적어 주세요'); DB.saved.unshift({ id: 'lodg' + Date.now(), name: q, lat: g.lat, lon: g.lon, tag: '숙소', at: Date.now() }); save(); render(); };
}
function bind(root) {
  $$('[data-go]', root).forEach((b) => (b.onclick = () => go(b.dataset.go)));
  $$('[data-q]', root).forEach((b) => (b.onclick = () => openQ(b.dataset.q)));
  $$('[data-nav]', root).forEach((b) => (b.onclick = () => { const it = b.dataset.from === 'saved' ? DB.saved[+b.dataset.nav] : S.last && S.last.items[+b.dataset.nav]; if (it) navTo(it, b.dataset.mode); }));
  $$('[data-navitem]', root).forEach((b) => (b.onclick = () => navTo(JSON.parse(b.dataset.navitem), 'walking')));
  $$('[data-navgeo]', root).forEach((b) => (b.onclick = () => { const l = DB.legs.find((x) => x.id === b.dataset.navgeo); if (l && l.fromGeo) navTo({ name: l.from, lat: l.fromGeo.lat, lon: l.fromGeo.lon }, 'transit'); }));
  $$('[data-save]', root).forEach((b) => (b.onclick = () => { const it = S.last && S.last.items[+b.dataset.save]; if (it) { saveItem(it); b.textContent = '저장됨'; } }));
  $$('[data-unsave]', root).forEach((b) => (b.onclick = () => { DB.saved.splice(+b.dataset.unsave, 1); save(); render(); }));
  $$('[data-tag]', root).forEach((b) => (b.onclick = () => { const [i, tg] = b.dataset.tag.split(':'); DB.saved[+i].tag = tg; save(); render(); }));
  $$('[data-sign]', root).forEach((b) => (b.onclick = () => openSign(b.dataset.sign)));
  $$('[data-xfer]', root).forEach((b) => (b.onclick = () => { S.xfer = b.dataset.xfer; go('xfer'); }));
  $$('[data-alarm]', root).forEach((b) => (b.onclick = () => { const l = DB.legs.find((x) => x.id === b.dataset.alarm); if (l) { setAlarm(l, !l.alarm); render(); } }));
  $$('[data-addleg]', root).forEach((b) => (b.onclick = () => legForm()));
  $$('[data-editleg]', root).forEach((b) => (b.onclick = () => legForm(DB.legs.find((x) => x.id === b.dataset.editleg))));
  $$('[data-open]', root).forEach((b) => (b.onclick = (e) => { e.preventDefault(); open(b.dataset.open); }));
  $$('[data-mapsearch]', root).forEach((b) => (b.onclick = () => { const pk = P.map(S.cc); openMap(pk.search(b.dataset.mapsearch), P.google.search(b.dataset.mapsearch)); }));
  $$('[data-done]', root).forEach((b) => (b.onclick = () => { DB.done[b.dataset.done] = Date.now(); save(); render(); }));
  $$('[data-reqseen]', root).forEach((b) => (b.onclick = () => { DB.seenReq[b.dataset.reqseen] = 1; save(); render(); }));
  $$('[data-req]', root).forEach((b) => (b.onclick = () => { closeVoice(); reqSheet(b.dataset.req + '\n(이걸 버튼/빠른 기능으로 만들어 줘)'); }));
}

// 입력줄: 기본 마이크, 글자가 생기면 X + 보내기
const inp = $('#askInput');
function syncAsk() { const has = inp.value.length > 0; $('#micBtn').hidden = has; $('#clrBtn').hidden = !has; $('#sendBtn').hidden = !has; }
inp.addEventListener('input', syncAsk);
$('#clrBtn').onclick = () => { inp.value = ''; syncAsk(); inp.focus(); };
$('#askForm').onsubmit = (e) => { e.preventDefault(); const v = inp.value.trim(); if (!v) return; inp.value = ''; syncAsk(); inp.blur(); handle(v); };
$('#micBtn').onclick = startVoice;
$('#wcFab').onclick = () => openQ('wc');
$('#reqBtn').onclick = () => reqSheet();
$('#setBtn').onclick = settingsSheet;
$$('.tab').forEach((tb) => (tb.onclick = () => go(tb.dataset.tab)));

// 네이티브 → 웹 콜백
window.onBack = () => {
  const sh = $$('.sheet'); if (sh.length) { sh[sh.length - 1].remove(); return true; }
  if (vEl) { closeVoice(); return true; }
  if (S.view === 'xfer') { go('move'); return true; }
  if (S.view !== 'home') { go('home'); return true; }
  return false;
};
window.onAppUpdated = (r, manual) => {
  if (r.updated) { toast(`새 화면 적용 (build ${r.build})${r.note ? ': ' + r.note : ''}`, 3500); setTimeout(() => location.reload(), 1200); }
  else if (manual) toast(r.error ? '업데이트 확인 실패: ' + r.error : `최신이에요 (build ${r.build})`, 3500);
};
window.onApkAvailable = (apk) => { DB.apk = apk; save(); badge(); };
window.onAppResume = () => { header(); research(false); syncReqs(); if (S.view === 'home') render(); };

// 시작
setInterval(header, 30000);
whereAmI(); render(); watch();
locate(120000).then(async (f) => { if (f) { S.here = f; await whereAmI(); } research(false); });
syncReqs();
})();
