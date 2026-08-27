(function () {
  const TYPE_COLORS = {
    "해양": "#0f6fb3",
    "내륙": "#c0392b",
  };

  // 베이스 지도와 구별되면서도 과하지 않은 코버리지 원 색상 (마커 색과는 별도)
  const COVERAGE_COLORS = {
    "해양": "#fb7318",
    "내륙": "#9c2fb0",
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

  // 지명 라벨이 없는 일반 지도. CARTO Voyager는 익명 요청 제한으로
  // "API KEY REQUIRED" 워터마크가 뜨는 문제가 있어 Esri World Ocean
  // Base(라벨 없음, 키 불필요)로 교체함.
  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}",
    {
      attribution: "Tiles &copy; Esri &mdash; GEBCO, NOAA, National Geographic, Garmin, HERE",
      maxZoom: 16,
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
  const PPP_RTK_COLOR = "#00897b";

  const pppRtkLayer = L.layerGroup();
  const pppRtkStyle = {
    color: PPP_RTK_COLOR,
    weight: 1.5,
    opacity: 0.85,
    fillColor: PPP_RTK_COLOR,
    fillOpacity: 0.18,
    interactive: false,
  };

  L.polygon(PPP_RTK_ZONE, pppRtkStyle).addTo(pppRtkLayer);
  PPP_RTK_EXTRA_ZONES.forEach((zone) => {
    L.polygon(zone, pppRtkStyle).addTo(pppRtkLayer);
  });

  pppRtkLayer.addTo(map);

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
      iconSize: [16, 16],
      iconAnchor: [8, 8],
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
      color: coverageColor,
      weight: 1.8,
      opacity: 0.85,
      fillColor: coverageColor,
      fillOpacity: 0.09,
      dashArray: "8 5",
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

    const coverageWrap = document.createElement("label");
    coverageWrap.className = "filter-chip coverage-chip";
    coverageWrap.innerHTML = `
      <input type="checkbox" id="filter-coverage" checked />
      <span>커버리지 반경</span>
    `;
    coverageWrap.querySelector("input").addEventListener("change", (e) => {
      showCoverage = e.target.checked;
      applyFilter();
    });
    container.appendChild(coverageWrap);
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

  map.on("click", (e) => {
    if (!measureState.mode) return;
    addMeasurePoint(e.latlng);
  });
  map.on("dblclick", () => {
    if (measureState.mode) exitMeasureMode();
  });

  const MeasureControl = L.Control.extend({
    options: { position: "topright" },
    onAdd: function () {
      const container = L.DomUtil.create("div", "measure-control");
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);

      const buttons = L.DomUtil.create("div", "measure-buttons", container);

      const distBtn = L.DomUtil.create("button", "measure-btn", buttons);
      distBtn.id = "measureDistanceBtn";
      distBtn.type = "button";
      distBtn.textContent = "📏 거리 측정";
      L.DomEvent.on(distBtn, "click", () => setMeasureMode("distance"));

      const areaBtn = L.DomUtil.create("button", "measure-btn", buttons);
      areaBtn.id = "measureAreaBtn";
      areaBtn.type = "button";
      areaBtn.textContent = "▱ 면적 측정";
      L.DomEvent.on(areaBtn, "click", () => setMeasureMode("area"));

      const clearBtn = L.DomUtil.create("button", "measure-btn measure-btn-clear", buttons);
      clearBtn.type = "button";
      clearBtn.textContent = "초기화";
      L.DomEvent.on(clearBtn, "click", () => clearMeasurement());

      const result = L.DomUtil.create("div", "measure-result", container);
      result.id = "measureResult";

      return container;
    },
  });

  map.addControl(new MeasureControl());

  function wireCategoryToggles() {
    const dgnssToggle = document.getElementById("toggleDgnss");
    const pppRtkToggle = document.getElementById("togglePppRtk");
    const dgnssPanel = document.getElementById("dgnssPanel");

    dgnssToggle.addEventListener("change", (e) => {
      dgnssCategoryOn = e.target.checked;
      dgnssPanel.classList.toggle("hidden", !dgnssCategoryOn);
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
  }

  renderTypeFilters();
  wireSelectAll();
  wireCategoryToggles();
  renderStationList();
})();
