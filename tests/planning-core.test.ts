import assert from "node:assert/strict";
import test from "node:test";
import { assign, planningModeFromRows, sequenceDaysByProximity, type Point } from "../app/planning-core";

function point(index: number, lng: number, kind: Point["kind"] = "Titular"): Point {
  return {
    id: String(index), sourceIndex: index, refId: String(index), name: `P${index}`, mt: "MT1",
    selection: kind === "Suplente" ? "S1" : "T", kind, priorityRank: kind === "Suplente" ? 0 : 99,
    lat: 0, lng, day: null, assignedMt: null, avgMeters: null,
  };
}

test("conserva el modo actual cuando existen suplentes", () => {
  const titles = [point(1, 0), point(2, 0.001), point(3, 1)];
  const spares = Array.from({ length: 9 }, (_, index) => point(10 + index, index < 6 ? index * 0.0001 : 1 + index * 0.0001, "Suplente"));
  const result = assign([...titles, ...spares], { MT1: { 1: 2, 2: 1 } });
  assert.equal(result.mode, "with-spares");
  const titleCounts = result.points.filter((item) => item.kind === "Titular" && item.day).reduce<Record<number, number>>((counts, item) => {
    counts[item.day!] = (counts[item.day!] ?? 0) + 1; return counts;
  }, {});
  assert.deepEqual(Object.values(titleCounts).sort((a, b) => a - b), [1, 2]);
  assert.equal(result.points.filter((item) => item.kind === "Suplente" && item.day).length, 9);
});

test("usa las cantidades exactas del forecast cuando no existen suplentes", () => {
  const titles = Array.from({ length: 9 }, (_, index) => point(index, index < 6 ? index * 0.001 : 1 + index * 0.001));
  const result = assign(titles, { MT1: { 1: 2, 2: 1 } });
  assert.equal(result.mode, "titles-only");
  assert.equal(result.points.filter((item) => item.day).length, 3);
  const counts = [1, 2].map((day) => result.points.filter((item) => item.day === day).length);
  assert.deepEqual(counts, [2, 1]);
  assert.match(result.notices[0].text, /sin aplicar la relación 1:3/);
});

test("deja sin día los titulares que exceden el forecast", () => {
  const titles = Array.from({ length: 10 }, (_, index) => point(index, index < 4 ? index * 0.001 : 1 + index * 0.001));
  const result = assign(titles, { MT1: { 1: 1, 2: 1 } });
  assert.equal(result.mode, "titles-only");
  assert.equal(result.points.filter((item) => item.day).length, 2);
  assert.equal(result.points.filter((item) => !item.day).length, 8);
});

test("mantiene las cuotas exactas mientras optimiza la agrupación", () => {
  const titles = [point(1, 0), point(2, 0.001), point(3, 1), point(4, 1.001), point(5, 1.002), point(6, 1.003)];
  const result = assign(titles, { MT1: { 1: 2, 2: 2 } });
  const counts = [...new Set(result.points.map((item) => item.day).filter(Boolean))].map((day) => result.points.filter((item) => item.day === day).length).sort((a, b) => a - b);
  assert.deepEqual(counts, [2, 2]);
});

test("renumera grupos completos desde el primer día hacia el más lejano", () => {
  const titles = [point(1, 0), point(2, 0.001), point(3, 10), point(4, 10.001), point(5, 1), point(6, 1.001)];
  titles.forEach((item, index) => { item.day = index < 2 ? 1 : index < 4 ? 2 : 5; item.assignedMt = "MT1"; });
  const result = sequenceDaysByProximity(titles);
  assert.equal(result.changedPoints, 4);
  assert.deepEqual(titles.filter((item) => item.day === 1).map((item) => item.id), ["1", "2"]);
  assert.deepEqual(titles.filter((item) => item.day === 2).map((item) => item.id), ["5", "6"]);
  assert.deepEqual(titles.filter((item) => item.day === 5).map((item) => item.id), ["3", "4"]);
});

test("solo intercambia grupos compatibles para conservar las cuotas diarias", () => {
  const titles = [point(1, 0), point(2, 0.001), point(3, 10), point(4, 1), point(5, 1.001), point(6, 2)];
  titles.forEach((item, index) => { item.day = index < 2 ? 1 : index === 2 ? 2 : index < 5 ? 3 : 4; item.assignedMt = "MT1"; });
  sequenceDaysByProximity(titles);
  assert.equal(titles.filter((item) => item.day === 1).length, 2);
  assert.equal(titles.filter((item) => item.day === 2).length, 1);
  assert.equal(titles.filter((item) => item.day === 3).length, 2);
  assert.equal(titles.filter((item) => item.day === 4).length, 1);
  assert.equal(titles.find((item) => item.id === "6")?.day, 2);
  assert.equal(titles.find((item) => item.id === "3")?.day, 4);
});

test("detecta suplentes desde la columna SELECCION aunque sus coordenadas no sean utilizables", () => {
  const rows = [{ "MT FINAL": "MT1", SELECCION: "T", LATITUD: 1, LONGITUD: 1, PDV: "A", RefID: "1" }, { "MT FINAL": "MT1", SELECCION: "S1", LATITUD: "", LONGITUD: "", PDV: "B", RefID: "2" }];
  assert.equal(planningModeFromRows(rows), "with-spares");
});
