"use client";

import dynamic from "next/dynamic";
import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, Check, ChevronDown, CircleGauge, Database, Download, Layers3, LineChart, LoaderCircle, MapPinned, MousePointer2, Route, Search, ShieldCheck, SlidersHorizontal, Sparkles, Tags, Trash2, UploadCloud, UserRound, X } from "lucide-react";
import { operationalMt, type Forecast, type Notice, type PlanningMode, type Point } from "./planning-core";

const GeoMap = dynamic(() => import("./GeoMap"), { ssr: false });
const COLORS = ["#0b7285", "#7c3aed", "#e8590c", "#2f9e44", "#c2255c", "#1971c2", "#a61e4d", "#5f3dc4", "#087f5b", "#9c36b5"];
const MT_PALETTE = ["#e8590c", "#7c3aed", "#0b7285", "#2f9e44", "#c2255c", "#1971c2", "#d6336c", "#5f3dc4", "#087f5b", "#f59f00", "#364fc7", "#9c36b5", "#099268", "#e03131", "#1098ad", "#2b8a3e", "#e67700", "#4c6ef5", "#ae3ec9", "#f76707", "#15aabf", "#40c057", "#fa5252", "#7950f2", "#fab005"];

type Busy = "base" | "forecast" | "calculate" | "download" | "qa" | "move" | "bulk-move" | null;
type PendingRequest = { resolve: (value: unknown) => void; reject: (reason: Error) => void };
type WorkerResponse = { id?: number; type?: string; text?: string; ok?: boolean; payload?: unknown; error?: string };

function sampledMapPoints(points: Point[], limit: number) {
  if (points.length <= limit) return points;
  const buckets = new Map<string, Point[]>();
  points.forEach((point) => {
    const bucketKey = `${point.day}-${point.kind}`, bucket = buckets.get(bucketKey) ?? [];
    bucket.push(point); buckets.set(bucketKey, bucket);
  });
  const sampled: Point[] = [], used = new Set<string>();
  buckets.forEach((bucket) => {
    const quota = Math.max(1, Math.floor(limit * bucket.length / points.length));
    const stride = bucket.length / quota;
    for (let index = 0; index < quota && sampled.length < limit; index++) {
      const point = bucket[Math.min(bucket.length - 1, Math.floor(index * stride))];
      if (!used.has(point.id)) { sampled.push(point); used.add(point.id); }
    }
  });
  for (let index = 0; index < points.length && sampled.length < limit; index++) {
    if (!used.has(points[index].id)) { sampled.push(points[index]); used.add(points[index].id); }
  }
  return sampled;
}

