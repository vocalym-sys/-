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
  const visibleOutline = PPP_RTK_ZONE.slice(invisibleEnd).concat(PPP_RTK_ZONE.slice(0, invisibleStart + 1));
  const territorialLimitLayer = L.layerGroup([
    L.polyline(visibleOutline, pppRtkOutlineStyle),
  ]);
  territorialLimitLayer.addTo(map);

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
