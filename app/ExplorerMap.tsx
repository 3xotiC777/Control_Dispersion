"use client";

import { useEffect, useRef, useState } from "react";
import { CircleMarker, MapContainer, Polygon, Popup, Rectangle, TileLayer, useMap, useMapEvents } from "react-leaflet";
import { latLngBounds, type LatLng, type LatLngBounds, type LatLngExpression } from "leaflet";
import type { CellValue, ExplorerPoint, ExplorerPolygon } from "./explorer-core";

type Bounds = [number, number, number, number];

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

export default function ExplorerMap({
  points,
  polygons,
  pointColor,
  polygonColor,
  selectedPointIds,
  selectedPolygonIds,
  multiSelect,
  onPointClick,
  onPolygonClick,
  onMultiSelect,
  onBoundsChange,
  extent,
  extentKey,
}: {
  points: ExplorerPoint[];
  polygons: ExplorerPolygon[];
  pointColor: (point: ExplorerPoint) => string;
  polygonColor: (polygon: ExplorerPolygon) => string;
  selectedPointIds: ReadonlySet<string>;
  selectedPolygonIds: ReadonlySet<string>;
  multiSelect: boolean;
  onPointClick: (point: ExplorerPoint) => void;
  onPolygonClick: (polygon: ExplorerPolygon) => void;
  onMultiSelect: (points: ExplorerPoint[]) => void;
  onBoundsChange?: (bounds: Bounds) => void;
  extent: Bounds | null;
  extentKey: string;
}) {
  const center: LatLngExpression = extent ? [(extent[1] + extent[3]) / 2, (extent[0] + extent[2]) / 2] : [18.7357, -70.1627];
  return <div className="map-wrap explorer-map-wrap"><MapContainer center={center} zoom={6} scrollWheelZoom preferCanvas className="leaflet-map">
    <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
    <FitInitialExtent extent={extent} extentKey={extentKey} />
    <ViewportReporter onBoundsChange={onBoundsChange} />
    <PointBoxSelection key={multiSelect ? "selecting" : "browsing"} enabled={multiSelect && points.length > 0} points={points} onSelect={onMultiSelect} />
    {polygons.map((polygon) => {
      const selected = selectedPolygonIds.has(polygon.id), color = polygonColor(polygon);
      return polygon.geometry.map((part, index) => <Polygon
        key={`${polygon.id}-${index}`}
        positions={part.map((ring) => ring.map(([lng, lat]) => [lat, lng] as [number, number]))}
        pathOptions={{ color: selected ? "#211841" : color, weight: selected ? 3 : 1.2, fillColor: color, fillOpacity: selected ? 0.34 : 0.15 }}
        eventHandlers={{ click: () => onPolygonClick(polygon) }}
      >{!multiSelect && <Popup><FeatureDetails attributes={polygon.attributes} /><button onClick={() => onPolygonClick(polygon)}>Editar polígono</button></Popup>}</Polygon>);
    })}
    {points.map((point) => {
      const selected = selectedPointIds.has(point.id), color = pointColor(point), outside = point.coverage === "Fuera", inside = point.coverage === "Dentro";
      const outline = selected ? "#211841" : outside ? "#dc2626" : inside ? "#087f5b" : "#fff";
      return <CircleMarker key={point.id} center={[point.lat, point.lng]} radius={selected ? 8 : outside ? 7 : 5.5} pathOptions={{ color: outline, weight: selected ? 3.5 : outside ? 3.5 : inside ? 2.25 : 1.5, fillColor: color, fillOpacity: 0.94 }} eventHandlers={{ click: () => { if (!multiSelect) onPointClick(point); } }}>
        {!multiSelect && <Popup><FeatureDetails attributes={point.attributes} /><button onClick={() => onPointClick(point)}>Editar punto</button></Popup>}
      </CircleMarker>;
    })}
  </MapContainer></div>;
}
