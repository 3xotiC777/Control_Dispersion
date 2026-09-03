"use client";

import { useEffect, useRef, useState } from "react";
import { CircleMarker, MapContainer, Polygon, Polyline, Popup, Rectangle, TileLayer, useMap, useMapEvents } from "react-leaflet";
import { latLngBounds, type LatLng, type LatLngBounds, type LatLngExpression } from "leaflet";
import type { CellValue, ExplorerPoint, ExplorerPolygon } from "./explorer-core";

type Bounds = [number, number, number, number];
type Coordinate = [number, number];
type DrawMode = "rectangle" | "polygon" | null;

function valueLabel(value: CellValue) {
  if (value == null || value === "") return "(vacío)";
  return String(value);
}

function FeatureDetails({ attributes }: { attributes: Record<string, CellValue> }) {
  const entries = Object.entries(attributes).filter(([, value]) => value != null && value !== "").slice(0, 9);
  return <div className="explorer-popup">{entries.map(([key, value]) => <p key={key}><b>{key}</b><span>{valueLabel(value)}</span></p>)}</div>;
}

function ViewportReporter({ onBoundsChange }: { onBoundsChange?: (bounds: Bounds) => void }) {
  const map = useMap();
  const report = () => {
    const bounds = map.getBounds();
    onBoundsChange?.([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]);
  };
  useEffect(() => { report(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useMapEvents({ moveend: report });
  return null;
}

function FitInitialExtent({ extent, extentKey }: { extent: Bounds | null; extentKey: string }) {
  const map = useMap(), previous = useRef("");
  useEffect(() => {
    if (!extent || previous.current === extentKey) return;
    previous.current = extentKey;
    const bounds = latLngBounds([extent[1], extent[0]], [extent[3], extent[2]]);
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [34, 34], maxZoom: 15, animate: false });
  }, [extent, extentKey, map]);
  return null;
}

function PointBoxSelection({ enabled, points, onSelect }: { enabled: boolean; points: ExplorerPoint[]; onSelect: (points: ExplorerPoint[]) => void }) {
  const map = useMap(), startRef = useRef<LatLng | null>(null);
  const [selectionBounds, setSelectionBounds] = useState<LatLngBounds | null>(null);
  useEffect(() => {
    const container = map.getContainer();
    if (enabled) { map.dragging.disable(); container.style.cursor = "crosshair"; }
    else { map.dragging.enable(); container.style.cursor = ""; startRef.current = null; }
    return () => { map.dragging.enable(); container.style.cursor = ""; };
  }, [enabled, map]);
  useMapEvents({
    mousedown(event) {
      if (!enabled || event.originalEvent.button !== 0) return;
      startRef.current = event.latlng; setSelectionBounds(latLngBounds(event.latlng, event.latlng));
    },
    mousemove(event) {
      if (enabled && startRef.current) setSelectionBounds(latLngBounds(startRef.current, event.latlng));
    },
    mouseup(event) {
      if (!enabled || !startRef.current) return;
      const bounds = latLngBounds(startRef.current, event.latlng);
      startRef.current = null; setSelectionBounds(null);
      onSelect(points.filter((point) => bounds.contains([point.lat, point.lng])));
    },
  });
  return selectionBounds ? <Rectangle bounds={selectionBounds} pathOptions={{ color: "#7148e8", weight: 2, fillColor: "#7148e8", fillOpacity: 0.12, dashArray: "6 5" }} /> : null;
}

function DrawingEvents({ mode, vertices, onVertices, onCursor, onComplete }: {
  mode: Exclude<DrawMode, null>;
  vertices: Coordinate[];
  onVertices: (vertices: Coordinate[]) => void;
  onCursor: (coordinate: Coordinate | null) => void;
  onComplete: (geometry: number[][][][]) => void;
}) {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    map.doubleClickZoom.disable(); container.style.cursor = "crosshair";
    return () => { map.doubleClickZoom.enable(); container.style.cursor = ""; };
  }, [map]);
  useMapEvents({
    click(event) {
      const coordinate: Coordinate = [event.latlng.lng, event.latlng.lat];
      if (mode === "polygon") { onVertices([...vertices, coordinate]); return; }
      if (!vertices.length) { onVertices([coordinate]); return; }
      const [startLng, startLat] = vertices[0], [endLng, endLat] = coordinate;
      if (Math.abs(startLng - endLng) < 1e-9 || Math.abs(startLat - endLat) < 1e-9) return;
      onComplete([[[[startLng, startLat], [endLng, startLat], [endLng, endLat], [startLng, endLat], [startLng, startLat]]]]);
    },
    mousemove(event) { onCursor([event.latlng.lng, event.latlng.lat]); },
    mouseout() { onCursor(null); },
  });
  return null;
}

