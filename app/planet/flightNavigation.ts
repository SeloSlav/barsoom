export type FlightHudEdge = "top" | "right" | "bottom" | "left";

export type FlightHudInsets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type FlightHudProjection = {
  x: number;
  y: number;
  edge: FlightHudEdge | null;
  angleRad: number;
};

type FlightHudProjectionInput = {
  viewX: number;
  viewY: number;
  viewZ: number;
  viewportWidth: number;
  viewportHeight: number;
  verticalFovRad: number;
  aspect: number;
  insets: FlightHudInsets;
  forceEdge?: boolean;
};

const EPSILON = 1e-8;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Projects a camera-space target into the readable part of the flight HUD.
 * Targets outside the frustum, behind the camera, or explicitly occulted are
 * placed on the nearest inset edge while retaining their turn direction.
 */
export function projectFlightHudTarget(input: FlightHudProjectionInput): FlightHudProjection {
  const width = Math.max(1, input.viewportWidth);
  const height = Math.max(1, input.viewportHeight);
  const centreX = width * 0.5;
  const centreY = height * 0.5;
  const minimumX = clamp(input.insets.left, 0, centreX);
  const maximumX = clamp(width - input.insets.right, centreX, width);
  const minimumY = clamp(input.insets.top, 0, centreY);
  const maximumY = clamp(height - input.insets.bottom, centreY, height);
  const halfTanY = Math.max(EPSILON, Math.tan(input.verticalFovRad * 0.5));
  const depth = Math.max(EPSILON, Math.abs(input.viewZ));
  const ndcX = input.viewX / (depth * halfTanY * Math.max(EPSILON, input.aspect));
  const ndcY = input.viewY / (depth * halfTanY);
  const screenX = centreX + ndcX * width * 0.5;
  const screenY = centreY - ndcY * height * 0.5;
  const behindCamera = input.viewZ >= 0;
  const insideReadableArea = !behindCamera && !input.forceEdge &&
    screenX >= minimumX && screenX <= maximumX &&
    screenY >= minimumY && screenY <= maximumY;

  if (insideReadableArea) {
    return { x: screenX, y: screenY, edge: null, angleRad: 0 };
  }

  const deltaX = screenX - centreX;
  let deltaY = screenY - centreY;
  if (Math.hypot(deltaX, deltaY) < EPSILON) {
    // A target exactly aft has no unique two-dimensional bearing. Put it on
    // the lower edge so the HUD still communicates that it is out of view.
    deltaY = 1;
  }
  const horizontalScale = deltaX > 0
    ? (maximumX - centreX) / deltaX
    : deltaX < 0 ? (minimumX - centreX) / deltaX : Number.POSITIVE_INFINITY;
  const verticalScale = deltaY > 0
    ? (maximumY - centreY) / deltaY
    : deltaY < 0 ? (minimumY - centreY) / deltaY : Number.POSITIVE_INFINITY;
  const edgeScale = Math.max(0, Math.min(horizontalScale, verticalScale));
  const x = clamp(centreX + deltaX * edgeScale, minimumX, maximumX);
  const y = clamp(centreY + deltaY * edgeScale, minimumY, maximumY);
  const distances: Array<[FlightHudEdge, number]> = [
    ["top", Math.abs(y - minimumY)],
    ["right", Math.abs(x - maximumX)],
    ["bottom", Math.abs(y - maximumY)],
    ["left", Math.abs(x - minimumX)],
  ];
  distances.sort((a, b) => a[1] - b[1]);
  return {
    x,
    y,
    edge: distances[0][0],
    angleRad: Math.atan2(deltaY, deltaX),
  };
}

function spreadAxis(values: number[], minimum: number, maximum: number, requestedGap: number) {
  if (values.length <= 1) return values.map((value) => clamp(value, minimum, maximum));
  const gap = Math.min(requestedGap, Math.max(0, (maximum - minimum) / (values.length - 1)));
  const positions = values.map((value) => clamp(value, minimum, maximum));
  for (let index = 1; index < positions.length; index += 1) {
    positions[index] = Math.max(positions[index], positions[index - 1] + gap);
  }
  if (positions.at(-1)! > maximum) {
    positions[positions.length - 1] = maximum;
    for (let index = positions.length - 2; index >= 0; index -= 1) {
      positions[index] = Math.min(positions[index], positions[index + 1] - gap);
    }
  }
  if (positions[0] < minimum) {
    const offset = minimum - positions[0];
    for (let index = 0; index < positions.length; index += 1) positions[index] += offset;
  }
  return positions;
}

/** Keeps edge-clamped targets individually readable without moving in-view reticles. */
export function distributeFlightHudEdges<T extends FlightHudProjection>(
  markers: readonly T[],
  viewportWidth: number,
  viewportHeight: number,
  insets: FlightHudInsets,
  minimumGapPx = 44,
) {
  const result = markers.map((marker) => ({ ...marker }));
  for (const edge of ["top", "right", "bottom", "left"] as const) {
    const indexed = result
      .map((marker, index) => ({ marker, index }))
      .filter(({ marker }) => marker.edge === edge)
      .sort((a, b) => (
        edge === "top" || edge === "bottom"
          ? a.marker.x - b.marker.x
          : a.marker.y - b.marker.y
      ));
    if (indexed.length === 0) continue;
    const horizontal = edge === "top" || edge === "bottom";
    const positions = spreadAxis(
      indexed.map(({ marker }) => horizontal ? marker.x : marker.y),
      horizontal ? insets.left : insets.top,
      horizontal ? viewportWidth - insets.right : viewportHeight - insets.bottom,
      minimumGapPx,
    );
    indexed.forEach(({ index }, sortedIndex) => {
      if (horizontal) result[index].x = positions[sortedIndex];
      else result[index].y = positions[sortedIndex];
    });
  }
  return result;
}

export function marsSurfaceRangeM(
  origin: { x: number; y: number; z: number },
  targetDirection: { x: number; y: number; z: number },
  radiusM: number,
) {
  const originLength = Math.hypot(origin.x, origin.y, origin.z);
  const targetLength = Math.hypot(targetDirection.x, targetDirection.y, targetDirection.z);
  if (originLength < EPSILON || targetLength < EPSILON) return 0;
  const cosine = clamp(
    (origin.x * targetDirection.x + origin.y * targetDirection.y + origin.z * targetDirection.z)
      / (originLength * targetLength),
    -1,
    1,
  );
  return Math.acos(cosine) * radiusM;
}
