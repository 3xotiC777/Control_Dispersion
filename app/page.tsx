"use client";

import dynamic from "next/dynamic";
import * as XLSX from "xlsx";
import { ChangeEvent, useMemo, useState } from "react";
import { CalendarDays, Check, ChevronDown, CircleGauge, Database, Download, Layers3, LineChart, LoaderCircle, MapPinned, Route, Search, ShieldCheck, SlidersHorizontal, Sparkles, Tags, UploadCloud, UserRound, X } from "lucide-react";

const GeoMap = dynamic(() => import("./GeoMap"), { ssr: false });

type Raw = Record<string, unknown>;
type Point = {
  id: string;
  refId: string;
  name: string;
  row: Raw;
  mt: string;
  selection: string;
  kind: "Titular" | "Suplente" | "Otro";
  lat: number;
  lng: number;
  day: number | null;
  assignedMt: string | null;
  avgMeters: number | null;
};
type Forecast = Record<string, Record<number, number>>;
type Notice = { type: "info" | "warn"; text: string };

const COLORS = ["#0b7285", "#7c3aed", "#e8590c", "#2f9e44", "#c2255c", "#1971c2", "#a61e4d", "#5f3dc4", "#087f5b", "#9c36b5"];
const MAX_SUPPLEMENT_DISTANCE_METERS = 15000;
const norm = (value: unknown) => String(value ?? "").trim().toUpperCase().replace(/\s+/g, " ");
const key = (value: unknown) => norm(value).replace(/[^A-Z0-9]/g, "");
const asNumber = (value: unknown) => {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const rad = (n: number) => (n * Math.PI) / 180;
const meters = (a: Pick<Point, "lat" | "lng">, b: Pick<Point, "lat" | "lng">) => {
  const R = 6371000;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const nearestAverage = (point: Point, peers: Point[]) => {
  const other = peers.filter((p) => p.id !== point.id);
  if (!other.length) return 0;
  return other.reduce((s, p) => s + meters(point, p), 0) / other.length;
};
const pointDistanceMatrix = (points: Point[]) => points.map((point) => points.map((other) => meters(point, other)));

function denseSubset(points: Point[], target: number) {
  if (points.length <= target) return [...points];
  const matrix = pointDistanceMatrix(points);
  const neighbors = Math.min(6, points.length - 1);
  return points.map((point, index) => ({ point, score: matrix[index].filter((_, other) => other !== index).sort((a, b) => a - b).slice(0, neighbors).reduce((sum, distance) => sum + distance, 0) }))
    .sort((a, b) => a.score - b.score).slice(0, target).map(({ point }) => point);
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
  const labels = Array(matrix.length).fill(-1);
  const remaining = [...capacities];
  const unassigned = new Set(matrix.map((_, index) => index));
  while (unassigned.size) {
    let chosenPoint = -1, chosenCluster = -1, chosenRegret = -Infinity, chosenCost = Infinity;
    for (const point of unassigned) {
      const options = medoids.map((medoid, cluster) => ({ cluster, cost: matrix[point][medoid] })).filter(({ cluster }) => remaining[cluster] > 0).sort((a, b) => a.cost - b.cost);
      if (!options.length) break;
      const regret = options.length === 1 ? Number.MAX_SAFE_INTEGER : options[1].cost - options[0].cost;
      if (regret > chosenRegret || (regret === chosenRegret && options[0].cost < chosenCost)) {
        chosenPoint = point; chosenCluster = options[0].cluster; chosenRegret = regret; chosenCost = options[0].cost;
      }
    }
    if (chosenPoint < 0) break;
    labels[chosenPoint] = chosenCluster;
    remaining[chosenCluster]--;
    unassigned.delete(chosenPoint);
  }
  return labels;
}

function refineClusterSwaps(labels: number[], matrix: number[][], maxSwaps = 120) {
  let swaps = 0;
  const clusterCount = Math.max(...labels) + 1;
  while (swaps < maxSwaps) {
    const sums = matrix.map((row) => Array.from({ length: clusterCount }, (_, cluster) => row.reduce((sum, value, point) => sum + (labels[point] === cluster ? value : 0), 0)));
    let bestA = -1, bestB = -1, bestDelta = -0.001;
    for (let a = 0; a < labels.length; a++) for (let b = a + 1; b < labels.length; b++) {
      const clusterA = labels[a], clusterB = labels[b];
      if (clusterA === clusterB) continue;
      const delta = (sums[b][clusterA] - matrix[b][a] - sums[a][clusterA]) + (sums[a][clusterB] - matrix[a][b] - sums[b][clusterB]);
      if (delta < bestDelta) { bestDelta = delta; bestA = a; bestB = b; }
    }
    if (bestA < 0) break;
    [labels[bestA], labels[bestB]] = [labels[bestB], labels[bestA]];
    swaps++;
  }
  return swaps;
}

function capacitatedClusters(points: Point[], capacities: number[], customMatrix?: number[][]) {
  if (!points.length) return [];
  if (capacities.length === 1) return Array(points.length).fill(0);
  const matrix = customMatrix ?? pointDistanceMatrix(points);
  let medoids = initialMedoids(matrix, capacities.length);
  let labels = exactCapacityAssignment(matrix, medoids, capacities);
  for (let iteration = 0; iteration < 12; iteration++) {
    const nextMedoids = medoids.map((medoid, cluster) => {
      const members = labels.map((label, point) => label === cluster ? point : -1).filter((point) => point >= 0);
      return members.reduce((best, candidate) => members.reduce((sum, other) => sum + matrix[candidate][other], 0) < members.reduce((sum, other) => sum + matrix[best][other], 0) ? candidate : best, members[0] ?? medoid);
    });
    if (nextMedoids.every((medoid, index) => medoid === medoids[index])) break;
    medoids = nextMedoids;
    labels = exactCapacityAssignment(matrix, medoids, capacities);
  }
  refineClusterSwaps(labels, matrix);
  return labels;
}

function withinClusterMean(labels: number[], matrix: number[][]) {
  let total = 0, pairs = 0;
  for (let a = 0; a < labels.length; a++) for (let b = a + 1; b < labels.length; b++) if (labels[a] === labels[b]) { total += matrix[a][b]; pairs++; }
  return pairs ? total / pairs : 0;
}

async function roadTimeMatrix(points: Point[]) {
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
const column = (rows: Raw[], names: string[]) => {
  const headers = Object.keys(rows[0] ?? {});
  return headers.find((h) => names.includes(key(h)));
};
const operationalMt = (point: Point) => point.assignedMt ?? point.mt;

function baseColumns(rows: Raw[]) {
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

function forecastMtColumn(rows: Raw[]) {
  if (!rows.length) throw new Error("El forecast no contiene registros.");
  const mt = column(rows, ["MTFINAL"]);
  if (!mt) throw new Error("No se encontró la columna \"MT FINAL\" en el forecast.");
  const days = Object.keys(rows[0]).filter((header) => Number.isInteger(Number(header)) && Number(header) > 0);
  if (!days.length) throw new Error("No se encontraron columnas de días numéricos en el forecast.");
  return mt;
}

function extractPoints(rows: Raw[]): Point[] {
  const fields = baseColumns(rows);
  const provisional = rows.map((row, index) => ({ row, index, lat: asNumber(row[fields.latitude]), lng: asNumber(row[fields.longitude]) }));
  const likelySwapped = provisional.filter((p) => p.lat !== null && p.lng !== null).filter((p) => Math.abs(p.lat!) > 60 && Math.abs(p.lng!) < 60).length > provisional.length * 0.55;
  return provisional.flatMap(({ row, index, lat, lng }) => {
    if (lat === null || lng === null) return [];
    const selection = norm(row[fields.selection]);
    const refId = String(row[fields.refId] ?? index + 1);
    const kind: Point["kind"] = selection === "T" || selection === "T PANEL" ? "Titular" : selection.startsWith("S") ? "Suplente" : "Otro";
    return [{ id: refId + "-" + index, refId, name: String(row[fields.pdv] ?? refId), row, mt: String(row[fields.mt] ?? "").trim(), selection, kind,
      lat: likelySwapped ? lng : lat, lng: likelySwapped ? lat : lng, day: null, assignedMt: null, avgMeters: null }];
  });
}

function extractForecast(rows: Raw[]) {
  const mtCol = forecastMtColumn(rows);
  const result: Forecast = {};
  rows.forEach((row) => {
    const mt = String(row[mtCol] ?? "").trim();
    if (!mt) return;
    Object.entries(row).forEach(([header, value]) => {
      const day = Number(header);
      const count = asNumber(value);
      if (Number.isInteger(day) && day > 0 && count && count > 0) (result[mt] ??= {})[day] = Math.round(count);
    });
  });
  return result;
}

function priority(point: Point) {
  const country = norm(point.row["Pais"] ?? point.row["PAIS"] ?? point.row["País"]);
  const dominican = country.includes("DOMINICAN") || country.includes("DOMINICANA");
  const order = dominican ? ["S PANEL", "S1", "S2", "S3", "S4", "S ON", "S ORO"] : ["S1", "S2", "S3", "S4"];
  const exact = order.indexOf(point.selection);
  return exact < 0 ? 99 : exact;
}

function refreshAverages(points: Point[]) {
  return points.map((point) => {
    if (!point.day) return { ...point, avgMeters: null };
    const assignedMt = point.assignedMt ?? point.mt;
    const titles = points.filter((p) => (p.assignedMt ?? p.mt) === assignedMt && p.day === point.day && p.kind === "Titular");
    const avgMeters = point.kind === "Titular"
      ? nearestAverage(point, titles)
      : titles.length ? Math.min(...titles.map((t) => meters(point, t))) : null;
    return { ...point, avgMeters };
  });
}

function allocateSpares(next: Point[], forecast: Forecast, notices: Notice[]) {
  next.filter((point) => point.kind === "Suplente").forEach((point) => { point.day = null; point.assignedMt = null; point.avgMeters = null; });
  const groups = Object.entries(forecast).flatMap(([mt, daily]) => Object.keys(daily).map(Number).flatMap((day) => {
    const titulars = next.filter((point) => point.kind === "Titular" && point.assignedMt === mt && point.day === day);
    return titulars.length ? [{ mt, day, titulars, desired: titulars.length * 3, assigned: [] as Point[], hasNearby: false }] : [];
  }));
  const edges = next.filter((point) => point.kind === "Suplente").flatMap((point) => groups.flatMap((group) => {
    const distance = Math.min(...group.titulars.map((title) => meters(point, title)));
    if (distance <= MAX_SUPPLEMENT_DISTANCE_METERS) { group.hasNearby = true; return [{ point, group, distance }]; }
    return [];
  })).sort((a, b) => priority(a.point) - priority(b.point) || a.distance - b.distance);
  const usedSpares = new Set<string>();
  edges.forEach(({ point, group }) => {
    if (usedSpares.has(point.id) || group.assigned.length >= group.desired) return;
    point.day = group.day;
    point.assignedMt = group.mt;
    group.assigned.push(point);
    usedSpares.add(point.id);
  });
  const allSpares = next.filter((point) => point.kind === "Suplente");
  groups.filter((group) => !group.hasNearby && group.assigned.length < group.desired).forEach((group) => {
    const fallback = allSpares.filter((point) => !usedSpares.has(point.id)).map((point) => ({ point, distance: Math.min(...group.titulars.map((title) => meters(point, title))) }))
      .sort((a, b) => a.distance - b.distance || priority(a.point) - priority(b.point)).slice(0, group.desired - group.assigned.length);
    fallback.forEach(({ point }) => { point.day = group.day; point.assignedMt = group.mt; group.assigned.push(point); usedSpares.add(point.id); });
    if (fallback.length) notices.push({ type: "info", text: `${group.mt}, día ${group.day}: no había suplentes a 15 km; se asignaron los ${fallback.length} más cercanos disponibles.` });
  });
  groups.forEach((group) => {
    if (group.assigned.length < group.desired) notices.push({ type: "warn", text: `${group.mt}, día ${group.day}: ${group.assigned.length}/${group.desired} suplentes disponibles.` });
  });
}

function assign(points: Point[], forecast: Forecast) {
  const next = points.map((p) => ({ ...p, day: null, assignedMt: null, avgMeters: null }));
  const notices: Notice[] = [];
  Object.entries(forecast).forEach(([mt, daily]) => {
    const all = next.filter((p) => p.mt === mt);
    const titles = all.filter((p) => p.kind === "Titular");
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

  // Titulares se conservan en su MT FINAL. Los suplentes se asignan después usando el universo global.
  allocateSpares(next, forecast, notices);
  return { points: refreshAverages(next), notices };
}

function readFile(file: File) {
  return file.arrayBuffer().then((b) => {
    const workbook = XLSX.read(b, { type: "array" });
    return XLSX.utils.sheet_to_json<Raw>(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
  });
}

export default function Home() {
  const [base, setBase] = useState<Raw[] | null>(null);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [mt, setMt] = useState("all");
  const [mtSearch, setMtSearch] = useState("");
  const [selectedDays, setSelectedDays] = useState<number[]>([]);
  const [openFilter, setOpenFilter] = useState<"mt" | "days" | null>(null);
  const [kind, setKind] = useState("all"); const [selectionFilter, setSelectionFilter] = useState("all");
  const [planningVersion, setPlanningVersion] = useState(0);
  const [selected, setSelected] = useState<Point | null>(null);
  const [error, setError] = useState("");
  const [qaRunning, setQaRunning] = useState(false);
  const handleFile = async (event: ChangeEvent<HTMLInputElement>, type: "base" | "forecast") => {
    const file = event.target.files?.[0]; if (!file) return;
    try { const rows = await readFile(file); if (type === "base") { baseColumns(rows); setBase(rows); } else setForecast(extractForecast(rows)); setError(""); }
    catch (e) { if (type === "base") setBase(null); else setForecast(null); setPoints([]); setNotices([]); setError(e instanceof Error ? e.message : "No se pudo leer el archivo."); }
  };
  const calculate = () => { try { if (!base || !forecast) throw new Error("Carga la base de puntos y el forecast antes de calcular."); const result = assign(extractPoints(base), forecast); setPoints(result.points); setNotices(result.notices); setSelected(null); setPlanningVersion((version) => version + 1); } catch (e) { setError(e instanceof Error ? e.message : "No fue posible calcular la asignación."); } };
  const mts = useMemo(() => Object.keys(forecast ?? {}).sort(), [forecast]);
  const selectionOptions = useMemo(() => {
    const order = ["T", "T PANEL", "S PANEL", "S1", "S2", "S3", "S4", "S ON", "S ORO"];
    return [...new Set(points.map((point) => point.selection))].sort((a, b) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)) || a.localeCompare(b));
  }, [points]);
  const availableDays = useMemo(() => mt === "all"
    ? [...new Set(points.flatMap((p) => p.day ? [p.day] : []))].sort((a, b) => a - b)
    : Object.keys(forecast?.[mt] ?? {}).map(Number).sort((a, b) => a - b), [points, forecast, mt]);
  const filtered = useMemo(() => points.filter((p) => (mt === "all" || operationalMt(p) === mt) && (!selectedDays.length || (p.day !== null && selectedDays.includes(p.day))) && (kind === "all" || p.kind === kind) && (selectionFilter === "all" || p.selection === selectionFilter)), [points, mt, selectedDays, kind, selectionFilter]);
  const selectMt = (nextMt: string) => {
    setMt(nextMt);
    setMtSearch(nextMt === "all" ? "" : nextMt);
    if (nextMt !== "all") setSelectedDays((previous) => previous.filter((currentDay) => Boolean(forecast?.[nextMt]?.[currentDay])));
    setOpenFilter(null);
  };
  const toggleDay = (currentDay: number) => setSelectedDays((previous) => previous.includes(currentDay)
    ? previous.filter((value) => value !== currentDay)
    : [...previous, currentDay].sort((a, b) => a - b));
  const matchingMts = useMemo(() => {
    const query = mtSearch.trim().toLocaleLowerCase();
    return query ? mts.filter((candidate) => candidate.toLocaleLowerCase().includes(query)) : mts;
  }, [mts, mtSearch]);
  const summary = useMemo(() => {
    const assigned = filtered.filter((p) => p.day);
    const tit = assigned.filter((p) => p.kind === "Titular"), sup = assigned.filter((p) => p.kind === "Suplente");
    const avg = (list: Point[]) => list.length ? list.reduce((s, p) => s + (p.avgMeters ?? 0), 0) / list.length : 0;
    return { assigned: assigned.length, tit: tit.length, sup: sup.length, tAvg: avg(tit), sAvg: avg(sup) };
  }, [filtered]);
  const moveSelected = (newDay: number | null) => { if (!selected) return; setPoints((previous) => refreshAverages(previous.map((p) => p.id === selected.id ? { ...p, day: newDay } : p))); setSelected((p) => p ? { ...p, day: newDay } : p); setNotices([{ type: "info", text: "Cambio manual aplicado. Revisa el indicador de forecast antes de exportar." }]); };
  const download = () => {
    if (!base || !points.length) return;
    const lookup = new Map(points.map((p) => [p.refId, p]));
    const refIdHeader = column(base, ["REFID"]);
    const mtHeader = Object.keys(base[0] ?? {}).find((header) => key(header) === "MTFINAL");
    const rows = base.map((row, i) => { const ref = String(row[refIdHeader ?? "RefID"] ?? i + 1), p = lookup.get(ref); return { ...row, ...(p?.assignedMt && mtHeader ? { [mtHeader]: p.assignedMt } : {}), DIA: p?.day ?? "", "Promedio metros": p?.avgMeters == null ? "" : Math.round(p.avgMeters) }; });
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Asignación"); XLSX.writeFile(wb, "BD_PUNTOS_ASIGNADOS.xlsx");
  };
  const runRoadQA = async () => {
    if (!forecast || mt === "all") { setError("Selecciona un MT FINAL específico antes de ejecutar el QA vial."); return; }
    const titles = points.filter((point) => operationalMt(point) === mt && point.kind === "Titular" && point.day);
    if (titles.length < 2) { setError(`${mt}: no hay suficientes titulares asignados para ejecutar el QA vial.`); return; }
    setQaRunning(true); setError("");
    try {
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
      const qaNotices: Notice[] = [];
      allocateSpares(next, forecast, qaNotices);
      qaNotices.unshift({ type: "info", text: swaps ? `QA vial de ${mt}: ${changedPoints} titulares cambiaron de día mediante ${swaps} intercambios. El tiempo medio interno bajó de ${(beforeSeconds / 60).toFixed(1)} a ${(afterSeconds / 60).toFixed(1)} minutos.` : `QA vial de ${mt}: la distribución ya era estable según los tiempos de conducción; no se necesitaron intercambios.` });
      setPoints(refreshAverages(next)); setNotices(qaNotices); setSelected(null); setPlanningVersion((version) => version + 1);
    } catch (exception) {
      setError(`QA vial no aplicado: ${exception instanceof Error ? exception.message : "no fue posible consultar la red de carreteras"} No se modificó la planificación.`);
    } finally { setQaRunning(false); }
  };
  return <main className="app-shell"><div className="page-container">
    <header className="site-header animate-fade-up"><span className="brand-pill"><Layers3 size={14} /> Base de puntos + Forecast</span><h1><span>Ruta Compacta</span> para operación de campo</h1><p>Planifica titulares por cercanía, completa cada jornada con suplentes priorizados y controla el cumplimiento del forecast.</p></header>
    <section className="upload-grid animate-fade-up">
      <label className={base ? "file-card loaded" : "file-card"}><div className="file-card-top"><i><Database size={21} /></i>{base && <span className="ready-badge"><Check size={13} /> Listo</span>}</div><strong>Base de puntos</strong><p>{base ? `${base.length.toLocaleString()} registros cargados` : "Arrastra o haz clic para subir tu Excel"}</p><small>MT FINAL · SELECCIÓN · LATITUD · LONGITUD</small><input type="file" accept=".xlsx,.xls" onChange={(e) => handleFile(e, "base")} /></label>
      <label className={forecast ? "file-card loaded" : "file-card"}><div className="file-card-top"><i><LineChart size={21} /></i>{forecast && <span className="ready-badge"><Check size={13} /> Listo</span>}</div><strong>Forecast mensual</strong><p>{forecast ? `${Object.keys(forecast).length} MT finales cargados` : "Arrastra o haz clic para subir tu Excel"}</p><small>MT FINAL en filas · días en columnas</small><input type="file" accept=".xlsx,.xls" onChange={(e) => handleFile(e, "forecast")} /></label>
      <button className="calculate" onClick={calculate} disabled={!base || !forecast}><UploadCloud size={18} /> Calcular planificación</button>
    </section>
    {error && <p className="message error">{error}</p>}
    {!!points.length && <div className="results animate-fade-up">
      <div className="results-heading"><div><span className="section-kicker"><Sparkles size={14} /> PLANIFICACIÓN CALCULADA</span><h2>Resumen de la operación</h2><p>{filtered.length.toLocaleString()} puntos visibles de {points.length.toLocaleString()} procesados</p></div><div className="result-actions"><button className="qa-road" onClick={runRoadQA} disabled={qaRunning || mt === "all"} title={mt === "all" ? "Selecciona un MT FINAL para ejecutar el QA vial" : `Optimizar ${mt} con tiempos de conducción`}>{qaRunning ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />} {qaRunning ? "Consultando carreteras…" : "QA vial"}</button><button className="download" onClick={download}><Download size={16} /> Descargar Excel</button></div></div>
      <section className="metrics"><article><i><Route size={20} /></i><div><span>Puntos asignados</span><strong>{summary.assigned}</strong><small>{summary.tit} titulares · {summary.sup} suplentes</small></div></article><article><i><CircleGauge size={20} /></i><div><span>Promedio titulares</span><strong>{Math.round(summary.tAvg).toLocaleString()} m</strong><small>entre titulares del mismo día</small></div></article><article className="accent"><i><MapPinned size={20} /></i><div><span>Promedio suplentes</span><strong>{Math.round(summary.sAvg).toLocaleString()} m</strong><small>al titular más cercano</small></div></article></section>
      <section className="toolbar"><div className="filters">
        <div className="filter-dropdown"><span><UserRound size={14} /> MT FINAL</span><button type="button" className="dropdown-trigger" aria-expanded={openFilter === "mt"} onClick={() => setOpenFilter((current) => current === "mt" ? null : "mt")}><b>{mt === "all" ? "Todos los MT" : mt}</b><ChevronDown size={16} /></button>{openFilter === "mt" && <div className="dropdown-menu mt-menu"><div className="dropdown-search"><Search size={16} /><input value={mtSearch} onChange={(e) => setMtSearch(e.target.value)} placeholder="Buscar MT FINAL" aria-label="Buscar MT FINAL" /></div><div className="dropdown-options"><label><input type="checkbox" checked={mt === "all"} onChange={() => selectMt("all")} /><span>Todos los MT</span></label>{matchingMts.map((option) => <label key={option}><input type="checkbox" checked={mt === option} onChange={() => selectMt(option)} /><span>{option}</span></label>)}{!matchingMts.length && <p className="empty-options">No hay coincidencias</p>}</div></div>}</div>
        <div className="filter-dropdown"><span><CalendarDays size={14} /> Días</span><button type="button" className="dropdown-trigger" aria-expanded={openFilter === "days"} onClick={() => setOpenFilter((current) => current === "days" ? null : "days")}><b>{selectedDays.length ? `${selectedDays.length} día${selectedDays.length === 1 ? "" : "s"} seleccionados` : "Todos los días"}</b><ChevronDown size={16} /></button>{openFilter === "days" && <div className="dropdown-menu days-menu"><div className="dropdown-options"><label><input type="checkbox" checked={!selectedDays.length} onChange={() => setSelectedDays([])} /><span>Todos los días</span></label>{availableDays.map((option) => <label key={option}><input type="checkbox" checked={selectedDays.includes(option)} onChange={() => toggleDay(option)} /><span>Día {option}</span></label>)}</div></div>}</div>
        <label><span><SlidersHorizontal size={14} /> Tipo de punto</span><select value={kind} onChange={(e) => setKind(e.target.value)}><option value="all">Titulares y suplentes</option><option value="Titular">Solo titulares</option><option value="Suplente">Solo suplentes</option></select></label><label><span><Tags size={14} /> Selección exacta</span><select value={selectionFilter} onChange={(e) => setSelectionFilter(e.target.value)}><option value="all">Todas las selecciones</option>{selectionOptions.map((selection) => <option key={selection} value={selection}>{selection}</option>)}</select></label></div>
      </section>
      <section className="map-section"><div className="map-heading"><div><span className="section-kicker"><MapPinned size={14} /> MAPA DE PLANIFICACIÓN</span><h2>{mt === "all" ? "Todos los MT" : mt}</h2></div><div className="map-key"><p><i className="dot title" /> Titular <i className="dot spare" /> Suplente</p><div className="day-legend">{availableDays.map((currentDay) => <span key={currentDay}><i style={{ backgroundColor: COLORS[(currentDay - 1) % COLORS.length] }} />Día {currentDay}</span>)}</div><small>El color identifica el día. Selecciona un punto para moverlo.</small></div></div><GeoMap points={filtered} colors={COLORS} planningVersion={planningVersion} onSelect={setSelected} /></section>
      <section className="day-table"><div className="table-heading"><span className="section-kicker"><Layers3 size={14} /> CONTROL POR JORNADA</span><h2>Distancias y cumplimiento</h2></div><table><thead><tr><th>MT FINAL</th><th>Día</th><th>Titulares</th><th>Suplentes</th><th>Prom. titulares</th><th>Prom. suplentes</th></tr></thead><tbody>{Object.entries(forecast ?? {}).filter(([m]) => mt === "all" || m === mt).flatMap(([m, d]) => Object.keys(d).map(Number).filter((currentDay) => !selectedDays.length || selectedDays.includes(currentDay)).map((currentDay) => { const group = points.filter((p) => operationalMt(p) === m && p.day === currentDay && (kind === "all" || p.kind === kind) && (selectionFilter === "all" || p.selection === selectionFilter)), ts = group.filter((p) => p.kind === "Titular"), ss = group.filter((p) => p.kind === "Suplente"); const a=(x:Point[])=>x.length?Math.round(x.reduce((s,p)=>s+(p.avgMeters??0),0)/x.length):0; return <tr key={`${m}-${currentDay}`}><td>{m}</td><td>Día {currentDay}</td><td>{ts.length} / {forecast?.[m]?.[currentDay]}</td><td>{ss.length} / {kind === "Suplente" ? "—" : ts.length * 3}</td><td>{a(ts).toLocaleString()} m</td><td>{a(ss).toLocaleString()} m</td></tr>; }))}</tbody></table></section>
    </div>}
    {notices.map((notice, i) => <p className={`message ${notice.type}`} key={i}>{notice.text}</p>)}
    {selected && <aside className="editor animate-pop-in"><button aria-label="Cerrar" onClick={() => setSelected(null)}><X size={20} /></button><span className="section-kicker">AJUSTE MANUAL</span><h3>{String(selected.row["PDV"] ?? selected.row["RefID"] ?? "Punto")}</h3><p>{operationalMt(selected)} · {selected.kind} · {selected.selection}</p><label><span>Asignar a</span><select value={selected.day ?? ""} onChange={(e) => moveSelected(e.target.value ? Number(e.target.value) : null)}><option value="">Sin asignar</option>{Object.keys(forecast?.[operationalMt(selected)] ?? {}).map(Number).sort((a,b)=>a-b).map((d) => <option key={d} value={d}>Día {d}</option>)}</select></label><small>Este ajuste se guardará en el Excel descargado.</small></aside>}
  </div></main>;
}
