export type Raw = Record<string, unknown>;

export type Point = {
  id: string;
  sourceIndex: number;
  refId: string;
  name: string;
  mt: string;
  selection: string;
  kind: "Titular" | "Suplente" | "Otro";
  priorityRank: number;
  lat: number;
  lng: number;
  day: number | null;
  assignedMt: string | null;
  avgMeters: number | null;
};

export type Forecast = Record<string, Record<number, number>>;
export type Notice = { type: "info" | "warn"; text: string };
export type PlanningMode = "with-spares" | "titles-only";

export const MAX_SUPPLEMENT_DISTANCE_METERS = 15000;
export const norm = (value: unknown) => String(value ?? "").trim().toUpperCase().replace(/\s+/g, " ");
export const key = (value: unknown) => norm(value).replace(/[^A-Z0-9]/g, "");
export const asNumber = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim().replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};

const rad = (value: number) => (value * Math.PI) / 180;
export const meters = (a: Pick<Point, "lat" | "lng">, b: Pick<Point, "lat" | "lng">) => {
  const earthRadius = 6371000;
  const deltaLatitude = rad(b.lat - a.lat), deltaLongitude = rad(b.lng - a.lng);
  const haversine = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(haversine));
};

export const column = (rows: Raw[], names: string[]) => {
  const headers = Object.keys(rows[0] ?? {});
  return headers.find((header) => names.includes(key(header)));
};

export function baseColumns(rows: Raw[]) {
  if (!rows.length) throw new Error("La base de puntos no contiene registros.");
  const columns = {
    mt: column(rows, ["MTFINAL"]),
    selection: column(rows, ["SELECCION", "SELECCIONPUNTO"]),
    latitude: column(rows, ["LATITUDE", "LATITUD", "LAT"]),
    longitude: column(rows, ["LONGITUDE", "LONGITUD", "LON", "LNG"]),
    pdv: column(rows, ["PDV"]),
    refId: column(rows, ["REFID"]),
  };
  const labels: Record<keyof typeof columns, string> = { mt: "MT FINAL", selection: "SELECCION", latitude: "LATITUD", longitude: "LONGITUD", pdv: "PDV", refId: "RefID" };
  const missing = (Object.keys(columns) as Array<keyof typeof columns>).find((name) => !columns[name]);
  if (missing) throw new Error(`No se encontró la columna "${labels[missing]}" en la base de puntos.`);
  return columns as Record<keyof typeof columns, string>;
}

export function planningModeFromRows(rows: Raw[]): PlanningMode {
  const selectionColumn = baseColumns(rows).selection;
  return rows.some((row) => norm(row[selectionColumn]).startsWith("S")) ? "with-spares" : "titles-only";
}

export function forecastMtColumn(rows: Raw[]) {
  if (!rows.length) throw new Error("El forecast no contiene registros.");
  const mt = column(rows, ["MTFINAL"]);
  if (!mt) throw new Error("No se encontró la columna \"MT FINAL\" en el forecast.");
  const days = Object.keys(rows[0]).filter((header) => Number.isInteger(Number(header)) && Number(header) > 0);
  if (!days.length) throw new Error("No se encontraron columnas de días numéricos en el forecast.");
  return mt;
}

export function extractForecast(rows: Raw[]) {
  const mtColumn = forecastMtColumn(rows);
  const result: Forecast = {};
  rows.forEach((row) => {
    const mt = String(row[mtColumn] ?? "").trim();
    if (!mt) return;
    Object.entries(row).forEach(([header, value]) => {
      const day = Number(header), count = asNumber(value);
      if (Number.isInteger(day) && day > 0 && count && count > 0) (result[mt] ??= {})[day] = Math.round(count);
    });
  });
  return result;
}

function selectionPriority(selection: string, country: string) {
  const dominican = country.includes("DOMINICAN") || country.includes("DOMINICANA");
  const order = dominican ? ["S PANEL", "S1", "S2", "S3", "S4", "S ON", "S ORO"] : ["S1", "S2", "S3", "S4"];
  const exact = order.indexOf(selection);
  return exact < 0 ? 99 : exact;
}

