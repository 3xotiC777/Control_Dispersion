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
export const DAY_FORECAST_TOLERANCE = 2;
export const norm = (value: unknown) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
export const key = (value: unknown) => norm(value).replace(/[^A-Z0-9]/g, "");
export const asNumber = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim().replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};

export function parseDayNumber(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value.getDate();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    if (value > 30000 && value < 60000) {
      const date = new Date(Math.round((value - 25569) * 86400 * 1000));
      if (!isNaN(date.getTime())) return date.getUTCDate();
    }
    if (value > 0) return Math.round(value);
    return null;
  }
  const str = String(value).trim();
  if (!str) return null;
  const directNum = Number(str.replace(",", "."));
  if (Number.isFinite(directNum)) {
    if (directNum > 30000 && directNum < 60000) {
      const date = new Date(Math.round((directNum - 25569) * 86400 * 1000));
      if (!isNaN(date.getTime())) return date.getUTCDate();
    }
    if (directNum > 0) return Math.round(directNum);
  }
  const dateMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (dateMatch) {
    const d = Number(dateMatch[1]);
    if (d >= 1 && d <= 31) return d;
  }
  const isoDateMatch = str.match(/^\d{4}[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (isoDateMatch) {
    const d = Number(isoDateMatch[2]);
    if (d >= 1 && d <= 31) return d;
  }
  const match = str.match(/\d+/);
  if (match) {
    const num = Number(match[0]);
    if (Number.isFinite(num) && num > 0) return Math.round(num);
  }
  return null;
}

const rad = (value: number) => (value * Math.PI) / 180;
export const meters = (a: Pick<Point, "lat" | "lng">, b: Pick<Point, "lat" | "lng">) => {
  const earthRadius = 6371000;
  const deltaLatitude = rad(b.lat - a.lat), deltaLongitude = rad(b.lng - a.lng);
  const haversine = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(haversine));
};

export const column = (rows: Raw[], names: string[]) => {
  const headers = Object.keys(rows[0] ?? {});
  const cleanNames = names.map(key);
  return headers.find((header) => cleanNames.includes(key(header)));
};

