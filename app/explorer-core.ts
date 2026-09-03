export type CellValue = string | number | boolean | null;
export type ColumnKind = "number" | "text" | "boolean" | "date";

export type ColumnMeta = {
  name: string;
  kind: ColumnKind;
  sourceIndex: number;
};

export type ExplorerPoint = {
  id: string;
  rowIndex: number;
  lat: number;
  lng: number;
  attributes: Record<string, CellValue>;
  coverage?: "Dentro" | "Fuera";
};

export type ExplorerPolygon = {
  id: string;
  rowIndex: number;
  bbox: [number, number, number, number];
  geometry: number[][][][];
  attributes: Record<string, CellValue>;
};

export type FilterOperator = "eq" | "neq" | "contains" | "starts" | "gt" | "gte" | "lt" | "lte" | "between" | "empty" | "not-empty";

export type FilterRule = {
  id: string;
  column: string;
  operator: FilterOperator;
  value: string;
  value2?: string;
  mode?: "condition" | "values";
  selectedValues?: string[];
};

export const EXPLORER_COLORS = [
  "#7148e8", "#1099c6", "#ef066f", "#2f9e44", "#e8590c", "#087f5b",
  "#d6336c", "#1971c2", "#e5a50a", "#9c36b5", "#12b886", "#c2255c",
  "#20c997", "#364fc7", "#f76707", "#0ca678", "#9c36b5", "#4c6ef5",
  "#d9480f", "#2b8a3e", "#ae3ec9", "#15aabf", "#e03131", "#66a80f",
];

export function normalizeHeader(value: unknown): string {
  return String(value ?? "").trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

export function findCoordinateColumns(headers: string[]): { latitude?: number; longitude?: number } {
  const normalized = headers.map(normalizeHeader);
  const latitudeNames = new Set(["LATITUD", "LATITUDE", "LAT", "Y", "COORDENADA Y", "COORD Y"]);
  const longitudeNames = new Set(["LONGITUD", "LONGITUDE", "LON", "LNG", "X", "COORDENADA X", "COORD X"]);
  return {
    latitude: normalized.findIndex((value) => latitudeNames.has(value)),
    longitude: normalized.findIndex((value) => longitudeNames.has(value)),
  };
}

export function inferColumnKind(values: CellValue[]): ColumnKind {
  const present = values.filter((value) => value !== null && value !== "").slice(0, 300);
  if (!present.length) return "text";
  if (present.every((value) => typeof value === "number" && Number.isFinite(value))) return "number";
  if (present.every((value) => typeof value === "boolean")) return "boolean";
  if (present.every((value) => /^\d{4}-\d{1,2}-\d{1,2}/.test(String(value)))) return "date";
  return "text";
}

export function matchesRule(attributes: Record<string, CellValue>, rule: FilterRule): boolean {
  const raw = attributes[rule.column];
  if (rule.mode === "values") {
    const selected = rule.selectedValues ?? [];
    return !selected.length || selected.includes(String(raw ?? ""));
  }
  if (rule.operator === "empty") return raw == null || String(raw).trim() === "";
  if (rule.operator === "not-empty") return raw != null && String(raw).trim() !== "";
  const left = String(raw ?? "").trim();
  const right = rule.value.trim();
  if (["gt", "gte", "lt", "lte", "between"].includes(rule.operator)) {
    const number = Number(raw), boundary = Number(rule.value), boundary2 = Number(rule.value2);
    if (!Number.isFinite(number) || !Number.isFinite(boundary)) return false;
    if (rule.operator === "gt") return number > boundary;
    if (rule.operator === "gte") return number >= boundary;
    if (rule.operator === "lt") return number < boundary;
    if (rule.operator === "lte") return number <= boundary;
    return Number.isFinite(boundary2) && number >= Math.min(boundary, boundary2) && number <= Math.max(boundary, boundary2);
  }
  const a = left.toLocaleLowerCase(), b = right.toLocaleLowerCase();
  if (rule.operator === "neq") return a !== b;
  if (rule.operator === "contains") return a.includes(b);
  if (rule.operator === "starts") return a.startsWith(b);
  return a === b;
}

export function sampleExplorerPoints(points: ExplorerPoint[], groupColumn: string, limit = 4500): ExplorerPoint[] {
  if (points.length <= limit) return points;
  const outside = points.filter((point) => point.coverage === "Fuera");
  if (outside.length >= limit) {
    const stride = outside.length / limit;
    return Array.from({ length: limit }, (_, index) => outside[Math.floor(index * stride)]);
  }
  const outsideIds = new Set(outside.map((point) => point.id));
  const available = points.filter((point) => !outsideIds.has(point.id));
  const remaining = limit - outside.length;
  const buckets = new Map<string, ExplorerPoint[]>();
  available.forEach((point) => {
    const key = String(point.attributes[groupColumn] ?? ""), bucket = buckets.get(key) ?? [];
    bucket.push(point);
    buckets.set(key, bucket);
  });
  const result: ExplorerPoint[] = [...outside];
  buckets.forEach((bucket) => {
    const quota = Math.max(1, Math.floor(remaining * bucket.length / available.length)), stride = bucket.length / quota;
    for (let index = 0; index < quota && result.length < limit; index++) result.push(bucket[Math.floor(index * stride)]);
  });
  if (result.length < limit) {
    const selectedIds = new Set(result.map((point) => point.id));
    for (let index = 0; index < available.length && result.length < limit; index++) {
      const candidate = available[index];
      if (candidate && !selectedIds.has(candidate.id)) {
        result.push(candidate);
        selectedIds.add(candidate.id);
      }
    }
  }
  return result;
}

function splitTopLevel(value: string): string[] {
  const chunks: string[] = [];
  let depth = 0, start = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "(") depth++;
    else if (value[index] === ")") depth--;
    else if (value[index] === "," && depth === 0) {
      chunks.push(value.slice(start, index));
      start = index + 1;
    }
  }
  chunks.push(value.slice(start));
  return chunks.map((chunk) => chunk.trim()).filter(Boolean);
}