export function extractPoints(rows: Raw[]): Point[] {
  const fields = baseColumns(rows);
  const countryColumn = column(rows, ["PAIS", "COUNTRY"]);
  let validCoordinates = 0, swappedCoordinates = 0;
  const coordinates = rows.map((row) => {
    const lat = asNumber(row[fields.latitude]), lng = asNumber(row[fields.longitude]);
    if (lat !== null && lng !== null) {
      validCoordinates++;
      if (Math.abs(lat) > 60 && Math.abs(lng) < 60) swappedCoordinates++;
    }
    return { lat, lng };
  });
  const likelySwapped = validCoordinates > 0 && swappedCoordinates > validCoordinates * 0.55;
  const points: Point[] = [];
  rows.forEach((row, sourceIndex) => {
    const { lat, lng } = coordinates[sourceIndex];
    if (lat === null || lng === null) return;
    const selection = norm(row[fields.selection]);
    const kind: Point["kind"] = selection === "T" || selection === "T PANEL" ? "Titular" : selection.startsWith("S") ? "Suplente" : "Otro";
    if (kind === "Otro") return;
    const refId = String(row[fields.refId] ?? sourceIndex + 1);
    points.push({
      id: `${refId}-${sourceIndex}`,
      sourceIndex,
      refId,
      name: String(row[fields.pdv] ?? refId),
      mt: String(row[fields.mt] ?? "").trim(),
      selection,
      kind,
      priorityRank: selectionPriority(selection, norm(countryColumn ? row[countryColumn] : "")),
      lat: likelySwapped ? lng : lat,
      lng: likelySwapped ? lat : lng,
      day: null,
      assignedMt: null,
      avgMeters: null,
    });
  });
  return points;
}

export const operationalMt = (point: Point) => point.assignedMt ?? point.mt;
const groupKey = (mt: string, day: number) => `${mt}\u0000${day}`;
const pointDistanceMatrix = (points: Point[]) => points.map((point) => points.map((other) => meters(point, other)));

function denseSubset(points: Point[], target: number) {
  if (points.length <= target) return [...points];
  const matrix = pointDistanceMatrix(points), neighbors = Math.min(6, points.length - 1);
  return points.map((point, index) => {
    const nearest = matrix[index].filter((_, other) => other !== index).sort((a, b) => a - b).slice(0, neighbors);
    return { point, score: nearest.reduce((sum, distance) => sum + distance, 0) };
  }).sort((a, b) => a.score - b.score).slice(0, target).map(({ point }) => point);
}

function initialMedoids(matrix: number[][], clusterCount: number) {
  if (!matrix.length) return [];
  const neighbors = Math.min(5, matrix.length - 1);
  const density = matrix.map((row, index) => row.filter((_, other) => other !== index).sort((a, b) => a - b).slice(0, neighbors).reduce((sum, value) => sum + value, 0));
  const medoids = [density.indexOf(Math.min(...density))];
  while (medoids.length < clusterCount) {
    let best = -1, bestDistance = -1;
    for (let point = 0; point < matrix.length; point++) {
      if (medoids.includes(point)) continue;
      const separation = Math.min(...medoids.map((medoid) => matrix[point][medoid]));
      if (separation > bestDistance) { best = point; bestDistance = separation; }
    }
    medoids.push(best < 0 ? medoids[0] : best);
  }
  return medoids;
}

function exactCapacityAssignment(matrix: number[][], medoids: number[], capacities: number[]) {
  const labels = Array(matrix.length).fill(-1), remaining = [...capacities];
  const unassigned = new Set(matrix.map((_, index) => index));
  while (unassigned.size) {
    let chosenPoint = -1, chosenCluster = -1, chosenRegret = -Infinity, chosenCost = Infinity;
    for (const point of unassigned) {
      let firstCluster = -1, firstCost = Infinity, secondCost = Infinity;
      medoids.forEach((medoid, cluster) => {
        if (remaining[cluster] <= 0) return;
        const cost = matrix[point][medoid];
        if (cost < firstCost) { secondCost = firstCost; firstCost = cost; firstCluster = cluster; }
        else if (cost < secondCost) secondCost = cost;
      });
      if (firstCluster < 0) continue;
      const regret = secondCost === Infinity ? Number.MAX_SAFE_INTEGER : secondCost - firstCost;
      if (regret > chosenRegret || (regret === chosenRegret && firstCost < chosenCost)) {
        chosenPoint = point; chosenCluster = firstCluster; chosenRegret = regret; chosenCost = firstCost;
      }
    }
    if (chosenPoint < 0) break;
    labels[chosenPoint] = chosenCluster;
    remaining[chosenCluster]--;
    unassigned.delete(chosenPoint);
  }
  return labels;
}