export function baseColumns(rows: Raw[]) {
  if (!rows.length) throw new Error("La base de puntos no contiene registros.");
  const headers = Object.keys(rows[0] ?? {});
  const columns = {
    mt: column(rows, ["MTFINAL", "MT", "TERRITORIO", "ZONA", "RUTA"]) ?? headers.find((h) => key(h).includes("MT") || key(h).includes("TERRITORIO")),
    selection: column(rows, ["SELECCION", "SELECCIONPUNTO", "TIPO", "TIPOPUNTO", "KIND", "CLASE", "CATEGORIA"]) ?? headers.find((h) => key(h).includes("SELECC") || key(h).includes("TIPO")),
    latitude: column(rows, ["LATITUDE", "LATITUD", "LAT", "Y"]) ?? headers.find((h) => key(h).startsWith("LAT")),
    longitude: column(rows, ["LONGITUDE", "LONGITUD", "LON", "LNG", "X"]) ?? headers.find((h) => key(h).startsWith("LON") || key(h).startsWith("LNG")),
    pdv: column(rows, ["PDV", "NOMBRE", "CLIENTE", "PUNTO", "NAME", "DESCRIPCION", "ESTABLECIMIENTO"]) ?? headers.find((h) => key(h).includes("PDV") || key(h).includes("NOMBRE") || key(h).includes("CLIENTE")),
    refId: column(rows, ["REFID", "ID", "CODIGO", "COD", "REF", "PUNTOID"]) ?? headers.find((h) => key(h).includes("REF") || key(h).includes("ID") || key(h).includes("COD")),
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

export function extractAssignedPoints(rows: Raw[]): { points: Point[]; forecast: Forecast; mode: PlanningMode } {
  if (!rows.length) throw new Error("La base no contiene registros.");
  const headers = Object.keys(rows[0] ?? {});

  const latCol = column(rows, ["LATITUDE", "LATITUD", "LAT", "Y"]) ?? headers.find((h) => key(h).startsWith("LAT"));
  const lngCol = column(rows, ["LONGITUDE", "LONGITUD", "LON", "LNG", "X"]) ?? headers.find((h) => key(h).startsWith("LON") || key(h).startsWith("LNG"));
  if (!latCol || !lngCol) {
    throw new Error('No se encontraron las columnas de coordenadas ("LATITUD" y "LONGITUD") en el archivo.');
  }

  // 1. Search for headers whose clean key is exactly "DIA"
  const exactDiaHeaders = headers.filter((h) => key(h) === "DIA");

  // 2. Search for headers that start with "DIA" or have day terms
  const otherDayHeaders = headers.filter((h) => {
    const k = key(h);
    return k !== "DIA" && (
      k.startsWith("DIA") ||
      k.includes("JORNADA") ||
      ["DIAS", "DAY", "DAYS"].includes(k)
    );
  });

  const candidateHeaders = [...exactDiaHeaders, ...otherDayHeaders];

  // Pick the header that actually contains the most valid day numbers in rows
  let bestDayCol: string | null = null;
  let maxValidCount = 0;

  for (const candidate of candidateHeaders) {
    let validCount = 0;
    const sampleSize = Math.min(rows.length, 500);
    for (let i = 0; i < sampleSize; i++) {
      const val = parseDayNumber(rows[i]?.[candidate]);
      if (val !== null && val > 0 && val <= 31) validCount++;
    }
    if (validCount > maxValidCount) {
      maxValidCount = validCount;
      bestDayCol = candidate;
    }
  }

  // If no candidate scored valid days, prefer exact "DIA" or any header containing DIA
  const dayCol = bestDayCol ?? exactDiaHeaders[0] ?? headers.find((h) => key(h).includes("DIA"));
  if (!dayCol) {
    throw new Error('No se encontró la columna de día ("DIA", "DÍA" o "JORNADA") en la base asignada.');
  }

  const mtCol = column(rows, ["MTFINAL", "MT", "TERRITORIO", "ZONA", "RUTA"]) ?? headers.find((h) => key(h).includes("MT") || key(h).includes("TERRITORIO"));
  const selCol = column(rows, ["SELECCION", "SELECCIONPUNTO", "TIPO", "TIPOPUNTO", "KIND", "CLASE", "CATEGORIA"]) ?? headers.find((h) => key(h).includes("SELECC") || key(h).includes("TIPO"));
  const pdvCol = column(rows, ["PDV", "NOMBRE", "CLIENTE", "PUNTO", "NAME", "DESCRIPCION", "ESTABLECIMIENTO"]) ?? headers.find((h) => key(h).includes("PDV") || key(h).includes("NOMBRE") || key(h).includes("CLIENTE"));
  const refIdCol = column(rows, ["REFID", "ID", "CODIGO", "COD", "REF", "PUNTOID"]) ?? headers.find((h) => key(h).includes("REF") || key(h).includes("ID") || key(h).includes("COD"));
  const avgCol = column(rows, ["PROMEDIOMETROS", "PROMEDIO", "AVGMETERS", "PROMETROS", "DISTANCIA"]) ?? headers.find((h) => key(h).includes("PROMEDIO") || key(h).includes("METROS"));
  const assignedMtCol = column(rows, ["MTASIGNADO", "ASSIGNEDMT"]);
  const countryCol = column(rows, ["PAIS", "COUNTRY"]);

  let validCoordinates = 0, swappedCoordinates = 0;
  const coordinates = rows.map((row) => {
    const lat = asNumber(row[latCol]), lng = asNumber(row[lngCol]);
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

    const rawSel = selCol ? norm(row[selCol]) : "T";
    const selection = rawSel || "T";
    const isSpare = selection.startsWith("S") || selection.includes("SUPLENTE") || selection.includes("SPARE");
    const kind: Point["kind"] = isSpare ? "Suplente" : "Titular";

    const refId = refIdCol ? String(row[refIdCol] ?? sourceIndex + 1) : String(sourceIndex + 1);
    const name = pdvCol ? String(row[pdvCol] ?? refId) : refId;
    const mt = mtCol ? String(row[mtCol] ?? "").trim() || "MT 1" : "MT 1";
    const assignedMt = assignedMtCol ? (String(row[assignedMtCol] ?? "").trim() || null) : null;
    let day = dayCol ? parseDayNumber(row[dayCol]) : null;
    if (day === null) {
      for (const [k, v] of Object.entries(row)) {
        if (key(k) === "DIA") {
          const parsed = parseDayNumber(v);
          if (parsed !== null && parsed > 0 && parsed <= 31) {
            day = parsed;
            break;
          }
        }
      }
    }
    const avgVal = avgCol ? asNumber(row[avgCol]) : null;

    points.push({
      id: `${refId}-${sourceIndex}`,
      sourceIndex,
      refId,
      name,
      mt,
      selection,
      kind,
      priorityRank: selectionPriority(selection, norm(countryCol ? row[countryCol] : "")),
      lat: likelySwapped ? lng : lat,
      lng: likelySwapped ? lat : lng,
      day,
      assignedMt,
      avgMeters: avgVal,
    });
  });

  refreshAverages(points);

  const hasSpares = points.some((p) => p.kind === "Suplente");
  const mode: PlanningMode = hasSpares ? "with-spares" : "titles-only";

  const derivedForecast: Forecast = {};
  points.forEach((point) => {
    const opMt = operationalMt(point);
    if (!opMt || !point.day) return;
    if (point.kind === "Titular" || mode === "titles-only") {
      derivedForecast[opMt] ??= {};
      derivedForecast[opMt][point.day] = (derivedForecast[opMt][point.day] ?? 0) + 1;
    }
  });
  points.forEach((point) => {
    const opMt = operationalMt(point);
    if (!opMt) return;
    derivedForecast[opMt] ??= {};
    if (point.day) {
      derivedForecast[opMt][point.day] ??= 0;
    }
  });

  return { points, forecast: derivedForecast, mode };
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

export function refineClusterDispersion(labels: number[], matrix: number[][], maxSwaps = 120) {
  const squaredMatrix = matrix.map((row) => row.map((distance) => distance * distance));
  return refineClusterSwaps(labels, squaredMatrix, maxSwaps);
}

function capacitatedClusters(points: Point[], capacities: number[], customMatrix?: number[][]) {
  if (!points.length) return [] as number[];
  if (capacities.length === 1) return Array(points.length).fill(0);
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
  refineClusterDispersion(labels, matrix, points.length > 300 ? 48 : 120);
  return labels;
}

type SequencedDayGroup = {
  day: number;
  points: Point[];
  medoid: { lat: number; lng: number };
};

const dayGroupMedoid = (points: Point[]) => {
  if (points.length === 1) return { lat: points[0].lat, lng: points[0].lng };
  let best = points[0], bestCost = Infinity;
  points.forEach((candidate) => {
    const cost = points.reduce((sum, other) => sum + meters(candidate, other), 0);
    if (cost < bestCost) { best = candidate; bestCost = cost; }
  });
  return { lat: best.lat, lng: best.lng };
};

export function sequenceDaysByProximity(points: Point[], forecast: Forecast, onlyMt?: string) {
  const byMt = new Map<string, Map<number, Point[]>>();
  points.forEach((point) => {
    if (point.kind !== "Titular" || !point.day) return;
    const mt = operationalMt(point);
    if (onlyMt && mt !== onlyMt) return;
    const daily = byMt.get(mt) ?? new Map<number, Point[]>(), group = daily.get(point.day) ?? [];
    group.push(point); daily.set(point.day, group); byMt.set(mt, daily);
  });
  let relabeledPoints = 0, reorderedGroups = 0, reorderedMts = 0, unresolvedDays = 0;
  const boundaryMoves = 0;
  byMt.forEach((daily, mt) => {
    const groups: SequencedDayGroup[] = [...daily.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([day, groupPoints]) => ({ day, points: groupPoints, medoid: dayGroupMedoid(groupPoints) }));
    if (groups.length < 2) return;
    const anchor = groups[0];
    const remaining = groups.slice(1);
    const ordered = [anchor];
    let previous = anchor;
    groups.slice(1).forEach((target) => {
      const expected = forecast[mt]?.[target.day] ?? target.points.length;
      const exact = remaining.filter((candidate) => candidate.points.length === expected);
      const withinTolerance = remaining.filter((candidate) => Math.abs(candidate.points.length - expected) <= DAY_FORECAST_TOLERANCE);
      const candidates = exact.length ? exact : withinTolerance.length ? withinTolerance : remaining;
      const source = [...candidates].sort((a, b) => {
        const sizeDelta = Math.abs(a.points.length - expected) - Math.abs(b.points.length - expected);
        return sizeDelta || meters(previous.medoid, a.medoid) - meters(previous.medoid, b.medoid) || a.day - b.day;
      })[0];
      ordered.push(source);
      remaining.splice(remaining.indexOf(source), 1);
      previous = source;
    });
    ordered.forEach((source, index) => {
      const target = groups[index], expected = forecast[mt]?.[target.day] ?? target.points.length;
      if (source.day !== target.day) reorderedGroups++;
      if (Math.abs(source.points.length - expected) > DAY_FORECAST_TOLERANCE) unresolvedDays++;
      source.points.forEach((point) => {
        if (point.day !== target.day) relabeledPoints++;
        point.day = target.day;
      });
    });
    if (ordered.some((group, index) => group.day !== groups[index].day)) reorderedMts++;
  });
  return { relabeledPoints, boundaryMoves, reorderedGroups, reorderedMts, unresolvedDays };
}

const pairCount = (size: number) => size > 1 ? (size * (size - 1)) / 2 : 0;
const normalizedDispersion = (sumSquaredDistances: number, size: number) => {
  const pairs = pairCount(size);
  return pairs ? sumSquaredDistances / pairs : 0;
};

export function improveDayGroupsWithinForecastTolerance(points: Point[], forecast: Forecast, onlyMt?: string) {
  const byMt = new Map<string, Point[]>();
  points.forEach((point) => {
    if (point.kind !== "Titular" || !point.day) return;
    const mt = operationalMt(point);
    if (onlyMt && mt !== onlyMt) return;
    const group = byMt.get(mt) ?? [];
    group.push(point); byMt.set(mt, group);
  });
  const movedIds = new Set<string>();
  let improvedMts = 0;
  byMt.forEach((mtPoints, mt) => {
    const days = [...new Set(mtPoints.map((point) => point.day!))].sort((a, b) => a - b);
    if (days.length < 2) return;
    const matrix = pointDistanceMatrix(mtPoints).map((row) => row.map((distance) => distance * distance));
    const members = days.map((day) => mtPoints.map((point, index) => point.day === day ? index : -1).filter((index) => index >= 0));
    const expected = days.map((day, index) => forecast[mt]?.[day] ?? members[index].length);
    const lower = expected.map((count) => Math.max(0, count - DAY_FORECAST_TOLERANCE));
    const upper = expected.map((count) => count + DAY_FORECAST_TOLERANCE);
    const sums = members.map((indices) => {
      let sum = 0;
      for (let a = 0; a < indices.length; a++) for (let b = a + 1; b < indices.length; b++) sum += matrix[indices[a]][indices[b]];
      return sum;
    });
    const diameters = members.map((indices) => {
      let diameter = 0;
      for (let a = 0; a < indices.length; a++) for (let b = a + 1; b < indices.length; b++) diameter = Math.max(diameter, matrix[indices[a]][indices[b]]);
      return diameter;
    });
    const movedInMt = new Set<number>();
    const maxMoves = days.length * DAY_FORECAST_TOLERANCE * 2;
    while (movedInMt.size < maxMoves) {
      let bestPoint = -1, bestSource = -1, bestDestination = -1, bestDelta = -1;
      for (let source = 0; source < days.length; source++) {
        const sourceSize = members[source].length;
        if (sourceSize <= lower[source] || sourceSize <= 2) continue;
        for (const pointIndex of members[source]) {
          if (movedInMt.has(pointIndex)) continue;
          const removed = members[source].reduce((sum, other) => sum + (other === pointIndex ? 0 : matrix[pointIndex][other]), 0);
          const sourceAfter = normalizedDispersion(sums[source] - removed, sourceSize - 1);
          for (let destination = 0; destination < days.length; destination++) {
            if (destination === source || members[destination].length >= upper[destination] || members[destination].length < 2) continue;
            const destinationSize = members[destination].length;
            const added = members[destination].reduce((sum, other) => sum + matrix[pointIndex][other], 0);
            const sourceBefore = normalizedDispersion(sums[source], sourceSize);
            const destinationBefore = normalizedDispersion(sums[destination], destinationSize);
            const destinationAfter = normalizedDispersion(sums[destination] + added, destinationSize + 1);
            if (sourceAfter > sourceBefore + 1 || destinationAfter > destinationBefore + 1) continue;
            const destinationDiameterAfter = members[destination].reduce((diameter, other) => Math.max(diameter, matrix[pointIndex][other]), diameters[destination]);
            if (destinationDiameterAfter > diameters[destination] + 1) continue;
            const before = sourceBefore + destinationBefore;
            const after = sourceAfter + destinationAfter;
            const delta = after - before;
            const tie = `${days[source]}:${days[destination]}:${mtPoints[pointIndex].id}`;
            const bestTie = bestPoint < 0 ? "" : `${days[bestSource]}:${days[bestDestination]}:${mtPoints[bestPoint].id}`;
            if (delta < bestDelta || (delta === bestDelta && tie < bestTie)) {
              bestPoint = pointIndex; bestSource = source; bestDestination = destination; bestDelta = delta;
            }
          }
        }
      }
      if (bestPoint < 0) break;
      const sourcePosition = members[bestSource].indexOf(bestPoint);
      const removed = members[bestSource].reduce((sum, other) => sum + (other === bestPoint ? 0 : matrix[bestPoint][other]), 0);
      const added = members[bestDestination].reduce((sum, other) => sum + matrix[bestPoint][other], 0);
      members[bestSource].splice(sourcePosition, 1);
      members[bestDestination].push(bestPoint);
      sums[bestSource] -= removed;
      sums[bestDestination] += added;
      diameters[bestSource] = members[bestSource].reduce((diameter, left, leftIndex) => {
        for (let rightIndex = leftIndex + 1; rightIndex < members[bestSource].length; rightIndex++) diameter = Math.max(diameter, matrix[left][members[bestSource][rightIndex]]);
        return diameter;
      }, 0);
      mtPoints[bestPoint].day = days[bestDestination];
      movedInMt.add(bestPoint);
      movedIds.add(mtPoints[bestPoint].id);
    }
    if (movedInMt.size) improvedMts++;
  });
  return { movedPoints: movedIds.size, improvedMts };
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

export function finalizeAssignment(points: Point[], forecast: Forecast, mode: PlanningMode, onlyMt?: string) {
  const next = points.map((point) => ({ ...point }));
  const notices: Notice[] = [];
  const sequencing = sequenceDaysByProximity(next, forecast, onlyMt);
  const flexibility = improveDayGroupsWithinForecastTolerance(next, forecast, onlyMt);
  if (sequencing.reorderedGroups) notices.push({
    type: "info",
    text: `Secuencia geográfica final: se renumeraron ${sequencing.reorderedGroups} grupos completos en ${sequencing.reorderedMts} MT FINAL, sin separar puntos de su grupo. Se priorizaron grupos con la cantidad exacta del forecast y solo se admite una diferencia de ±${DAY_FORECAST_TOLERANCE} cuando la base ya llega desbalanceada.`,
  });
  if (sequencing.unresolvedDays) notices.push({ type: "warn", text: `${sequencing.unresolvedDays} jornada${sequencing.unresolvedDays === 1 ? "" : "s"} no pudieron quedar dentro de la tolerancia ±${DAY_FORECAST_TOLERANCE} por falta de puntos compatibles.` });
  if (flexibility.movedPoints) notices.push({
    type: "info",
    text: `Flexibilidad del forecast: ${flexibility.movedPoints} titular${flexibility.movedPoints === 1 ? "" : "es"} fronterizo${flexibility.movedPoints === 1 ? "" : "s"} cambiaron de día en ${flexibility.improvedMts} MT FINAL porque redujeron la dispersión. ${sequencing.unresolvedDays ? `Cada cambio respetó el rango permitido de ±${DAY_FORECAST_TOLERANCE} puntos; las jornadas ya desbalanceadas se reportan por separado.` : `Todas las jornadas se mantienen dentro de ±${DAY_FORECAST_TOLERANCE} puntos.`}`,
  });
  if (mode === "with-spares") allocateSpares(next, forecast, notices);
  else if (!onlyMt) notices.unshift({ type: "info", text: "Modo solo titulares detectado: no se aplicó la relación 1:3; se usó el forecast por MT FINAL y día. La flexibilidad final de ±2 solo se consume cuando reduce la dispersión, y los titulares excedentes quedan sin día." });
  return { points: refreshAverages(next), notices };
}

export function assign(points: Point[], forecast: Forecast, detectedMode?: PlanningMode, options: { finalize?: boolean } = {}) {
  const next = points.map((point) => ({ ...point, day: null, assignedMt: null, avgMeters: null }));
  const notices: Notice[] = [];
  const mode: PlanningMode = detectedMode ?? (next.some((point) => point.kind === "Suplente") ? "with-spares" : "titles-only");
  const byMt = new Map<string, Point[]>();
  next.forEach((point) => { const list = byMt.get(point.mt) ?? []; list.push(point); byMt.set(point.mt, list); });
  Object.entries(forecast).forEach(([mt, daily]) => {
    const all = byMt.get(mt) ?? [], titles = all.filter((point) => point.kind === "Titular");
    const days = Object.entries(daily).map(([day, count]) => ({ day: Number(day), count })).sort((a, b) => a.day - b.day);
    const needed = days.reduce((sum, plan) => sum + plan.count, 0);
    if (!all.length) { notices.push({ type: "warn", text: `${mt}: no hay puntos con coordenadas en la base.` }); return; }
    if (titles.length < needed) notices.push({ type: "warn", text: `${mt}: el forecast pide ${needed} titulares y la base tiene ${titles.length}. Se asignaron todos los disponibles.` });
    const selectedTitles = denseSubset(titles, Math.min(needed, titles.length));
    let remaining = selectedTitles.length;
    const effectiveDays = days.map((plan) => { const count = Math.min(plan.count, remaining); remaining -= count; return { ...plan, count }; }).filter((plan) => plan.count > 0);
    const labels = capacitatedClusters(selectedTitles, effectiveDays.map((plan) => plan.count));
    selectedTitles.forEach((point, index) => { point.day = effectiveDays[labels[index]]?.day ?? null; point.assignedMt = point.day ? mt : null; });
  });
  if (options.finalize === false) return { points: next, notices, mode };
  const finalized = finalizeAssignment(next, forecast, mode);
  return { points: finalized.points, notices: [...finalized.notices, ...notices], mode };
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

export async function runSmartRoadQa(points: Point[], onProgress?: (text: string) => void) {
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
  const notices: Notice[] = [{
    type: "info",
    text: changedPoints
      ? `QA vial automático: ${reviewed} cruces revisados en ${new Set(candidates.map((candidate) => candidate.mt)).size} MT; ${changedPoints} titular${changedPoints === 1 ? "" : "es"} cambiaron de día mediante ${swaps} intercambio${swaps === 1 ? "" : "s"}. Mejora media acumulada: ${(savedSeconds / Math.max(improvedPairs, 1) / 60).toFixed(1)} minutos por cruce corregido.`
      : `QA vial automático: ${reviewed} cruces sospechosos fueron revisados y la asignación ya era estable según los tiempos de conducción.`,
  }];
  if (failed) notices.push({ type: "info", text: `${failed} validaciones viales no pudieron consultarse; esos grupos conservaron su asignación original.` });
  return { points: next, notices };
}

export async function runRoadQa(points: Point[], mt: string) {
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
  const notices: Notice[] = [{ type: "info", text: swaps ? `QA vial de ${mt}: ${changedPoints} titulares cambiaron de día mediante ${swaps} intercambios. El tiempo medio interno bajó de ${(beforeSeconds / 60).toFixed(1)} a ${(afterSeconds / 60).toFixed(1)} minutos.` : `QA vial de ${mt}: la distribución ya era estable según los tiempos de conducción; no se necesitaron intercambios.` }];
  return { points: next, notices };
}
