/// <reference lib="webworker" />

import * as XLSX from "xlsx";
import { assign, baseColumns, extractForecast, extractPoints, forecastMtColumn, key, operationalMt, refreshAverages, runRoadQa, type Forecast, type Notice, type Point, type Raw } from "./planning-core";

type WorkerRequest = { id: number; type: "load-base" | "load-forecast" | "calculate" | "move" | "qa" | "download"; payload?: Record<string, unknown> };

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
    const sourcePoints = extractPoints(parseWorkbook(baseBuffer));
    progress("Agrupando titulares y asignando suplentes…");
    const result = assign(sourcePoints, forecast);
    currentPoints = result.points;
    return result;
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
  if (request.type === "qa") {
    if (!forecast) throw new Error("No hay forecast cargado.");
    progress("Consultando carreteras y optimizando el MT…");
    const result = await runRoadQa(currentPoints, forecast, String(payload.mt));
    currentPoints = result.points;
    return result;
  }
  if (request.type === "download") {
    if (!baseBuffer || !currentPoints.length) throw new Error("No hay una planificación para descargar.");
    progress("Preparando el Excel en segundo plano…");
    const workbook = XLSX.read(baseBuffer, { type: "array", dense: true, cellStyles: true, cellFormula: true, cellHTML: false, cellNF: true });
    type DenseCell = { t?: string; v?: unknown; [property: string]: unknown };
    const sheet = workbook.Sheets[workbook.SheetNames[0]] as unknown as Array<Array<DenseCell | undefined>> & { "!ref"?: string };
    const headers = (sheet[0] ?? []).map((cell) => cell?.v);
    const mtColumnIndex = headers.findIndex((header) => key(header) === "MTFINAL");
    const dayColumnIndex = headers.length;
    const averageColumnIndex = dayColumnIndex + 1;
    sheet[0] ??= [];
    sheet[0][dayColumnIndex] = { t: "s", v: "DIA" };
    sheet[0][averageColumnIndex] = { t: "s", v: "Promedio metros" };
    const assignmentByRow = new Map(currentPoints.map((point) => [point.sourceIndex, point]));
    for (let sourceIndex = 0; sourceIndex < baseCount; sourceIndex++) {
      const point = assignmentByRow.get(sourceIndex);
      const rowIndex = sourceIndex + 1;
      const row = sheet[rowIndex] ?? (sheet[rowIndex] = []);
      if (point?.assignedMt && mtColumnIndex >= 0) row[mtColumnIndex] = { ...(row[mtColumnIndex] ?? {}), t: "s", v: point.assignedMt };
      row[dayColumnIndex] = point?.day == null ? { t: "s", v: "" } : { t: "n", v: point.day };
      row[averageColumnIndex] = point?.avgMeters == null ? { t: "s", v: "" } : { t: "n", v: Math.round(point.avgMeters) };
    }
    const range = XLSX.utils.decode_range(sheet["!ref"] ?? `A1:A${baseCount + 1}`);
    range.e.c = averageColumnIndex;
    sheet["!ref"] = XLSX.utils.encode_range(range);
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
