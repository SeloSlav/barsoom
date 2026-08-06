const RETICLE_GUIDE_SPAN_UNITS = 2.56;
const RETICLE_TARGET_SPAN_PX = 64;
const RETICLE_MINIMUM_WORLD_SCALE_M = 2.5;
const RETICLE_MAXIMUM_WORLD_SCALE_M = 1_000_000;

export function selectionReticleWorldScale(
  distanceM: number,
  viewportHeightPx: number,
  verticalFovRad: number,
) {
  const safeDistanceM = Math.max(0, distanceM);
  const safeViewportHeightPx = Math.max(1, viewportHeightPx);
  const visibleWorldHeightM = 2 * safeDistanceM * Math.tan(verticalFovRad * 0.5);
  const scaleM = visibleWorldHeightM * RETICLE_TARGET_SPAN_PX
    / (safeViewportHeightPx * RETICLE_GUIDE_SPAN_UNITS);
  return Math.min(
    RETICLE_MAXIMUM_WORLD_SCALE_M,
    Math.max(RETICLE_MINIMUM_WORLD_SCALE_M, scaleM),
  );
}
