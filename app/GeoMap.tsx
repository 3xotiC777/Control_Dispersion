"use client";

import { MapContainer, Marker, Popup, TileLayer } from "react-leaflet";
import { divIcon, type LatLngExpression } from "leaflet";
import styles from "./supplement-markers.module.css";

type Point = { id: string; refId: string; name: string; mt: string; assignedMt: string | null; selection: string; kind: "Titular" | "Suplente" | "Otro"; lat: number; lng: number; day: number | null; avgMeters: number | null; row: Record<string, unknown> };

function PointPopup({ point, onSelect }: { point: Point; onSelect: (point: Point) => void }) {
  return <Popup><b>{point.name}</b><br />RefID: {point.refId}<br />{point.assignedMt ?? point.mt}<br />Día {point.day} · {point.kind}<br />{Math.round(point.avgMeters ?? 0).toLocaleString()} m promedio<br /><button onClick={() => onSelect(point)}>Cambiar día</button></Popup>;
}

function labeledIcon(label: "T" | "S", color: string) {
  return divIcon({
    className: styles.supplementIcon,
    html: `<span class="${styles.supplementLabel}" style="--day-color:${color}">${label}</span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

export default function GeoMap({ points, colors, planningVersion, onSelect }: { points: Point[]; colors: string[]; planningVersion: number; onSelect: (p: Point) => void }) {
  const center: LatLngExpression = points.length ? [points.reduce((s,p)=>s+p.lat,0)/points.length, points.reduce((s,p)=>s+p.lng,0)/points.length] : [18.7357, -70.1627];
  return <div className="map-wrap"><MapContainer key={planningVersion} center={center} zoom={points.length === 1 ? 13 : 8} scrollWheelZoom className="leaflet-map"><TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' contributors url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />{points.filter((p) => p.day).map((point) => {
    const color = colors[(point.day! - 1) % colors.length];
    return <Marker key={point.id} position={[point.lat, point.lng]} icon={labeledIcon(point.kind === "Titular" ? "T" : "S", color)} eventHandlers={{ click: () => onSelect(point) }}><PointPopup point={point} onSelect={onSelect} /></Marker>;
  })}</MapContainer></div>;
}
