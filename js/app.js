(function () {
  // DGNSS는 해양/내륙 구분보다 "PPP-RTK와 구별되는 하나의 서비스"로
  // 한눈에 읽히는 게 중요해서 해양/내륙 모두 같은 색으로 통일함
  // (PPP-RTK 구역의 붉은색과 뚜렷이 대비되도록 흰색 계열 — PPP_RTK_COLOR 참고).
  const DGNSS_COLOR = "#ffffff";
  const DGNSS_OUTLINE_COLOR = "#616161"; // 커버리지 원 경계선 — 흰색은 자체로 안 보여서 짙은 회색 사용
  const MARKER_COLOR = "#1565c0"; // 기준국 심벌(마커) 전용 색 — 서비스 범위(흰색)와는 별도
  const TYPE_COLORS = {
    "해양": MARKER_COLOR,
    "내륙": MARKER_COLOR,
  };

  // 마커와 같은 색으로 채우되, 경계선만 DGNSS_OUTLINE_COLOR로 더 짙게
  const COVERAGE_COLORS = {
    "해양": DGNSS_COLOR,
    "내륙": DGNSS_COLOR,
  };

  // 커버리지 확인용 반경: 해양기준국 100해리(NM), 내륙기준국 80km
  const COVERAGE_RADIUS_M = {
    "해양": 100 * 1852,
    "내륙": 80 * 1000,
  };

  // 전세계가 아닌 한반도 중심 동북아시아 범위로 팬/줌 제한
  const NE_ASIA_BOUNDS = L.latLngBounds([15, 105], [50, 150]);
  const map = L.map("map", {
    zoomControl: true,
    maxBounds: NE_ASIA_BOUNDS,
    maxBoundsViscosity: 1.0,
    minZoom: 5,
  }).setView([36.2, 127.8], 7);

  // 구글어스류 지형/위성 느낌의 베이스맵. NatGeo World Map은 지명·도로가
  // 타일 이미지에 박혀 있어 CSS로 못 지웠고, World Physical Map은
  // 지명/도로는 없지만 한반도 지역은 원본 해상도가 줌 8까지뿐이라 그
  // 이상은 흐려졌음. Esri World Imagery(실제 위성사진, 구글어스
  // 기본 화면과 동일한 방식)로 교체 — 위성사진 자체에는 지명/도로
  // 텍스트가 없음.
  //
  // maxNativeZoom: 실제 타일 서버 응답을 확인해 정한 값(18). 서울·부산·
  // 여수 등 도심/본토 연안은 줌 19까지도 실사진이 있지만, 마라도·
  // 울릉도·독도·백령도·속초처럼 이 지도가 특히 다루는 외곽 도서 지역은
  // 줌 19부터 "Map data not yet available" 플레이스홀더가 나옴 — 그래서
  // 모든 지역에서 실사진이 보장되는 18을 공통 상한으로 잡음.
  // maxZoom: 18보다 더 당겨보고 싶을 때를 위해 20까지 허용 — 이 구간은
  // Leaflet이 18줌 타일을 확대(디지털 줌)해서 보여주므로 화질은
  // 흐려지지만, 서버의 빈 타일 대신 항상 뭔가는 표시됨.
  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      attribution: "Tiles &copy; Esri &mdash; Esri, Vantor, Earthstar Geographics, and the GIS User Community",
      maxNativeZoom: 18,
      maxZoom: 20,
    }
  ).addTo(map);

  const markers = new Map();
  const circles = new Map();
  const activeTypes = new Set(Object.keys(TYPE_COLORS));
  const activeStations = new Set(STATIONS.map((s) => s.name));
  let showCoverage = true;
  let dgnssCategoryOn = true;
  let pppRtkCategoryOn = true;

  // --- PPP-RTK(센티미터급) 서비스 구역 ---
  // DGNSS(흰색)와 뚜렷이 구별되도록 붉은색 계열로 지정 (너무 새빨갛지
  // 않은 톤).
  const PPP_RTK_COLOR = "#c0392b";
  const PPP_RTK_OUTLINE_COLOR = "#7b241c"; // 경계선 — 같은 계열의 더 짙은 톤

  // 투명도 슬라이더는 항상 50%(중앙)에서 시작하되, 그 지점이 각 서비스의
  // 실제 기본 투명도(DGNSS 20%, PPP-RTK 35%)가 되도록 스케일을 둠
  // (슬라이더 위치 0.5 * SCALE = 기본 투명도).
  const DGNSS_OPACITY_SCALE = 0.4; // 슬라이더 0.5 -> 20%
  const PPP_RTK_OPACITY_SCALE = 0.7; // 슬라이더 0.5 -> 35%
  let pppRtkFillOpacity = 0.5 * PPP_RTK_OPACITY_SCALE;
  let dgnssFillOpacity = 0.5 * DGNSS_OPACITY_SCALE;

  const pppRtkLayer = L.layerGroup();
  const pppRtkFillStyle = {
    stroke: false,
    fillColor: PPP_RTK_COLOR,
    fillOpacity: pppRtkFillOpacity,
    interactive: false,
  };
  const pppRtkOutlineStyle = {
    color: PPP_RTK_OUTLINE_COLOR,
    weight: 0.6,
    opacity: 0.85,
    fill: false,
    interactive: false,
  };

  // 본토·제주·서해 5도(백령도/대청도/소청도/연평도/우도) 구역은 서로
  // 겹치거나(제주) NLL 모양 경계로 이어붙여서(서해 5도) 하나로 합쳐진
  // 폴리곤으로 그림. 육지 부분(본토/제주/서해 5도 각각, 그리고 휴전선
  // 부근에서 우리 구역과 겹치는 북한 육지 조각들)은 구멍(hole)으로
  // 뚫어서 해상 구역만 채색.
  //
  // Leaflet은 폴리곤의 모든 링(외곽선 + 구멍)을 같은 색으로 테두리
  // 그리기 때문에, 채색용 폴리곤은 테두리 없이(stroke:false)만 그리고
  // 실제 경계선은 PPP_RTK_ZONE 외곽 좌표만 따로 폴리라인으로 그려서
  // 해안선(육지 라인)에는 색이 들어가지 않도록 함. 본토(남한) 육지는
  // 더 이상 별도 구멍이 아니라 PPP_RTK_ZONE 외곽선 자체에 슬릿(slit)
  // 형태로 포함되어 있음(군사분계선 구간이 남한 북쪽 경계선과 겹쳐서
  // 발생한 것을 shapely buffer(0)로 위상학적으로 정리한 결과 — 별도
  // 구멍 폴리곤일 때와 채워지는 영역은 동일함).
  const pppRtkFillLayer = L.polygon(
    [PPP_RTK_ZONE, ...PPP_RTK_GSHHG_LAND_HOLES],
    pppRtkFillStyle
  ).addTo(pppRtkLayer);

  // 경계선(=영해한계선, 영해및접속수역법 제1조)은 PPP-RTK 서비스 범위
  // 채색과 같은 좌표를 쓰지만, 법적으로는 별개 개념이라 별도 토글
  // (#toggleTerritorialLimit)로 분리해 그림 — pppRtkLayer가 아니라
  // 독립된 territorialLimitLayer에 둠. PPP_RTK_INVISIBLE_RANGE 구간
  // (한강하류~군사분계선 동쪽끝, 내륙이라 실제 경계가 아님)만 제외하고
  // 나머지 외곽선을 하나의 열린 폴리라인으로 이어 그림.
  const [invisibleStart, invisibleEnd] = PPP_RTK_INVISIBLE_RANGE;
  const visibleOutlineBase = PPP_RTK_ZONE.slice(invisibleEnd).concat(PPP_RTK_ZONE.slice(0, invisibleStart + 1));
  // 소령도(마지막 공식 기점) 부근에서 선이 뚝 끊기는 게 아니라, 그
  // 기점을 중심으로 한 12해리 원호가 자연스럽게 이어져야 하는데(직선기선
  // 끝점도 국제법상 원호로 이어짐), 그 원호를 만들 별도 좌표 자료가 없어
  // 이 근사치는 원래 소령도 부근에서 뚝 끊겨 있었음 — 사용자가 국립해양
  // 조사원 참고 지도(점선이 소령도 이북 위도 37.17도까지 매끄럽게
  // 이어짐)를 보여주며 이 부분이 빠졌다고 지적함. 마침
  // TERRITORIAL_LIMIT_OFFICIAL(공식 shapefile)의 본토 선 시작 구간이
  // 정확히 이 원호 부분(37.17도에서 36.90도까지)이라 그 실제 좌표를
  // 그대로 이어붙임 — 나머지 구간(NLL 방향)은 여전히 안 그림, 이
  // 자연스러운 원호 연장만 보정.
  //
  // PPP_RTK_INVISIBLE_RANGE는 인덱스 71(소령도 부근 마지막 본토 체인
  // 점)에서 끊어서(js/ppp-rtk.js 참고) 그 바로 다음이었던 점 C(원래
  // NLL 방향 확장을 위한 대각접속점, 본토 체인의 자연스러운 연장이
  // 아님)를 아예 건너뛰고 바로 이 공식 원호로 이음 — 처음에는 C까지
  // 포함해서 이었더니 방위각이 21˚→183˚로 거의 반대 방향으로 꺾였다가
  // 되돌아오는 뾰족한 "V"자 굴절이 생겨(사용자가 스크린샷으로 지적),
  // C를 빼자 21˚→24˚→25˚로 매끄럽게 이어짐.
  const westSeaArc = TERRITORIAL_LIMIT_OFFICIAL[1].slice(0, 11).slice().reverse();
  const visibleOutline = visibleOutlineBase.concat(westSeaArc);
  // 위 visibleOutline은 소령도 부근(37.16969, 125.6577)에서 다시 끊김 —
  // 사용자가 지적한 "서북쪽으로 소청도·백령도 쪽으로 빠지는 라인"이
  // 아직 없는 상태. 사용자가 정확한 두 좌표를 지정함 —
  // 37-10-10.88N,125-39-27.73E(= 위 visibleOutline의 끝점과 사실상 동일)
  // 부터 37-55-09.86N,123-59-53.41E(= 백령도 서단 부근, 1953년 유엔군사
  // 령관이 설정한 NLL 서쪽 끝점으로 흔히 알려진 좌표와 거의 일치)까지를
  // 참고 이미지처럼 매끄러운 곡선으로 이어달라는 요청. 두 점 사이의 실제
  // 굴곡을 알려주는 좌표 자료는 없으므로, 직선 대신 2차 베지어 곡선으로
  // 근사함 — 제어점을 직선(현弦)의 중점에서 육지 반대쪽(남서쪽, 바다
  // 쪽)으로 살짝 밀어 완만하게 부풀린 곡선을 만듦(비공식 근사치).
  function quadraticBezier(p0, p1, control, steps) {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      pts.push([
        mt * mt * p0[0] + 2 * mt * t * control[0] + t * t * p1[0],
        mt * mt * p0[1] + 2 * mt * t * control[1] + t * t * p1[1],
      ]);
    }
    return pts;
  }
  const nwCurveStart = visibleOutline[visibleOutline.length - 1];
  const nwCurveEnd = [37.919406, 123.998169];
  const nwCurveControl = [37.387, 124.715];
  const nwCurve = quadraticBezier(nwCurveStart, nwCurveEnd, nwCurveControl, 48);
  const visibleOutlineExtended = visibleOutline.concat(nwCurve.slice(1));
  // 국립해양조사원이 공개하는 참고 지도들의 "영해선" 표기 방식(점선)을
  // 따라, 실선 대신 점선으로 그림 — dashArray를 아주 짧은 선+긴 여백으로,
  // lineCap을 round로 줘서 네모난 대시가 아니라 동그란 점처럼 보이게 함.
  const territorialLimitStyle = {
    color: "#f1c40f",
    weight: 2,
    opacity: 0.95,
    fill: false,
    interactive: false,
    dashArray: "1 7",
    lineCap: "round",
  };
  // 서해 5도(백령도·대청도·소청도·연평도·우도)는 23개 직선기선 기점에
  // 안 들어가 있어(그 체인은 소령도에서 끝남) 위 visibleOutline에는
  // 아예 빠져 있지만, 이 섬들도 실제 영토라 자기 해안선 기준 12해리
  // 영해가 존재함 — 사용자가 지적한 대로, 그냥 빠뜨리면 안 됨. 본토
  // 체인과 이어붙이지 않고(그러면 다시 NLL을 따라가는 가짜 직선기선처럼
  // 보임) 울릉도·독도처럼 섬마다 독립된 폐곡선으로 추가함 — 각 폐곡선은
  // js/five-islands-tsea.js에서 이미 NLL(js/ppp-rtk.js의 PPP_RTK_ZONE
  // 경계)을 넘지 않도록 잘라서 만들어 둠.
  const territorialLimitLayer = L.layerGroup([
    L.polyline(visibleOutlineExtended, territorialLimitStyle),
    ...FIVE_ISLANDS_TERRITORIAL_SEA.map((ring) => L.polyline(ring, territorialLimitStyle)),
  ]);
  territorialLimitLayer.addTo(map);

  // --- 영해한계선(국가공간정보 공식자료) ---
  // 사용자가 제공한 정부 공간정보 테이블 TB_ZN_TRTSEA(영해한계선)
  // shapefile 원본 좌표(js/territorial-limit-official.js 참고) — 위
  // territorialLimitLayer(PPP_RTK_ZONE 기반 추정치)와는 독립된 별도
  // 레이어. 기본은 꺼진 상태(#toggleTerritorialLimitOfficial)이고, 위
  // 추정치 라인과 구별되도록 다른 색을 씀. TERRITORIAL_LIMIT_OFFICIAL은
  // [독도, 본토, 울릉도] 3개 선(본토만 열린 선, 나머지는 폐곡선)의 배열 —
  // Leaflet의 L.polyline은 좌표 배열의 배열을 그대로 멀티 폴리라인으로
  // 받아들임.
  // 위 territorialLimitStyle과 같은 이유로 점선 처리(국립해양조사원 참고
  // 지도의 "영해선" 표기 방식).
  const territorialLimitOfficialStyle = {
    color: "#e91e63",
    weight: 2,
    opacity: 0.95,
    fill: false,
    interactive: false,
    dashArray: "1 7",
    lineCap: "round",
  };
  const territorialLimitOfficialLayer = L.layerGroup([
    L.polyline(TERRITORIAL_LIMIT_OFFICIAL, territorialLimitOfficialStyle),
  ]);

  // --- 북방한계선(NLL, 비공식 근사치) ---
  // js/nll-line.js 참고 — 공식 고시 좌표가 없어(1953년 유엔군사령관이
  // 일방적으로 설정) js/ppp-rtk.js 구축 때 이미 사용한 A·D·E·T 지점을
  // 재활용한 근사선. 기본은 꺼진 상태. 점선 + 뚜렷한 녹색으로 다른
  // 선들과 확실히 구분되게 표시하고, 비공식 근사치임을 토글 라벨에도
  // 명시함(index.html 참고).
  const nllLineStyle = {
    color: "#2ecc71",
    weight: 1.5,
    opacity: 0.9,
    dashArray: "6 4",
    fill: false,
    interactive: false,
  };
  const nllLineLayer = L.layerGroup([
    L.polyline(NLL_WEST, nllLineStyle),
    L.polyline(NLL_EAST, nllLineStyle),
  ]);

  const pppRtkIslandLayers = PPP_RTK_ISLANDS.map((island) =>
    L.circle([island.lat, island.lng], {
      color: PPP_RTK_OUTLINE_COLOR,
      weight: 0.6,
      opacity: 0.85,
      fillColor: PPP_RTK_COLOR,
      fillOpacity: pppRtkFillOpacity,
      interactive: false,
      radius: island.radiusKm * 1000,
    }).addTo(pppRtkLayer)
  );

  pppRtkLayer.addTo(map);

  // --- 영해기점(별표1) 23개소 ---
  // DGNSS(흰색 원 마커)·PPP-RTK(붉은색 구역)와 구별되도록 보라색
  // 마름모 심벌로 표시 (css/style.css .basepoint-marker 참고).

  function makeBasepointIcon() {
    return L.divIcon({
      className: "basepoint-marker",
      html: `<span></span>`,
      iconSize: [8, 8],
      iconAnchor: [4, 4],
    });
  }

  function basepointPopupHtml(point) {
    return `
      <div class="popup">
        <h3>${point.no}. ${point.name} <span class="badge">영해기점</span></h3>
        <table>
          <tr><td>위도</td><td>${point.lat.toFixed(6)}° (${dmsFromDecimal(point.lat)})</td></tr>
          <tr><td>경도</td><td>${point.lng.toFixed(6)}° (${dmsFromDecimal(point.lng)})</td></tr>
        </table>
      </div>
    `;
  }

  const basepointsLayer = L.layerGroup();
  BASEPOINTS.forEach((point) => {
    L.marker([point.lat, point.lng], { icon: makeBasepointIcon() })
      .bindPopup(basepointPopupHtml(point))
      .addTo(basepointsLayer);
  });
  basepointsLayer.addTo(map);

  // --- 특정해역(어선안전조업법 시행령 별표2) / 조업자제해역(별표4) ---
  // 서비스 범위(DGNSS/PPP-RTK)와 구별되는 규제구역이라 기본은 꺼둠.
  const specialZoneStyle = {
    color: "#e67e22",
    weight: 1.5,
    opacity: 0.9,
    fillColor: "#f39c12",
    fillOpacity: 0.18,
  };
  const specialZoneLayer = L.layerGroup([
    L.polygon(SPECIAL_SEA_ZONE_EAST, specialZoneStyle),
    L.polygon(SPECIAL_SEA_ZONE_WEST, specialZoneStyle),
  ]);

  const restraintZoneStyle = {
    color: "#8e44ad",
    weight: 1.5,
    opacity: 0.9,
    dashArray: "6 4",
    fillColor: "#8e44ad",
    fillOpacity: 0.12,
  };
  const restraintZoneLayer = L.layerGroup([
    L.polygon(FISHING_RESTRAINT_ZONE_EAST, restraintZoneStyle),
    L.polygon(FISHING_RESTRAINT_ZONE_WEST, restraintZoneStyle),
  ]);

  // --- 서해특정해역 세부 조업구역(어선안전조업규정 별표1) ---
  // 위 서해특정해역(SPECIAL_SEA_ZONE_WEST)을 대청도어선/저인망/덕적도서방
  // 3개 조업구역으로 세분한 경계. 서로 맞닿아 있어 하나의 스타일로 묶어
  // 그림(별표1 자체가 색상 구분을 두지 않음).
  const westFishingZoneStyle = {
    color: "#1f6fb0",
    weight: 1.5,
    opacity: 0.9,
    dashArray: "3 3",
    fillColor: "#3498db",
    fillOpacity: 0.12,
  };
  const westFishingZoneLayer = L.layerGroup([
    L.polygon(DAECHEONGDO_FISHING_ZONE, westFishingZoneStyle),
    L.polygon(TRAWL_FISHING_ZONE, westFishingZoneStyle),
    L.polygon(DEOKJEOKDO_WEST_FISHING_ZONE, westFishingZoneStyle),
  ]);

  // --- 이동통신망(스마트폰 LTE) 해상 가청거리 (추정) ---
  // js/mobile-coverage.js의 MOBILE_COVERAGE_POLYGONS 참고 — 공식 좌표
  // 없는 추정치라 다른 법정 구역과 구별되게 초록색 계열로, 기본은 꺼둠.
  const mobileCoverageLayer = L.layerGroup([
    L.polygon(MOBILE_COVERAGE_POLYGONS, {
      color: "#27ae60",
      weight: 1,
      opacity: 0.7,
      fillColor: "#2ecc71",
      fillOpacity: 0.15,
      renderer: L.canvas(),
      interactive: false,
    }),
  ]);

  // --- KPS(한국형 위성항법시스템) 격자점 ---
  // 사용자가 표로 제공한 32개 격자점(js/kps-grid.js의 KPS_GRID_POINTS)을
  // 그대로 점으로 찍음 — 아직 이 격자가 KPS의 공식 서비스 범위 경계인지
  // 확인 전이라, 우선 점 좌표만 표시(면적/경계선은 없음). 기본은 꺼둠.
  function kpsGridPopupHtml(point) {
    return `
      <div class="popup">
        <h3>격자점 ${point.id} <span class="badge">KPS</span></h3>
        <table>
          <tr><td>위도</td><td>${point.lat}°</td></tr>
          <tr><td>경도</td><td>${point.lng}°</td></tr>
        </table>
      </div>
    `;
  }
  const kpsGridLayer = L.layerGroup();
  KPS_GRID_POINTS.forEach((point) => {
    L.marker([point.lat, point.lng], {
      icon: L.divIcon({
        className: "kps-grid-marker",
        html: `<span class="dot"></span><span class="num">${point.id}</span>`,
        iconSize: null,
      }),
    })
      .bindPopup(kpsGridPopupHtml(point))
      .addTo(kpsGridLayer);
  });

  // --- 한일중간선 / 한일중간수역(한일어업협정) / 한중잠정조치수역(한중어업협정) ---
  const koreaJapanMedianLineLayer = L.layerGroup([
    L.polyline(KR_JP_MEDIAN_LINE, {
      color: "#27ae60",
      weight: 1.5,
      opacity: 0.9,
    }),
  ]);

  const koreaJapanJointZoneStyle = {
    color: "#16a085",
    weight: 1.5,
    opacity: 0.9,
    fillColor: "#1abc9c",
    fillOpacity: 0.15,
  };
  const koreaJapanJointZoneLayer = L.layerGroup([
    L.polygon(KR_JP_JOINT_ZONE_EAST_SEA, koreaJapanJointZoneStyle),
    L.polygon(KR_JP_JOINT_ZONE_JEJU_WEST, koreaJapanJointZoneStyle),
    L.polygon(KR_JP_JOINT_ZONE_JEJU_EAST, koreaJapanJointZoneStyle),
  ]);

  const koreaChinaProvisionalZoneLayer = L.layerGroup([
    L.polygon(KR_CN_PROVISIONAL_ZONE, {
      color: "#2c3e8c",
      weight: 1.5,
      opacity: 0.9,
      fillColor: "#3f51b5",
      fillOpacity: 0.15,
    }),
  ]);

  // --- 해구(대해구, 기상청 해상예보구역 격자) ---
  // 위·경도 0.5도 간격이지만, 격자선은 해구번호가 확인된 칸(아래
  // haeguNumberLayer와 같은 js/haegu-numbers.js의 DAEHAEGU_NUMBERS)에
  // 한해서만 그림 — 번호를 모르는 나머지 칸까지 균일한 선으로 채우면
  // 실제로 확인 안 된 해구까지 있는 것처럼 보이므로, 확인된 칸의 경계만
  // 사각형으로 그림.
  const DAEHAEGU_STEP = 0.5;

  function buildHaeguGridLayer(style) {
    const canvasRenderer = L.canvas();
    const layer = L.layerGroup();
    const half = DAEHAEGU_STEP / 2;
    for (const key of Object.keys(DAEHAEGU_NUMBERS)) {
      const [lat, lng] = key.split(",").map(Number);
      L.rectangle(
        [
          [lat - half, lng - half],
          [lat + half, lng + half],
        ],
        { ...style, fill: false, renderer: canvasRenderer, interactive: false }
      ).addTo(layer);
    }
    return layer;
  }

  const daehaeguLayer = buildHaeguGridLayer({
    color: "#d35400",
    weight: 1,
    opacity: 0.6,
  });

  const haeguNumberLayer = L.layerGroup();
  for (const [key, no] of Object.entries(DAEHAEGU_NUMBERS)) {
    const [lat, lng] = key.split(",").map(Number);
    L.marker([lat, lng], {
      icon: L.divIcon({
        className: "haegu-number-label",
        html: String(no),
        iconSize: null,
      }),
      interactive: false,
      keyboard: false,
    }).addTo(haeguNumberLayer);
  }

  // --- 위경도 1도 격자 ---
  // 격자선은 지도 좌표계에 고정(팬/줌 시 자연스럽게 함께 움직임).
  // 라벨은 지도가 아니라 "화면"의 좌측/하단 가장자리에 고정되도록
  // move/zoom 이벤트마다 픽셀 위치를 다시 계산해서 그림.
  const GRID_COLOR = "#5a7c92";
  const GRID_MIN_LAT = 15;
  const GRID_MAX_LAT = 50;
  const GRID_MIN_LNG = 105;
  const GRID_MAX_LNG = 150;
  const LABEL_EDGE_PADDING = 4;

  const gridLayer = L.layerGroup();

  for (let lat = GRID_MIN_LAT; lat <= GRID_MAX_LAT; lat++) {
    L.polyline(
      [
        [lat, GRID_MIN_LNG],
        [lat, GRID_MAX_LNG],
      ],
      { color: GRID_COLOR, weight: 1, opacity: 0.55, dashArray: "1 5", interactive: false }
    ).addTo(gridLayer);
  }

  for (let lng = GRID_MIN_LNG; lng <= GRID_MAX_LNG; lng++) {
    L.polyline(
      [
        [GRID_MIN_LAT, lng],
        [GRID_MAX_LAT, lng],
      ],
      { color: GRID_COLOR, weight: 1, opacity: 0.55, dashArray: "1 5", interactive: false }
    ).addTo(gridLayer);
  }

  gridLayer.addTo(map);

  const graticuleContainer = L.DomUtil.create("div", "graticule-labels", map.getContainer());
  const graticuleLatLabels = [];
  const graticuleLngLabels = [];

  for (let lat = GRID_MIN_LAT; lat <= GRID_MAX_LAT; lat++) {
    const el = L.DomUtil.create("div", "grid-label grid-label-lat", graticuleContainer);
    el.textContent = lat + "°N";
    graticuleLatLabels.push({ lat, el });
  }

  for (let lng = GRID_MIN_LNG; lng <= GRID_MAX_LNG; lng++) {
    const el = L.DomUtil.create("div", "grid-label grid-label-lng", graticuleContainer);
    el.textContent = lng + "°E";
    graticuleLngLabels.push({ lng, el });
  }

  function updateGraticuleLabels() {
    const size = map.getSize();
    graticuleLatLabels.forEach(({ lat, el }) => {
      const y = map.latLngToContainerPoint([lat, GRID_MIN_LNG]).y;
      if (y < 0 || y > size.y) {
        el.style.display = "none";
        return;
      }
      el.style.display = "";
      el.style.left = LABEL_EDGE_PADDING + "px";
      el.style.top = y + "px";
    });
    graticuleLngLabels.forEach(({ lng, el }) => {
      const x = map.latLngToContainerPoint([GRID_MIN_LAT, lng]).x;
      if (x < 0 || x > size.x) {
        el.style.display = "none";
        return;
      }
      el.style.display = "";
      el.style.top = size.y - LABEL_EDGE_PADDING + "px";
      el.style.left = x + "px";
    });
  }

  map.on("move zoom resize", updateGraticuleLabels);
  updateGraticuleLabels();

  function dmsFromDecimal(deg) {
    const sign = deg < 0 ? -1 : 1;
    const abs = Math.abs(deg);
    const d = Math.floor(abs);
    const minFloat = (abs - d) * 60;
    const m = Math.floor(minFloat);
    const s = (minFloat - m) * 60;
    return `${sign < 0 ? "-" : ""}${d}° ${String(m).padStart(2, "0")}' ${s.toFixed(2)}"`;
  }

  function makeIcon(type) {
    const color = TYPE_COLORS[type] || "#666";
    return L.divIcon({
      className: "station-marker",
      html: `<span style="background:${color}"></span>`,
      iconSize: [8, 8],
      iconAnchor: [4, 4],
    });
  }

  function popupHtml(station) {
    return `
      <div class="popup">
        <h3>${station.name} <span class="badge">${station.type}</span></h3>
        <table>
          <tr><td>위도</td><td>${station.lat.toFixed(6)}° (${dmsFromDecimal(station.lat)})</td></tr>
          <tr><td>경도</td><td>${station.lng.toFixed(6)}° (${dmsFromDecimal(station.lng)})</td></tr>
        </table>
      </div>
    `;
  }

  const validStations = STATIONS.filter(
    (s) => typeof s.lat === "number" && typeof s.lng === "number"
  );

  validStations.forEach((station) => {
    const coverageColor = COVERAGE_COLORS[station.type] || "#333";

    const circle = L.circle([station.lat, station.lng], {
      radius: COVERAGE_RADIUS_M[station.type] || 0,
      color: DGNSS_OUTLINE_COLOR,
      weight: 0.6,
      opacity: 0.85,
      fillColor: coverageColor,
      fillOpacity: dgnssFillOpacity,
      interactive: false,
    }).addTo(map);
    circles.set(station.name, circle);

    const marker = L.marker([station.lat, station.lng], {
      icon: makeIcon(station.type),
    })
      .addTo(map)
      .bindPopup(popupHtml(station));
    markers.set(station.name, marker);
  });

  function renderTypeFilters() {
    const container = document.getElementById("typeFilters");
    container.innerHTML = "";
    Object.keys(TYPE_COLORS).forEach((type) => {
      const id = `filter-${type}`;
      const wrap = document.createElement("label");
      wrap.className = "filter-chip";
      wrap.style.setProperty("--chip-color", TYPE_COLORS[type]);
      wrap.innerHTML = `
        <input type="checkbox" id="${id}" checked />
        <span>${type}</span>
      `;
      wrap.querySelector("input").addEventListener("change", (e) => {
        if (e.target.checked) activeTypes.add(type);
        else activeTypes.delete(type);
        applyFilter();
      });
      container.appendChild(wrap);
    });
  }

  function stationVisible(station) {
    return dgnssCategoryOn && activeTypes.has(station.type) && activeStations.has(station.name);
  }

  function setStationVisibility(station, visible) {
    const marker = markers.get(station.name);
    const circle = circles.get(station.name);

    if (visible) {
      if (!map.hasLayer(marker)) marker.addTo(map);
    } else {
      if (map.hasLayer(marker)) map.removeLayer(marker);
    }

    if (visible && showCoverage) {
      if (!map.hasLayer(circle)) circle.addTo(map);
    } else {
      if (map.hasLayer(circle)) map.removeLayer(circle);
    }
  }

  function updateStationCount() {
    const shown = validStations.filter(stationVisible).length;
    document.getElementById("stationCount").textContent =
      `표시된 기준국: ${shown} / 전체 ${STATIONS.length}` +
      (STATIONS.length > validStations.length
        ? ` (좌표 미확인 ${STATIONS.length - validStations.length}개소 제외)`
        : "");
    updateSelectAllState();
  }

  function updateSelectAllState() {
    const selectAll = document.getElementById("selectAllStations");
    if (!selectAll) return;
    const total = validStations.length;
    const activeCount = validStations.filter((s) => activeStations.has(s.name)).length;
    selectAll.checked = activeCount === total;
    selectAll.indeterminate = activeCount > 0 && activeCount < total;
  }

  function applyFilter() {
    validStations.forEach((station) => setStationVisibility(station, stationVisible(station)));
    renderStationList();
  }

  function renderStationList() {
    const list = document.getElementById("stationList");
    list.innerHTML = "";
    updateStationCount();

    validStations.forEach((station) => {
      const on = activeStations.has(station.name);
      const li = document.createElement("li");
      li.className = stationVisible(station) ? "" : "off";
      li.innerHTML = `
        <input type="checkbox" class="station-toggle" ${on ? "checked" : ""} aria-label="${station.name} 표시 여부" />
        <span class="dot" style="background:${TYPE_COLORS[station.type]}"></span>
        <span class="name">${station.name}</span>
        <span class="type">${station.type}</span>
      `;
      const checkbox = li.querySelector(".station-toggle");
      checkbox.addEventListener("click", (e) => e.stopPropagation());
      checkbox.addEventListener("change", (e) => {
        if (e.target.checked) activeStations.add(station.name);
        else activeStations.delete(station.name);
        li.classList.toggle("off", !stationVisible(station));
        setStationVisibility(station, stationVisible(station));
        updateStationCount();
      });
      li.addEventListener("click", () => {
        map.setView([station.lat, station.lng], 10, { animate: true });
        if (activeStations.has(station.name)) markers.get(station.name).openPopup();
      });
      list.appendChild(li);
    });
  }

  function wireSelectAll() {
    const selectAll = document.getElementById("selectAllStations");
    selectAll.addEventListener("click", (e) => e.stopPropagation());
    selectAll.addEventListener("change", (e) => {
      if (e.target.checked) {
        validStations.forEach((s) => activeStations.add(s.name));
      } else {
        activeStations.clear();
      }
      applyFilter();
    });
  }

  // --- 거리 / 면적 측정 ---
  const MEASURE_COLORS = { distance: "#e91e63", area: "#00bcd4" };

  const measureState = {
    mode: null, // "distance" | "area" | null
    points: [],
    layer: null,
    vertexMarkers: [],
  };

  function toRad(deg) {
    return (deg * Math.PI) / 180;
  }

  function formatDistance(m) {
    return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
  }

  function formatArea(m2) {
    return m2 >= 1e6 ? `${(m2 / 1e6).toFixed(2)} km²` : `${Math.round(m2)} m²`;
  }

  function computeDistance(latlngs) {
    let total = 0;
    for (let i = 1; i < latlngs.length; i++) {
      total += map.distance(latlngs[i - 1], latlngs[i]);
    }
    return total;
  }

  // 구면 다각형 면적(spherical excess 근사식), 극지방이 아닌 일반적인 범위에서 충분히 정확함
  function computeArea(latlngs) {
    if (latlngs.length < 3) return 0;
    const R = 6371000;
    let sum = 0;
    for (let i = 0; i < latlngs.length; i++) {
      const p1 = latlngs[i];
      const p2 = latlngs[(i + 1) % latlngs.length];
      sum += toRad(p2.lng - p1.lng) * (2 + Math.sin(toRad(p1.lat)) + Math.sin(toRad(p2.lat)));
    }
    return Math.abs((sum * R * R) / 2);
  }

  function updateMeasureButtons() {
    const distBtn = document.getElementById("measureDistanceBtn");
    const areaBtn = document.getElementById("measureAreaBtn");
    if (distBtn) distBtn.classList.toggle("active", measureState.mode === "distance");
    if (areaBtn) areaBtn.classList.toggle("active", measureState.mode === "area");
  }

  function updateMeasureResult() {
    const resultEl = document.getElementById("measureResult");
    if (!resultEl) return;
    if (!measureState.mode) {
      resultEl.textContent = "";
      return;
    }
    if (measureState.points.length === 0) {
      resultEl.textContent =
        measureState.mode === "distance"
          ? "지도를 클릭해 거리를 측정할 지점을 추가하세요."
          : "지도를 클릭해 면적을 측정할 지점을 추가하세요 (3개 이상).";
      return;
    }
    if (measureState.mode === "distance") {
      resultEl.textContent = `거리: ${formatDistance(computeDistance(measureState.points))} (${measureState.points.length}개 지점)`;
    } else {
      resultEl.textContent =
        measureState.points.length >= 3
          ? `면적: ${formatArea(computeArea(measureState.points))} (${measureState.points.length}개 지점)`
          : `지점 ${measureState.points.length}개 (최소 3개 필요)`;
    }
  }

  function clearMeasurement() {
    measureState.points = [];
    if (measureState.layer) {
      map.removeLayer(measureState.layer);
      measureState.layer = null;
    }
    measureState.vertexMarkers.forEach((m) => map.removeLayer(m));
    measureState.vertexMarkers = [];
    updateMeasureResult();
  }

  function addMeasurePoint(latlng) {
    measureState.points.push(latlng);
    const color = MEASURE_COLORS[measureState.mode];

    const vertex = L.circleMarker(latlng, {
      radius: 4,
      color: color,
      weight: 2,
      fillColor: "#fff",
      fillOpacity: 1,
    }).addTo(map);
    measureState.vertexMarkers.push(vertex);

    if (measureState.mode === "distance") {
      if (measureState.layer) {
        measureState.layer.setLatLngs(measureState.points);
      } else {
        measureState.layer = L.polyline(measureState.points, {
          color: color,
          weight: 3,
          dashArray: "6 4",
        }).addTo(map);
      }
    } else if (measureState.mode === "area") {
      if (measureState.layer) {
        measureState.layer.setLatLngs(measureState.points);
      } else {
        measureState.layer = L.polygon(measureState.points, {
          color: color,
          weight: 2,
          fillColor: color,
          fillOpacity: 0.15,
        }).addTo(map);
      }
    }
    updateMeasureResult();
  }

  function setMeasureMode(mode) {
    if (measureState.mode === mode) {
      exitMeasureMode();
      return;
    }
    if (pinMode) setPinMode(false);
    clearMeasurement();
    measureState.mode = mode;
    map.doubleClickZoom.disable();
    map.getContainer().style.cursor = "crosshair";
    updateMeasureButtons();
    updateMeasureResult();
  }

  function exitMeasureMode() {
    measureState.mode = null;
    map.doubleClickZoom.enable();
    map.getContainer().style.cursor = "";
    updateMeasureButtons();
    updateMeasureResult();
  }

  // --- 좌표 검색 / 좌표 찍기 ---
  const PIN_COLOR = "#d81b60";
  let pinMode = false;
  const pinMarkers = [];

  function makePinIcon() {
    return L.divIcon({
      className: "pin-marker",
      html: `<span></span>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
  }

  function coordPopupHtml(lat, lng) {
    return `
      <div class="popup">
        <h3>좌표</h3>
        <table>
          <tr><td>위도</td><td>${lat.toFixed(6)}° (${dmsFromDecimal(lat)})</td></tr>
          <tr><td>경도</td><td>${lng.toFixed(6)}° (${dmsFromDecimal(lng)})</td></tr>
        </table>
        <button type="button" class="popup-remove-pin">이 핀 삭제</button>
      </div>
    `;
  }

  function addPinMarker(latlng) {
    const marker = L.marker(latlng, { icon: makePinIcon() }).addTo(map);
    marker.bindPopup(coordPopupHtml(latlng.lat, latlng.lng));
    marker.on("popupopen", () => {
      const el = marker.getPopup().getElement();
      const btn = el && el.querySelector(".popup-remove-pin");
      if (btn) {
        btn.addEventListener("click", () => {
          map.removeLayer(marker);
          const idx = pinMarkers.indexOf(marker);
          if (idx !== -1) pinMarkers.splice(idx, 1);
        });
      }
    });
    marker.openPopup();
    pinMarkers.push(marker);
    return marker;
  }

  function clearPins() {
    pinMarkers.forEach((m) => map.removeLayer(m));
    pinMarkers.length = 0;
  }

  function setPinMode(on) {
    pinMode = on;
    if (pinMode) {
      exitMeasureMode();
      map.getContainer().style.cursor = "crosshair";
    } else {
      map.getContainer().style.cursor = "";
    }
    const btn = document.getElementById("coordPinBtn");
    if (btn) btn.classList.toggle("active", pinMode);
  }

  // 좌표 한쪽(위도 또는 경도)을 도/도분/도분초 어떤 단위로 입력해도 파싱.
  // 구분자는 "-", 공백, ":", "°", "'", '"' 아무거나 섞어써도 되고, 반구
  // 문자(N/S/E/W)는 있어도 없어도 됨. 예: "37.5665", "37-33.99N",
  // "37-33-59.4N", "37 33 59.4 N".
  function parseOneCoord(raw) {
    if (typeof raw !== "string") return null;
    let s = raw.trim();
    if (!s) return null;
    let hemisphere = null;
    const hemisMatch = s.match(/[NSEW]/i);
    if (hemisMatch) {
      hemisphere = hemisMatch[0].toUpperCase();
      s = s.replace(/[NSEW]/gi, " ");
    }
    const negative = !hemisphere && s.trim().startsWith("-");
    const nums = s.match(/\d+(?:\.\d+)?/g);
    if (!nums || nums.length === 0 || nums.length > 3) return null;
    let value = parseFloat(nums[0]);
    if (nums.length >= 2) value += parseFloat(nums[1]) / 60;
    if (nums.length >= 3) value += parseFloat(nums[2]) / 3600;
    if (hemisphere === "S" || hemisphere === "W" || negative) value = -value;
    return value;
  }

  // "위도, 경도" 형식(콤마 구분 우선, 없으면 반구 문자 뒤 또는 공백 2개
  // 토큰으로 분리). 위도/경도 각각 도·도분·도분초 단위 아무거나 지원.
  function parseCoordInput(text) {
    const trimmed = text.trim();
    if (!trimmed) return null;
    let latRaw, lngRaw;
    if (trimmed.includes(",")) {
      const idx = trimmed.indexOf(",");
      latRaw = trimmed.slice(0, idx);
      lngRaw = trimmed.slice(idx + 1);
    } else {
      const hemisSplit = trimmed.match(/^(.*?[NSns])\s*(.+)$/);
      if (hemisSplit) {
        latRaw = hemisSplit[1];
        lngRaw = hemisSplit[2];
      } else {
        const parts = trimmed.split(/\s+/);
        if (parts.length !== 2) return null;
        [latRaw, lngRaw] = parts;
      }
    }
    const lat = parseOneCoord(latRaw);
    const lng = parseOneCoord(lngRaw);
    if (lat === null || lng === null || Number.isNaN(lat) || Number.isNaN(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
  }

  function handleCoordSearch() {
    const input = document.getElementById("coordSearchInput");
    const errorEl = document.getElementById("coordSearchError");
    const parsed = parseCoordInput(input.value);
    if (!parsed) {
      errorEl.textContent = "형식이 올바르지 않습니다. 예: 37.5665, 126.9780 / 37-33-59.4N, 126-58-40.8E";
      return;
    }
    errorEl.textContent = "";
    const latlng = L.latLng(parsed.lat, parsed.lng);
    map.setView(latlng, Math.max(map.getZoom(), 10), { animate: true });
    addPinMarker(latlng);
  }

  // 좌표 검색/찍기와 거리·면적 측정 도구는 지도 위에 겹쳐 그리면 지도
  // 확인 시야를 가리므로, Leaflet 컨트롤이 아니라 지도 레이어 밖의
  // 상단 툴바(#toolbar, index.html)에 일반 DOM으로 직접 그림.
  function buildCoordToolbar() {
    const container = document.getElementById("coordToolbar");

    // 좌표 검색과 좌표 찍기/핀 지우기를 한 줄에 나란히 배치해 툴바 세로
    // 높이를 줄임(제목 탭과 같은 높이에 들어가야 하므로).
    const searchRow = L.DomUtil.create("div", "coord-search-row", container);
    const input = L.DomUtil.create("input", "coord-search-input", searchRow);
    input.type = "text";
    input.id = "coordSearchInput";
    input.placeholder = "37-33-59.4N, 126-58-40.8E";
    input.title = "도/도분/도분초 단위 모두 가능. 예: 37.5665, 126.9780 / 37-33-59.4N, 126-58-40.8E";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleCoordSearch();
    });

    const searchBtn = L.DomUtil.create("button", "measure-btn", searchRow);
    searchBtn.type = "button";
    searchBtn.textContent = "이동";
    searchBtn.addEventListener("click", handleCoordSearch);

    const pinBtn = L.DomUtil.create("button", "measure-btn", searchRow);
    pinBtn.id = "coordPinBtn";
    pinBtn.type = "button";
    pinBtn.textContent = "📍 좌표 찍기";
    pinBtn.addEventListener("click", () => setPinMode(!pinMode));

    const clearBtn = L.DomUtil.create("button", "measure-btn measure-btn-clear", searchRow);
    clearBtn.type = "button";
    clearBtn.textContent = "핀 지우기";
    clearBtn.addEventListener("click", clearPins);

    const errorEl = L.DomUtil.create("div", "coord-search-error", container);
    errorEl.id = "coordSearchError";
  }

  buildCoordToolbar();

  map.on("click", (e) => {
    if (measureState.mode) {
      addMeasurePoint(e.latlng);
      return;
    }
    if (pinMode) {
      addPinMarker(e.latlng);
    }
  });
  map.on("dblclick", () => {
    if (measureState.mode) exitMeasureMode();
    if (pinMode) setPinMode(false);
  });

  function buildMeasureToolbar() {
    const container = document.getElementById("measureToolbar");

    const buttons = L.DomUtil.create("div", "measure-buttons", container);

    const distBtn = L.DomUtil.create("button", "measure-btn", buttons);
    distBtn.id = "measureDistanceBtn";
    distBtn.type = "button";
    distBtn.textContent = "📏 거리 측정";
    distBtn.addEventListener("click", () => setMeasureMode("distance"));

    const areaBtn = L.DomUtil.create("button", "measure-btn", buttons);
    areaBtn.id = "measureAreaBtn";
    areaBtn.type = "button";
    areaBtn.textContent = "▱ 면적 측정";
    areaBtn.addEventListener("click", () => setMeasureMode("area"));

    const clearBtn = L.DomUtil.create("button", "measure-btn measure-btn-clear", buttons);
    clearBtn.type = "button";
    clearBtn.textContent = "초기화";
    clearBtn.addEventListener("click", () => clearMeasurement());

    const result = L.DomUtil.create("div", "measure-result", container);
    result.id = "measureResult";
  }

  buildMeasureToolbar();

  function wireCategoryToggles() {
    const dgnssToggle = document.getElementById("toggleDgnss");
    const coverageToggle = document.getElementById("toggleCoverage");
    const pppRtkToggle = document.getElementById("togglePppRtk");
    const basepointsToggle = document.getElementById("toggleBasepoints");
    const dgnssPanel = document.getElementById("dgnssPanel");

    dgnssToggle.addEventListener("change", (e) => {
      dgnssCategoryOn = e.target.checked;
      dgnssPanel.classList.toggle("hidden", !dgnssCategoryOn);
      applyFilter();
    });

    coverageToggle.addEventListener("change", (e) => {
      showCoverage = e.target.checked;
      applyFilter();
    });

    pppRtkToggle.addEventListener("change", (e) => {
      pppRtkCategoryOn = e.target.checked;
      if (pppRtkCategoryOn) {
        pppRtkLayer.addTo(map);
      } else {
        map.removeLayer(pppRtkLayer);
      }
    });

    basepointsToggle.addEventListener("change", (e) => {
      if (e.target.checked) {
        basepointsLayer.addTo(map);
      } else {
        map.removeLayer(basepointsLayer);
      }
    });

    const territorialLimitToggle = document.getElementById("toggleTerritorialLimit");
    territorialLimitToggle.addEventListener("change", (e) => {
      if (e.target.checked) {
        territorialLimitLayer.addTo(map);
      } else {
        map.removeLayer(territorialLimitLayer);
      }
    });

    const territorialLimitOfficialToggle = document.getElementById("toggleTerritorialLimitOfficial");
    territorialLimitOfficialToggle.addEventListener("change", (e) => {
      if (e.target.checked) {
        territorialLimitOfficialLayer.addTo(map);
      } else {
        map.removeLayer(territorialLimitOfficialLayer);
      }
    });

    const nllLineToggle = document.getElementById("toggleNllLine");
    nllLineToggle.addEventListener("change", (e) => {
      if (e.target.checked) {
        nllLineLayer.addTo(map);
      } else {
        map.removeLayer(nllLineLayer);
      }
    });

    const specialZoneToggle = document.getElementById("toggleSpecialZone");
    specialZoneToggle.addEventListener("change", (e) => {
      if (e.target.checked) {
        specialZoneLayer.addTo(map);
      } else {
        map.removeLayer(specialZoneLayer);
      }
    });

    const restraintZoneToggle = document.getElementById("toggleRestraintZone");
    restraintZoneToggle.addEventListener("change", (e) => {
      if (e.target.checked) {
        restraintZoneLayer.addTo(map);
      } else {
        map.removeLayer(restraintZoneLayer);
      }
    });

    const westFishingZoneToggle = document.getElementById("toggleWestFishingZone");
    westFishingZoneToggle.addEventListener("change", (e) => {
      if (e.target.checked) {
        westFishingZoneLayer.addTo(map);
      } else {
        map.removeLayer(westFishingZoneLayer);
      }
    });

    const mobileCoverageToggle = document.getElementById("toggleMobileCoverage");
    mobileCoverageToggle.addEventListener("change", (e) => {
      if (e.target.checked) {
        mobileCoverageLayer.addTo(map);
      } else {
        map.removeLayer(mobileCoverageLayer);
      }
    });

    const kpsGridToggle = document.getElementById("toggleKpsGrid");
    kpsGridToggle.addEventListener("change", (e) => {
      if (e.target.checked) {
        kpsGridLayer.addTo(map);
      } else {
        map.removeLayer(kpsGridLayer);
      }
    });

    const koreaJapanMedianLineToggle = document.getElementById("toggleKoreaJapanMedianLine");
    koreaJapanMedianLineToggle.addEventListener("change", (e) => {
      if (e.target.checked) {
        koreaJapanMedianLineLayer.addTo(map);
      } else {
        map.removeLayer(koreaJapanMedianLineLayer);
      }
    });

    const koreaJapanJointZoneToggle = document.getElementById("toggleKoreaJapanJointZone");
    koreaJapanJointZoneToggle.addEventListener("change", (e) => {
      if (e.target.checked) {
        koreaJapanJointZoneLayer.addTo(map);
      } else {
        map.removeLayer(koreaJapanJointZoneLayer);
      }
    });

    const koreaChinaProvisionalZoneToggle = document.getElementById("toggleKoreaChinaProvisionalZone");
    koreaChinaProvisionalZoneToggle.addEventListener("change", (e) => {
      if (e.target.checked) {
        koreaChinaProvisionalZoneLayer.addTo(map);
      } else {
        map.removeLayer(koreaChinaProvisionalZoneLayer);
      }
    });

    const daehaeguToggle = document.getElementById("toggleDaehaegu");
    daehaeguToggle.addEventListener("change", (e) => {
      if (e.target.checked) {
        daehaeguLayer.addTo(map);
      } else {
        map.removeLayer(daehaeguLayer);
      }
    });

    const haeguNumbersToggle = document.getElementById("toggleHaeguNumbers");
    haeguNumbersToggle.addEventListener("change", (e) => {
      if (e.target.checked) {
        haeguNumberLayer.addTo(map);
      } else {
        map.removeLayer(haeguNumberLayer);
      }
    });
  }

  // --- 서비스 범위 투명도 조절 ---
  function wireOpacityControls() {
    const dgnssSlider = document.getElementById("dgnssOpacity");
    const pppRtkSlider = document.getElementById("pppRtkOpacity");
    const dgnssValueEl = document.getElementById("dgnssOpacityValue");
    const pppRtkValueEl = document.getElementById("pppRtkOpacityValue");

    // 화면에는 슬라이더 자체의 위치(%)를 그대로 보여주고(기본 50%),
    // 실제 적용되는 투명도는 DGNSS_OPACITY_SCALE/PPP_RTK_OPACITY_SCALE로
    // 축소해서 적용함 — 즉 슬라이더 50%가 곧 "기본값"임.
    const toPercent = (sliderValue) => `${Math.round(sliderValue * 100)}%`;
    dgnssValueEl.textContent = toPercent(parseFloat(dgnssSlider.value));
    pppRtkValueEl.textContent = toPercent(parseFloat(pppRtkSlider.value));

    dgnssSlider.addEventListener("input", (e) => {
      const sliderValue = parseFloat(e.target.value);
      dgnssFillOpacity = sliderValue * DGNSS_OPACITY_SCALE;
      dgnssValueEl.textContent = toPercent(sliderValue);
      circles.forEach((circle) => circle.setStyle({ fillOpacity: dgnssFillOpacity }));
    });

    pppRtkSlider.addEventListener("input", (e) => {
      const sliderValue = parseFloat(e.target.value);
      pppRtkFillOpacity = sliderValue * PPP_RTK_OPACITY_SCALE;
      pppRtkValueEl.textContent = toPercent(sliderValue);
      pppRtkFillLayer.setStyle({ fillOpacity: pppRtkFillOpacity });
      pppRtkIslandLayers.forEach((circle) => circle.setStyle({ fillOpacity: pppRtkFillOpacity }));
    });
  }

  renderTypeFilters();
  wireSelectAll();
  wireCategoryToggles();
  wireOpacityControls();
  renderStationList();
})();