function stripOuter(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("(") && trimmed.endsWith(")") ? trimmed.slice(1, -1).trim() : trimmed;
}

function parseRing(value: string): number[][] {
  return splitTopLevel(stripOuter(value)).map((pair) => pair.trim().split(/\s+/).slice(0, 2).map(Number)).filter((pair) => pair.length === 2 && pair.every(Number.isFinite));
}

export function parseWktGeometry(input: unknown): number[][][][] | null {
  const source = String(input ?? "").trim().replace(/^SRID=\d+;/i, "");
  if (!source || /\bEMPTY\b/i.test(source)) return null;
  const firstParen = source.indexOf("(");
  if (firstParen < 0) return null;
  const body = source.slice(firstParen);
  if (/^POLYGON\b/i.test(source)) {
    const rings = splitTopLevel(stripOuter(body)).map(parseRing).filter((ring) => ring.length >= 3);
    return rings.length ? [rings] : null;
  }
  if (/^MULTIPOLYGON\b/i.test(source)) {
    const polygons = splitTopLevel(stripOuter(body)).map((polygon) => splitTopLevel(stripOuter(polygon)).map(parseRing).filter((ring) => ring.length >= 3)).filter((polygon) => polygon.length);
    return polygons.length ? polygons : null;
  }
  return null;
}

export function geometryBounds(geometry: number[][][][]): [number, number, number, number] {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  geometry.forEach((polygon) => polygon.forEach((ring) => ring.forEach(([lng, lat]) => {
    west = Math.min(west, lng); south = Math.min(south, lat); east = Math.max(east, lng); north = Math.max(north, lat);
  })));
  return [west, south, east, north];
}

function closedRing(ring: number[][]): number[][] {
  if (!ring.length) return [];
  const first = ring[0], last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, [...first]];
}

function polygonWkt(polygon: number[][][]): string {
  return `(${polygon.map((ring) => `(${closedRing(ring).map(([lng, lat]) => `${lng} ${lat}`).join(", ")})`).join(", ")})`;
}

export function geometryToWkt(geometry: number[][][][]): string {
  if (!geometry.length) return "POLYGON EMPTY";
  if (geometry.length === 1) return `POLYGON ${polygonWkt(geometry[0])}`;
  return `MULTIPOLYGON (${geometry.map(polygonWkt).join(", ")})`;
}

export function encodeGeoPackagePolygon(geometry: number[][][][]): Uint8Array {
  if (geometry.length !== 1 || !geometry[0]?.length) throw new Error("Solo se pueden exportar geometrías Polygon válidas.");
  const rings = geometry[0].map(closedRing);
  if (rings.some((ring) => ring.length < 4)) throw new Error("El polígono necesita al menos tres vértices.");
  const [minX, minY, maxX, maxY] = geometryBounds([rings]);
  const wkbBytes = 1 + 4 + 4 + rings.reduce((total, ring) => total + 4 + ring.length * 16, 0);
  const bytes = new Uint8Array(40 + wkbBytes), view = new DataView(bytes.buffer);
  bytes[0] = 0x47; bytes[1] = 0x50; bytes[2] = 0; bytes[3] = 3;
  view.setInt32(4, 4326, true);
  view.setFloat64(8, minX, true); view.setFloat64(16, maxX, true);
  view.setFloat64(24, minY, true); view.setFloat64(32, maxY, true);
  let offset = 40;
  view.setUint8(offset, 1); offset += 1;
  view.setUint32(offset, 3, true); offset += 4;
  view.setUint32(offset, rings.length, true); offset += 4;
  rings.forEach((ring) => {
    view.setUint32(offset, ring.length, true); offset += 4;
    ring.forEach(([lng, lat]) => {
      view.setFloat64(offset, lng, true); view.setFloat64(offset + 8, lat, true); offset += 16;
    });
  });
  return bytes;
}