export function refineClusterSwaps(labels: number[], matrix: number[][], maxSwaps = 120) {
  if (!labels.length) return 0;
  let swaps = 0;
  const clusterCount = Math.max(...labels) + 1;
  const sums = matrix.map(() => Array(clusterCount).fill(0));
  for (let point = 0; point < matrix.length; point++) for (let other = 0; other < matrix.length; other++) sums[point][labels[other]] += matrix[point][other];
  while (swaps < maxSwaps) {
    let bestA = -1, bestB = -1, bestDelta = -0.001;
    for (let a = 0; a < labels.length; a++) for (let b = a + 1; b < labels.length; b++) {
      const clusterA = labels[a], clusterB = labels[b];
      if (clusterA === clusterB) continue;
      const delta = (sums[b][clusterA] - matrix[b][a] - sums[a][clusterA]) + (sums[a][clusterB] - matrix[a][b] - sums[b][clusterB]);
      if (delta < bestDelta) { bestDelta = delta; bestA = a; bestB = b; }
    }
    if (bestA < 0) break;
    const clusterA = labels[bestA], clusterB = labels[bestB];
    [labels[bestA], labels[bestB]] = [clusterB, clusterA];
    for (let point = 0; point < labels.length; point++) {
      sums[point][clusterA] += matrix[point][bestB] - matrix[point][bestA];
      sums[point][clusterB] += matrix[point][bestA] - matrix[point][bestB];
    }
    swaps++;
  }
  return swaps;
}

function refineFlexibleMoves(labels: number[], matrix: number[][], targets: number[], maxMoves: number) {
  if (labels.length < 2 || targets.length < 2) return 0;
  const clusterCount = targets.length;
  const sizes = Array(clusterCount).fill(0);
  labels.forEach((label) => sizes[label]++);
  const sums = matrix.map(() => Array(clusterCount).fill(0));
  for (let point = 0; point < matrix.length; point++) for (let other = 0; other < matrix.length; other++) sums[point][labels[other]] += matrix[point][other];
  const moved = new Set<number>();
  let moves = 0;
  while (moves < maxMoves) {
    let bestPoint = -1, bestCluster = -1, bestGain = 0;
    for (let point = 0; point < labels.length; point++) {
      if (moved.has(point)) continue;
      const current = labels[point];
      if (sizes[current] <= 1) continue;
      const ownAverage = sums[point][current] / (sizes[current] - 1);
      for (let candidate = 0; candidate < clusterCount; candidate++) {
        if (candidate === current || sizes[candidate] === 0) continue;
        const otherAverage = sums[point][candidate] / sizes[candidate];
        const gain = ownAverage - otherAverage;
        const deviationBefore = Math.abs(sizes[current] - targets[current]) + Math.abs(sizes[candidate] - targets[candidate]);
        const deviationAfter = Math.abs(sizes[current] - 1 - targets[current]) + Math.abs(sizes[candidate] + 1 - targets[candidate]);
        const worsensTarget = deviationAfter > deviationBefore;
        const requiredGain = worsensTarget ? Math.max(250, ownAverage * 0.25) : Math.max(100, ownAverage * 0.1);
        if (gain >= requiredGain && gain > bestGain) { bestPoint = point; bestCluster = candidate; bestGain = gain; }
      }
    }
    if (bestPoint < 0) break;
    const previous = labels[bestPoint];
    labels[bestPoint] = bestCluster;
    sizes[previous]--;
    sizes[bestCluster]++;
    for (let point = 0; point < labels.length; point++) {
      sums[point][previous] -= matrix[point][bestPoint];
      sums[point][bestCluster] += matrix[point][bestPoint];
    }
    moved.add(bestPoint);
    moves++;
  }
  return moves;
}

