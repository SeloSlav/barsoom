import { describe, expect, it } from "vitest";
import { selectionReticleWorldScale } from "../app/planet/selectionReticle";

const GUIDE_SPAN_UNITS = 2.56;
const TARGET_SPAN_PX = 64;
const FOV_RAD = 42 * Math.PI / 180;

function projectedGuideSpanPx(distanceM: number, viewportHeightPx: number) {
  const scaleM = selectionReticleWorldScale(distanceM, viewportHeightPx, FOV_RAD);
  const visibleWorldHeightM = 2 * distanceM * Math.tan(FOV_RAD * 0.5);
  return GUIDE_SPAN_UNITS * scaleM / visibleWorldHeightM * viewportHeightPx;
}

describe("selection reticle sizing", () => {
  it.each([
    { distanceM: 250_000, viewportHeightPx: 720 },
    { distanceM: 10_000_000, viewportHeightPx: 1_080 },
    { distanceM: 30_000_000, viewportHeightPx: 900 },
  ])("keeps a $TARGET_SPAN_PX px guide at $distanceM m", ({ distanceM, viewportHeightPx }) => {
    expect(projectedGuideSpanPx(distanceM, viewportHeightPx)).toBeCloseTo(TARGET_SPAN_PX, 8);
  });

  it("retains a practical minimum scale during the final descent", () => {
    expect(selectionReticleWorldScale(2, 1_080, FOV_RAD)).toBe(2.5);
  });
});
