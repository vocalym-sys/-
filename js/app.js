(function () {
  const TYPE_COLORS = {
    "해양": "#0f6fb3",
    "내륙": "#c0392b",
  };

  // 커버리지 확인용 반경: 해양기준국 100해리(NM), 내륙기준국 80km
  const COVERAGE_RADIUS_M = {
    "해양": 100 * 1852,
    "내륙": 80 * 1000,
  };

  const map = L.map("map", { zoomControl: true }).setView([36.2, 127.8], 7);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 18,
  }).addTo(map);

  const markers = new Map();
  const circles = new Map();
  const activeTypes = new Set(Object.keys(TYPE_COLORS));
  let showCoverage = true;

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
    const color = TYPE_COLORS[station.type] || "#666";

    const circle = L.circle([station.lat, station.lng], {
      radius: COVERAGE_RADIUS_M[station.type] || 0,
      color: color,
      weight: 1,
      opacity: 0.6,
      fillColor: color,
      fillOpacity: 0.06,
      dashArray: "4 4",
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

  function applyFilter() {
    validStations.forEach((station) => {
      const marker = markers.get(station.name);
      const circle = circles.get(station.name);
      const visible = activeTypes.has(station.type);

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
    });
    renderStationList();
  }

  function renderStationList() {
    const list = document.getElementById("stationList");
    list.innerHTML = "";
    const visibleStations = validStations.filter((s) => activeTypes.has(s.type));
    document.getElementById("stationCount").textContent =
      `표시된 기준국: ${visibleStations.length} / 전체 ${STATIONS.length}` +
      (STATIONS.length > validStations.length
        ? ` (좌표 미확인 ${STATIONS.length - validStations.length}개소 제외)`
        : "");

    visibleStations.forEach((station) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <span class="dot" style="background:${TYPE_COLORS[station.type]}"></span>
        <span class="name">${station.name}</span>
        <span class="type">${station.type}</span>
      `;
      li.addEventListener("click", () => {
        map.setView([station.lat, station.lng], 10, { animate: true });
        markers.get(station.name).openPopup();
      });
      list.appendChild(li);
    });
  }

  renderTypeFilters();
  renderStationList();
})();
