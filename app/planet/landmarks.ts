import { MARS_REFERENCE_RADIUS_M } from "./constants";
import type { Vec3 } from "./types";

export type MarsLandmark = {
  id: string;
  name: string;
  featureType: string;
  latitudeDeg: number;
  longitudeDeg: number;
  hoverRadiusKm: number;
  landingLatitudeDeg?: number;
  landingLongitudeDeg?: number;
  headingRad?: number;
};

/**
 * Recognisable Martian regions used by the orbital surface picker. The
 * landmark coordinate identifies the named feature; optional landing
 * coordinates put the observer at a nearby human-scale view of its relief.
 */
export const MARS_LANDMARKS: readonly MarsLandmark[] = [
  {
    id: "olympus-mons",
    name: "Olympus Mons",
    featureType: "Shield volcano",
    latitudeDeg: 18.65,
    longitudeDeg: -133.8,
    hoverRadiusKm: 420,
    landingLatitudeDeg: 23.35,
    landingLongitudeDeg: -135.95,
    headingRad: Math.PI,
  },
  {
    id: "ius-chasma",
    name: "Ius Chasma",
    featureType: "Valles Marineris canyon",
    latitudeDeg: -7.29,
    longitudeDeg: -84.39,
    hoverRadiusKm: 300,
  },
  {
    id: "noctis-labyrinthus",
    name: "Noctis Labyrinthus",
    featureType: "Intersecting chasmata",
    latitudeDeg: -6.8,
    longitudeDeg: -100.1,
    hoverRadiusKm: 250,
    landingLatitudeDeg: -6.735,
    landingLongitudeDeg: -100.0025,
    headingRad: -2.35962,
  },
  {
    id: "korolev",
    name: "Korolev Crater",
    featureType: "Ice-filled impact crater",
    latitudeDeg: 72.77,
    longitudeDeg: 164.58,
    hoverRadiusKm: 110,
  },
  {
    id: "hellas-planitia",
    name: "Hellas Planitia",
    featureType: "Impact basin",
    latitudeDeg: -42.4,
    longitudeDeg: 70.5,
    hoverRadiusKm: 850,
  },
  {
    id: "gale-crater",
    name: "Gale Crater",
    featureType: "Impact crater / Aeolis Mons",
    latitudeDeg: -5.4,
    longitudeDeg: 137.8,
    hoverRadiusKm: 105,
  },
  {
    id: "jezero-crater",
    name: "Jezero Crater",
    featureType: "Ancient lake basin",
    latitudeDeg: 18.38,
    longitudeDeg: 77.58,
    hoverRadiusKm: 80,
  },
  {
    id: "syrtis-major",
    name: "Syrtis Major Planum",
    featureType: "Dark volcanic province",
    latitudeDeg: 8.4,
    longitudeDeg: 69.5,
    hoverRadiusKm: 520,
  },
  {
    id: "elysium-mons",
    name: "Elysium Mons",
    featureType: "Shield volcano",
    latitudeDeg: 24.75,
    longitudeDeg: 146.87,
    hoverRadiusKm: 280,
  },
  {
    id: "arsia-mons",
    name: "Arsia Mons",
    featureType: "Tharsis volcano",
    latitudeDeg: -8.35,
    longitudeDeg: -120.09,
    hoverRadiusKm: 280,
  },
  {
    id: "utopia-planitia",
    name: "Utopia Planitia",
    featureType: "Northern impact basin",
    latitudeDeg: 46.7,
    longitudeDeg: 117.5,
    hoverRadiusKm: 760,
  },
  {
    id: "argyre-planitia",
    name: "Argyre Planitia",
    featureType: "Impact basin",
    latitudeDeg: -49.7,
    longitudeDeg: -42.0,
    hoverRadiusKm: 520,
  },
];

export function landmarkDirection(landmark: MarsLandmark): Vec3 {
  const latitude = landmark.latitudeDeg * Math.PI / 180;
  const longitude = landmark.longitudeDeg * Math.PI / 180;
  const cosLatitude = Math.cos(latitude);
  return {
    x: cosLatitude * Math.cos(longitude),
    y: Math.sin(latitude),
    z: cosLatitude * Math.sin(longitude),
  };
}

export function findMarsLandmarkAtDirection(direction: Vec3) {
  const directionLength = Math.hypot(direction.x, direction.y, direction.z);
  if (directionLength < 1e-12) return null;

  let closest: { landmark: MarsLandmark; angularDistanceRad: number; radiusRad: number } | null = null;
  for (const landmark of MARS_LANDMARKS) {
    const target = landmarkDirection(landmark);
    const dot = Math.max(-1, Math.min(1, (
      direction.x * target.x + direction.y * target.y + direction.z * target.z
    ) / directionLength));
    const angularDistanceRad = Math.acos(dot);
    const radiusRad = landmark.hoverRadiusKm * 1_000 / MARS_REFERENCE_RADIUS_M;
    if (angularDistanceRad > radiusRad) continue;
    if (!closest || angularDistanceRad / radiusRad < closest.angularDistanceRad / closest.radiusRad) {
      closest = { landmark, angularDistanceRad, radiusRad };
    }
  }
  return closest;
}
