/// <reference lib="webworker" />

import * as XLSX from "xlsx";
import initSqlJs, { type Database } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { boundsIntersect, findCoordinateColumns, geoPackageEnvelope, geometryBounds, inferColumnKind, normalizeHeader, parseGeoPackageBinary, parseWktGeometry, pointInGeometry, simplifyGeometry, type CellValue, type ColumnKind, type ColumnMeta, type ExplorerPoint, type ExplorerPolygon } from "./explorer-core";

type WorkerRequest = { id: number; type: string; payload?: Record<string, unknown> };
type Bounds = [number, number, number, number];
type SheetState = { workbook: XLSX.WorkBook; sheetName: string; headerRow: number; headers: string[] };

let pointSheet: SheetState | null = null;
let pointColumns: ColumnMeta[] = [];
let points: ExplorerPoint[] = [];
let pointFileName = "PUNTOS_EDITADOS.xlsx";
let pointLatitudeColumn = "";
let pointLongitudeColumn = "";
let polygonSheet: SheetState | null = null;
let polygonColumns: ColumnMeta[] = [];
let polygons: ExplorerPolygon[] = [];
let polygonExtent: Bounds | null = null;
let polygonFileName = "POLIGONOS_EDITADOS.xlsx";
let gpkgDb: Database | null = null;
let gpkgTable = "";
let gpkgGeometryColumn = "";
let gpkgPrimaryKey = "";
let gpkgCount = 0;
let gpkgIndex: { id: string; bbox: Bounds }[] = [];

function progress(text: string) {
  self.postMessage({ type: "progress", text });
}

function uniqueHeaders(values: unknown[]): string[] {
  const seen = new Map<string, number>();
  return values.map((value, index) => {
    const base = String(value ?? "").trim() || `Columna ${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base} (${count + 1})` : base;
  });
}

function findHeaderRow(rows: unknown[][], requiresCoordinates: boolean): number {
  let best = 0, bestScore = -1;
  rows.slice(0, 30).forEach((row, index) => {
    const headers = row.map((value) => String(value ?? ""));
    const coordinates = findCoordinateColumns(headers);
    const coordinateScore = coordinates.latitude != null && coordinates.latitude >= 0 && coordinates.longitude != null && coordinates.longitude >= 0 ? 10000 : 0;
    const score = row.filter((value) => String(value ?? "").trim()).length + coordinateScore;
    if (score > bestScore && (!requiresCoordinates || coordinateScore > 0)) { best = index; bestScore = score; }
  });
  if (requiresCoordinates && bestScore < 10000) throw new Error("No se encontraron las columnas LATITUD y LONGITUD. Son las únicas columnas obligatorias.");
  return best;
}

function asCellValue(value: unknown): CellValue {
  if (value == null || value === "") return value === "" ? "" : null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

function parseWorkbook(buffer: ArrayBuffer) {
  return XLSX.read(buffer, { type: "array", dense: false, cellStyles: false, cellFormula: true, cellHTML: false, cellNF: false });
}

function sheetRows(workbook: XLSX.WorkBook, sheetName: string): unknown[][] {
  return XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true, blankrows: false });
}

function buildColumns(headers: string[], dataRows: unknown[][]): ColumnMeta[] {
  return headers.map((name, sourceIndex) => ({ name, sourceIndex, kind: inferColumnKind(dataRows.slice(0, 500).map((row) => asCellValue(row[sourceIndex]))) }));
}

function worksheetSet(sheet: SheetState, rowIndex: number, columnIndex: number, value: CellValue) {
  const worksheet = sheet.workbook.Sheets[sheet.sheetName];
  const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
  worksheet[address] = value == null ? { t: "z", v: undefined } : typeof value === "number" ? { t: "n", v: value } : typeof value === "boolean" ? { t: "b", v: value } : { t: "s", v: value };
  const range = XLSX.utils.decode_range(worksheet["!ref"] ?? address);
  range.e.r = Math.max(range.e.r, rowIndex); range.e.c = Math.max(range.e.c, columnIndex);
  worksheet["!ref"] = XLSX.utils.encode_range(range);
}

