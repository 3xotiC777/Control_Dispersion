/// <reference lib="webworker" />

import * as XLSX from "xlsx";
import { assign, baseColumns, extractAssignedPoints, extractForecast, extractPoints, finalizeAssignment, forecastMtColumn, key, operationalMt, planningModeFromRows, refreshAverages, runRoadQa, runSmartRoadQa, type Forecast, type Notice, type PlanningMode, type Point, type Raw } from "./planning-core";

type WorkerRequest = { id: number; type: "load-base" | "load-forecast" | "load-assigned" | "calculate" | "move" | "bulk-move" | "qa" | "download"; payload?: Record<string, unknown> };

let baseBuffer: ArrayBuffer | null = null;
let baseCount = 0;
let forecast: Forecast | null = null;
let currentPoints: Point[] = [];

function progress(text: string) {
  self.postMessage({ type: "progress", text });
}

function parseWorkbook(buffer: ArrayBuffer) {
  const workbook = XLSX.read(buffer, { type: "array", dense: true, cellStyles: false, cellFormula: false, cellHTML: false, cellNF: false });
  return XLSX.utils.sheet_to_json<Raw>(workbook.Sheets[workbook.SheetNames[0]], { defval: "", raw: true });
}

async function handleRequest(request: WorkerRequest) {
  const payload = request.payload ?? {};
  if (request.type === "load-base") {
    progress("Leyendo la base en segundo plano…");
    const buffer = payload.buffer as ArrayBuffer;
    const rows = parseWorkbook(buffer);
    baseColumns(rows);
    baseBuffer = buffer;
    baseCount = rows.length;
    currentPoints = [];
    return { count: rows.length };
  }
  if (request.type === "load-assigned") {
    progress("Leyendo la base asignada en segundo plano…");
    const buffer = payload.buffer as ArrayBuffer;
    const rows = parseWorkbook(buffer);
    baseBuffer = buffer;
    baseCount = rows.length;
    const extracted = extractAssignedPoints(rows);
    currentPoints = extracted.points;
    forecast = extracted.forecast;
    return {
      count: rows.length,
      points: extracted.points,
      forecast: extracted.forecast,
      mode: extracted.mode,
      assignedCount: extracted.points.filter((p) => p.day !== null).length,
    };
  }
  if (request.type === "load-forecast") {
    progress("Leyendo el forecast…");
    const rows = parseWorkbook(payload.buffer as ArrayBuffer);
    forecastMtColumn(rows);
    forecast = extractForecast(rows);
    currentPoints = [];
    return { forecast };
  }
  if (request.type === "calculate") {
    if (!baseBuffer || !forecast) throw new Error("Carga la base de puntos y el forecast antes de calcular.");
    progress(`Preparando ${baseCount.toLocaleString()} registros…`);
    const sourceRows = parseWorkbook(baseBuffer);
    const mode = planningModeFromRows(sourceRows);
    const sourcePoints = extractPoints(sourceRows);
    progress("Agrupando titulares según el forecast…");
    const initial = assign(sourcePoints, forecast, mode, { finalize: false });
    progress("Detectando cruces que necesitan QA vial…");
    const smartQa = await runSmartRoadQa(initial.points, progress);
    progress(mode === "with-spares" ? "Ordenando días y asignando suplentes…" : "Ordenando los días desde el grupo más cercano al más lejano…");
    const finalized = finalizeAssignment(smartQa.points, forecast, mode);
    currentPoints = finalized.points;
    return { points: finalized.points, notices: [...finalized.notices, ...smartQa.notices, ...initial.notices], mode: initial.mode };
  }
  if (request.type === "move") {
    const id = String(payload.id), newDay = payload.day == null ? null : Number(payload.day);
    const selected = currentPoints.find((point) => point.id === id);
    if (!selected) throw new Error("No se encontró el punto seleccionado.");
    const oldKey = selected.day ? `${operationalMt(selected)}\u0000${selected.day}` : "";
    selected.day = newDay;
    refreshAverages(currentPoints);
    const newKey = selected.day ? `${operationalMt(selected)}\u0000${selected.day}` : "";
    const updates = currentPoints.filter((point) => point.id === id || (point.day && (`${operationalMt(point)}\u0000${point.day}` === oldKey || `${operationalMt(point)}\u0000${point.day}` === newKey)));
    return { updates, notices: [{ type: "info", text: "Cambio manual aplicado. Revisa el indicador de forecast antes de exportar." }] as Notice[] };
  }
  if (request.type === "bulk-move") {
    const ids = new Set((payload.ids as string[] | undefined) ?? []);
    const newDay = payload.day == null ? null : Number(payload.day);
    if (!ids.size) throw new Error("No hay puntos seleccionados.");
    const affectedGroups = new Set<string>();
    let changed = 0;
    currentPoints.forEach((point) => {
      if (!ids.has(point.id)) return;
      if (point.day) affectedGroups.add(`${operationalMt(point)}\u0000${point.day}`);
      point.day = newDay;
      if (point.day) affectedGroups.add(`${operationalMt(point)}\u0000${point.day}`);
      changed++;
    });
    if (!changed) throw new Error("Los puntos seleccionados ya no están disponibles.");
    refreshAverages(currentPoints);
    const updates = currentPoints.filter((point) => ids.has(point.id) || (point.day && affectedGroups.has(`${operationalMt(point)}\u0000${point.day}`)));
    return { updates, notices: [{ type: "info", text: `${changed} puntos cambiaron en bloque al día ${newDay ?? "sin asignar"}. Revisa el cumplimiento del forecast antes de exportar.` }] as Notice[] };
  }
  if (request.type === "qa") {
    if (!forecast) throw new Error("No hay forecast cargado.");
    progress("Consultando carreteras y optimizando el MT…");
    const mt = String(payload.mt), qa = await runRoadQa(currentPoints, mt);
    progress("Aplicando la secuencia geográfica final…");
    const mode: PlanningMode = currentPoints.some((point) => point.kind === "Suplente") ? "with-spares" : "titles-only";
    const finalized = finalizeAssignment(qa.points, forecast, mode, mt);
    currentPoints = finalized.points;
    return { points: finalized.points, notices: [...qa.notices, ...finalized.notices] };
  }
  if (request.type === "download") {
    if (!baseBuffer || !currentPoints.length) throw new Error("No hay una planificación para descargar.");
    progress("Preparando el Excel en segundo plano…");
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(baseBuffer, { type: "array", dense: true, cellStyles: true, cellFormula: true, cellHTML: false, cellNF: true });
    } catch {
      workbook = XLSX.read(baseBuffer, { type: "array", dense: true, cellStyles: false, cellFormula: false, cellHTML: false, cellNF: false });
    }
    const sheetName = workbook.SheetNames[0];
    const sheetObj = (workbook.Sheets[sheetName] ?? {}) as Record<string, any>;
    const range = XLSX.utils.decode_range(sheetObj["!ref"] ?? `A1:Z${baseCount + 1}`);

    const getCell = (r: number, c: number) => {
      if (Array.isArray(sheetObj["!data"])) return sheetObj["!data"]?.[r]?.[c];
      if (Array.isArray(sheetObj)) return sheetObj[r]?.[c];
      return sheetObj[XLSX.utils.encode_cell({ r, c })];
    };

    const writeCell = (r: number, c: number, cell: { t: string; v: unknown }) => {
      const addr = XLSX.utils.encode_cell({ r, c });
      sheetObj[addr] = cell;
      if (Array.isArray(sheetObj["!data"])) {
        sheetObj["!data"][r] ??= [];
        sheetObj["!data"][r][c] = cell;
      }
      if (Array.isArray(sheetObj)) {
        sheetObj[r] ??= [];
        sheetObj[r][c] = cell;
      }
    };

    const headers: string[] = [];
    for (let c = 0; c <= Math.max(range.e.c, 50); c++) {
      const val = getCell(0, c)?.v;
      headers[c] = val !== undefined && val !== null ? String(val).trim() : "";
    }

    const mtColumnIndex = headers.findIndex((h) => key(h) === "MTFINAL");
    let dayColumnIndex = headers.findIndex((h) => key(h) === "DIA");
    if (dayColumnIndex < 0) {
      dayColumnIndex = headers.findIndex((h) => ["DIAS", "DAY", "DIAASIGNADO", "JORNADA"].includes(key(h)));
    }
    if (dayColumnIndex < 0) dayColumnIndex = range.e.c + 1;

    let averageColumnIndex = headers.findIndex((h) => ["PROMEDIOMETROS", "PROMEDIO", "AVGMETERS", "PROMETROS"].includes(key(h)));
    if (averageColumnIndex < 0) {
      averageColumnIndex = dayColumnIndex > range.e.c ? dayColumnIndex + 1 : range.e.c + 1;
    }

    writeCell(0, dayColumnIndex, { t: "s", v: "DIA" });
    writeCell(0, averageColumnIndex, { t: "s", v: "Promedio metros" });

    const assignmentByRow = new Map(currentPoints.map((point) => [point.sourceIndex, point]));
    for (let sourceIndex = 0; sourceIndex < baseCount; sourceIndex++) {
      const point = assignmentByRow.get(sourceIndex);
      const rowIndex = sourceIndex + 1;
      if (point?.assignedMt && mtColumnIndex >= 0) {
        const prev = getCell(rowIndex, mtColumnIndex);
        writeCell(rowIndex, mtColumnIndex, { ...(prev ?? {}), t: "s", v: point.assignedMt });
      }
      writeCell(rowIndex, dayColumnIndex, point?.day == null ? { t: "s", v: "" } : { t: "n", v: point.day });
      writeCell(rowIndex, averageColumnIndex, point?.avgMeters == null ? { t: "s", v: "" } : { t: "n", v: Math.round(point.avgMeters) });
    }

    range.e.c = Math.max(range.e.c, dayColumnIndex, averageColumnIndex);
    range.e.r = Math.max(range.e.r, baseCount);
    sheetObj["!ref"] = XLSX.utils.encode_range(range);

    const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx", compression: true }) as ArrayBuffer;
    return { buffer };
  }
  throw new Error("Operación no reconocida.");
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    const payload = await handleRequest(request);
    const transfer = request.type === "download" ? [(payload as { buffer: ArrayBuffer }).buffer] : [];
    self.postMessage({ id: request.id, ok: true, payload }, transfer);
  } catch (error) {
    self.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : "No fue posible completar la operación." });
  }
};

export {};