export function parseGeoPackageBinary(blob: Uint8Array): number[][][][] | null {
  if (blob.length < 13 || blob[0] !== 0x47 || blob[1] !== 0x50) return null;
  const flags = blob[3], envelopeIndicator = (flags >> 1) & 7;
  const envelopeBytes = envelopeIndicator === 0 ? 0 : envelopeIndicator === 1 ? 32 : envelopeIndicator === 2 || envelopeIndicator === 3 ? 48 : 64;
  let offset = 8 + envelopeBytes;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);

  const parseGeometry = (): number[][][][] | null => {
    if (offset + 5 > view.byteLength) return null;
    const little = view.getUint8(offset) === 1; offset += 1;
    let rawType = view.getUint32(offset, little); offset += 4;
    let dimensions = 2;
    if (rawType & 0x80000000) dimensions++;
    if (rawType & 0x40000000) dimensions++;
    if (rawType & 0x20000000) offset += 4;
    rawType &= 0x0fffffff;
    if (rawType >= 3000) { dimensions = 4; rawType -= 3000; }
    else if (rawType >= 2000) { dimensions = 3; rawType -= 2000; }
    else if (rawType >= 1000) { dimensions = 3; rawType -= 1000; }
    if (rawType === 3) {
      const ringCount = view.getUint32(offset, little); offset += 4;
      const polygon: number[][][] = [];
      for (let ringIndex = 0; ringIndex < ringCount; ringIndex++) {
        const pointCount = view.getUint32(offset, little); offset += 4;
        const ring: number[][] = [];
        for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
          const x = view.getFloat64(offset, little), y = view.getFloat64(offset + 8, little);
          offset += dimensions * 8;
          ring.push([x, y]);
        }
        polygon.push(ring);
      }
      return [polygon];
    }
    if (rawType === 6) {
      const polygonCount = view.getUint32(offset, little); offset += 4;
      const multi: number[][][][] = [];
      for (let polygonIndex = 0; polygonIndex < polygonCount; polygonIndex++) {
        const parsed = parseGeometry();
        if (parsed) multi.push(...parsed);
      }
      return multi;
    }
    return null;
  };
  try { return parseGeometry(); } catch { return null; }
}

export function geoPackageEnvelope(blob: Uint8Array): [number, number, number, number] | null {
  if (blob.length < 8 || blob[0] !== 0x47 || blob[1] !== 0x50) return null;
  const flags = blob[3], little = Boolean(flags & 1), envelopeIndicator = (flags >> 1) & 7;
  if (envelopeIndicator === 0 || blob.length < 40) {
    const geometry = parseGeoPackageBinary(blob);
    return geometry ? geometryBounds(geometry) : null;
  }
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const minX = view.getFloat64(8, little), maxX = view.getFloat64(16, little), minY = view.getFloat64(24, little), maxY = view.getFloat64(32, little);
  return [minX, minY, maxX, maxY].every(Number.isFinite) ? [minX, minY, maxX, maxY] : null;
}

function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
    const [xi, yi] = ring[current], [xj, yj] = ring[previous];
    const crosses = (yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function pointInGeometry(lng: number, lat: number, geometry: number[][][][]): boolean {
  return geometry.some((polygon) => {
    if (!polygon.length || !pointInRing(lng, lat, polygon[0])) return false;
    return !polygon.slice(1).some((hole) => pointInRing(lng, lat, hole));
  });
}

export function simplifyGeometry(geometry: number[][][][], maxVerticesPerRing = 100): number[][][][] {
  return geometry.map((polygon) => polygon.map((ring) => {
    if (ring.length <= maxVerticesPerRing) return ring;
    const stride = Math.ceil(ring.length / maxVerticesPerRing);
    const reduced = ring.filter((_, index) => index % stride === 0);
    if (reduced.length && (reduced[0][0] !== reduced.at(-1)?.[0] || reduced[0][1] !== reduced.at(-1)?.[1])) reduced.push(reduced[0]);
    return reduced;
  }));
}

export function boundsIntersect(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