function pointBounds(): Bounds | null {
  if (!points.length) return null;
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  points.forEach((point) => { west = Math.min(west, point.lng); south = Math.min(south, point.lat); east = Math.max(east, point.lng); north = Math.max(north, point.lat); });
  return [west, south, east, north];
}

function mergeExtent(current: Bounds | null, next: Bounds): Bounds {
  return current ? [Math.min(current[0], next[0]), Math.min(current[1], next[1]), Math.max(current[2], next[2]), Math.max(current[3], next[3])] : next;
}

function polygonView(bounds?: Bounds, limit = 2200): { polygons: ExplorerPolygon[]; totalInView: number; limited: boolean } {
  if (gpkgDb && gpkgIndex.length) {
    const candidates = bounds ? gpkgIndex.filter((entry) => boundsIntersect(entry.bbox, bounds)) : gpkgIndex;
    const stride = candidates.length > limit ? candidates.length / limit : 1;
    const selected = candidates.length > limit ? Array.from({ length: limit }, (_, index) => candidates[Math.floor(index * stride)]) : candidates;
    const view: ExplorerPolygon[] = [];
    for (let start = 0; start < selected.length; start += 400) {
      const ids = selected.slice(start, start + 400).map((entry) => entry.id), placeholders = ids.map(() => "?").join(",");
      const statement = gpkgDb.prepare(`SELECT * FROM ${sqlQuote(gpkgTable)} WHERE ${sqlQuote(gpkgPrimaryKey)} IN (${placeholders})`);
      statement.bind(ids);
      while (statement.step()) {
        const row = statement.getAsObject(), blob = row[gpkgGeometryColumn];
        const geometry = blob instanceof Uint8Array ? parseGeoPackageBinary(blob) : null;
        if (!geometry) continue;
        const attributes: Record<string, CellValue> = {};
        polygonColumns.forEach((column) => { attributes[column.name] = sqlCell(row[column.name]); });
        view.push({ id: String(row[gpkgPrimaryKey]), rowIndex: view.length, bbox: geometryBounds(geometry), geometry: simplifyGeometry(geometry, 90), attributes });
      }
      statement.free();
    }
    return { polygons: view, totalInView: candidates.length, limited: candidates.length > view.length };
  }
  const candidates = bounds ? polygons.filter((polygon) => boundsIntersect(polygon.bbox, bounds)) : polygons;
  const stride = candidates.length > limit ? candidates.length / limit : 1;
  const view = candidates.length > limit
    ? Array.from({ length: limit }, (_, index) => candidates[Math.floor(index * stride)])
    : candidates;
  return {
    polygons: view.map((polygon) => ({ ...polygon, geometry: simplifyGeometry(polygon.geometry, 90) })),
    totalInView: candidates.length,
    limited: candidates.length > view.length,
  };
}

function addPointColumn(name: string, kind: ColumnKind, defaultValue: CellValue) {
  if (!pointSheet) throw new Error("Primero carga un Excel de puntos.");
  if (pointColumns.some((column) => normalizeHeader(column.name) === normalizeHeader(name))) throw new Error(`La columna “${name}” ya existe.`);
  const sourceIndex = pointSheet.headers.length;
  pointSheet.headers.push(name); pointColumns.push({ name, kind, sourceIndex });
  worksheetSet(pointSheet, pointSheet.headerRow, sourceIndex, name);
  points.forEach((point) => { point.attributes[name] = defaultValue; worksheetSet(pointSheet!, point.rowIndex, sourceIndex, defaultValue); });
}

