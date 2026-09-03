import assert from "node:assert/strict";
import test from "node:test";
import { encodeGeoPackagePolygon, findCoordinateColumns, geometryToWkt, geoPackageEnvelope, inferColumnKind, matchesRule, parseGeoPackageBinary, parseWktGeometry, pointInGeometry, sampleExplorerPoints, type ExplorerPoint } from "../app/explorer-core";

test("detecta latitud y longitud por nombre aunque cambie su posición", () => {
  assert.deepEqual(findCoordinateColumns(["PDV", "Longitud", "Ciudad", "LATITUD"]), { latitude: 3, longitude: 1 });
});

test("infiere columnas numéricas y aplica rangos", () => {
  assert.equal(inferColumnKind([1, 4, 9, null]), "number");
  assert.equal(matchesRule({ VENTAS: 14 }, { id: "1", column: "VENTAS", operator: "between", value: "10", value2: "20" }), true);
  assert.equal(matchesRule({ VENTAS: 24 }, { id: "2", column: "VENTAS", operator: "lt", value: "20" }), false);
});

test("acepta varios valores seleccionados de una misma columna", () => {
  const rule = { id: "multi", column: "CANAL", operator: "eq" as const, value: "", mode: "values" as const, selectedValues: ["Tradicional", "Mayorista"] };
  assert.equal(matchesRule({ CANAL: "Mayorista" }, rule), true);
  assert.equal(matchesRule({ CANAL: "Moderno" }, rule), false);
});

test("mantiene todos los puntos fuera de cobertura en una vista muestreada", () => {
  const points: ExplorerPoint[] = Array.from({ length: 20 }, (_, index) => ({
    id: String(index), rowIndex: index, lat: index, lng: index,
    attributes: { GRUPO: index % 2 ? "A" : "B" }, coverage: index === 3 || index === 17 ? "Fuera" : "Dentro",
  }));
  const sample = sampleExplorerPoints(points, "GRUPO", 8);
  assert.equal(sample.length, 8);
  assert.deepEqual(sample.filter((point) => point.coverage === "Fuera").map((point) => point.id).sort(), ["17", "3"]);
});

test("interpreta Polygon WKT con huecos", () => {
  const geometry = parseWktGeometry("POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0), (4 4, 6 4, 6 6, 4 6, 4 4))");
  assert.ok(geometry);
  assert.equal(pointInGeometry(2, 2, geometry), true);
  assert.equal(pointInGeometry(5, 5, geometry), false);
  assert.equal(pointInGeometry(12, 5, geometry), false);
});

test("interpreta MultiPolygon WKT", () => {
  const geometry = parseWktGeometry("MULTIPOLYGON (((0 0, 1 0, 1 1, 0 1, 0 0)), ((5 5, 6 5, 6 6, 5 6, 5 5)))");
  assert.ok(geometry);
  assert.equal(geometry.length, 2);
  assert.equal(pointInGeometry(5.5, 5.5, geometry), true);
});

test("interpreta un GeoPackage Binary Polygon en EPSG:4326", () => {
  const coordinates = [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]];
  const buffer = new ArrayBuffer(8 + 1 + 4 + 4 + 4 + coordinates.length * 16), view = new DataView(buffer);
  view.setUint8(0, 0x47); view.setUint8(1, 0x50); view.setUint8(2, 0); view.setUint8(3, 1); view.setInt32(4, 4326, true);
  let offset = 8; view.setUint8(offset, 1); offset += 1; view.setUint32(offset, 3, true); offset += 4; view.setUint32(offset, 1, true); offset += 4; view.setUint32(offset, coordinates.length, true); offset += 4;
  coordinates.forEach(([x, y]) => { view.setFloat64(offset, x, true); view.setFloat64(offset + 8, y, true); offset += 16; });
  const geometry = parseGeoPackageBinary(new Uint8Array(buffer));
  assert.ok(geometry);
  assert.deepEqual(geoPackageEnvelope(new Uint8Array(buffer)), [0, 0, 2, 2]);
  assert.equal(pointInGeometry(1, 1, geometry), true);
  assert.equal(pointInGeometry(3, 1, geometry), false);
});

test("exporta geometría real a WKT y GeoPackage Binary", () => {
  const geometry = [[[[0, 0], [3, 0], [3, 2], [0, 2], [0, 0]]]];
  assert.equal(geometryToWkt(geometry), "POLYGON ((0 0, 3 0, 3 2, 0 2, 0 0))");
  const binary = encodeGeoPackagePolygon(geometry);
  assert.deepEqual(geoPackageEnvelope(binary), [0, 0, 3, 2]);
  assert.deepEqual(parseGeoPackageBinary(binary), geometry);
});
