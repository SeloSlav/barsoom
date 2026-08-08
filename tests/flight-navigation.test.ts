import { describe, expect, it } from "vitest";
import {
  distributeFlightHudEdges,
  marsSurfaceRangeM,
  projectFlightHudTarget,
  selectNearestFlightTargets,
  type FlightHudInsets,
} from "../app/planet/flightNavigation";

const viewport = {
  viewportWidth: 800,
  viewportHeight: 600,
  verticalFovRad: Math.PI / 2,
  aspect: 4 / 3,
};
const insets: FlightHudInsets = { top: 100, right: 20, bottom: 40, left: 20 };

describe("spacecraft flight navigation HUD", () => {
  it("keeps a visible forward target on its exact screen position", () => {
    const marker = projectFlightHudTarget({
      ...viewport,
      insets,
      viewX: 0,
      viewY: 0,
      viewZ: -100,
    });
    expect(marker.edge).toBeNull();
    expect(marker.x).toBeCloseTo(400, 8);
    expect(marker.y).toBeCloseTo(300, 8);
  });

  it("clamps an off-screen target to the edge in its turn direction", () => {
    const marker = projectFlightHudTarget({
      ...viewport,
      insets,
      viewX: 500,
      viewY: 0,
      viewZ: -100,
    });
    expect(marker.edge).toBe("right");
    expect(marker.x).toBe(780);
    expect(marker.y).toBeCloseTo(300, 8);
    expect(marker.angleRad).toBeCloseTo(0, 8);
  });

  it("keeps an exactly aft or occulted destination represented on an edge", () => {
    const aft = projectFlightHudTarget({
      ...viewport,
      insets,
      viewX: 0,
      viewY: 0,
      viewZ: 100,
    });
    const occulted = projectFlightHudTarget({
      ...viewport,
      insets,
      viewX: 0,
      viewY: 0,
      viewZ: -100,
      forceEdge: true,
    });
    expect(aft.edge).toBe("bottom");
    expect(aft.y).toBe(560);
    expect(occulted.edge).toBe("bottom");
  });

  it("spreads crowded edge arrows while leaving in-view targets untouched", () => {
    const markers = distributeFlightHudEdges([
      { x: 780, y: 170, edge: "right" as const, angleRad: 0, id: "a" },
      { x: 780, y: 174, edge: "right" as const, angleRad: 0, id: "b" },
      { x: 780, y: 178, edge: "right" as const, angleRad: 0, id: "c" },
      { x: 410, y: 320, edge: null, angleRad: 0, id: "visible" },
    ], 800, 600, insets, 44);
    const edgeMarkers = markers.slice(0, 3);
    expect(edgeMarkers[1].y - edgeMarkers[0].y).toBeGreaterThanOrEqual(44);
    expect(edgeMarkers[2].y - edgeMarkers[1].y).toBeGreaterThanOrEqual(44);
    expect(markers[3]).toMatchObject({ x: 410, y: 320, edge: null });
  });

  it("limits surface navigation to the nearest destinations", () => {
    const targets = [
      { id: "far", rangeM: 900 },
      { id: "nearest", rangeM: 100 },
      { id: "middle", rangeM: 500 },
      { id: "near", rangeM: 300 },
    ];
    expect(selectNearestFlightTargets(targets, 3).map((target) => target.id))
      .toEqual(["nearest", "near", "middle"]);
    expect(targets.map((target) => target.id))
      .toEqual(["far", "nearest", "middle", "near"]);
  });

  it("reports globe-following range for surface destinations", () => {
    const rangeM = marsSurfaceRangeM(
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      3_389_500,
    );
    expect(rangeM).toBeCloseTo(Math.PI * 3_389_500 / 2, 6);
  });
});
