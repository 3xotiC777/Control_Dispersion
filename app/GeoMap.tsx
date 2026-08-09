"use client";

import { CircleMarker, MapContainer, Popup, TileLayer } from "react-leaflet";
import type { LatLngExpression } from "leaflet";

type Point = { id: string; mt: string; selection: string; kind: "Titular" | "Suplente" | "Otro"; lat: number; lng: number; day: number | null; avgMeters: number | null; row: Record<string, unknown> };

export default function GeoMap({ points, colors, planningVersion, onSelect }: { points: Point[]; colors: string[]; planningVersion: number; onSelect: (p: Point) => void }) {
  const center: LatLngExpression = points.length ? [points.reduce((s,p)=>s+p.lat,0)/points.length, points.reduce((s,p)=>s+p.lng,0)/points.length] : [18.7357, -70.1627];
  return <div className="map-wrap"><MapContainer key={planningVersion} center={center} zoom={points.length === 1 ? 13 : 8} scrollWheelZoom className="leaflet-map"><TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' contributors url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />{points.filter((p) => p.day).map((p) => <CircleMarker key={p.id} center={[p.lat,p.lng]} radius={p.kind === "Titular" ? 9 : 6} pathOptions={{ color: p.kind === "Titular" ? "#102a43" : "#fff", weight: p.kind === "Titular" ? 2 : 1, fillColor: colors[(p.day! - 1) % colors.length], fillOpacity: p.kind === "Titular" ? .95 : .72 }} eventHandlers={{ click: () => onSelect(p) }}><Popup><b>{String(p.row["PDV"] ?? p.row["RefID"] ?? "Punto")}</b><br />{p.mt}<br />Día {p.day} · {p.kind}<br />{Math.round(p.avgMeters ?? 0).toLocaleString()} m promedio<br /><button onClick={() => onSelect(p)}>Cambiar día</button></Popup></CircleMarker>)}</MapContainer></div>;
}