function classifyPoints(): { inside: number; outside: number } {
  if (!points.length || (!polygons.length && !gpkgDb)) throw new Error("Carga puntos y polígonos antes de evaluar la cobertura.");
  const polygonCount = gpkgDb ? gpkgCount : polygons.length;
  progress(`Evaluando ${points.length.toLocaleString()} puntos contra ${polygonCount.toLocaleString()} polígonos…`);
  if (!pointColumns.some((column) => column.name === "DENTRO_POLIGONO")) addPointColumn("DENTRO_POLIGONO", "text", "Fuera");
  const coverageColumn = pointColumns.find((column) => column.name === "DENTRO_POLIGONO")!;
  let inside = 0;
  if (gpkgDb && gpkgIndex.length) {
    const extent = polygonExtent!, area = Math.max(0.0001, (extent[2] - extent[0]) * (extent[3] - extent[1]));
    const cellSize = Math.max(0.003, Math.min(1, Math.sqrt(area / gpkgIndex.length) * 2.2));
    const grid = new Map<string, number[]>(), oversized: number[] = [];
    const cell = (value: number, origin: number) => Math.floor((value - origin) / cellSize);
    gpkgIndex.forEach((entry, index) => {
      const x0 = cell(entry.bbox[0], extent[0]), x1 = cell(entry.bbox[2], extent[0]), y0 = cell(entry.bbox[1], extent[1]), y1 = cell(entry.bbox[3], extent[1]);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) { oversized.push(index); return; }
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const key = `${x}:${y}`, list = grid.get(key) ?? []; list.push(index); grid.set(key, list); }
    });
    const statement = gpkgDb.prepare(`SELECT ${sqlQuote(gpkgGeometryColumn)} AS geometry FROM ${sqlQuote(gpkgTable)} WHERE ${sqlQuote(gpkgPrimaryKey)} = ?`);
    const cache = new Map<string, number[][][][]>();
    points.forEach((point, index) => {
      const candidateIndexes = [...(grid.get(`${cell(point.lng, extent[0])}:${cell(point.lat, extent[1])}`) ?? []), ...oversized];
      const isInside = candidateIndexes.some((candidateIndex) => {
        const entry = gpkgIndex[candidateIndex], [west, south, east, north] = entry.bbox;
        if (point.lng < west || point.lng > east || point.lat < south || point.lat > north) return false;
        let geometry = cache.get(entry.id);
        if (!geometry) {
          statement.bind([entry.id]);
          if (statement.step()) {
            const blob = statement.getAsObject().geometry;
            geometry = blob instanceof Uint8Array ? parseGeoPackageBinary(blob) ?? undefined : undefined;
          }
          statement.reset();
          if (geometry) {
            if (cache.size >= 1500) cache.delete(cache.keys().next().value!);
            cache.set(entry.id, geometry);
          }
        }
        return Boolean(geometry && pointInGeometry(point.lng, point.lat, geometry));
      });
      point.coverage = isInside ? "Dentro" : "Fuera"; point.attributes.DENTRO_POLIGONO = point.coverage;
      worksheetSet(pointSheet!, point.rowIndex, coverageColumn.sourceIndex, point.coverage); if (isInside) inside++;
      if ((index + 1) % 5000 === 0) progress(`Evaluando cobertura… ${(index + 1).toLocaleString()} de ${points.length.toLocaleString()}`);
    });
    statement.free();
  } else {
    const extent = polygonExtent!;
    const area = Math.max(0.0001, (extent[2] - extent[0]) * (extent[3] - extent[1]));
    const cellSize = Math.max(0.003, Math.min(1, Math.sqrt(area / Math.max(1, polygons.length)) * 2.2));
    const grid = new Map<string, number[]>(), oversized: number[] = [];
    const cell = (value: number, origin: number) => Math.floor((value - origin) / cellSize);
    polygons.forEach((polygon, index) => {
      const x0 = cell(polygon.bbox[0], extent[0]), x1 = cell(polygon.bbox[2], extent[0]), y0 = cell(polygon.bbox[1], extent[1]), y1 = cell(polygon.bbox[3], extent[1]);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) { oversized.push(index); return; }
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const key = `${x}:${y}`, list = grid.get(key) ?? []; list.push(index); grid.set(key, list); }
    });
    points.forEach((point) => {
      const candidates = [...(grid.get(`${cell(point.lng, extent[0])}:${cell(point.lat, extent[1])}`) ?? []), ...oversized];
      const isInside = candidates.some((index) => { const polygon = polygons[index], [west, south, east, north] = polygon.bbox; return point.lng >= west && point.lng <= east && point.lat >= south && point.lat <= north && pointInGeometry(point.lng, point.lat, polygon.geometry); });
      point.coverage = isInside ? "Dentro" : "Fuera"; point.attributes.DENTRO_POLIGONO = point.coverage;
      worksheetSet(pointSheet!, point.rowIndex, coverageColumn.sourceIndex, point.coverage); if (isInside) inside++;
    });
  }
  return { inside, outside: points.length - inside };
}

