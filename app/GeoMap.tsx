"use client";

import { useEffect, useRef, useState } from "react";
import { MapContainer, Marker, Popup, Rectangle, TileLayer, useMap, useMapEvents } from "react-leaflet";
import { divIcon, latLngBounds, type LatLng, type LatLngBounds, type LatLngExpression } from "leaflet";
import styles from "./supplement-markers.module.css";
import { operationalMt, type Point } from "./planning-core";

function PointPopup({ point, onSelect }: { point: Point; onSelect: (point: Point) => void }) {
  return <Popup><b>{point.name}</b><br />RefID: {point.refId}<br />{point.assignedMt ?? point.mt}<br />Día {point.day} · {point.kind}<br />{Math.round(point.avgMeters ?? 0).toLocaleString()} m promedio<br /><button onClick={() => onSelect(point)}>Cambiar día</button></Popup>;
}

function labeledIcon(label: "T" | "S", color: string, selected: boolean) {
  const cacheKey = `${label}-${color}-${selected ? "selected" : "normal"}`;
  const cached = iconCache.get(cacheKey);
  if (cached) return cached;
  const icon = divIcon({
    className: styles.supplementIcon,
    html: `<span class="${styles.supplementLabel}${selected ? ` ${styles.selectedLabel}` : ""}" style="--day-color:${color}">${label}</span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
  iconCache.set(cacheKey, icon);
  return icon;
}

const iconCache = new Map<string, ReturnType<typeof divIcon>>();

function BoxSelection({ enabled, points, onSelect }: { enabled: boolean; points: Point[]; onSelect: (points: Point[]) => void }) {
  const map = useMap();
  const startRef = useRef<LatLng | null>(null);
  const [bounds, setBounds] = useState<LatLngBounds | null>(null);
  useEffect(() => {
    const container = map.getContainer();
    if (enabled) { map.dragging.disable(); container.style.cursor = "crosshair"; }
    else { map.dragging.enable(); container.style.cursor = ""; startRef.current = null; }
    return () => { map.dragging.enable(); container.style.cursor = ""; };
  }, [enabled, map]);
  useMapEvents({
    mousedown(event) {
      if (!enabled || event.originalEvent.button !== 0) return;
      startRef.current = event.latlng;
      setBounds(latLngBounds(event.latlng, event.latlng));
    },
    mousemove(event) {
      if (!enabled || !startRef.current) return;
      setBounds(latLngBounds(startRef.current, event.latlng));
    },
    mouseup(event) {
      if (!enabled || !startRef.current) return;
      const selectionBounds = latLngBounds(startRef.current, event.latlng);
      startRef.current = null;
      setBounds(null);
      onSelect(points.filter((point) => selectionBounds.contains([point.lat, point.lng])));
    },
  });
  return bounds ? <Rectangle bounds={bounds} pathOptions={{ color: "#7148e8", weight: 2, fillColor: "#7148e8", fillOpacity: 0.12, dashArray: "6 5" }} /> : null;
}

function AutoCenterMap({ points, filterKey }: { points: Point[]; filterKey?: string }) {
  const map = useMap();
  const prevFilterKey = useRef<string | null>(null);

  useEffect(() => {
    if (!points.length || !filterKey) return;
    if (prevFilterKey.current !== filterKey) {
      prevFilterKey.current = filterKey;
      if (points.length === 1) {
        map.setView([points[0].lat, points[0].lng], 14, { animate: true });
      } else {
        const bounds = latLngBounds(points.map((p) => [p.lat, p.lng]));
        if (bounds.isValid()) {
          map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15, animate: true });
        }
      }
    }
  }, [map, filterKey, points]);

  return null;
}

export default function GeoMap({ points, colors, planningVersion, onSelect, multiSelect, selectedIds, onMultiSelect, filterKey, viewMode = "day", mtColors }: { points: Point[]; colors: string[]; planningVersion: number; onSelect: (p: Point) => void; multiSelect: boolean; selectedIds: ReadonlySet<string>; onMultiSelect: (points: Point[]) => void; filterKey?: string; viewMode?: "day" | "mt"; mtColors?: Map<string, string> }) {
  const center: LatLngExpression = points.length ? [points.reduce((s,p)=>s+p.lat,0)/points.length, points.reduce((s,p)=>s+p.lng,0)/points.length] : [18.7357, -70.1627];
  return <div className="map-wrap"><MapContainer key={planningVersion} center={center} zoom={points.length === 1 ? 13 : 8} scrollWheelZoom className="leaflet-map"><TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" /><BoxSelection enabled={multiSelect} points={points} onSelect={onMultiSelect} /><AutoCenterMap points={points} filterKey={filterKey} />{points.map((point) => {
    const color = viewMode === "mt" && mtColors
      ? (mtColors.get(operationalMt(point)) ?? colors[0])
      : colors[(point.day! - 1) % colors.length];
    return <Marker key={point.id} position={[point.lat, point.lng]} icon={labeledIcon(point.kind === "Titular" ? "T" : "S", color, selectedIds.has(point.id))} eventHandlers={{ click: () => { if (!multiSelect) onSelect(point); } }}>{!multiSelect && <PointPopup point={point} onSelect={onSelect} />}</Marker>;
  })}</MapContainer></div>;
}