function capacitatedClusters(points: Point[], capacities: number[], flexible = false, customMatrix?: number[][]) {
  if (!points.length) return { labels: [] as number[], flexibleMoves: 0 };
  if (capacities.length === 1) return { labels: Array(points.length).fill(0), flexibleMoves: 0 };
  const matrix = customMatrix ?? pointDistanceMatrix(points);
  let medoids = initialMedoids(matrix, capacities.length);
  let labels = exactCapacityAssignment(matrix, medoids, capacities);
  for (let iteration = 0; iteration < 10; iteration++) {
    const nextMedoids = medoids.map((medoid, cluster) => {
      const members = labels.map((label, point) => label === cluster ? point : -1).filter((point) => point >= 0);
      if (!members.length) return medoid;
      let best = members[0], bestCost = Infinity;
      members.forEach((candidate) => {
        const cost = members.reduce((sum, other) => sum + matrix[candidate][other], 0);
        if (cost < bestCost) { best = candidate; bestCost = cost; }
      });
      return best;
    });
    if (nextMedoids.every((medoid, index) => medoid === medoids[index])) break;
    medoids = nextMedoids;
    labels = exactCapacityAssignment(matrix, medoids, capacities);
  }
  refineClusterSwaps(labels, matrix, points.length > 300 ? 36 : 90);
  const flexibleMoves = flexible ? refineFlexibleMoves(labels, matrix, capacities, Math.min(points.length, points.length > 300 ? 120 : 240)) : 0;
  return { labels, flexibleMoves };
}