export default function ExplorerMap({
  points,
  polygons,
  drawnPolygons,
  pointColor,
  polygonColor,
  selectedPointIds,
  selectedPolygonIds,
  multiSelect,
  drawMode,
  activeDrawnPolygonId,
  onPointClick,
  onPolygonClick,
  onMultiSelect,
  onDrawComplete,
  onDrawnPolygonClick,
  onCancelDraw,
  onBoundsChange,
  extent,
  extentKey,
}: {
  points: ExplorerPoint[];
  polygons: ExplorerPolygon[];
  drawnPolygons: ExplorerPolygon[];
  pointColor: (point: ExplorerPoint) => string;
  polygonColor: (polygon: ExplorerPolygon) => string;
  selectedPointIds: ReadonlySet<string>;
  selectedPolygonIds: ReadonlySet<string>;
  multiSelect: boolean;
  drawMode: DrawMode;
  activeDrawnPolygonId: string | null;
  onPointClick: (point: ExplorerPoint) => void;
  onPolygonClick: (polygon: ExplorerPolygon) => void;
  onMultiSelect: (points: ExplorerPoint[]) => void;
  onDrawComplete: (geometry: number[][][][]) => void;
  onDrawnPolygonClick: (polygon: ExplorerPolygon) => void;
  onCancelDraw: () => void;
  onBoundsChange?: (bounds: Bounds) => void;
  extent: Bounds | null;
  extentKey: string;
}) {
  const center: LatLngExpression = extent ? [(extent[1] + extent[3]) / 2, (extent[0] + extent[2]) / 2] : [18.7357, -70.1627];
  const [draft, setDraft] = useState<{ mode: DrawMode; vertices: Coordinate[]; cursor: Coordinate | null }>({ mode: null, vertices: [], cursor: null });
  const draftVertices = draft.mode === drawMode ? draft.vertices : [], draftCursor = draft.mode === drawMode ? draft.cursor : null;
  const setDraftVertices = (vertices: Coordinate[]) => setDraft((current) => ({ mode: drawMode, vertices, cursor: current.mode === drawMode ? current.cursor : null }));
  const setDraftCursor = (cursor: Coordinate | null) => setDraft((current) => ({ mode: drawMode, vertices: current.mode === drawMode ? current.vertices : [], cursor }));
  const completeDrawing = (geometry: number[][][][]) => { setDraft({ mode: null, vertices: [], cursor: null }); onDrawComplete(geometry); };
  const finishPolygon = () => {
    if (draftVertices.length < 3) return;
    const first = draftVertices[0], last = draftVertices[draftVertices.length - 1];
    const ring = first[0] === last[0] && first[1] === last[1] ? draftVertices : [...draftVertices, first];
    completeDrawing([[[...ring]]]);
  };
  const cancelDrawing = () => { setDraft({ mode: null, vertices: [], cursor: null }); onCancelDraw(); };
  const preview = draftCursor ? [...draftVertices, draftCursor] : draftVertices;
  const rectanglePreview = drawMode === "rectangle" && draftVertices[0] && draftCursor
    ? latLngBounds([draftVertices[0][1], draftVertices[0][0]], [draftCursor[1], draftCursor[0]]) : null;
  return <div className={`map-wrap explorer-map-wrap${drawMode ? " drawing" : ""}`}>
    {drawMode && <div className="draw-map-toolbar" onDoubleClick={(event) => event.stopPropagation()}>
      <div><b>{drawMode === "rectangle" ? "Dibujando rectángulo" : "Dibujando polígono"}</b><span>{drawMode === "rectangle" ? (draftVertices.length ? "Haz clic en la esquina opuesta" : "Haz clic en la primera esquina") : `${draftVertices.length} vértice${draftVertices.length === 1 ? "" : "s"} marcado${draftVertices.length === 1 ? "" : "s"}`}</span></div>
      {drawMode === "polygon" && <button type="button" className="finish" disabled={draftVertices.length < 3} onClick={finishPolygon}>Terminar polígono</button>}
      <button type="button" onClick={cancelDrawing}>Cancelar</button>
    </div>}
    <MapContainer center={center} zoom={6} scrollWheelZoom preferCanvas className="leaflet-map">
    <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
    <FitInitialExtent extent={extent} extentKey={extentKey} />
    <ViewportReporter onBoundsChange={onBoundsChange} />
    <PointBoxSelection key={multiSelect && !drawMode ? "selecting" : "browsing"} enabled={multiSelect && !drawMode && points.length > 0} points={points} onSelect={onMultiSelect} />
    {drawMode && <DrawingEvents mode={drawMode} vertices={draftVertices} onVertices={setDraftVertices} onCursor={setDraftCursor} onComplete={completeDrawing} />}
    {rectanglePreview && <Rectangle bounds={rectanglePreview} pathOptions={{ color: "#c06b11", weight: 2.5, fillColor: "#f59f00", fillOpacity: 0.2, dashArray: "7 5" }} />}
    {drawMode === "polygon" && preview.length > 1 && <Polyline positions={preview.map(([lng, lat]) => [lat, lng] as [number, number])} pathOptions={{ color: "#c06b11", weight: 2.5, dashArray: "7 5" }} />}
    {drawMode === "polygon" && draftVertices.map(([lng, lat], index) => <CircleMarker key={`draft-${index}`} center={[lat, lng]} radius={4} pathOptions={{ color: "#fff", weight: 1.5, fillColor: "#d97706", fillOpacity: 1 }} />)}
    {polygons.map((polygon) => {
      const selected = selectedPolygonIds.has(polygon.id), color = polygonColor(polygon);
      return polygon.geometry.map((part, index) => <Polygon
        key={`${polygon.id}-${index}`}
        positions={part.map((ring) => ring.map(([lng, lat]) => [lat, lng] as [number, number]))}
        pathOptions={{ color: selected ? "#211841" : color, weight: selected ? 3 : 1.2, fillColor: color, fillOpacity: selected ? 0.34 : 0.15 }}
        eventHandlers={{ click: () => { if (!drawMode) onPolygonClick(polygon); } }}
      >{!multiSelect && !drawMode && <Popup><FeatureDetails attributes={polygon.attributes} /><button onClick={() => onPolygonClick(polygon)}>Editar polígono</button></Popup>}</Polygon>);
    })}
    {drawnPolygons.flatMap((polygon) => polygon.geometry.map((part, index) => {
      const active = polygon.id === activeDrawnPolygonId;
      return <Polygon key={`drawn-${polygon.id}-${index}`} positions={part.map((ring) => ring.map(([lng, lat]) => [lat, lng] as [number, number]))} pathOptions={{ color: active ? "#7c2d12" : "#c06b11", weight: active ? 4 : 2.5, fillColor: "#f59f00", fillOpacity: active ? 0.3 : 0.2, dashArray: active ? undefined : "8 5" }} eventHandlers={{ click: () => { if (!drawMode) onDrawnPolygonClick(polygon); } }}>
        {!drawMode && <Popup><FeatureDetails attributes={polygon.attributes} /><button onClick={() => onDrawnPolygonClick(polygon)}>Editar descripción</button></Popup>}
      </Polygon>;
    }))}
    {points.map((point) => {
      const selected = selectedPointIds.has(point.id), color = pointColor(point), outside = point.coverage === "Fuera", inside = point.coverage === "Dentro";
      const outline = selected ? "#211841" : outside ? "#dc2626" : inside ? "#087f5b" : "#fff";
      return <CircleMarker key={point.id} center={[point.lat, point.lng]} radius={selected ? 8 : outside ? 7 : 5.5} pathOptions={{ color: outline, weight: selected ? 3.5 : outside ? 3.5 : inside ? 2.25 : 1.5, fillColor: color, fillOpacity: 0.94 }} eventHandlers={{ click: () => { if (!multiSelect && !drawMode) onPointClick(point); } }}>
        {!multiSelect && !drawMode && <Popup><FeatureDetails attributes={point.attributes} /><button onClick={() => onPointClick(point)}>Editar punto</button></Popup>}
      </CircleMarker>;
    })}
  </MapContainer></div>;
}
