"use client";

import dynamic from "next/dynamic";
import * as XLSX from "xlsx";
import { ChangeEvent, useMemo, useState } from "react";

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
const centroid = (points: Point[]) => ({
  lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
  lng: points.reduce((s, p) => s + p.lng, 0) / points.length,
});
const nearestAverage = (point: Point, peers: Point[]) => {
  const other = peers.filter((p) => p.id !== point.id);
  if (!other.length) return 0;
  return other.reduce((s, p) => s + meters(point, p), 0) / other.length;
};
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

function extractPoints(rows: Raw[]) {
  const fields = baseColumns(rows);
  const provisional = rows.map((row, index) => ({ row, index, lat: asNumber(row[fields.latitude]), lng: asNumber(row[fields.longitude]) }));
  const likelySwapped = provisional.filter((p) => p.lat !== null && p.lng !== null).filter((p) => Math.abs(p.lat!) > 60 && Math.abs(p.lng!) < 60).length > provisional.length * 0.55;
  return provisional.flatMap(({ row, index, lat, lng }) => {
    if (lat === null || lng === null) return [];
    const selection = norm(row[fields.selection]);
    const refId = String(row[fields.refId] ?? index + 1);
    return [{ id: refId + "-" + index, refId, name: String(row[fields.pdv] ?? refId), row, mt: String(row[fields.mt] ?? "").trim(), selection,
      kind: selection === "T" || selection === "T PANEL" ? "Titular" : selection.startsWith("S") ? "Suplente" : "Otro",
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

function assign(points: Point[], forecast: Forecast) {
  const next = points.map((p) => ({ ...p, day: null, assignedMt: null, avgMeters: null }));
  const notices: Notice[] = [];
  Object.entries(forecast).forEach(([mt, daily]) => {
    const all = next.filter((p) => p.mt === mt);
    const titles = all.filter((p) => p.kind === "Titular");
    const days = Object.entries(daily).map(([day, count]) => ({ day: Number(day), count })).sort((a, b) => b.count - a.count);
    const needed = days.reduce((sum, x) => sum + x.count, 0);
    if (!all.length) { notices.push({ type: "warn", text: `${mt}: no hay puntos con coordenadas en la base.` }); return; }
    if (titles.length < needed) notices.push({ type: "warn", text: `${mt}: el forecast pide ${needed} titulares y la base tiene ${titles.length}. Se asignaron todos los disponibles.` });
    // Density is calculated once per MT to keep large bases responsive in the browser.
    const density = new Map(titles.map((point) => [point.id, titles.filter((x) => x.id !== point.id)
      .map((x) => meters(point, x)).sort((a, b) => a - b).slice(0, 4).reduce((sum, d) => sum + d, 0)]));
    let available = [...titles];
    days.forEach(({ day, count }) => {
      if (!available.length) return;
      const take = Math.min(count, available.length);
      // Seed where the remaining local density is greatest, then tighten around its centroid.
      const seed = [...available].sort((a, b) => (density.get(a.id) ?? 0) - (density.get(b.id) ?? 0))[0];
      let group = [...available].sort((a, b) => meters(seed, a) - meters(seed, b)).slice(0, take);
      for (let i = 0; i < 3 && group.length > 1; i++) {
        const c = centroid(group);
        group = [...available].sort((a, b) => meters(a, c as Point) - meters(b, c as Point)).slice(0, take);
      }
      group.forEach((p) => { p.day = day; p.assignedMt = mt; });
      const ids = new Set(group.map((p) => p.id));
      available = available.filter((p) => !ids.has(p.id));
    });

  });

  // Titulares remain in their original MT FINAL. Suplentes are then allocated globally to the closest eligible daily group.
  const groups = Object.entries(forecast).flatMap(([mt, daily]) => Object.keys(daily).map(Number).flatMap((day) => {
    const titulars = next.filter((point) => point.kind === "Titular" && point.assignedMt === mt && point.day === day);
    return titulars.length ? [{ mt, day, titulars, desired: titulars.length * 3, assigned: [] as Point[] }] : [];
  }));
  const edges = next.filter((point) => point.kind === "Suplente").flatMap((point) => groups.flatMap((group) => {
    const distance = Math.min(...group.titulars.map((title) => meters(point, title)));
    return distance <= MAX_SUPPLEMENT_DISTANCE_METERS ? [{ point, group, distance }] : [];
  })).sort((a, b) => priority(a.point) - priority(b.point) || a.distance - b.distance);
  const usedSpares = new Set<string>();
  edges.forEach(({ point, group }) => {
    if (usedSpares.has(point.id) || group.assigned.length >= group.desired) return;
    point.day = group.day;
    point.assignedMt = group.mt;
    group.assigned.push(point);
    usedSpares.add(point.id);
  });
  groups.forEach((group) => {
    if (group.assigned.length < group.desired) notices.push({ type: "warn", text: `${group.mt}, día ${group.day}: ${group.assigned.length}/${group.desired} suplentes dentro de 15 km de los titulares.` });
  });
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
  const [mt, setMt] = useState("all"); const [day, setDay] = useState("all"); const [kind, setKind] = useState("all"); const [selectionFilter, setSelectionFilter] = useState("all");
  const [planningVersion, setPlanningVersion] = useState(0);
  const [selected, setSelected] = useState<Point | null>(null);
  const [error, setError] = useState("");
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
  const filtered = useMemo(() => points.filter((p) => (mt === "all" || operationalMt(p) === mt) && (day === "all" || p.day === Number(day)) && (kind === "all" || p.kind === kind) && (selectionFilter === "all" || p.selection === selectionFilter)), [points, mt, day, kind, selectionFilter]);
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
  return <main>
    <header><div><p className="eyebrow">PLANIFICACIÓN TERRITORIAL</p><h1>Ruta Compacta</h1></div><p className="header-note">Asignación espacial de visitas con control de forecast</p></header>
    <section className="hero"><div><p className="eyebrow">OPERACIÓN DE CAMPO</p><h2>Menos dispersión.<br /><em>Más visitas útiles.</em></h2><p>Calcula titulares por cercanía geográfica y completa cada jornada con suplentes priorizados.</p></div><div className="steps"><span>01 · Carga</span><span>02 · Calcula</span><span>03 · Ajusta y exporta</span></div></section>
    <section className="upload-grid"><label className={base ? "file-card loaded" : "file-card"}><span>Base de puntos</span><strong>{base ? `${base.length.toLocaleString()} registros listos` : "BD PUNTOS.xlsx"}</strong><small>MT FINAL · SELECCION · LATITUDE · LONGITUDE</small><input type="file" accept=".xlsx,.xls" onChange={(e) => handleFile(e, "base")} /></label><label className={forecast ? "file-card loaded" : "file-card"}><span>Forecast mensual</span><strong>{forecast ? `${Object.keys(forecast).length} MT finales listos` : "FORCAST.xlsx"}</strong><small>MT FINAL en filas · días en columnas</small><input type="file" accept=".xlsx,.xls" onChange={(e) => handleFile(e, "forecast")} /></label><button className="calculate" onClick={calculate} disabled={!base || !forecast}>Calcular planificación <b>→</b></button></section>
    {error && <p className="message error">{error}</p>}
    {!!points.length && <>
      <section className="toolbar"><div className="filters"><label>MT FINAL<select value={mt} onChange={(e) => { const nextMt = e.target.value; setMt(nextMt); if (day !== "all" && nextMt !== "all" && !forecast?.[nextMt]?.[Number(day)]) setDay("all"); }}><option value="all">Todos los MT</option>{mts.map((x) => <option key={x} value={x}>{x}</option>)}</select></label><label>Día<select value={day} onChange={(e) => setDay(e.target.value)}><option value="all">Todos los días</option>{availableDays.map((x) => <option key={x} value={x}>Día {x}</option>)}</select></label><label>Tipo de punto<select value={kind} onChange={(e) => setKind(e.target.value)}><option value="all">Titulares y suplentes</option><option value="Titular">Solo titulares</option><option value="Suplente">Solo suplentes</option></select></label><label>Selección exacta<select value={selectionFilter} onChange={(e) => setSelectionFilter(e.target.value)}><option value="all">Todas las selecciones</option>{selectionOptions.map((selection) => <option key={selection} value={selection}>{selection}</option>)}</select></label></div><button className="download" onClick={download}>Descargar Excel ↓</button></section>
      <section className="metrics"><article><span>Puntos asignados</span><strong>{summary.assigned}</strong><small>{summary.tit} titulares · {summary.sup} suplentes</small></article><article><span>Promedio titulares</span><strong>{Math.round(summary.tAvg).toLocaleString()} m</strong><small>entre titulares del mismo día</small></article><article><span>Promedio suplentes</span><strong>{Math.round(summary.sAvg).toLocaleString()} m</strong><small>al titular más cercano</small></article></section>
      <section className="map-section"><div className="map-heading"><div><p className="eyebrow">MAPA DE PLANIFICACIÓN</p><h2>{mt === "all" ? "Todos los MT" : mt}</h2></div><div className="map-key"><p><i className="dot title" /> Titular <i className="dot spare" /> Suplente</p><div className="day-legend">{availableDays.map((currentDay) => <span key={currentDay}><i style={{ backgroundColor: COLORS[(currentDay - 1) % COLORS.length] }} />Día {currentDay}</span>)}</div><small>El color identifica el día. Selecciona un punto para moverlo.</small></div></div><GeoMap points={filtered} colors={COLORS} planningVersion={planningVersion} onSelect={setSelected} /></section>
      <section className="day-table"><div><p className="eyebrow">CONTROL POR JORNADA</p><h2>Distancias y cumplimiento</h2></div><table><thead><tr><th>MT FINAL</th><th>Día</th><th>Titulares</th><th>Suplentes</th><th>Prom. titulares</th><th>Prom. suplentes</th></tr></thead><tbody>{Object.entries(forecast ?? {}).filter(([m]) => mt === "all" || m === mt).flatMap(([m, d]) => Object.keys(d).map(Number).filter((currentDay) => day === "all" || currentDay === Number(day)).map((currentDay) => { const group = points.filter((p) => operationalMt(p) === m && p.day === currentDay && (kind === "all" || p.kind === kind) && (selectionFilter === "all" || p.selection === selectionFilter)), ts = group.filter((p) => p.kind === "Titular"), ss = group.filter((p) => p.kind === "Suplente"); const a=(x:Point[])=>x.length?Math.round(x.reduce((s,p)=>s+(p.avgMeters??0),0)/x.length):0; return <tr key={`${m}-${currentDay}`}><td>{m}</td><td>Día {currentDay}</td><td>{ts.length} / {forecast?.[m]?.[currentDay]}</td><td>{ss.length} / {kind === "Suplente" ? "—" : ts.length * 3}</td><td>{a(ts).toLocaleString()} m</td><td>{a(ss).toLocaleString()} m</td></tr>; }))}</tbody></table></section>
    </>}
    {notices.map((notice, i) => <p className={`message ${notice.type}`} key={i}>{notice.text}</p>)}
    {selected && <aside className="editor"><button aria-label="Cerrar" onClick={() => setSelected(null)}>×</button><p className="eyebrow">AJUSTE MANUAL</p><h3>{String(selected.row["PDV"] ?? selected.row["RefID"] ?? "Punto")}</h3><p>{operationalMt(selected)} · {selected.kind} · {selected.selection}</p><label>Asignar a<select value={selected.day ?? ""} onChange={(e) => moveSelected(e.target.value ? Number(e.target.value) : null)}><option value="">Sin asignar</option>{Object.keys(forecast?.[operationalMt(selected)] ?? {}).map(Number).sort((a,b)=>a-b).map((d) => <option key={d} value={d}>Día {d}</option>)}</select></label><small>Este ajuste se guardará en el Excel descargado.</small></aside>}
  </main>;
}