function proportionalPlans(days: Array<{ day: number; count: number }>, available: number, multiplier: number) {
  const requested = days.reduce((sum, plan) => sum + plan.count * multiplier, 0);
  const assignable = available;
  if (!requested || !assignable) return [];
  const allocations = days.map((plan) => {
    const exact = plan.count * multiplier * assignable / requested;
    return { day: plan.day, count: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = assignable - allocations.reduce((sum, plan) => sum + plan.count, 0);
  allocations.sort((a, b) => b.remainder - a.remainder || a.day - b.day);
  for (let index = 0; index < allocations.length && remaining > 0; index++, remaining--) allocations[index].count++;
  return allocations.sort((a, b) => a.day - b.day).filter((plan) => plan.count > 0);
}

export function refreshAverages(points: Point[]) {
  const groups = new Map<string, { titles: Point[]; members: Point[] }>();
  points.forEach((point) => {
    point.avgMeters = null;
    if (!point.day) return;
    const key = groupKey(operationalMt(point), point.day);
    const group = groups.get(key) ?? { titles: [], members: [] };
    group.members.push(point);
    if (point.kind === "Titular") group.titles.push(point);
    groups.set(key, group);
  });
  groups.forEach(({ titles, members }) => {
    members.forEach((point) => {
      if (!titles.length) return;
      if (point.kind === "Titular") {
        if (titles.length === 1) point.avgMeters = 0;
        else point.avgMeters = titles.reduce((sum, title) => sum + (title.id === point.id ? 0 : meters(point, title)), 0) / (titles.length - 1);
      } else point.avgMeters = titles.reduce((nearest, title) => Math.min(nearest, meters(point, title)), Infinity);
    });
  });
  return points;
}

type SpareGroup = {
  mt: string;
  day: number;
  titulars: Point[];
  desired: number;
  assigned: Point[];
  hasNearby: boolean;
  center: { lat: number; lng: number };
};

const GRID_DEGREES = 0.1;
const gridKey = (lat: number, lng: number) => `${Math.floor(lat / GRID_DEGREES)}:${Math.floor(lng / GRID_DEGREES)}`;

export function allocateSpares(next: Point[], forecast: Forecast, notices: Notice[]) {
  next.forEach((point) => { if (point.kind === "Suplente") { point.day = null; point.assignedMt = null; point.avgMeters = null; } });
  const titleGroups = new Map<string, Point[]>();
  next.forEach((point) => {
    if (point.kind !== "Titular" || !point.day || !point.assignedMt || !forecast[point.assignedMt]?.[point.day]) return;
    const key = groupKey(point.assignedMt, point.day);
    const titles = titleGroups.get(key) ?? [];
    titles.push(point);
    titleGroups.set(key, titles);
  });
  const groups: SpareGroup[] = [...titleGroups.entries()].map(([compound, titulars]) => {
    const split = compound.lastIndexOf("\u0000"), mt = compound.slice(0, split), day = Number(compound.slice(split + 1));
    return {
      mt, day, titulars, desired: titulars.length * 3, assigned: [], hasNearby: false,
      center: { lat: titulars.reduce((sum, point) => sum + point.lat, 0) / titulars.length, lng: titulars.reduce((sum, point) => sum + point.lng, 0) / titulars.length },
    };
  });
  const groupGrid = new Map<string, SpareGroup[]>();
  groups.forEach((group) => {
    const cell = gridKey(group.center.lat, group.center.lng), bucket = groupGrid.get(cell) ?? [];
    bucket.push(group); groupGrid.set(cell, bucket);
  });
  const spares = next.filter((point) => point.kind === "Suplente");
  const edges: Array<{ point: Point; group: SpareGroup; distance: number }> = [];
  const candidateLimit = 16;
  spares.forEach((point) => {
    const cellLat = Math.floor(point.lat / GRID_DEGREES), cellLng = Math.floor(point.lng / GRID_DEGREES);
    const localGroups: SpareGroup[] = [];
    for (let latOffset = -2; latOffset <= 2; latOffset++) for (let lngOffset = -2; lngOffset <= 2; lngOffset++) {
      const bucket = groupGrid.get(`${cellLat + latOffset}:${cellLng + lngOffset}`);
      if (bucket) localGroups.push(...bucket);
    }
    const cosine = Math.cos(rad(point.lat));
    localGroups.map((group) => {
      const deltaLat = point.lat - group.center.lat, deltaLng = (point.lng - group.center.lng) * cosine;
      return { group, score: deltaLat * deltaLat + deltaLng * deltaLng };
    }).sort((a, b) => a.score - b.score).slice(0, candidateLimit).forEach(({ group }) => {
      const distance = group.titulars.reduce((nearest, title) => Math.min(nearest, meters(point, title)), Infinity);
      if (distance <= MAX_SUPPLEMENT_DISTANCE_METERS) { group.hasNearby = true; edges.push({ point, group, distance }); }
    });
  });
  edges.sort((a, b) => a.point.priorityRank - b.point.priorityRank || a.distance - b.distance);
  const usedSpares = new Set<string>();
  edges.forEach(({ point, group }) => {
    if (usedSpares.has(point.id) || group.assigned.length >= group.desired) return;
    point.day = group.day; point.assignedMt = group.mt; group.assigned.push(point); usedSpares.add(point.id);
  });
  const fallbackNotices: string[] = [];
  groups.filter((group) => !group.hasNearby && group.assigned.length < group.desired).forEach((group) => {
    const missing = group.desired - group.assigned.length;
    const fallback = spares.filter((point) => !usedSpares.has(point.id)).map((point) => ({
      point,
      distance: group.titulars.reduce((nearest, title) => Math.min(nearest, meters(point, title)), Infinity),
    })).sort((a, b) => a.distance - b.distance || a.point.priorityRank - b.point.priorityRank).slice(0, missing);
    fallback.forEach(({ point }) => { point.day = group.day; point.assignedMt = group.mt; group.assigned.push(point); usedSpares.add(point.id); });
    if (fallback.length) fallbackNotices.push(`${group.mt}, día ${group.day}: no había suplentes a 15 km; se asignaron los ${fallback.length} más cercanos disponibles.`);
  });
  fallbackNotices.slice(0, 20).forEach((text) => notices.push({ type: "info", text }));
  if (fallbackNotices.length > 20) notices.push({ type: "info", text: `${fallbackNotices.length - 20} jornadas adicionales usaron suplentes fuera de 15 km. Revisa la tabla de cumplimiento para el detalle.` });
  const shortages = groups.filter((group) => group.assigned.length < group.desired).map((group) => `${group.mt}, día ${group.day}: ${group.assigned.length}/${group.desired} suplentes disponibles.`);
  shortages.slice(0, 30).forEach((text) => notices.push({ type: "warn", text }));
  if (shortages.length > 30) notices.push({ type: "warn", text: `${shortages.length - 30} jornadas adicionales no alcanzaron la relación 1:3. La tabla conserva el detalle completo por MT y día.` });
}

export function assign(points: Point[], forecast: Forecast, detectedMode?: PlanningMode) {
  const next = points.map((point) => ({ ...point, day: null, assignedMt: null, avgMeters: null }));
  const notices: Notice[] = [];
  const mode: PlanningMode = detectedMode ?? (next.some((point) => point.kind === "Suplente") ? "with-spares" : "titles-only");
  const multiplier = mode === "titles-only" ? 3 : 1;
  let flexibleMoves = 0;
  const byMt = new Map<string, Point[]>();
  next.forEach((point) => { const list = byMt.get(point.mt) ?? []; list.push(point); byMt.set(point.mt, list); });
  Object.entries(forecast).forEach(([mt, daily]) => {
    const all = byMt.get(mt) ?? [], titles = all.filter((point) => point.kind === "Titular");
    const days = Object.entries(daily).map(([day, count]) => ({ day: Number(day), count })).sort((a, b) => a.day - b.day);
    const needed = days.reduce((sum, plan) => sum + plan.count * multiplier, 0);
    if (!all.length) { notices.push({ type: "warn", text: `${mt}: no hay puntos con coordenadas en la base.` }); return; }
    if (titles.length < needed) notices.push({ type: "warn", text: mode === "titles-only"
      ? `${mt}: la meta 1:3 pide ${needed} titulares y la base tiene ${titles.length}. Se distribuyeron todos los disponibles proporcionalmente entre los días.`
      : `${mt}: el forecast pide ${needed} titulares y la base tiene ${titles.length}. Se asignaron todos los disponibles.` });
    const selectedTitles = mode === "titles-only" ? [...titles] : denseSubset(titles, Math.min(needed, titles.length));
    let remaining = selectedTitles.length;
    const effectiveDays = mode === "titles-only"
      ? proportionalPlans(days, selectedTitles.length, multiplier)
      : days.map((plan) => { const count = Math.min(plan.count, remaining); remaining -= count; return { ...plan, count }; }).filter((plan) => plan.count > 0);
    const clustered = capacitatedClusters(selectedTitles, effectiveDays.map((plan) => plan.count), mode === "titles-only");
    const labels = clustered.labels;
    flexibleMoves += clustered.flexibleMoves;
    selectedTitles.forEach((point, index) => { point.day = effectiveDays[labels[index]]?.day ?? null; point.assignedMt = point.day ? mt : null; });
  });
  if (mode === "with-spares") allocateSpares(next, forecast, notices);
  else notices.unshift({ type: "info", text: `Modo sin suplentes detectado: se asignaron todos los titulares; la meta por día es 3 × forecast y la compacidad espacial tiene prioridad. ${flexibleMoves ? `${flexibleMoves} punto${flexibleMoves === 1 ? "" : "s"} cambiaron de grupo para reducir la dispersión, aunque la cantidad diaria pueda variar frente a la meta.` : "La distribución alcanzó la mejor agrupación encontrada sin necesitar desviarse de la meta diaria."}` });
  return { points: refreshAverages(next), notices, mode };
}

export function withinClusterMean(labels: number[], matrix: number[][]) {
  let total = 0, pairs = 0;
  for (let a = 0; a < labels.length; a++) for (let b = a + 1; b < labels.length; b++) if (labels[a] === labels[b]) { total += matrix[a][b]; pairs++; }
  return pairs ? total / pairs : 0;
}

export async function roadTimeMatrix(points: Point[]) {
  if (points.length > 225) throw new Error("El QA vial admite hasta 225 titulares por MT en una ejecución.");
  const result = Array.from({ length: points.length }, () => Array(points.length).fill(0));
  const request = async (sources: Point[], destinations: Point[], sourceOffset: number, destinationOffset: number, sameSet = false) => {
    const coordinates = sameSet ? sources : [...sources, ...destinations];
    const coordinateText = coordinates.map((point) => `${point.lng},${point.lat}`).join(";");
    const query = sameSet ? "annotations=duration&skip_waypoints=true" : `sources=${sources.map((_, index) => index).join(";")}&destinations=${destinations.map((_, index) => index + sources.length).join(";")}&annotations=duration&skip_waypoints=true`;
    const response = await fetch(`https://router.project-osrm.org/table/v1/driving/${coordinateText}?${query}`);
    if (!response.ok) throw new Error(`El servicio vial respondió ${response.status}.`);
    const data = await response.json() as { code?: string; durations?: Array<Array<number | null>> };
    if (data.code !== "Ok" || !data.durations) throw new Error("El servicio vial no pudo construir la matriz de tiempos.");
    data.durations.forEach((row, source) => row.forEach((value, destination) => {
      if (value == null) throw new Error("Hay puntos que no pudieron conectarse a la red vial.");
      result[sourceOffset + source][destinationOffset + destination] = value;
    }));
  };
  if (points.length <= 95) await request(points, points, 0, 0, true);
  else {
    const block = 45;
    for (let source = 0; source < points.length; source += block) for (let destination = 0; destination < points.length; destination += block) {
      await request(points.slice(source, source + block), points.slice(destination, destination + block), source, destination);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return result.map((row, a) => row.map((value, b) => (value + result[b][a]) / 2));
}

type SmartQaCandidate = { mt: string; dayA: number; dayB: number; severity: number };

function averageDistanceTo(point: Point, group: Point[], excludeSelf = false) {
  let total = 0, count = 0;
  group.forEach((other) => {
    if (excludeSelf && other.id === point.id) return;
    total += meters(point, other); count++;
  });
  return count ? total / count : 0;
}

function pairwiseDistanceMean(group: Point[]) {
  let total = 0, pairs = 0;
  for (let first = 0; first < group.length; first++) for (let second = first + 1; second < group.length; second++) {
    total += meters(group[first], group[second]); pairs++;
  }
  return pairs ? total / pairs : 0;
}

function smartQaCandidates(points: Point[]) {
  const byMt = new Map<string, Map<number, Point[]>>();
  points.forEach((point) => {
    if (point.kind !== "Titular" || !point.day) return;
    const mt = operationalMt(point), days = byMt.get(mt) ?? new Map<number, Point[]>(), group = days.get(point.day) ?? [];
    group.push(point); days.set(point.day, group); byMt.set(mt, days);
  });
  const candidates: SmartQaCandidate[] = [];
  byMt.forEach((daily, mt) => {
    const groups = [...daily.entries()].sort((a, b) => a[0] - b[0]);
    const mtCandidates: SmartQaCandidate[] = [];
    for (let first = 0; first < groups.length; first++) for (let second = first + 1; second < groups.length; second++) {
      const [dayA, titlesA] = groups[first], [dayB, titlesB] = groups[second];
      if (titlesA.length + titlesB.length > 90) continue;
      const withinA = pairwiseDistanceMean(titlesA), withinB = pairwiseDistanceMean(titlesB);
      const gainA = titlesA.reduce((best, point) => {
        const own = averageDistanceTo(point, titlesA, true), other = averageDistanceTo(point, titlesB);
        return Math.max(best, own > 0 ? (own - other) / own : 0);
      }, 0);
      const gainB = titlesB.reduce((best, point) => {
        const own = averageDistanceTo(point, titlesB, true), other = averageDistanceTo(point, titlesA);
        return Math.max(best, own > 0 ? (own - other) / own : 0);
      }, 0);
      let nearestCross = Infinity;
      titlesA.forEach((titleA) => titlesB.forEach((titleB) => { nearestCross = Math.min(nearestCross, meters(titleA, titleB)); }));
      const dispersion = Math.max(withinA, withinB, 1);
      const mutualGain = Math.min(gainA, gainB);
      const severity = mutualGain > 0.04
        ? 10 + gainA + gainB
        : dispersion > 2500 && nearestCross < dispersion * 0.3 ? 1 - nearestCross / dispersion : 0;
      if (severity > 0.08) mtCandidates.push({ mt, dayA, dayB, severity });
    }
    mtCandidates.sort((a, b) => b.severity - a.severity);
    candidates.push(...mtCandidates.slice(0, 2));
  });
  return candidates.sort((a, b) => b.severity - a.severity).slice(0, 24);
}

export async function runSmartRoadQa(points: Point[], forecast: Forecast, onProgress?: (text: string) => void) {
  const next = points.map((point) => ({ ...point }));
  const originalDays = new Map(next.filter((point) => point.kind === "Titular").map((point) => [point.id, point.day]));
  const candidates = smartQaCandidates(next);
  if (!candidates.length) return {
    points: next,
    notices: [{ type: "info", text: "QA vial automático: no se detectaron cruces espaciales que necesitaran validación por carretera." }] as Notice[],
  };
  let reviewed = 0, failed = 0, swaps = 0, improvedPairs = 0, savedSeconds = 0;
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    onProgress?.(`QA vial automático ${index + 1}/${candidates.length}: ${candidate.mt}, días ${candidate.dayA} y ${candidate.dayB}…`);
    const titles = next.filter((point) => point.kind === "Titular" && operationalMt(point) === candidate.mt && (point.day === candidate.dayA || point.day === candidate.dayB));
    if (titles.length < 2 || titles.length > 90) continue;
    try {
      const matrix = await roadTimeMatrix(titles);
      const labels = titles.map((point) => point.day === candidate.dayA ? 0 : 1);
      const before = withinClusterMean(labels, matrix);
      const pairSwaps = refineClusterSwaps(labels, matrix, Math.min(24, titles.length));
      const after = withinClusterMean(labels, matrix);
      const improvement = before - after;
      if (pairSwaps > 0 && improvement >= 30 && improvement / Math.max(before, 1) >= 0.02) {
        titles.forEach((point, titleIndex) => { point.day = labels[titleIndex] === 0 ? candidate.dayA : candidate.dayB; });
        swaps += pairSwaps; improvedPairs++; savedSeconds += improvement;
      }
      reviewed++;
    } catch {
      failed++;
    }
    if (index < candidates.length - 1) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const changedPoints = next.filter((point) => point.kind === "Titular" && point.day !== originalDays.get(point.id)).length;
  if (changedPoints) {
    const ignoredNotices: Notice[] = [];
    allocateSpares(next, forecast, ignoredNotices);
    refreshAverages(next);
  }
  const notices: Notice[] = [{
    type: "info",
    text: changedPoints
      ? `QA vial automático: ${reviewed} cruces revisados en ${new Set(candidates.map((candidate) => candidate.mt)).size} MT; ${changedPoints} titular${changedPoints === 1 ? "" : "es"} cambiaron de día mediante ${swaps} intercambio${swaps === 1 ? "" : "s"}. Mejora media acumulada: ${(savedSeconds / Math.max(improvedPairs, 1) / 60).toFixed(1)} minutos por cruce corregido.`
      : `QA vial automático: ${reviewed} cruces sospechosos fueron revisados y la asignación ya era estable según los tiempos de conducción.`,
  }];
  if (failed) notices.push({ type: "info", text: `${failed} validaciones viales no pudieron consultarse; esos grupos conservaron su asignación original.` });
  return { points: next, notices };
}

export async function runRoadQa(points: Point[], forecast: Forecast, mt: string) {
  const titles = points.filter((point) => operationalMt(point) === mt && point.kind === "Titular" && point.day);
  if (titles.length < 2) throw new Error(`${mt}: no hay suficientes titulares asignados para ejecutar el QA vial.`);
  const roadMatrix = await roadTimeMatrix(titles);
  const days = [...new Set(titles.map((point) => point.day!))].sort((a, b) => a - b);
  const dayIndex = new Map(days.map((day, index) => [day, index]));
  const labels = titles.map((point) => dayIndex.get(point.day!)!);
  const beforeSeconds = withinClusterMean(labels, roadMatrix);
  const swaps = refineClusterSwaps(labels, roadMatrix, Math.min(160, titles.length * 2));
  const afterSeconds = withinClusterMean(labels, roadMatrix);
  const changedDays = new Map(titles.map((point, index) => [point.id, days[labels[index]]]));
  const changedPoints = titles.filter((point) => changedDays.get(point.id) !== point.day).length;
  const next = points.map((point) => point.kind === "Titular" && changedDays.has(point.id) ? { ...point, day: changedDays.get(point.id)! } : { ...point });
  const notices: Notice[] = [];
  allocateSpares(next, forecast, notices);
  notices.unshift({ type: "info", text: swaps ? `QA vial de ${mt}: ${changedPoints} titulares cambiaron de día mediante ${swaps} intercambios. El tiempo medio interno bajó de ${(beforeSeconds / 60).toFixed(1)} a ${(afterSeconds / 60).toFixed(1)} minutos.` : `QA vial de ${mt}: la distribución ya era estable según los tiempos de conducción; no se necesitaron intercambios.` });
  return { points: refreshAverages(next), notices };
}
