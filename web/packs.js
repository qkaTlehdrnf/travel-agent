/* 국가 팩: 나라별 지도 앱, 승강장 표기, 설치 권장 앱.
   현재 위치(또는 구간의 나라)로 자동 전환된다. 값이 확실하지 않은 건 confirmed:false 로 두고 화면에 '미확인'으로 표시. */
window.PACKS = (function () {
  const enc = encodeURIComponent;
  const google = {
    name: 'Google 지도',
    search: (q, lat, lon) => `https://www.google.com/maps/search/?api=1&query=${enc(q)}${lat ? `&query_place_id=` : ''}`,
    place: (p) => p.gid ? `https://www.google.com/maps/search/?api=1&query=${enc(p.name)}&query_place_id=${enc(p.gid)}` : `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`,
    dir: (p, mode) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}${p.gid ? `&destination_place_id=${enc(p.gid)}` : ''}&travelmode=${mode || 'walking'}`,
  };
  const naver = {
    name: '네이버 지도',
    search: (q) => `nmap://search?query=${enc(q)}&appname=com.wonjoong.travelagent`,
    place: (p) => `nmap://place?lat=${p.lat}&lng=${p.lon}&name=${enc(p.name)}&appname=com.wonjoong.travelagent`,
    dir: (p, mode) => `nmap://route/${mode === 'transit' ? 'public' : mode === 'driving' ? 'car' : 'walk'}?dlat=${p.lat}&dlng=${p.lon}&dname=${enc(p.name)}&appname=com.wonjoong.travelagent`,
    web: (p) => `https://map.naver.com/p/search/${enc(p.name)}`,
  };
  const amap = {
    name: '고덕지도(Amap)',
    search: (q) => `androidamap://poi?sourceApplication=travelagent&keywords=${enc(q)}&dev=0`,
    place: (p) => `androidamap://viewMap?sourceApplication=travelagent&poiname=${enc(p.name)}&lat=${p.lat}&lon=${p.lon}&dev=1`,
    dir: (p, mode) => `amapuri://route/plan/?dlat=${p.lat}&dlon=${p.lon}&dname=${enc(p.name)}&dev=1&t=${mode === 'transit' ? 1 : mode === 'driving' ? 0 : 2}`,
    web: (p) => `https://uri.amap.com/marker?position=${p.lon},${p.lat}&name=${enc(p.name)}`,
  };
  // 승강장 표기: word=표지판 단어, en=그 나라 앱/전광판에서 쓰는 영어, zones=구역 표기 여부
  const PLAT = {
    CH_de: { word: 'Gleis', en: 'Platform', lang: '독일어', zones: 'A–D', confirmed: true, tip: 'Gleis는 "선로"라는 뜻이라 한 승강장 양쪽 번호가 다를 수 있어요(3 | 4).' },
    CH_fr: { word: 'Voie', en: 'Platform', lang: '프랑스어', zones: 'A–D', confirmed: true },
    CH_it: { word: 'Binario', en: 'Platform', lang: '이탈리아어', zones: 'A–D', confirmed: false },
    DE: { word: 'Gleis', en: 'Track / Platform', lang: '독일어', zones: 'A–F', confirmed: false, tip: '역마다 영어 표기가 Track·Platform으로 섞여 있어요.' },
    AT: { word: 'Bahnsteig / Gleis', en: 'Platform', lang: '독일어', zones: 'A–E', confirmed: false },
    IT: { word: 'Binario', en: 'Platform', lang: '이탈리아어', zones: '', confirmed: false, tip: '큰 역은 "Binario 4 Est"처럼 동·서 구분이 붙기도 해요.' },
    FR: { word: 'Voie', en: 'Platform / Track', lang: '프랑스어', zones: '', confirmed: false, tip: '파리 Gare de Lyon처럼 문자 승강장(Voie A–N)이 있는 역이 있고, 번호는 출발 20분 전쯤 표시돼요.' },
    ES: { word: 'Vía', en: 'Platform', lang: '스페인어', zones: '', confirmed: false },
    NL: { word: 'Spoor', en: 'Platform / Track', lang: '네덜란드어', zones: 'a / b', confirmed: false },
    BE: { word: 'Voie / Spoor', en: 'Platform', lang: '프랑스어·네덜란드어', zones: '', confirmed: false },
    CZ: { word: 'Nástupiště · Kolej', en: 'Platform · Track', lang: '체코어', zones: '', confirmed: false, tip: '승강장(Nástupiště) 번호와 선로(Kolej) 번호가 따로 있어요. 둘 다 확인하세요.' },
    GB: { word: 'Platform', en: 'Platform', lang: '영어', zones: '', confirmed: true },
    JP: { word: '番線', en: 'Track', lang: '일본어', zones: '호차 번호', confirmed: false, numFirst: true },
    CN: { word: '站台 / 检票口', en: 'Platform / Gate', lang: '중국어', zones: '', confirmed: false, tip: '고속철은 승강장보다 검표구(检票口) 번호가 먼저 안내돼요.' },
    KR: { word: '타는 곳', en: 'Platform', lang: '한국어', zones: '', confirmed: true },
    default: { word: 'Platform', en: 'Platform', lang: '현지어', zones: '', confirmed: false },
  };
  const APPS = {
    KR: [['네이버 지도', '길찾기·대중교통'], ['카카오 T', '택시'], ['배달의민족', '배달'], ['코레일톡', '기차']],
    CN: [['高德地图 Amap', '지도·길찾기'], ['Alipay', '결제(외국 카드 연결)'], ['美团 Meituan', '배달·맛집'], ['滴滴 DiDi', '택시'], ['铁路12306', '기차']],
    JP: [['Japan Transit Planner', '열차 경로'], ['GO タクシー', '택시'], ['Suica', '교통카드']],
    CH: [['SBB Mobile', '기차·승강장 실시간']],
    DE: [['DB Navigator', '기차·승강장 실시간']],
    AT: [['ÖBB Tickets', '기차']],
    IT: [['Trenitalia', '기차'], ['Italo Treno', '기차'], ['Glovo', '배달']],
    FR: [['SNCF Connect', '기차'], ['Bonjour RATP', '파리 지하철']],
    ES: [['Renfe', '기차'], ['Glovo', '배달']],
    GB: [['Trainline', '기차'], ['Citymapper', '대중교통']],
    NL: [['NS', '기차']],
    CZ: [['Můj vlak', '기차'], ['Bolt', '택시']],
    default: [['Uber', '택시'], ['Citymapper', '대중교통']],
  };
  const MAP = { KR: naver, CN: amap };
  function platKey(cc, region) { if (cc === 'CH') return 'CH_' + (region || 'de'); return PLAT[cc] ? cc : 'default'; }
  return {
    map: (cc) => MAP[cc] || google,
    mapName: (cc) => (MAP[cc] || google).name,
    plat: (cc, region) => PLAT[platKey(cc, region)],
    apps: (cc) => APPS[cc] || APPS.default,
    google, naver, amap,
    countryName: (cc) => ({ KR: '한국', CN: '중국', JP: '일본', CH: '스위스', DE: '독일', AT: '오스트리아', IT: '이탈리아', FR: '프랑스', ES: '스페인', GB: '영국', NL: '네덜란드', BE: '벨기에', CZ: '체코', US: '미국' })[cc] || cc || '?',
    list: ['KR', 'CN', 'JP', 'CH', 'DE', 'AT', 'IT', 'FR', 'ES', 'GB', 'NL', 'BE', 'CZ'],
  };
})();
