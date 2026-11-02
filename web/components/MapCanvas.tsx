"use client";

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState, type RefObject } from "react";
import { MapContainer, TileLayer, useMap } from "react-leaflet";
import type { MapCluster, MapNode } from "@/lib/ui/api";
import { directionsUrl, percent } from "@/lib/ui/format";
import { MAP_STATUS_COLORS } from "@/lib/ui/mapColors";

export type MapHandle = { open: (nodeId: number) => void };

const COVERAGE_METERS = 1000; // a cluster head's ~1 km radio radius
const DEFAULT_CENTER: [number, number] = [24.2075, 55.7447]; // Al Ain

const ESRI = {
  url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
  maxZoom: 19,
};
const OSM = {
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 19,
};
const FAILURES_BEFORE_FALLBACK = 5;

/** Built with DOM calls, not HTML strings: tree labels are typed by users. */
function nodePopup(node: MapNode, orgSlug: string): HTMLElement {
  const box = document.createElement("div");
  const title = document.createElement("div");
  title.style.fontWeight = "500";
  title.textContent = node.tree_label;
  const detail = document.createElement("div");
  detail.textContent = `LoRa ${node.lora_id} · ${node.status}${
    node.avg_confidence === null ? "" : ` · ${percent(node.avg_confidence)}`
  }`;
  const links = document.createElement("div");
  links.style.marginTop = "6px";
  links.style.display = "flex";
  links.style.gap = "10px";
  const history = document.createElement("a");
  history.href = `/${orgSlug}/history?node=${node.node_id}&tree=${encodeURIComponent(node.tree_label)}`;
  history.textContent = "Tree data";
  const navigate = document.createElement("a");
  navigate.href = directionsUrl(node.location_lat, node.location_lon);
  navigate.target = "_blank";
  navigate.rel = "noopener noreferrer";
  navigate.textContent = "Navigate";
  links.append(history, navigate);
  box.append(title, detail, links);
  return box;
}

function clusterPopup(cluster: MapCluster): HTMLElement {
  const box = document.createElement("div");
  const title = document.createElement("div");
  title.style.fontWeight = "500";
  title.textContent = cluster.name;
  const detail = document.createElement("div");
  detail.textContent = `${cluster.node_count} nodes${cluster.revoked ? " · revoked" : ""}`;
  box.append(title, detail);
  return box;
}

/**
 * Draws with Leaflet directly on one canvas. A React component per marker wouldn't stay fast at
 * 8,000 trees. Only alert trees get an animated marker, and there are few of those.
 */
function Markers({
  nodes,
  clusters,
  orgSlug,
  handleRef,
}: {
  nodes: MapNode[];
  clusters: MapCluster[];
  orgSlug: string;
  handleRef: RefObject<MapHandle | null>;
}) {
  const map = useMap();
  const fitted = useRef(false);

  useEffect(() => {
    const renderer = L.canvas({ padding: 0.5 });
    const group = L.layerGroup().addTo(map);
    const byId = new Map<number, L.Layer>();

    for (const cluster of clusters) {
      if (cluster.location_lat === null || cluster.location_lon === null)
        continue;
      const center: L.LatLngTuple = [
        cluster.location_lat,
        cluster.location_lon,
      ];
      L.circle(center, {
        radius: COVERAGE_METERS,
        color: "#5fa8e0",
        weight: 1,
        fillOpacity: 0.04,
        interactive: false,
        renderer,
      }).addTo(group);
      L.marker(center, {
        icon: L.divIcon({
          className: "",
          html: '<span class="cluster-marker"></span>',
          iconSize: [18, 18],
        }),
        title: cluster.name,
        zIndexOffset: 500,
      })
        .bindPopup(clusterPopup(cluster))
        .addTo(group);
    }

    for (const node of nodes) {
      const at: L.LatLngTuple = [node.location_lat, node.location_lon];
      const popup = () => nodePopup(node, orgSlug);
      const marker =
        node.status === "alert"
          ? L.marker(at, {
              icon: L.divIcon({
                className: "alert-marker",
                iconSize: [14, 14],
              }),
              title: node.tree_label,
              zIndexOffset: 1000,
            })
          : L.circleMarker(at, {
              renderer,
              radius: 5,
              color: "#ffffff",
              weight: 1,
              opacity: 0.5,
              fillColor: MAP_STATUS_COLORS[node.status],
              fillOpacity: 0.95,
            });
      marker.bindPopup(popup).addTo(group);
      byId.set(node.node_id, marker);
    }

    handleRef.current = {
      open(nodeId) {
        const marker = byId.get(nodeId) as
          (L.Marker | L.CircleMarker) | undefined;
        if (!marker) return;
        map.setView(marker.getLatLng(), Math.max(map.getZoom(), 17));
        marker.openPopup();
      },
    };

    // Only once, so the 60 s refresh doesn't pull the map away from where the user has moved it.
    if (!fitted.current) {
      const points: L.LatLngTuple[] = nodes.map((n) => [
        n.location_lat,
        n.location_lon,
      ]);
      if (points.length > 0) {
        map.fitBounds(points, { padding: [30, 30], maxZoom: 18 });
        fitted.current = true;
      }
    }
    return () => {
      group.remove();
    };
  }, [map, nodes, clusters, orgSlug, handleRef]);

  return null;
}

export function MapCanvas({
  nodes,
  clusters,
  orgSlug,
  handleRef,
}: {
  nodes: MapNode[];
  clusters: MapCluster[];
  orgSlug: string;
  handleRef: RefObject<MapHandle | null>;
}) {
  const [tiles, setTiles] = useState(ESRI);
  const failures = useRef(0);
  return (
    <MapContainer
      center={DEFAULT_CENTER}
      zoom={15}
      preferCanvas
      className="h-full w-full"
    >
      <TileLayer
        key={tiles.url}
        url={tiles.url}
        attribution={tiles.attribution}
        maxZoom={tiles.maxZoom}
        eventHandlers={{
          tileerror: () => {
            failures.current += 1;
            if (failures.current >= FAILURES_BEFORE_FALLBACK) setTiles(OSM);
          },
        }}
      />
      <Markers
        nodes={nodes}
        clusters={clusters}
        orgSlug={orgSlug}
        handleRef={handleRef}
      />
    </MapContainer>
  );
}