function parseTypedValue(value: unknown, kind: ColumnKind): CellValue {
  if (value == null || value === "") return "";
  if (kind === "number") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error("El valor debe ser numérico para esta columna.");
    return parsed;
  }
  if (kind === "boolean") return value === true || String(value).toLocaleLowerCase() === "true" || String(value).toLocaleLowerCase() === "sí";
  return String(value);
}

function sqlQuote(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function sqlCell(value: unknown): CellValue {
  if (value == null || typeof value === "string" || typeof value === "number") return value as CellValue;
  return String(value);
}

async function loadPoints(buffer: ArrayBuffer, name: string) {
  progress("Reconociendo columnas y coordenadas…");
  const workbook = parseWorkbook(buffer), sheetName = workbook.SheetNames[0], rows = sheetRows(workbook, sheetName);
  const headerRow = findHeaderRow(rows, true), headers = uniqueHeaders(rows[headerRow] ?? []), coordinateColumns = findCoordinateColumns(headers);
  const dataRows = rows.slice(headerRow + 1), columns = buildColumns(headers, dataRows);
  const latitudeIndex = coordinateColumns.latitude!, longitudeIndex = coordinateColumns.longitude!;
  columns[latitudeIndex].kind = "number"; columns[longitudeIndex].kind = "number";
  const parsed: ExplorerPoint[] = [];
  dataRows.forEach((row, offset) => {
    const lat = Number(row[latitudeIndex]), lng = Number(row[longitudeIndex]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    const attributes: Record<string, CellValue> = {};
    headers.forEach((header, index) => { attributes[header] = asCellValue(row[index]); });
    parsed.push({ id: `p-${headerRow + 1 + offset}`, rowIndex: headerRow + 1 + offset, lat, lng, attributes });
  });
  if (!parsed.length) throw new Error("Las columnas de coordenadas existen, pero no contienen puntos válidos.");
  pointSheet = { workbook, sheetName, headerRow, headers };
  pointColumns = columns; pointLatitudeColumn = headers[latitudeIndex]; pointLongitudeColumn = headers[longitudeIndex]; points = parsed; pointFileName = name.replace(/\.xlsx?$/i, "") + "_EDITADO.xlsx";
  return { name, count: parsed.length, skipped: dataRows.length - parsed.length, columns, points: parsed, extent: pointBounds() };
}

async function loadPolygonExcel(buffer: ArrayBuffer, name: string) {
  progress("Buscando geometrías WKT en las hojas del Excel…");
  const workbook = parseWorkbook(buffer);
  const orderedSheets = [...workbook.SheetNames].sort((a, b) => (normalizeHeader(a) === "GRID" ? -1 : normalizeHeader(b) === "GRID" ? 1 : 0));
  let selected: { sheetName: string; rows: unknown[][]; headerRow: number; headers: string[]; wktIndex: number } | null = null;
  for (const sheetName of orderedSheets) {
    const rows = sheetRows(workbook, sheetName);
    const headerRow = findHeaderRow(rows, false), headers = uniqueHeaders(rows[headerRow] ?? []);
    const wktIndex = headers.findIndex((header) => ["WKT", "WKT GEOM", "GEOMETRY", "GEOMETRIA"].includes(normalizeHeader(header)));
    if (wktIndex >= 0) { selected = { sheetName, rows, headerRow, headers, wktIndex }; break; }
  }
  if (!selected) throw new Error("No se encontró una columna WKT o wkt_geom en ninguna hoja del Excel.");
  const dataRows = selected.rows.slice(selected.headerRow + 1), columns = buildColumns(selected.headers, dataRows);
  const parsed: ExplorerPolygon[] = []; let extent: Bounds | null = null;
  dataRows.forEach((row, offset) => {
    const geometry = parseWktGeometry(row[selected!.wktIndex]);
    if (!geometry) return;
    const bbox = geometryBounds(geometry), attributes: Record<string, CellValue> = {};
    selected!.headers.forEach((header, index) => { attributes[header] = asCellValue(row[index]); });
    parsed.push({ id: `g-${selected!.headerRow + 1 + offset}`, rowIndex: selected!.headerRow + 1 + offset, bbox, geometry, attributes });
    extent = mergeExtent(extent, bbox);
  });
  if (!parsed.length) throw new Error("La columna WKT existe, pero no contiene polígonos válidos.");
  polygonSheet = { workbook, sheetName: selected.sheetName, headerRow: selected.headerRow, headers: selected.headers };
  gpkgDb = null; gpkgTable = ""; gpkgGeometryColumn = ""; gpkgPrimaryKey = ""; gpkgCount = 0; gpkgIndex = [];
  polygonColumns = columns; polygons = parsed; polygonExtent = extent; polygonFileName = name.replace(/\.xlsx?$/i, "") + "_EDITADO.xlsx";
  const focus = pointBounds() ?? extent!;
  return { name, count: parsed.length, columns, extent, sourceType: "excel", sheetName: selected.sheetName, view: polygonView(focus) };
}

async function loadGeoPackage(buffer: ArrayBuffer, name: string) {
  progress("Abriendo el GeoPackage en segundo plano…");
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const db = new SQL.Database(new Uint8Array(buffer));
  const content = db.exec("SELECT c.table_name, g.column_name, g.srs_id FROM gpkg_contents c JOIN gpkg_geometry_columns g ON g.table_name = c.table_name WHERE c.data_type = 'features' ORDER BY c.table_name LIMIT 1");
  if (!content.length || !content[0].values.length) throw new Error("El GeoPackage no contiene una capa vectorial de polígonos.");
  const [tableName, geometryColumn, srsId] = content[0].values[0].map(String);
  if (Number(srsId) !== 4326) throw new Error(`La capa usa EPSG:${srsId}. Por ahora los polígonos deben estar en WGS84 / EPSG:4326.`);
  const tableInfo = db.exec(`PRAGMA table_info(${sqlQuote(tableName)})`)[0];
  const definitions = tableInfo.values.map((row) => ({ name: String(row[1]), type: String(row[2]).toUpperCase(), pk: Number(row[5]) > 0 }));
  const primaryKey = definitions.find((definition) => definition.pk)?.name ?? definitions.find((definition) => normalizeHeader(definition.name) === "FID")?.name;
  if (!primaryKey) throw new Error("No se encontró una llave primaria para editar la capa del GeoPackage.");
  const columns = definitions.filter((definition) => definition.name !== geometryColumn).map((definition, sourceIndex) => ({ name: definition.name, sourceIndex, kind: /INT|REAL|DOUBLE|FLOAT|NUM/.test(definition.type) ? "number" as const : "text" as const }));
  progress("Indexando los límites de los polígonos sin cargar toda su geometría…");
  const indexStatement = db.prepare(`SELECT ${sqlQuote(primaryKey)} AS feature_id, ${sqlQuote(geometryColumn)} AS geometry FROM ${sqlQuote(tableName)}`);
  const index: { id: string; bbox: Bounds }[] = []; let extent: Bounds | null = null, scanned = 0;
  while (indexStatement.step()) {
    const row = indexStatement.getAsObject(), blob = row.geometry;
    const bbox = blob instanceof Uint8Array ? geoPackageEnvelope(blob) : null;
    if (bbox) { index.push({ id: String(row.feature_id), bbox }); extent = mergeExtent(extent, bbox); }
    scanned++;
    if (scanned % 10000 === 0) progress(`Indexando polígonos… ${scanned.toLocaleString()}`);
  }
  indexStatement.free();
  const count = index.length;
  if (!count || !extent) { db.close(); throw new Error("La capa encontrada no contiene polígonos compatibles."); }
  gpkgDb?.close(); gpkgDb = db; gpkgTable = tableName; gpkgGeometryColumn = geometryColumn; gpkgPrimaryKey = primaryKey;
  gpkgCount = count; gpkgIndex = index; polygonSheet = null; polygonColumns = columns; polygons = []; polygonExtent = extent; polygonFileName = name.replace(/\.gpkg$/i, "") + "_EDITADO.gpkg";
  const focus = pointBounds() ?? extent;
  return { name, count, columns, extent, sourceType: "gpkg", layerName: tableName, view: polygonView(focus) };
}

function addPolygonColumn(name: string, kind: ColumnKind, defaultValue: CellValue) {
  if (!polygons.length && !gpkgDb) throw new Error("Primero carga una capa de polígonos.");
  if (polygonColumns.some((column) => normalizeHeader(column.name) === normalizeHeader(name))) throw new Error(`La columna “${name}” ya existe.`);
  const sourceIndex = polygonColumns.length;
  polygonColumns.push({ name, kind, sourceIndex });
  polygons.forEach((polygon) => { polygon.attributes[name] = defaultValue; });
  if (polygonSheet) {
    polygonSheet.headers.push(name); worksheetSet(polygonSheet, polygonSheet.headerRow, polygonSheet.headers.length - 1, name);
    polygons.forEach((polygon) => worksheetSet(polygonSheet!, polygon.rowIndex, polygonSheet!.headers.length - 1, defaultValue));
  } else if (gpkgDb) {
    const sqlType = kind === "number" ? "REAL" : kind === "boolean" ? "INTEGER" : "TEXT";
    gpkgDb.run(`ALTER TABLE ${sqlQuote(gpkgTable)} ADD COLUMN ${sqlQuote(name)} ${sqlType}`);
    gpkgDb.run(`UPDATE ${sqlQuote(gpkgTable)} SET ${sqlQuote(name)} = ?`, [defaultValue as string | number | null]);
  }
}

function dropPolygonColumn(name: string) {
  const column = polygonColumns.find((candidate) => candidate.name === name);
  if (!column) throw new Error("No se encontró la columna seleccionada.");
  if (name === gpkgPrimaryKey || name === gpkgGeometryColumn || ["FID", "WKT GEOM", "WKT"].includes(normalizeHeader(name))) throw new Error("Esta columna estructural no se puede eliminar.");
  if (polygonSheet) {
    const headers = polygonSheet.headers.filter((header) => header !== name);
    const rows = sheetRows(polygonSheet.workbook, polygonSheet.sheetName);
    const rebuilt = rows.map((row, rowIndex) => rowIndex < polygonSheet!.headerRow ? row : row.filter((_, columnIndex) => columnIndex !== column.sourceIndex));
    polygonSheet.workbook.Sheets[polygonSheet.sheetName] = XLSX.utils.aoa_to_sheet(rebuilt);
    polygonSheet.headers = headers;
    polygonColumns = polygonColumns.filter((candidate) => candidate.name !== name).map((candidate, index) => ({ ...candidate, sourceIndex: index }));
  } else if (gpkgDb) {
    gpkgDb.run(`ALTER TABLE ${sqlQuote(gpkgTable)} DROP COLUMN ${sqlQuote(name)}`);
    polygonColumns = polygonColumns.filter((candidate) => candidate.name !== name).map((candidate, index) => ({ ...candidate, sourceIndex: index }));
  }
  polygons.forEach((polygon) => { delete polygon.attributes[name]; });
}

function workbookBuffer(workbook: XLSX.WorkBook): ArrayBuffer {
  const output = XLSX.write(workbook, { type: "array", bookType: "xlsx", compression: true }) as ArrayBuffer | Uint8Array;
  if (output instanceof ArrayBuffer) return output;
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
}

async function handleRequest(request: WorkerRequest) {
  const payload = request.payload ?? {};
  if (request.type === "load-points") return loadPoints(payload.buffer as ArrayBuffer, String(payload.name ?? "PUNTOS.xlsx"));
  if (request.type === "load-polygons") {
    const buffer = payload.buffer as ArrayBuffer, name = String(payload.name ?? "POLIGONOS.xlsx");
    return /\.gpkg$/i.test(name) ? loadGeoPackage(buffer, name) : loadPolygonExcel(buffer, name);
  }
  if (request.type === "polygon-view") return polygonView(payload.bounds as Bounds | undefined, Math.max(200, Math.min(3500, Number(payload.limit) || 2200)));
  if (request.type === "classify") return { ...classifyPoints(), points };
  if (request.type === "edit-points") {
    const ids = new Set((payload.ids as string[] | undefined) ?? []), column = pointColumns.find((candidate) => candidate.name === payload.column);
    if (!column || !pointSheet) throw new Error("Selecciona una columna válida.");
    const value = parseTypedValue(payload.value, column.kind), updates: ExplorerPoint[] = [];
    if (column.name === pointLatitudeColumn && (value === "" || Math.abs(Number(value)) > 90)) throw new Error("La latitud debe ser un número entre -90 y 90.");
    if (column.name === pointLongitudeColumn && (value === "" || Math.abs(Number(value)) > 180)) throw new Error("La longitud debe ser un número entre -180 y 180.");
    points.forEach((point) => { if (ids.has(point.id)) {
      point.attributes[column.name] = value;
      if (column.name === pointLatitudeColumn) point.lat = Number(value);
      if (column.name === pointLongitudeColumn) point.lng = Number(value);
      worksheetSet(pointSheet!, point.rowIndex, column.sourceIndex, value); updates.push(point);
    } });
    return { updates };
  }
  if (request.type === "add-point-column") {
    const name = String(payload.name ?? "").trim(), kind = payload.kind as ColumnKind;
    if (!name) throw new Error("Escribe el nombre de la nueva columna.");
    addPointColumn(name, kind, parseTypedValue(payload.value, kind));
    return { columns: pointColumns, points };
  }
  if (request.type === "edit-polygons") {
    const ids = new Set((payload.ids as string[] | undefined) ?? []), column = polygonColumns.find((candidate) => candidate.name === payload.column);
    if (!column) throw new Error("Selecciona una columna válida.");
    const value = parseTypedValue(payload.value, column.kind), updates: ExplorerPolygon[] = [];
    polygons.forEach((polygon) => { if (ids.has(polygon.id)) { polygon.attributes[column.name] = value; updates.push({ ...polygon, geometry: simplifyGeometry(polygon.geometry, 90) }); } });
    if (polygonSheet) updates.forEach((polygon) => worksheetSet(polygonSheet!, polygon.rowIndex, column.sourceIndex, value));
    else if (gpkgDb && ids.size) {
      const statement = gpkgDb.prepare(`UPDATE ${sqlQuote(gpkgTable)} SET ${sqlQuote(column.name)} = ? WHERE ${sqlQuote(gpkgPrimaryKey)} = ?`);
      ids.forEach((id) => { statement.run([value as string | number | null, id]); statement.reset(); }); statement.free();
      const view = polygonView(payload.bounds as Bounds | undefined);
      return { updates: view.polygons.filter((polygon) => ids.has(polygon.id)), view };
    }
    return { updates };
  }
  if (request.type === "add-polygon-column") {
    const name = String(payload.name ?? "").trim(), kind = payload.kind as ColumnKind;
    if (!name) throw new Error("Escribe el nombre de la nueva columna.");
    addPolygonColumn(name, kind, parseTypedValue(payload.value, kind));
    return { columns: polygonColumns, view: polygonView(payload.bounds as Bounds | undefined) };
  }
  if (request.type === "drop-polygon-column") {
    dropPolygonColumn(String(payload.column));
    return { columns: polygonColumns, view: polygonView(payload.bounds as Bounds | undefined) };
  }
  if (request.type === "download-points") {
    if (!pointSheet) throw new Error("No hay un Excel de puntos para descargar.");
    progress("Preparando el Excel con todos los cambios…");
    return { buffer: workbookBuffer(pointSheet.workbook), name: pointFileName };
  }
  if (request.type === "download-polygons") {
    progress("Preparando la capa de polígonos editada…");
    if (polygonSheet) return { buffer: workbookBuffer(polygonSheet.workbook), name: polygonFileName, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
    if (gpkgDb) {
      const bytes = gpkgDb.export(), buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      return { buffer, name: polygonFileName, mime: "application/geopackage+sqlite3" };
    }
    throw new Error("No hay una capa de polígonos para descargar.");
  }
  throw new Error("Operación no reconocida.");
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    const payload = await handleRequest(request);
    const transfer: Transferable[] = [];
    if (payload && typeof payload === "object" && "buffer" in payload && payload.buffer instanceof ArrayBuffer) transfer.push(payload.buffer);
    self.postMessage({ id: request.id, ok: true, payload }, transfer);
  } catch (error) {
    self.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : "No fue posible completar la operación." });
  }
};
