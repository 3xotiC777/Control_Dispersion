"use client";

import dynamic from "next/dynamic";
import { type ChangeEvent, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { BoxSelect, Check, ChevronDown, Columns3, Download, FileSpreadsheet, Filter, Layers3, LoaderCircle, MapPinned, Palette, Plus, Save, Shapes, Trash2, X } from "lucide-react";
import { EXPLORER_COLORS, matchesRule, normalizeHeader, type CellValue, type ColumnKind, type ColumnMeta, type ExplorerPoint, type ExplorerPolygon, type FilterOperator, type FilterRule } from "./explorer-core";

const ExplorerMap = dynamic(() => import("./ExplorerMap"), { ssr: false });
type Bounds = [number, number, number, number];
type PendingRequest = { resolve: (value: unknown) => void; reject: (reason: Error) => void };
type WorkerResponse = { id?: number; type?: string; text?: string; ok?: boolean; payload?: unknown; error?: string };
type DataInfo = { name: string; count: number; skipped?: number; sourceType?: "excel" | "gpkg"; sheetName?: string; layerName?: string };

function displayValue(value: CellValue) {
  return value == null || value === "" ? "(vacío)" : String(value);
}

function colorFor(value: CellValue) {
  const text = displayValue(value);
  let hash = 0;
  for (let index = 0; index < text.length; index++) hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  return EXPLORER_COLORS[Math.abs(hash) % EXPLORER_COLORS.length];
}

function samplePoints(points: ExplorerPoint[], groupColumn: string, limit = 4500) {
  if (points.length <= limit) return points;
  const buckets = new Map<string, ExplorerPoint[]>();
  points.forEach((point) => {
    const key = displayValue(point.attributes[groupColumn]), bucket = buckets.get(key) ?? [];
    bucket.push(point); buckets.set(key, bucket);
  });
  const result: ExplorerPoint[] = [];
  buckets.forEach((bucket) => {
    const quota = Math.max(1, Math.floor(limit * bucket.length / points.length)), stride = bucket.length / quota;
    for (let index = 0; index < quota && result.length < limit; index++) result.push(bucket[Math.floor(index * stride)]);
  });
  return result;
}

const textOperators: { value: FilterOperator; label: string }[] = [
  { value: "eq", label: "Es igual a" }, { value: "neq", label: "Es diferente de" },
  { value: "contains", label: "Contiene" }, { value: "starts", label: "Comienza por" },
  { value: "empty", label: "Está vacío" }, { value: "not-empty", label: "No está vacío" },
];
const numericOperators: { value: FilterOperator; label: string }[] = [
  { value: "eq", label: "Es igual a" }, { value: "neq", label: "Es diferente de" },
  { value: "gt", label: "Mayor que" }, { value: "gte", label: "Mayor o igual que" },
  { value: "lt", label: "Menor que" }, { value: "lte", label: "Menor o igual que" },
  { value: "between", label: "Entre" }, { value: "empty", label: "Está vacío" }, { value: "not-empty", label: "No está vacío" },
];

function downloadBuffer(buffer: ArrayBuffer, name: string, mime: string) {
  const url = URL.createObjectURL(new Blob([buffer], { type: mime }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

export default function DataExplorer() {
  const workerRef = useRef<Worker | null>(null), pendingRef = useRef(new Map<number, PendingRequest>()), requestIdRef = useRef(0), boundsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null), latestBoundsRef = useRef<Bounds | null>(null);
  const [pointInfo, setPointInfo] = useState<DataInfo | null>(null), [polygonInfo, setPolygonInfo] = useState<DataInfo | null>(null);
  const [pointColumns, setPointColumns] = useState<ColumnMeta[]>([]), [polygonColumns, setPolygonColumns] = useState<ColumnMeta[]>([]);
  const [points, setPoints] = useState<ExplorerPoint[]>([]), [polygonView, setPolygonView] = useState<ExplorerPolygon[]>([]);
  const [pointExtent, setPointExtent] = useState<Bounds | null>(null), [polygonExtent, setPolygonExtent] = useState<Bounds | null>(null);
  const [polygonViewMeta, setPolygonViewMeta] = useState({ total: 0, limited: false });
  const [filters, setFilters] = useState<FilterRule[]>([]), [filterColumn, setFilterColumn] = useState("");
  const [groupColumn, setGroupColumn] = useState(""), [multiSelect, setMultiSelect] = useState(false);
  const [selectedPointIds, setSelectedPointIds] = useState<Set<string>>(new Set()), [selectedPolygonIds, setSelectedPolygonIds] = useState<Set<string>>(new Set());
  const [editColumn, setEditColumn] = useState(""), [editValue, setEditValue] = useState("");
  const [newColumnName, setNewColumnName] = useState(""), [newColumnKind, setNewColumnKind] = useState<ColumnKind>("text"), [newColumnValue, setNewColumnValue] = useState("");
  const [dropColumn, setDropColumn] = useState("");
  const [busy, setBusy] = useState(""), [progress, setProgress] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [dataVersion, setDataVersion] = useState(0), [openPanel, setOpenPanel] = useState<"filters" | "groups" | "columns" | null>("filters");

  useEffect(() => {
    const worker = new Worker(new URL("./explorer.worker.ts", import.meta.url), { type: "module" });
    const pending = pendingRef.current;
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "progress") { setProgress(message.text ?? "Procesando…"); return; }
      if (message.id == null) return;
      const request = pending.get(message.id); if (!request) return;
      pending.delete(message.id);
      if (message.ok) request.resolve(message.payload); else request.reject(new Error(message.error ?? "No fue posible completar la operación."));
    };
    worker.onerror = () => setError("El explorador geográfico se detuvo. Vuelve a cargar el archivo.");
    return () => { worker.terminate(); pending.forEach(({ reject }) => reject(new Error("El proceso fue cerrado."))); pending.clear(); if (boundsTimerRef.current) clearTimeout(boundsTimerRef.current); };
  }, []);

  const workerCall = useCallback((type: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = []) => new Promise<unknown>((resolve, reject) => {
    const worker = workerRef.current;
    if (!worker) { reject(new Error("El explorador todavía se está iniciando.")); return; }
    const id = ++requestIdRef.current; pendingRef.current.set(id, { resolve, reject }); worker.postMessage({ id, type, payload }, transfer);
  }), []);

  const classify = useCallback(async () => {
    if (!pointInfo || !polygonInfo) return;
    const result = await workerCall("classify") as { inside: number; outside: number; points: ExplorerPoint[] };
    setPoints(result.points); setPointColumns((current) => current.some((column) => column.name === "DENTRO_POLIGONO") ? current : [...current, { name: "DENTRO_POLIGONO", kind: "text", sourceIndex: current.length }]);
    setNotice(`Cobertura calculada: ${result.inside.toLocaleString()} puntos dentro y ${result.outside.toLocaleString()} fuera de los polígonos.`);
  }, [pointInfo, polygonInfo, workerCall]);

  const handlePointsFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file || busy) return;
    setBusy("points"); setError(""); setNotice(""); setProgress("Leyendo el Excel de puntos…");
    try {
      const buffer = await file.arrayBuffer();
      const result = await workerCall("load-points", { buffer, name: file.name }, [buffer]) as { name: string; count: number; skipped: number; columns: ColumnMeta[]; points: ExplorerPoint[]; extent: Bounds };
      setPointInfo({ name: result.name, count: result.count, skipped: result.skipped }); setPointColumns(result.columns); setPoints(result.points); setPointExtent(result.extent);
      const preferred = result.columns.find((column) => normalizeHeader(column.name) === "DIA") ?? result.columns.find((column) => normalizeHeader(column.name) === "MT FINAL") ?? result.columns[0];
      setGroupColumn(preferred?.name ?? ""); setFilterColumn(preferred?.name ?? ""); setFilters([]); setSelectedPointIds(new Set()); setDataVersion((value) => value + 1);
      if (polygonInfo) {
        const coverage = await workerCall("classify") as { inside: number; outside: number; points: ExplorerPoint[] };
        setPoints(coverage.points); setPointColumns((current) => current.some((column) => column.name === "DENTRO_POLIGONO") ? current : [...current, { name: "DENTRO_POLIGONO", kind: "text", sourceIndex: current.length }]);
        setNotice(`Cobertura calculada automáticamente: ${coverage.inside.toLocaleString()} dentro y ${coverage.outside.toLocaleString()} fuera.`);
      }
    } catch (exception) { setError(exception instanceof Error ? exception.message : "No se pudo leer el Excel de puntos."); }
    finally { setBusy(""); setProgress(""); event.target.value = ""; }
  };

  const handlePolygonFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file || busy) return;
    setBusy("polygons"); setError(""); setNotice(""); setProgress("Leyendo la capa de polígonos…");
    try {
      const buffer = await file.arrayBuffer();
      const result = await workerCall("load-polygons", { buffer, name: file.name }, [buffer]) as { name: string; count: number; columns: ColumnMeta[]; extent: Bounds; sourceType: "excel" | "gpkg"; sheetName?: string; layerName?: string; view: { polygons: ExplorerPolygon[]; totalInView: number; limited: boolean } };
      setPolygonInfo({ name: result.name, count: result.count, sourceType: result.sourceType, sheetName: result.sheetName, layerName: result.layerName }); setPolygonColumns(result.columns); setPolygonExtent(result.extent);
      setPolygonView(result.view.polygons); setPolygonViewMeta({ total: result.view.totalInView, limited: result.view.limited }); setSelectedPolygonIds(new Set()); setDataVersion((value) => value + 1);
      if (!pointInfo) {
        const preferred = result.columns.find((column) => /CLASIFIC|ZONA|TIPO/.test(normalizeHeader(column.name))) ?? result.columns[0];
        setGroupColumn(preferred?.name ?? ""); setFilterColumn(preferred?.name ?? ""); setFilters([]);
      } else {
        const coverage = await workerCall("classify") as { inside: number; outside: number; points: ExplorerPoint[] };
        setPoints(coverage.points); setPointColumns((current) => current.some((column) => column.name === "DENTRO_POLIGONO") ? current : [...current, { name: "DENTRO_POLIGONO", kind: "text", sourceIndex: current.length }]);
        setNotice(`Cobertura calculada automáticamente: ${coverage.inside.toLocaleString()} dentro y ${coverage.outside.toLocaleString()} fuera.`);
      }
    } catch (exception) { setError(exception instanceof Error ? exception.message : "No se pudo leer la capa de polígonos."); }
    finally { setBusy(""); setProgress(""); event.target.value = ""; }
  };

  const activeColumns = points.length ? pointColumns : polygonColumns;
  const activeIsPoints = points.length > 0;
  const appliedFilters = useMemo(() => filters.filter((rule) => ["empty", "not-empty"].includes(rule.operator) || rule.value.trim()), [filters]);
  const deferredFilters = useDeferredValue(appliedFilters);
  const filteredPoints = useMemo(() => points.filter((point) => deferredFilters.every((rule) => matchesRule(point.attributes, rule))), [points, deferredFilters]);
  const filteredPolygons = useMemo(() => activeIsPoints ? polygonView : polygonView.filter((polygon) => deferredFilters.every((rule) => matchesRule(polygon.attributes, rule))), [activeIsPoints, polygonView, deferredFilters]);
  const mapPoints = useMemo(() => samplePoints(filteredPoints, groupColumn), [filteredPoints, groupColumn]);
  const mapLimited = filteredPoints.length > mapPoints.length;
  const groupLegend = useMemo(() => {
    const values = new Set<string>();
    if (activeIsPoints) mapPoints.forEach((point) => values.add(displayValue(point.attributes[groupColumn])));
    else filteredPolygons.forEach((polygon) => values.add(displayValue(polygon.attributes[groupColumn])));
    return [...values].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, 40);
  }, [activeIsPoints, mapPoints, filteredPolygons, groupColumn]);
  const initialExtent = pointExtent ?? polygonExtent;
  const selectedCount = selectedPointIds.size + selectedPolygonIds.size;
  const editColumns = selectedPointIds.size ? pointColumns : polygonColumns;
  const pointColor = useCallback((point: ExplorerPoint) => colorFor(point.attributes[groupColumn]), [groupColumn]);
  const polygonColor = useCallback((polygon: ExplorerPolygon) => colorFor(polygon.attributes[groupColumn]), [groupColumn]);

  const addFilter = () => {
    const column = activeColumns.find((candidate) => candidate.name === filterColumn); if (!column) return;
    setFilters((current) => [...current, { id: crypto.randomUUID(), column: column.name, operator: column.kind === "number" ? "gte" : "eq", value: "" }]);
  };
  const updateFilter = (id: string, patch: Partial<FilterRule>) => setFilters((current) => current.map((rule) => rule.id === id ? { ...rule, ...patch } : rule));

  const handleBoundsChange = useCallback((bounds: Bounds) => {
    latestBoundsRef.current = bounds;
    if (!polygonInfo) return;
    if (boundsTimerRef.current) clearTimeout(boundsTimerRef.current);
    boundsTimerRef.current = setTimeout(async () => {
      try {
        const result = await workerCall("polygon-view", { bounds, limit: 2200 }) as { polygons: ExplorerPolygon[]; totalInView: number; limited: boolean };
        setPolygonView(result.polygons); setPolygonViewMeta({ total: result.totalInView, limited: result.limited });
      } catch { /* A newer viewport request or an unload can safely supersede this one. */ }
    }, 220);
  }, [polygonInfo, workerCall]);

  const selectPoint = (point: ExplorerPoint) => { setSelectedPointIds(new Set([point.id])); setSelectedPolygonIds(new Set()); setEditColumn(pointColumns[0]?.name ?? ""); setEditValue(""); };
  const selectPolygon = (polygon: ExplorerPolygon) => {
    setSelectedPointIds(new Set());
    setSelectedPolygonIds((current) => {
      if (!multiSelect) return new Set([polygon.id]);
      const next = new Set(current); if (next.has(polygon.id)) next.delete(polygon.id); else next.add(polygon.id); return next;
    });
    setEditColumn(polygonColumns[0]?.name ?? ""); setEditValue("");
  };
  const selectMultiplePoints = (selected: ExplorerPoint[]) => { setSelectedPointIds(new Set(selected.map((point) => point.id))); setSelectedPolygonIds(new Set()); setEditColumn(pointColumns[0]?.name ?? ""); setEditValue(""); };
  const clearSelection = () => { setSelectedPointIds(new Set()); setSelectedPolygonIds(new Set()); setEditColumn(""); setEditValue(""); };

  const applyEdit = async () => {
    if (!selectedCount || !editColumn || busy) return;
    setBusy("edit"); setError("");
    try {
      if (selectedPointIds.size) {
        const result = await workerCall("edit-points", { ids: [...selectedPointIds], column: editColumn, value: editValue }) as { updates: ExplorerPoint[] };
        const updates = new Map(result.updates.map((point) => [point.id, point])); setPoints((current) => current.map((point) => updates.get(point.id) ?? point));
      } else {
        const result = await workerCall("edit-polygons", { ids: [...selectedPolygonIds], column: editColumn, value: editValue, bounds: latestBoundsRef.current }) as { updates: ExplorerPolygon[]; view?: { polygons: ExplorerPolygon[]; totalInView: number; limited: boolean } };
        if (result.view) { setPolygonView(result.view.polygons); setPolygonViewMeta({ total: result.view.totalInView, limited: result.view.limited }); }
        else { const updates = new Map(result.updates.map((polygon) => [polygon.id, polygon])); setPolygonView((current) => current.map((polygon) => updates.get(polygon.id) ?? polygon)); }
      }
      setNotice(`${selectedCount.toLocaleString()} elemento${selectedCount === 1 ? "" : "s"} actualizado${selectedCount === 1 ? "" : "s"} en “${editColumn}”.`); clearSelection();
    } catch (exception) { setError(exception instanceof Error ? exception.message : "No fue posible aplicar el cambio."); }
    finally { setBusy(""); }
  };

  const addColumn = async () => {
    if (!newColumnName.trim() || busy) return;
    setBusy("column"); setError("");
    try {
      if (activeIsPoints) {
        const result = await workerCall("add-point-column", { name: newColumnName, kind: newColumnKind, value: newColumnValue }) as { columns: ColumnMeta[]; points: ExplorerPoint[] };
        setPointColumns(result.columns); setPoints(result.points);
      } else {
        const result = await workerCall("add-polygon-column", { name: newColumnName, kind: newColumnKind, value: newColumnValue, bounds: latestBoundsRef.current }) as { columns: ColumnMeta[]; view: { polygons: ExplorerPolygon[]; totalInView: number; limited: boolean } };
        setPolygonColumns(result.columns); setPolygonView(result.view.polygons); setPolygonViewMeta({ total: result.view.totalInView, limited: result.view.limited });
      }
      setNotice(`Columna “${newColumnName.trim()}” creada con su valor predeterminado.`); setNewColumnName(""); setNewColumnValue("");
    } catch (exception) { setError(exception instanceof Error ? exception.message : "No fue posible crear la columna."); }
    finally { setBusy(""); }
  };

  const removePolygonColumn = async () => {
    if (!dropColumn || !polygonInfo || busy) return;
    setBusy("drop"); setError("");
    try {
      const result = await workerCall("drop-polygon-column", { column: dropColumn, bounds: latestBoundsRef.current }) as { columns: ColumnMeta[]; view: { polygons: ExplorerPolygon[]; totalInView: number; limited: boolean } };
      setPolygonColumns(result.columns); setPolygonView(result.view.polygons); setPolygonViewMeta({ total: result.view.totalInView, limited: result.view.limited });
      if (groupColumn === dropColumn) setGroupColumn(result.columns[0]?.name ?? "");
      setNotice(`Columna “${dropColumn}” eliminada de la capa exportable.`); setDropColumn("");
    } catch (exception) { setError(exception instanceof Error ? exception.message : "No fue posible eliminar la columna."); }
    finally { setBusy(""); }
  };

  const download = async (target: "points" | "polygons") => {
    if (busy) return; setBusy(`download-${target}`); setError(""); setProgress("Preparando la descarga con tus cambios…");
    try {
      const result = await workerCall(target === "points" ? "download-points" : "download-polygons") as { buffer: ArrayBuffer; name: string; mime?: string };
      downloadBuffer(result.buffer, result.name, result.mime ?? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    } catch (exception) { setError(exception instanceof Error ? exception.message : "No fue posible preparar la descarga."); }
    finally { setBusy(""); setProgress(""); }
  };

  return <section className="explorer-workspace animate-fade-up">
    <div className="explorer-intro"><div><span className="section-kicker"><MapPinned size={14} /> EXPLORADOR GEOGRÁFICO</span><h2>Carga, cruza y edita cualquier base</h2><p>Solo LATITUD y LONGITUD son obligatorias. El resto de columnas se convierte en filtros, colores y campos editables.</p></div><span className="explorer-mode-badge"><Layers3 size={15} /> Espacio independiente</span></div>
    <div className="explorer-upload-grid">
      <label className={`file-card explorer-upload-card${pointInfo ? " loaded" : ""}`}><div className="file-card-top"><i><FileSpreadsheet size={22} /></i>{pointInfo && <span className="ready-badge"><Check size={13} /> {pointInfo.count.toLocaleString()}</span>}</div><strong>Puntos en Excel</strong><p>{pointInfo ? pointInfo.name : "Sube cualquier base para verla y editarla en el mapa"}</p><small>Único requisito: columnas LATITUD y LONGITUD</small><input type="file" accept=".xlsx,.xls" disabled={Boolean(busy)} onChange={handlePointsFile} /></label>
      <label className={`file-card explorer-upload-card${polygonInfo ? " loaded" : ""}`}><div className="file-card-top"><i><Shapes size={22} /></i>{polygonInfo && <span className="ready-badge"><Check size={13} /> {polygonInfo.count.toLocaleString()}</span>}</div><strong>Polígonos</strong><p>{polygonInfo ? polygonInfo.name : "Carga una capa GeoPackage o un Excel con geometría WKT"}</p><small>GPKG EPSG:4326 · Excel WKT · hoja GRID detectada automáticamente</small><input type="file" accept=".gpkg,.xlsx,.xls" disabled={Boolean(busy)} onChange={handlePolygonFile} /></label>
      {pointInfo && polygonInfo && <button className="coverage-action" onClick={classify} disabled={Boolean(busy)}><MapPinned size={18} /><span>Evaluar cobertura<small>Dentro / fuera del polígono</small></span></button>}
    </div>
    {progress && <p className="processing-message"><LoaderCircle className="spin" size={16} /> {progress}</p>}
    {error && <p className="message error">{error}</p>}
    {notice && <p className="message info">{notice}</p>}
    {(pointInfo || polygonInfo) && <div className="explorer-layout">
      <aside className="explorer-rail">
        <div className="explorer-rail-heading"><span>CAPAS Y OPERACIONES</span><strong>{activeIsPoints ? "Trabajando sobre puntos" : "Trabajando sobre polígonos"}</strong></div>
        <div className="explorer-stats"><span><i className={pointInfo ? "active" : ""} /><b>{pointInfo?.count.toLocaleString() ?? "—"}</b> puntos</span><span><i className={polygonInfo ? "active polygon" : ""} /><b>{polygonInfo?.count.toLocaleString() ?? "—"}</b> polígonos</span></div>
        <button className="rail-section-trigger" onClick={() => setOpenPanel(openPanel === "filters" ? null : "filters")}><span><Filter size={15} /> Escoger filtros</span><ChevronDown className={openPanel === "filters" ? "rotated" : ""} size={16} /></button>
        {openPanel === "filters" && <div className="rail-section-body">
          <div className="filter-builder"><select value={filterColumn} onChange={(event) => setFilterColumn(event.target.value)}><option value="">Selecciona una columna</option>{activeColumns.map((column) => <option key={column.name} value={column.name}>{column.name} · {column.kind === "number" ? "numérica" : "texto"}</option>)}</select><button onClick={addFilter} disabled={!filterColumn}><Plus size={15} /> Agregar filtro</button></div>
          {filters.map((rule) => {
            const column = activeColumns.find((candidate) => candidate.name === rule.column), operators = column?.kind === "number" ? numericOperators : textOperators;
            return <div className="filter-rule" key={rule.id}><div><b>{rule.column}</b><button aria-label={`Quitar filtro ${rule.column}`} onClick={() => setFilters((current) => current.filter((candidate) => candidate.id !== rule.id))}><X size={14} /></button></div><select aria-label={`Operador para ${rule.column}`} value={rule.operator} onChange={(event) => updateFilter(rule.id, { operator: event.target.value as FilterOperator })}>{operators.map((operator) => <option value={operator.value} key={operator.value}>{operator.label}</option>)}</select>{!["empty", "not-empty"].includes(rule.operator) && <input aria-label={`Valor para ${rule.column}`} type={column?.kind === "number" ? "number" : "text"} value={rule.value} placeholder="Valor" onChange={(event) => updateFilter(rule.id, { value: event.target.value })} />}{rule.operator === "between" && <input aria-label={`Valor máximo para ${rule.column}`} type="number" value={rule.value2 ?? ""} placeholder="Valor máximo" onChange={(event) => updateFilter(rule.id, { value2: event.target.value })} />}</div>;
          })}
          {!filters.length && <p className="rail-empty">Agrega uno o varios filtros. Todos se aplican al mismo tiempo.</p>}
          {!!filters.length && <button className="clear-filters" onClick={() => setFilters([])}><Trash2 size={14} /> Limpiar filtros</button>}
        </div>}
        <button className="rail-section-trigger" onClick={() => setOpenPanel(openPanel === "groups" ? null : "groups")}><span><Palette size={15} /> Agrupaciones</span><ChevronDown className={openPanel === "groups" ? "rotated" : ""} size={16} /></button>
        {openPanel === "groups" && <div className="rail-section-body"><label className="rail-label"><span>Colorear el mapa por</span><select value={groupColumn} onChange={(event) => setGroupColumn(event.target.value)}>{activeColumns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select></label><p className="rail-empty">Cada valor diferente recibe un color estable en el mapa.</p></div>}
        <button className="rail-section-trigger" onClick={() => setOpenPanel(openPanel === "columns" ? null : "columns")}><span><Columns3 size={15} /> Columnas</span><ChevronDown className={openPanel === "columns" ? "rotated" : ""} size={16} /></button>
        {openPanel === "columns" && <div className="rail-section-body"><label className="rail-label"><span>Nueva columna</span><input value={newColumnName} placeholder="Ej. REVISADO" onChange={(event) => setNewColumnName(event.target.value)} /></label><div className="column-pair"><select value={newColumnKind} onChange={(event) => setNewColumnKind(event.target.value as ColumnKind)}><option value="text">Texto</option><option value="number">Número</option><option value="boolean">Sí / No</option></select><input value={newColumnValue} type={newColumnKind === "number" ? "number" : "text"} placeholder="Valor por defecto" onChange={(event) => setNewColumnValue(event.target.value)} /></div><button className="rail-primary" onClick={addColumn} disabled={!newColumnName.trim() || Boolean(busy)}><Plus size={15} /> Crear para todos</button>{polygonInfo && !pointInfo && <><div className="rail-divider" /><label className="rail-label"><span>Eliminar columna del polígono</span><select value={dropColumn} onChange={(event) => setDropColumn(event.target.value)}><option value="">Selecciona una columna</option>{polygonColumns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select></label><button className="rail-danger" onClick={removePolygonColumn} disabled={!dropColumn || Boolean(busy)}><Trash2 size={14} /> Eliminar columna</button></>}</div>}
      </aside>
      <section className="explorer-canvas">
        <div className="explorer-map-heading"><div><span className="section-kicker"><MapPinned size={14} /> VISTA ESPACIAL</span><h2>{groupColumn ? `Color por ${groupColumn}` : "Mapa de datos"}</h2><p>{activeIsPoints ? `${filteredPoints.length.toLocaleString()} puntos después de filtros` : `${filteredPolygons.length.toLocaleString()} polígonos visibles`}</p></div><div className="explorer-map-actions"><button className={multiSelect ? "active" : ""} onClick={() => { setMultiSelect((value) => !value); clearSelection(); }} disabled={activeIsPoints && mapLimited}><BoxSelect size={16} /> Selección múltiple</button></div></div>
        {mapLimited && <p className="map-performance-note">Vista rápida: se muestran {mapPoints.length.toLocaleString()} de {filteredPoints.length.toLocaleString()} puntos. Aplica filtros para activar la selección múltiple sobre todos los resultados.</p>}
        {polygonViewMeta.limited && <p className="polygon-performance-note">Se dibujan {polygonView.length.toLocaleString()} de {polygonViewMeta.total.toLocaleString()} polígonos en esta vista. Acércate para ver el detalle completo.</p>}
        {multiSelect && <p className="map-selection-help"><BoxSelect size={15} /> {activeIsPoints ? "Arrastra un rectángulo sobre los puntos que deseas editar." : "Haz clic en varios polígonos para agregarlos o quitarlos de la selección."}</p>}
        <ExplorerMap points={mapPoints} polygons={filteredPolygons} pointColor={pointColor} polygonColor={polygonColor} selectedPointIds={selectedPointIds} selectedPolygonIds={selectedPolygonIds} multiSelect={multiSelect} onPointClick={selectPoint} onPolygonClick={selectPolygon} onMultiSelect={selectMultiplePoints} onBoundsChange={handleBoundsChange} extent={initialExtent} extentKey={`${dataVersion}-${pointInfo?.name ?? ""}-${polygonInfo?.name ?? ""}`} />
        <div className="explorer-legend"><span>Agrupado por <b>{groupColumn || "sin agrupación"}</b></span><div>{groupLegend.map((value) => <i key={value}><em style={{ background: colorFor(value) }} />{value}</i>)}{groupLegend.length >= 40 && <i>+ más valores</i>}</div></div>
      </section>
    </div>}
    {(pointInfo || polygonInfo) && <div className="explorer-download-bar"><div><Save size={20} /><span><b>Tus cambios quedan en el archivo final</b><small>Filtros y colores solo cambian la vista; las ediciones y nuevas columnas sí se guardan.</small></span></div><div>{pointInfo && <button onClick={() => download("points")} disabled={Boolean(busy)}><Download size={16} /> Descargar puntos</button>}{polygonInfo && <button className="secondary" onClick={() => download("polygons")} disabled={Boolean(busy)}><Download size={16} /> Descargar polígonos</button>}</div></div>}
    {!!selectedCount && <aside className="editor explorer-editor animate-pop-in"><button className="editor-close" aria-label="Cerrar" onClick={clearSelection}><X size={20} /></button><span className="section-kicker">EDICIÓN DE ATRIBUTOS</span><h3>{selectedCount.toLocaleString()} {selectedPointIds.size ? "punto" : "polígono"}{selectedCount === 1 ? "" : "s"}</h3><p>Elige cualquier columna y escribe el valor que deben recibir los elementos seleccionados.</p><label><span>Columna a modificar</span><select value={editColumn} onChange={(event) => setEditColumn(event.target.value)}><option value="">Selecciona una columna</option>{editColumns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select></label><label><span>Nuevo valor</span><input type={editColumns.find((column) => column.name === editColumn)?.kind === "number" ? "number" : "text"} value={editValue} onChange={(event) => setEditValue(event.target.value)} placeholder="Escribe el nuevo valor" /></label><button className="bulk-apply" onClick={applyEdit} disabled={!editColumn || Boolean(busy)}>{busy === "edit" ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} Aplicar cambio</button><small>La modificación se verá de inmediato y se incluirá en la descarga.</small></aside>}
  </section>;
}