export default function OptimizedPage() {
  const workerRef = useRef<Worker | null>(null);
  const filtersRef = useRef<HTMLElement | null>(null);
  const pendingRef = useRef(new Map<number, PendingRequest>());
  const requestIdRef = useRef(0);
  const [baseInfo, setBaseInfo] = useState<{ name: string; count: number } | null>(null);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [planningMode, setPlanningMode] = useState<PlanningMode | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [mt, setMt] = useState("all");
  const [mtSearch, setMtSearch] = useState("");
  const [selectedDays, setSelectedDays] = useState<number[]>([]);
  const [openFilter, setOpenFilter] = useState<"mt" | "days" | null>(null);
  const [viewMode, setViewMode] = useState<"day" | "mt">("day");
  const [kind, setKind] = useState("all");
  const [selectionFilter, setSelectionFilter] = useState("all");
  const [planningVersion, setPlanningVersion] = useState(0);
  const [selected, setSelected] = useState<Point | null>(null);
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDay, setBulkDay] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [progress, setProgress] = useState("");

  useEffect(() => {
    const worker = new Worker(new URL("./planning.worker.ts", import.meta.url), { type: "module" });
    const pendingRequests = pendingRef.current;
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "progress") { setProgress(message.text ?? "Procesando…"); return; }
      if (message.id == null) return;
      const pending = pendingRef.current.get(message.id);
      if (!pending) return;
      pendingRef.current.delete(message.id);
      if (message.ok) pending.resolve(message.payload);
      else pending.reject(new Error(message.error ?? "No fue posible completar la operación."));
    };
    worker.onerror = () => setError("El proceso de cálculo se detuvo inesperadamente. Vuelve a cargar los archivos.");
    return () => {
      worker.terminate();
      pendingRequests.forEach(({ reject }) => reject(new Error("El proceso fue cerrado.")));
      pendingRequests.clear();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!openFilter) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (filtersRef.current && !filtersRef.current.contains(event.target as Node)) {
        setOpenFilter(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [openFilter]);

  const workerCall = useCallback((type: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = []) => new Promise<unknown>((resolve, reject) => {
    const worker = workerRef.current;
    if (!worker) { reject(new Error("El motor de cálculo todavía se está iniciando.")); return; }
    const id = ++requestIdRef.current;
    pendingRef.current.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload }, transfer);
  }), []);

  const handleFile = async (event: ChangeEvent<HTMLInputElement>, type: "base" | "forecast") => {
    const file = event.target.files?.[0];
    if (!file || busy) return;
    setBusy(type); setError(""); setProgress(type === "base" ? "Leyendo la base en segundo plano…" : "Leyendo el forecast…");
    try {
      const buffer = await file.arrayBuffer();
      if (type === "base") {
        const result = await workerCall("load-base", { buffer }, [buffer]) as { count: number };
        setBaseInfo({ name: file.name, count: result.count });
      } else {
        const result = await workerCall("load-forecast", { buffer }, [buffer]) as { forecast: Forecast };
        setForecast(result.forecast);
      }
      setPoints([]); setPlanningMode(null); setNotices([]); setSelected(null); setSelectedIds(new Set()); setMultiSelect(false); setBulkDay(""); setMt("all"); setSelectedDays([]);
    } catch (exception) {
      if (type === "base") setBaseInfo(null); else setForecast(null);
      setPoints([]); setPlanningMode(null); setNotices([]);
      setError(exception instanceof Error ? exception.message : "No se pudo leer el archivo.");
    } finally { setBusy(null); setProgress(""); }
  };

  const calculate = async () => {
    if (!baseInfo || !forecast || busy) return;
    setBusy("calculate"); setError(""); setProgress(`Optimizando ${baseInfo.count.toLocaleString()} registros…`);
    try {
      const result = await workerCall("calculate") as { points: Point[]; notices: Notice[]; mode: PlanningMode };
      setPoints(result.points); setPlanningMode(result.mode); setNotices(result.notices); setSelected(null); setSelectedIds(new Set()); setMultiSelect(false); setBulkDay(""); setPlanningVersion((version) => version + 1);
    } catch (exception) { setError(exception instanceof Error ? exception.message : "No fue posible calcular la asignación."); }
    finally { setBusy(null); setProgress(""); }
  };

  const mts = useMemo(() => Object.keys(forecast ?? {}).sort(), [forecast]);
  const selectionOptions = useMemo(() => {
    const order = ["T", "T PANEL", "S PANEL", "S1", "S2", "S3", "S4", "S ON", "S ORO"];
    return [...new Set(points.map((point) => point.selection))].sort((a, b) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)) || a.localeCompare(b));
  }, [points]);
  const availableDays = useMemo(() => {
    if (mt !== "all") return Object.keys(forecast?.[mt] ?? {}).map(Number).sort((a, b) => a - b);
    return [...new Set(Object.values(forecast ?? {}).flatMap((daily) => Object.keys(daily).map(Number)))].sort((a, b) => a - b);
  }, [forecast, mt]);
  const selectedDaySet = useMemo(() => new Set(selectedDays), [selectedDays]);
  const filtered = useMemo(() => points.filter((point) =>
    (mt === "all" || operationalMt(point) === mt) &&
    (!selectedDaySet.size || (point.day !== null && selectedDaySet.has(point.day))) &&
    (kind === "all" || point.kind === kind) &&
    (selectionFilter === "all" || point.selection === selectionFilter)
  ), [points, mt, selectedDaySet, kind, selectionFilter]);

  const summary = useMemo(() => {
    let assigned = 0, tit = 0, sup = 0, titleDistance = 0, spareDistance = 0;
    filtered.forEach((point) => {
      if (!point.day) return;
      assigned++;
      if (point.kind === "Titular") { tit++; titleDistance += point.avgMeters ?? 0; }
      else if (point.kind === "Suplente") { sup++; spareDistance += point.avgMeters ?? 0; }
    });
    return { assigned, tit, sup, tAvg: tit ? titleDistance / tit : 0, sAvg: sup ? spareDistance / sup : 0 };
  }, [filtered]);

  const tableStats = useMemo(() => {
    const stats = new Map<string, { tit: number; sup: number; titleDistance: number; spareDistance: number }>();
    filtered.forEach((point) => {
      if (!point.day) return;
      const compound = `${operationalMt(point)}\u0000${point.day}`;
      const row = stats.get(compound) ?? { tit: 0, sup: 0, titleDistance: 0, spareDistance: 0 };
      if (point.kind === "Titular") { row.tit++; row.titleDistance += point.avgMeters ?? 0; }
      else if (point.kind === "Suplente") { row.sup++; row.spareDistance += point.avgMeters ?? 0; }
      stats.set(compound, row);
    });
    return stats;
  }, [filtered]);

  const tableRows = useMemo(() => Object.entries(forecast ?? {}).filter(([currentMt]) => mt === "all" || currentMt === mt).flatMap(([currentMt, daily]) =>
    Object.keys(daily).map(Number).filter((day) => !selectedDaySet.size || selectedDaySet.has(day)).map((day) => {
      const stat = tableStats.get(`${currentMt}\u0000${day}`) ?? { tit: 0, sup: 0, titleDistance: 0, spareDistance: 0 };
      return { mt: currentMt, day, ...stat, titleAverage: stat.tit ? Math.round(stat.titleDistance / stat.tit) : 0, spareAverage: stat.sup ? Math.round(stat.spareDistance / stat.sup) : 0 };
    })
  ), [forecast, mt, selectedDaySet, tableStats]);

  const mapCandidates = useMemo(() => filtered.filter((point) => point.day), [filtered]);
  const mapLimit = mt === "all" ? 1200 : 3000;
  const mapPoints = useMemo(() => sampledMapPoints(mapCandidates, mapLimit), [mapCandidates, mapLimit]);
  const mapLimited = mapCandidates.length > mapPoints.length;
  const bulkPoints = useMemo(() => points.filter((point) => selectedIds.has(point.id)), [points, selectedIds]);
  const bulkDays = useMemo(() => {
    if (!bulkPoints.length) return [];
    const common = new Set(Object.keys(forecast?.[operationalMt(bulkPoints[0])] ?? {}).map(Number));
    bulkPoints.slice(1).forEach((point) => {
      const available = new Set(Object.keys(forecast?.[operationalMt(point)] ?? {}).map(Number));
      [...common].forEach((day) => { if (!available.has(day)) common.delete(day); });
    });
    return [...common].sort((a, b) => a - b);
  }, [bulkPoints, forecast]);
  const bulkSummary = useMemo(() => ({
    titles: bulkPoints.filter((point) => point.kind === "Titular").length,
    spares: bulkPoints.filter((point) => point.kind === "Suplente").length,
    mts: new Set(bulkPoints.map(operationalMt)).size,
  }), [bulkPoints]);

  const clearBulkSelection = () => { setSelectedIds(new Set()); setMultiSelect(false); setBulkDay(""); };
  const handleMultiSelect = (selectedPoints: Point[]) => { setSelectedIds(new Set(selectedPoints.map((point) => point.id))); setBulkDay(""); };

  const selectMt = (nextMt: string) => {
    setMt(nextMt); setMtSearch(nextMt === "all" ? "" : nextMt);
    if (nextMt !== "all") setSelectedDays((previous) => previous.filter((day) => Boolean(forecast?.[nextMt]?.[day])));
    clearBulkSelection();
    setOpenFilter(null);
  };
  const toggleDay = (day: number) => { setSelectedDays((previous) => previous.includes(day) ? previous.filter((value) => value !== day) : [...previous, day].sort((a, b) => a - b)); clearBulkSelection(); };
  const matchingMts = useMemo(() => {
    const query = mtSearch.trim().toLocaleLowerCase();
    return query ? mts.filter((candidate) => candidate.toLocaleLowerCase().includes(query)) : mts;
  }, [mts, mtSearch]);
  const mtColorMap = useMemo(() => {
    const map = new Map<string, string>();
    mts.forEach((name, index) => {
      map.set(name, MT_PALETTE[index % MT_PALETTE.length]);
    });
    return map;
  }, [mts]);
  const visibleMts = useMemo(() => {
    if (mt !== "all") return [mt];
    const presentMts = new Set(filtered.map(operationalMt));
    return mts.filter((candidate) => presentMts.has(candidate));
  }, [mt, filtered, mts]);
  const filterKey = useMemo(() => `${planningVersion}|${mt}|${selectedDays.join(",")}|${kind}|${selectionFilter}|${viewMode}`, [planningVersion, mt, selectedDays, kind, selectionFilter, viewMode]);

  const moveSelected = async (newDay: number | null) => {
    if (!selected || busy) return;
    setBusy("move"); setError("");
    try {
      const result = await workerCall("move", { id: selected.id, day: newDay }) as { updates: Point[]; notices: Notice[] };
      const updates = new Map(result.updates.map((point) => [point.id, point]));
      setPoints((previous) => previous.map((point) => updates.get(point.id) ?? point));
      setSelected((previous) => previous ? updates.get(previous.id) ?? { ...previous, day: newDay } : previous);
      setNotices(result.notices);
    } catch (exception) { setError(exception instanceof Error ? exception.message : "No fue posible mover el punto."); }
    finally { setBusy(null); }
  };

  const moveBulkSelection = async () => {
    if (!selectedIds.size || !bulkDay || busy) return;
    setBusy("bulk-move"); setError("");
    try {
      const result = await workerCall("bulk-move", { ids: [...selectedIds], day: Number(bulkDay) }) as { updates: Point[]; notices: Notice[] };
      const updates = new Map(result.updates.map((point) => [point.id, point]));
      setPoints((previous) => previous.map((point) => updates.get(point.id) ?? point));
      setNotices(result.notices);
      clearBulkSelection();
    } catch (exception) { setError(exception instanceof Error ? exception.message : "No fue posible mover los puntos seleccionados."); }
    finally { setBusy(null); }
  };

  const download = async () => {
    if (!points.length || busy) return;
    setBusy("download"); setError(""); setProgress("Preparando el Excel en segundo plano…");
    try {
      const result = await workerCall("download") as { buffer: ArrayBuffer };
      const url = URL.createObjectURL(new Blob([result.buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = "BD_PUNTOS_ASIGNADOS.xlsx"; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (exception) { setError(exception instanceof Error ? exception.message : "No fue posible generar el Excel."); }
    finally { setBusy(null); setProgress(""); }
  };

  const runRoadQA = async () => {
    if (!forecast || mt === "all") { setError("Selecciona un MT FINAL específico antes de ejecutar el QA vial."); return; }
    if (busy) return;
    setBusy("qa"); setError(""); setProgress("Consultando carreteras y optimizando el MT…");
    try {
      const result = await workerCall("qa", { mt }) as { points: Point[]; notices: Notice[] };
      setPoints(result.points); setNotices(result.notices); setSelected(null); setSelectedIds(new Set()); setMultiSelect(false); setBulkDay(""); setPlanningVersion((version) => version + 1);
    } catch (exception) { setError(`QA vial no aplicado: ${exception instanceof Error ? exception.message : "no fue posible consultar la red de carreteras"} No se modificó la planificación.`); }
    finally { setBusy(null); setProgress(""); }
  };

  return <main className="app-shell"><div className="page-container">
    <header className="site-header animate-fade-up"><span className="brand-pill"><Layers3 size={14} /> Base de puntos + Forecast</span><h1><span>Ruta Compacta</span> para operación de campo</h1><p>Planifica puntos por cercanía, adapta automáticamente estudios con o sin suplentes y ejecuta un QA vial inteligente.</p></header>
    <section className="upload-grid animate-fade-up">
      <label className={baseInfo ? "file-card loaded" : "file-card"}><div className="file-card-top"><i><Database size={21} /></i>{baseInfo && <span className="ready-badge"><Check size={13} /> Listo</span>}</div><strong>Base de puntos</strong><p>{busy === "base" ? "Cargando sin bloquear la página…" : baseInfo ? `${baseInfo.count.toLocaleString()} registros cargados` : "Arrastra o haz clic para subir tu Excel"}</p><small>MT FINAL · SELECCIÓN · LATITUD · LONGITUD</small><input disabled={Boolean(busy)} type="file" accept=".xlsx,.xls" onChange={(event) => handleFile(event, "base")} /></label>
      <label className={forecast ? "file-card loaded" : "file-card"}><div className="file-card-top"><i><LineChart size={21} /></i>{forecast && <span className="ready-badge"><Check size={13} /> Listo</span>}</div><strong>Forecast mensual</strong><p>{busy === "forecast" ? "Cargando forecast…" : forecast ? `${Object.keys(forecast).length} MT finales cargados` : "Arrastra o haz clic para subir tu Excel"}</p><small>MT FINAL en filas · días en columnas</small><input disabled={Boolean(busy)} type="file" accept=".xlsx,.xls" onChange={(event) => handleFile(event, "forecast")} /></label>
      <button className="calculate" onClick={calculate} disabled={!baseInfo || !forecast || Boolean(busy)}>{busy === "calculate" ? <LoaderCircle className="spin" size={18} /> : <UploadCloud size={18} />} {busy === "calculate" ? "Calculando sin bloquear…" : "Calcular planificación"}</button>
    </section>
    {progress && <p className="processing-message"><LoaderCircle className="spin" size={16} /> {progress}</p>}
    {error && <p className="message error">{error}</p>}
    {!!points.length && <div className="results animate-fade-up">
      <div className="results-heading"><div><span className="section-kicker"><Sparkles size={14} /> PLANIFICACIÓN + QA VIAL AUTOMÁTICO</span><h2>Resumen de la operación</h2><p>{filtered.length.toLocaleString()} puntos visibles de {points.length.toLocaleString()} procesados</p></div><div className="result-actions"><button className="qa-road" onClick={runRoadQA} disabled={Boolean(busy) || mt === "all"} title={mt === "all" ? "Selecciona un MT FINAL para repetir el QA vial" : `Repetir la optimización vial de ${mt}`}>{busy === "qa" ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />} {busy === "qa" ? "Consultando carreteras…" : "Repetir QA vial"}</button><button className="download" onClick={download} disabled={Boolean(busy)}>{busy === "download" ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />} {busy === "download" ? "Preparando…" : "Descargar Excel"}</button></div></div>
      <section className="metrics"><article><i><Route size={20} /></i><div><span>Puntos asignados</span><strong>{summary.assigned}</strong><small>{summary.tit} titulares · {summary.sup} suplentes</small></div></article><article><i><CircleGauge size={20} /></i><div><span>Promedio titulares</span><strong>{Math.round(summary.tAvg).toLocaleString()} m</strong><small>entre titulares del mismo día</small></div></article><article className="accent"><i><MapPinned size={20} /></i><div>{planningMode === "titles-only" ? <><span>Modo solo titulares</span><strong>Forecast exacto</strong><small>cuota estricta por MT y día</small></> : <><span>Promedio suplentes</span><strong>{Math.round(summary.sAvg).toLocaleString()} m</strong><small>al titular más cercano</small></>}</div></article></section>
      <div className="map-layout">
        <aside className="map-sidebar" ref={filtersRef}>
          <div className="view-mode-panel">
            <span className="section-kicker"><Layers3 size={14} /> MODO DE VISUALIZACIÓN</span>
            <div className="view-mode-options">
              <button
                type="button"
                className={`view-mode-btn${viewMode === "day" ? " active" : ""}`}
                onClick={() => setViewMode("day")}
              >
                <CalendarDays size={15} /> Ver por día
              </button>
              <button
                type="button"
                className={`view-mode-btn${viewMode === "mt" ? " active" : ""}`}
                onClick={() => setViewMode("mt")}
              >
                <UserRound size={15} /> Ver por MT
              </button>
            </div>
          </div>
          <div className="filters-panel">
            <div className="filters-panel-header">
              <span className="section-kicker"><SlidersHorizontal size={14} /> FILTROS</span>
              <h3>Filtros</h3>
            </div>
            <div className="filters">
              <div className="filter-dropdown"><span><UserRound size={14} /> MT FINAL</span><button type="button" className="dropdown-trigger" aria-expanded={openFilter === "mt"} onClick={() => setOpenFilter((current) => current === "mt" ? null : "mt")}><b>{mt === "all" ? "Todos los MT" : mt}</b><ChevronDown size={16} /></button>{openFilter === "mt" && <div className="dropdown-menu mt-menu"><div className="dropdown-search"><Search size={16} /><input value={mtSearch} onChange={(event) => setMtSearch(event.target.value)} placeholder="Buscar MT FINAL" aria-label="Buscar MT FINAL" /></div><div className="dropdown-options"><label><input type="checkbox" checked={mt === "all"} onChange={() => selectMt("all")} /><span>Todos los MT</span></label>{matchingMts.map((option) => <label key={option}><input type="checkbox" checked={mt === option} onChange={() => selectMt(option)} /><span>{option}</span></label>)}{!matchingMts.length && <p className="empty-options">No hay coincidencias</p>}</div></div>}</div>
              <div className="filter-dropdown"><span><CalendarDays size={14} /> Días</span><button type="button" className="dropdown-trigger" aria-expanded={openFilter === "days"} onClick={() => setOpenFilter((current) => current === "days" ? null : "days")}><b>{selectedDays.length ? `${selectedDays.length} día${selectedDays.length === 1 ? "" : "s"} seleccionados` : "Todos los días"}</b><ChevronDown size={16} /></button>{openFilter === "days" && <div className="dropdown-menu days-menu"><div className="dropdown-options"><label><input type="checkbox" checked={!selectedDays.length} onChange={() => { setSelectedDays([]); clearBulkSelection(); }} /><span>Todos los días</span></label>{availableDays.map((option) => <label key={option}><input type="checkbox" checked={selectedDays.includes(option)} onChange={() => toggleDay(option)} /><span>Día {option}</span></label>)}</div></div>}</div>
              <label><span><SlidersHorizontal size={14} /> Tipo de punto</span><select value={kind} onChange={(event) => { setKind(event.target.value); clearBulkSelection(); }}><option value="all">Titulares y suplentes</option><option value="Titular">Solo titulares</option><option value="Suplente">Solo suplentes</option></select></label>
              <label><span><Tags size={14} /> Selección exacta</span><select value={selectionFilter} onChange={(event) => { setSelectionFilter(event.target.value); clearBulkSelection(); }}><option value="all">Todas las selecciones</option>{selectionOptions.map((selection) => <option key={selection} value={selection}>{selection}</option>)}</select></label>
            </div>
          </div>
        </aside>
        <section className="map-section"><div className="map-heading"><div className="map-title-actions"><div><span className="section-kicker"><MapPinned size={14} /> MAPA DE PLANIFICACIÓN</span><h2>{mt === "all" ? "Todos los MT" : mt}</h2></div><button type="button" className={`map-select-button${multiSelect ? " active" : ""}`} disabled={mapLimited || !mapPoints.length || Boolean(busy)} onClick={() => { if (multiSelect) clearBulkSelection(); else { setMultiSelect(true); setSelected(null); setSelectedIds(new Set()); setBulkDay(""); } }} title={mapLimited ? "Filtra un MT FINAL o días hasta que el mapa muestre todos los puntos" : "Arrastra un rectángulo para seleccionar varios puntos"}><MousePointer2 size={16} /> Selección múltiple</button></div><div className="map-key"><p><i className="dot title" /> Titular <i className="dot spare" /> Suplente</p>{viewMode === "day" ? <div className="day-legend">{availableDays.map((day) => <span key={day}><i style={{ backgroundColor: COLORS[(day - 1) % COLORS.length] }} />Día {day}</span>)}</div> : <div className="day-legend">{visibleMts.map((m) => <span key={m}><i style={{ backgroundColor: mtColorMap.get(m) ?? COLORS[0] }} />{m}</span>)}</div>}<small>{viewMode === "day" ? "El color identifica el día. Selecciona un punto para moverlo." : "El color identifica el MT FINAL. Selecciona un punto para moverlo."}</small></div></div>{mapLimited && <p className="map-performance-note">Vista rápida: se muestran {mapPoints.length.toLocaleString()} de {mapCandidates.length.toLocaleString()} puntos. Selecciona un MT FINAL o días específicos para verlos todos y activar la selección múltiple.</p>}{multiSelect && <p className="map-selection-help"><MousePointer2 size={15} /> Mantén presionado el botón izquierdo y arrastra un rectángulo alrededor de los puntos que deseas mover.</p>}<GeoMap points={mapPoints} colors={COLORS} planningVersion={planningVersion} onSelect={setSelected} multiSelect={multiSelect} selectedIds={selectedIds} onMultiSelect={handleMultiSelect} filterKey={filterKey} viewMode={viewMode} mtColors={mtColorMap} /></section>
      </div>
      <section className="day-table"><div className="table-heading"><span className="section-kicker"><Layers3 size={14} /> CONTROL POR JORNADA</span><h2>Distancias y cumplimiento</h2></div><table><thead><tr><th>MT FINAL</th><th>Día</th><th>Titulares / forecast</th><th>Suplentes</th><th>Prom. titulares</th><th>Prom. suplentes</th></tr></thead><tbody>{tableRows.map((row) => <tr key={`${row.mt}-${row.day}`}><td>{row.mt}</td><td>Día {row.day}</td><td>{row.tit} / {forecast?.[row.mt]?.[row.day] ?? 0}</td><td>{planningMode === "titles-only" ? "No aplica" : `${row.sup} / ${kind === "Suplente" ? "—" : row.tit * 3}`}</td><td>{row.titleAverage.toLocaleString()} m</td><td>{planningMode === "titles-only" ? "—" : `${row.spareAverage.toLocaleString()} m`}</td></tr>)}</tbody></table></section>
    </div>}
    {notices.map((notice, index) => <p className={`message ${notice.type}`} key={`${notice.type}-${index}`}>{notice.text}</p>)}
    {!!bulkPoints.length && <aside className="editor bulk-editor animate-pop-in"><button className="editor-close" aria-label="Cerrar selección múltiple" onClick={clearBulkSelection}><X size={20} /></button><span className="section-kicker">SELECCIÓN MÚLTIPLE</span><h3>{bulkPoints.length.toLocaleString()} puntos seleccionados</h3><p>{bulkSummary.titles} titulares · {bulkSummary.spares} suplentes<br />{bulkSummary.mts} MT FINAL involucrado{bulkSummary.mts === 1 ? "" : "s"}</p><label><span>Mover todos al día</span><select value={bulkDay} onChange={(event) => setBulkDay(event.target.value)} disabled={busy === "bulk-move" || !bulkDays.length}><option value="">Selecciona un día</option>{bulkDays.map((day) => <option key={day} value={day}>Día {day}</option>)}</select></label><button className="bulk-apply" onClick={moveBulkSelection} disabled={!bulkDay || busy === "bulk-move"}>{busy === "bulk-move" ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} {busy === "bulk-move" ? "Aplicando cambios…" : `Mover ${bulkPoints.length.toLocaleString()} puntos`}</button><button className="bulk-clear" onClick={clearBulkSelection} disabled={busy === "bulk-move"}><Trash2 size={15} /> Limpiar selección</button>{!bulkDays.length && <small>No hay días comunes entre los MT seleccionados. Filtra un solo MT FINAL y vuelve a seleccionar.</small>}<small>El cambio se reflejará en la tabla y en el Excel descargado.</small></aside>}
    {selected && <aside className="editor animate-pop-in"><button className="editor-close" aria-label="Cerrar" onClick={() => setSelected(null)}><X size={20} /></button><span className="section-kicker">AJUSTE MANUAL</span><h3>{selected.name}</h3><p>RefID: {selected.refId}<br />{operationalMt(selected)} · {selected.kind} · {selected.selection}</p><label><span>Asignar a</span><select disabled={busy === "move"} value={selected.day ?? ""} onChange={(event) => moveSelected(event.target.value ? Number(event.target.value) : null)}><option value="">Sin asignar</option>{Object.keys(forecast?.[operationalMt(selected)] ?? {}).map(Number).sort((a, b) => a - b).map((day) => <option key={day} value={day}>Día {day}</option>)}</select></label><small>{busy === "move" ? "Aplicando cambio…" : "Este ajuste se guardará en el Excel descargado."}</small></aside>}
  </div></main>;
}
