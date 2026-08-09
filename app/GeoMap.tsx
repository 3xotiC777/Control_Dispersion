"use client";

import { CircleMarker, MapContainer, Marker, Popup, TileLayer } from "react-leaflet";
import { divIcon, type LatLngExpression } from "leaflet";
import styles from "./supplement-markers.module.css";

type Point = { id: string; mt: string; assignedMt: string | null; selection: string; kind: "Titular" | "Suplente" | "Otro"; lat: number; lng: number; day: number | null; avgMeters: number | null; row: Record<string, unknown> };

function PointPopup({ point, onSelect }: { point: Point; onSelect: (point: Point) => void }) {
  return <Popup><b>{String(point.row["PDV"] ?? point.row["RefID"] ?? "Punto")}</b><br />{point.assignedMt ?? point.mt}<br />Día {point.day} · {point.kind}<br />{Math.round(point.avgMeters ?? 0).toLocaleString()} m promedio<br /><button onClick={() => onSelect(point)}>Cambiar día</button></Popup>;
}

function supplementIcon(color: string) {
  return divIcon({
    className: styles.supplementIcon,
    html: `<span class="${styles.supplementLabel}" style="--day-color:${color}">S</span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

export default function GeoMap({ points, colors, planningVersion, onSelect }: { points: Point[]; colors: string[]; planningVersion: number; onSelect: (p: Point) => void }) {
  const center: LatLngExpression = points.length ? [points.reduce((s,p)=>s+p.lat,0)/points.length, points.reduce((s,p)=>s+p.lng,0)/points.length] : [18.7357, -70.1627];
  return <div className="map-wrap"><MapContainer key={planningVersion} center={center} zoom={points.length === 1 ? 13 : 8} scrollWheelZoom className="leaflet-map"><TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' contributors url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />{points.filter((p) => p.day).map((point) => {
    const color = colors[(point.day! - 1) % colors.length];
    return point.kind === "Suplente"
      ? <Marker key={point.id} position={[point.lat, point.lng]} icon={supplementIcon(color)} eventHandlers={{ click: () => onSelect(point) }}><PointPopup point={point} onSelect={onSelect} /></Marker>
      : <CircleMarker key={point.id} center={[point.lat, point.lng]} radius={9} pathOptions={{ color: "#102a43", weight: 2, fillColor: color, fillOpacity: .95 }} eventHandlers={{ click: () => onSelect(point) }}><PointPopup point={point} onSelect={onSelect} /></CircleMarker>;
  })}</MapContainer></div>;
}
