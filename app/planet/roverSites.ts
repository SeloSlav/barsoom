import { MARS_REFERENCE_RADIUS_M } from "./constants";
import { localEnuBasis } from "./math";
import type { Vec3 } from "./types";

export type RetiredRoverModel = "sojourner" | "mer";

export type RetiredRoverSite = {
  id: string;
  name: string;
  model: RetiredRoverModel;
  finalSite: string;
  latitudeDeg: number;
  longitudeDeg: number;
  modelHeadingRad: number;
  visitDistanceM: number;
  missionEndYear: number;
};

/**
 * Surface positions for completed rover missions only. Spirit and Opportunity
 * use the last corrected PDS traverse positions. Sojourner stayed within 12 m
 * of Pathfinder, below the useful precision of the global terrain dataset, so
 * its refined Pathfinder landing-site coordinate is the model anchor.
 *
 * PDS MER traverse products:
 * https://an.rsl.wustl.edu/mera/AN/pages/mer/mer_traverse.htm
 * NASA Pathfinder refined site:
 * https://science.nasa.gov/photojournal/mars-pathfinder-first-anniversary-special-refined-landing-site-location/
 */
export const RETIRED_ROVER_SITES: readonly RetiredRoverSite[] = [
  {
    id: "sojourner-rover",
    name: "Sojourner",
    model: "sojourner",
    finalSite: "Ares Vallis / Pathfinder",
    latitudeDeg: 19.13,
    longitudeDeg: -33.22,
    modelHeadingRad: 2.36,
    visitDistanceM: 8,
    missionEndYear: 1997,
  },
  {
    id: "spirit-rover",
    name: "Spirit",
    model: "mer",
    finalSite: "Troy / Home Plate",
    latitudeDeg: -14.60037,
    longitudeDeg: 175.52538,
    modelHeadingRad: -2.02,
    visitDistanceM: 14,
    missionEndYear: 2011,
  },
  {
    id: "opportunity-rover",
    name: "Opportunity",
    model: "mer",
    finalSite: "Perseverance Valley",
    latitudeDeg: -2.32895,
    longitudeDeg: -5.34995,
    modelHeadingRad: 1.22,
    visitDistanceM: 14,
    missionEndYear: 2019,
  },
] as const;

export function roverSiteDirection(site: Pick<RetiredRoverSite, "latitudeDeg" | "longitudeDeg">): Vec3 {
  const latitude = site.latitudeDeg * Math.PI / 180;
  const longitude = site.longitudeDeg * Math.PI / 180;
  const cosLatitude = Math.cos(latitude);
  return {
    x: cosLatitude * Math.cos(longitude),
    y: Math.sin(latitude),
    z: cosLatitude * Math.sin(longitude),
  };
}

/** Places a visitor south of the artifact, facing due north toward it. */
export function roverVisitCoordinates(site: RetiredRoverSite) {
  const latitudeOffsetDeg = site.visitDistanceM / MARS_REFERENCE_RADIUS_M * 180 / Math.PI;
  return {
    latitudeDeg: site.latitudeDeg - latitudeOffsetDeg,
    longitudeDeg: site.longitudeDeg,
    headingRad: 0,
  };
}

export function roverModelBasis(site: RetiredRoverSite, surfaceNormalInput: Vec3) {
  const normalLength = Math.hypot(surfaceNormalInput.x, surfaceNormalInput.y, surfaceNormalInput.z);
  const up = normalLength > 1e-9
    ? {
        x: surfaceNormalInput.x / normalLength,
        y: surfaceNormalInput.y / normalLength,
        z: surfaceNormalInput.z / normalLength,
      }
    : roverSiteDirection(site);
  const enu = localEnuBasis(site.latitudeDeg, site.longitudeDeg);
  const nominalForward = {
    x: enu.north.x * Math.cos(site.modelHeadingRad) + enu.east.x * Math.sin(site.modelHeadingRad),
    y: enu.north.y * Math.cos(site.modelHeadingRad) + enu.east.y * Math.sin(site.modelHeadingRad),
    z: enu.north.z * Math.cos(site.modelHeadingRad) + enu.east.z * Math.sin(site.modelHeadingRad),
  };
  const normalComponent = nominalForward.x * up.x + nominalForward.y * up.y + nominalForward.z * up.z;
  const forwardLength = Math.hypot(
    nominalForward.x - up.x * normalComponent,
    nominalForward.y - up.y * normalComponent,
    nominalForward.z - up.z * normalComponent,
  );
  const forward = {
    x: (nominalForward.x - up.x * normalComponent) / Math.max(1e-9, forwardLength),
    y: (nominalForward.y - up.y * normalComponent) / Math.max(1e-9, forwardLength),
    z: (nominalForward.z - up.z * normalComponent) / Math.max(1e-9, forwardLength),
  };
  return {
    right: {
      x: up.y * forward.z - up.z * forward.y,
      y: up.z * forward.x - up.x * forward.z,
      z: up.x * forward.y - up.y * forward.x,
    },
    up,
    forward,
  };
}
