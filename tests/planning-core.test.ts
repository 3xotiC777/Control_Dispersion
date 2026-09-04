import assert from "node:assert/strict";
import test from "node:test";
import { assign, forecastToleranceFor, improveDayGroupsWithinForecastTolerance, planningModeFromRows, refineClusterDispersion, sequenceDaysByProximity, type Point } from "../app/planning-core";

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
  assert.match(result.notices[0].text, /no se aplicó la relación 1:3/);
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
  const result = sequenceDaysByProximity(titles, { MT1: { 1: 2, 2: 2, 5: 2 } });
  assert.equal(result.relabeledPoints, 4);
  assert.equal(result.boundaryMoves, 0);
  assert.deepEqual(titles.filter((item) => item.day === 1).map((item) => item.id), ["1", "2"]);
  assert.deepEqual(titles.filter((item) => item.day === 2).map((item) => item.id), ["5", "6"]);
  assert.deepEqual(titles.filter((item) => item.day === 5).map((item) => item.id), ["3", "4"]);
});

test("renumera grupos completos dentro del margen del forecast", () => {
  const titles = [point(1, 0), point(2, 0.001), point(3, 10), point(4, 1), point(5, 1.001), point(6, 2)];
  titles.forEach((item, index) => { item.day = index < 2 ? 1 : index === 2 ? 2 : index < 5 ? 3 : 4; item.assignedMt = "MT1"; });
  const originalGroups = [["1", "2"], ["3"], ["4", "5"], ["6"]];
  const result = sequenceDaysByProximity(titles, { MT1: { 1: 2, 2: 1, 3: 2, 4: 1 } });
  assert.equal(result.boundaryMoves, 0);
  assert.ok(result.routeMetersAfter <= result.routeMetersBefore);
  originalGroups.forEach((ids) => assert.equal(new Set(ids.map((id) => titles.find((item) => item.id === id)?.day)).size, 1));
  const expected = { 1: 2, 2: 1, 3: 2, 4: 1 };
  Object.entries(expected).forEach(([day, count]) => assert.ok(Math.abs(titles.filter((item) => item.day === Number(day)).length - count) <= forecastToleranceFor(count)));
});

test("conserva grupos completos al corregir el orden geográfico de los días", () => {
  const titles = [point(1, 0), point(2, 0.001), point(3, 10), point(4, 1), point(5, 1.001), point(6, 1.002), point(7, 1.003), point(8, 1.004)];
  titles.forEach((item, index) => { item.day = index < 2 ? 1 : index === 2 ? 2 : 3; item.assignedMt = "MT1"; });
  const result = sequenceDaysByProximity(titles, { MT1: { 1: 2, 2: 1, 3: 5 } });
  assert.equal(result.boundaryMoves, 0);
  assert.equal(result.unresolvedDays, 0);
  assert.ok(result.routeMetersAfter <= result.routeMetersBefore);
  [["1", "2"], ["3"], ["4", "5", "6", "7", "8"]].forEach((ids) => assert.equal(new Set(ids.map((id) => titles.find((item) => item.id === id)?.day)).size, 1));
});

test("penaliza con más fuerza los pares extremos sin alterar las cuotas", () => {
  const coordinates = [0, 9, 10, 1, 2, 11];
  const matrix = coordinates.map((left) => coordinates.map((right) => Math.abs(left - right)));
  const labels = [0, 0, 0, 1, 1, 1];
  const squaredCost = () => {
    let total = 0;
    for (let a = 0; a < labels.length; a++) for (let b = a + 1; b < labels.length; b++) {
      if (labels[a] === labels[b]) total += matrix[a][b] ** 2;
    }
    return total;
  };
  const before = squaredCost();
  const swaps = refineClusterDispersion(labels, matrix);
  assert.ok(swaps > 0);
  assert.ok(squaredCost() < before);
  assert.deepEqual([0, 1].map((cluster) => labels.filter((label) => label === cluster).length), [3, 3]);
});

test("usa el margen del forecast solo cuando reduce la dispersión", () => {
  const titles = [point(1, 0), point(2, 0.001), point(3, 0.002), point(4, 0.1), point(5, 0.098), point(6, 0.099), point(7, 0.1), point(8, 0.101)];
  titles.forEach((item, index) => { item.day = index < 4 ? 1 : 2; item.assignedMt = "MT1"; });
  const result = improveDayGroupsWithinForecastTolerance(titles, { MT1: { 1: 4, 2: 4 } });
  assert.equal(result.movedPoints, 1);
  assert.equal(titles.find((item) => item.id === "4")?.day, 2);
  assert.deepEqual([1, 2].map((day) => titles.filter((item) => item.day === day).length), [3, 5]);
});

test("mueve junto un pequeño bloque lejano hacia el día geográficamente correcto", () => {
  const titles = [
    ...Array.from({ length: 17 }, (_, index) => point(index + 1, index * 0.0001)),
    ...Array.from({ length: 3 }, (_, index) => point(index + 18, 1 + index * 0.0001)),
    ...Array.from({ length: 20 }, (_, index) => point(index + 21, 1 + index * 0.0001)),
  ];
  titles.forEach((item, index) => { item.day = index < 20 ? 1 : 2; item.assignedMt = "MT1"; });
  const result = improveDayGroupsWithinForecastTolerance(titles, { MT1: { 1: 20, 2: 20 } });
  assert.equal(result.movedPoints, 3);
  assert.deepEqual([1, 2].map((day) => titles.filter((item) => item.day === day).length), [17, 23]);
  ["18", "19", "20"].forEach((id) => assert.equal(titles.find((item) => item.id === id)?.day, 2));
});

test("forma desde el inicio grupos compactos usando el forecast como guía", () => {
  const titles = [
    ...Array.from({ length: 17 }, (_, index) => point(index + 1, index * 0.0001)),
    ...Array.from({ length: 23 }, (_, index) => point(index + 18, 1 + index * 0.0001)),
  ];
  const result = assign(titles, { MT1: { 1: 20, 2: 20 } }, "titles-only", { finalize: false });
  assert.deepEqual([1, 2].map((day) => result.points.filter((item) => item.day === day).length).sort((a, b) => a - b), [17, 23]);
});

test("evita volver al final del mes a una zona ya atendida", () => {
  const groups = [
    { day: 7, count: 20, lng: 0 }, { day: 8, count: 20, lng: 0.1 }, { day: 9, count: 20, lng: 0.2 },
    { day: 10, count: 20, lng: 0.3 }, { day: 21, count: 20, lng: 10 }, { day: 22, count: 20, lng: 10.1 },
    { day: 23, count: 23, lng: 0.4 },
  ];
  let index = 1;
  const titles = groups.flatMap((group) => Array.from({ length: group.count }, (_, offset) => {
    const item = point(index++, group.lng + offset * 0.00001);
    item.day = group.day; item.assignedMt = "MT1";
    return item;
  }));
  const forecast = { MT1: Object.fromEntries(groups.map(({ day, count }) => [day, count])) };
  const result = sequenceDaysByProximity(titles, forecast);
  assert.ok(result.routeMetersAfter < result.routeMetersBefore * 0.6);
  assert.equal(result.unresolvedDays, 0);
});

test("no consume la tolerancia cuando los días ya son compactos", () => {
  const titles = [point(1, 0), point(2, 0.001), point(3, 0.002), point(4, 0.003), point(5, 1), point(6, 1.001), point(7, 1.002), point(8, 1.003)];
  titles.forEach((item, index) => { item.day = index < 4 ? 1 : 2; item.assignedMt = "MT1"; });
  const result = improveDayGroupsWithinForecastTolerance(titles, { MT1: { 1: 4, 2: 4 } });
  assert.equal(result.movedPoints, 0);
  assert.deepEqual([1, 2].map((day) => titles.filter((item) => item.day === day).length), [4, 4]);
});

test("detecta suplentes desde la columna SELECCION aunque sus coordenadas no sean utilizables", () => {
  const rows = [{ "MT FINAL": "MT1", SELECCION: "T", LATITUD: 1, LONGITUD: 1, PDV: "A", RefID: "1" }, { "MT FINAL": "MT1", SELECCION: "S1", LATITUD: "", LONGITUD: "", PDV: "B", RefID: "2" }];
  assert.equal(planningModeFromRows(rows), "with-spares");
});
