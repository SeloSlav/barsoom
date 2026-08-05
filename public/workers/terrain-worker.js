const MARS_REFERENCE_RADIUS_M = 3_389_500;
const PLANET_SEED = 0x4d415253;
const TERRAIN_WORKER_REVISION = "barsoom-terrain-geometry-v8";
const DETAIL_OCTAVES = [
  [38, 310],
  [91, 142],
  [218, 61],
  [530, 24],
  [1320, 8.5],
  [3300, 2.8],
  [8200, 0.82],
  [20500, 0.22],
  [48000, 12],
  [110000, 5.2],
  [250000, 2.1],
  [560000, 0.85],
  [1250000, 0.32],
  [2800000, 0.11],
];
const CRATER_SCALES = [
  [10, 60000, 0.30, 4000, 12000, 120, 650],
  [13, 16000, 0.34, 900, 3200, 25, 180],
  [16, 4000, 0.32, 180, 750, 4, 38],
  [18, 1000, 0.24, 35, 160, 0.8, 7],
];
const TAU = Math.PI * 2;

function normalize(x, y, z) {
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

function faceDirection(face, u, v) {
  switch (face) {
    case "px": return normalize(1, v, -u);
    case "nx": return normalize(-1, v, u);
    case "py": return normalize(u, 1, -v);
    case "ny": return normalize(u, -1, v);
    case "pz": return normalize(u, v, 1);
    case "nz": return normalize(-u, v, -1);
  }
}

function mix32(value) {
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

function spatialSeed(...components) {
  let hash = PLANET_SEED >>> 0;
  for (const component of components) hash = mix32(hash ^ mix32(component | 0));
  return hash >>> 0;
}

function hash3(x, y, z, seed) {
  return mix32(seed ^ Math.imul(x, 0x1f123bb5) ^ Math.imul(y, 0x5f356495) ^ Math.imul(z, 0x6c8e9cf5)) / 0xffffffff;
}

function smooth(value) {
  return value * value * (3 - 2 * value);
}

function valueNoise3(x, y, z, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const tx = smooth(x - ix);
  const ty = smooth(y - iy);
  const tz = smooth(z - iz);
  const sample = (dx, dy, dz) => hash3(ix + dx, iy + dy, iz + dz, seed);
  const lerp = (a, b, t) => a + (b - a) * t;
  const x00 = lerp(sample(0, 0, 0), sample(1, 0, 0), tx);
  const x10 = lerp(sample(0, 1, 0), sample(1, 1, 0), tx);
  const x01 = lerp(sample(0, 0, 1), sample(1, 0, 1), tx);
  const x11 = lerp(sample(0, 1, 1), sample(1, 1, 1), tx);
  return lerp(lerp(x00, x10, ty), lerp(x01, x11, ty), tz) * 2 - 1;
}

function detailHeight(direction, resolvedOctaves) {
  let height = 0;
  for (let octave = 0; octave < Math.min(resolvedOctaves, DETAIL_OCTAVES.length); octave += 1) {
    const [frequency, amplitude] = DETAIL_OCTAVES[octave];
    const seed = spatialSeed(0x6d617273, octave);
    const noise = valueNoise3(
      direction[0] * frequency + 17.1,
      direction[1] * frequency - 8.7,
      direction[2] * frequency + 3.9,
      seed,
    );
    const ridge = 1 - Math.abs(noise);
    const erosion = valueNoise3(
      direction[0] * frequency * 0.47 - 11,
      direction[1] * frequency * 0.47 + 7,
      direction[2] * frequency * 0.47 + 19,
      seed ^ 0x9e3779b9,
    );
    height += (noise * 0.62 + (ridge * ridge - 0.34) * 0.38) * amplitude * (0.78 + erosion * 0.22);
  }
  return height;
}

function wrapCell(value, count) {
  return ((value % count) + count) % count;
}

function random01(seed, lane) {
  return spatialSeed(seed, lane) / 0xffffffff;
}

function resolvedCraterScalesForLod(lod) {
  let count = 0;
  for (const scale of CRATER_SCALES) {
    if (lod >= scale[0]) count += 1;
  }
  return count;
}

function craterHeight(directionInput, resolvedScales) {
  const directionLength = Math.hypot(directionInput[0], directionInput[1], directionInput[2]) || 1;
  const direction = [
    directionInput[0] / directionLength,
    directionInput[1] / directionLength,
    directionInput[2] / directionLength,
  ];
  const latitude = Math.asin(Math.max(-1, Math.min(1, direction[1])));
  const longitude = Math.atan2(direction[2], direction[0]);
  const normalizedLongitude = ((longitude + Math.PI) % TAU + TAU) % TAU;
  let height = 0;
  const limit = Math.max(0, Math.min(CRATER_SCALES.length, resolvedScales));

  for (let scaleIndex = 0; scaleIndex < limit; scaleIndex += 1) {
    const [minimumLod, spacingM, density, minimumRadiusM, maximumRadiusM, minimumDepthM, maximumDepthM] = CRATER_SCALES[scaleIndex];
    void minimumLod;
    const latitudeStep = spacingM / MARS_REFERENCE_RADIUS_M;
    const latitudeCellCount = Math.ceil(Math.PI / latitudeStep);
    const centerRow = Math.floor((latitude + Math.PI * 0.5) / latitudeStep);

    for (let rowOffset = -2; rowOffset <= 2; rowOffset += 1) {
      const row = centerRow + rowOffset;
      if (row < 0 || row >= latitudeCellCount) continue;
      const rowLatitude = -Math.PI * 0.5 + (row + 0.5) * latitudeStep;
      const longitudeCellCount = Math.max(
        4,
        Math.round(TAU * MARS_REFERENCE_RADIUS_M * Math.max(0.001, Math.abs(Math.cos(rowLatitude))) / spacingM),
      );
      const centerColumn = Math.floor(normalizedLongitude / TAU * longitudeCellCount);

      for (let columnOffset = -2; columnOffset <= 2; columnOffset += 1) {
        const column = wrapCell(centerColumn + columnOffset, longitudeCellCount);
        const seed = spatialSeed(0x63726174, scaleIndex, row, column);
        if (random01(seed, 0) > density) continue;

        const craterLatitude = rowLatitude + (random01(seed, 1) - 0.5) * latitudeStep * 0.66;
        const longitudeStep = TAU / longitudeCellCount;
        const craterLongitude = -Math.PI + (column + 0.5) * longitudeStep +
          (random01(seed, 2) - 0.5) * longitudeStep * 0.66;
        const cosLatitude = Math.cos(craterLatitude);
        const craterDirection = [
          cosLatitude * Math.cos(craterLongitude),
          Math.sin(craterLatitude),
          cosLatitude * Math.sin(craterLongitude),
        ];
        const radiusT = random01(seed, 3) ** 1.45;
        const radiusM = minimumRadiusM * (maximumRadiusM / minimumRadiusM) ** radiusT;
        const dot = Math.max(-1, Math.min(1,
          direction[0] * craterDirection[0] + direction[1] * craterDirection[1] + direction[2] * craterDirection[2],
        ));
        const maximumDistanceM = radiusM * 1.6;
        if (dot < Math.cos(maximumDistanceM / MARS_REFERENCE_RADIUS_M)) continue;
        const distanceM = Math.acos(dot) * MARS_REFERENCE_RADIUS_M;
        if (distanceM >= maximumDistanceM) continue;

        const depthT = 0.35 + radiusT * 0.65;
        const depthM = minimumDepthM * (maximumDepthM / minimumDepthM) ** depthT;
        const radiusRatio = distanceM / radiusM;
        const bowl = radiusRatio < 1 ? -depthM * (1 - radiusRatio * radiusRatio) ** 2 : 0;
        const rimDistance = (radiusRatio - 1) / 0.105;
        const rim = depthM * 0.22 * Math.exp(-(rimDistance * rimDistance));
        const ejecta = radiusRatio > 1 ? depthM * 0.025 * Math.exp(-(radiusRatio - 1) * 5.5) : 0;
        height += bowl + rim + ejecta;
      }
    }
  }
  return height;
}

function terrainDetailHeightForLod(direction, lod) {
  const resolvedOctaves = Math.max(0, Math.min(DETAIL_OCTAVES.length, lod - 2));
  return detailHeight(direction, resolvedOctaves) +
    craterHeight(direction, resolvedCraterScalesForLod(lod));
}

function bilinear(values, size, x, y) {
  const x0 = Math.max(0, Math.min(size - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(size - 1, Math.floor(y)));
  const x1 = Math.min(size - 1, x0 + 1);
  const y1 = Math.min(size - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, x - x0));
  const ty = Math.max(0, Math.min(1, y - y0));
  const a = values[y0 * size + x0] * (1 - tx) + values[y0 * size + x1] * tx;
  const b = values[y1 * size + x0] * (1 - tx) + values[y1 * size + x1] * tx;
  return a * (1 - ty) + b * ty;
}

function sampleBase(base, u, v) {
  const count = 2 ** base.key.lod;
  const tileU = Math.max(0, Math.min(1, ((u + 1) * 0.5) * count - base.key.x));
  const tileV = Math.max(0, Math.min(1, ((v + 1) * 0.5) * count - base.key.y));
  return {
    height: bilinear(base.heightsM, base.gridSize, tileU * (base.gridSize - 1), tileV * (base.gridSize - 1)),
    areoid: bilinear(base.areoidM, base.gridSize, tileU * (base.gridSize - 1), tileV * (base.gridSize - 1)),
  };
}

function generate(message) {
  const { jobId, key, base, segments, skirtM } = message;
  const gridSize = segments + 1;
  const surfaceCount = gridSize * gridSize;
  const skirtCount = gridSize * 4;
  const vertexCount = surfaceCount + skirtCount;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const planetDirections = new Float32Array(vertexCount * 3);
  const elevations = new Float32Array(vertexCount);
  const areoidElevations = new Float32Array(vertexCount);
  const morphDelta = new Float32Array(vertexCount * 3);
  const tileUv = new Float32Array(vertexCount * 2);
  const surface = new Float32Array(vertexCount);
  const count = 2 ** key.lod;
  // Skirts only need to cover the spacing between adjacent vertices. Keeping
  // the former 140 m minimum at LOD 18 turned an otherwise sub-metre seam into
  // a visible rectangular canyon beside the playable patch.
  const localSkirtM = Math.min(skirtM, Math.max(0.35,
    (MARS_REFERENCE_RADIUS_M * 2 / count) / segments * 0.12));
  const u0 = -1 + 2 * key.x / count;
  const v0 = -1 + 2 * key.y / count;
  const size = 2 / count;
  const centerDirection = faceDirection(key.face, u0 + size * 0.5, v0 + size * 0.5);
  const centerBase = sampleBase(base, u0 + size * 0.5, v0 + size * 0.5);
  const centerHeight = centerBase.height + terrainDetailHeightForLod(centerDirection, key.lod);
  const center = centerDirection.map((component) => component * (MARS_REFERENCE_RADIUS_M + centerHeight));

  // Build the exact parent mesh under this child. A radial height delta is not
  // enough to join a tessellated cube-sphere: the odd child-edge vertices must
  // land on the parent's straight triangles, not merely sample its height
  // function at the same direction. This interpolation is the crack-free
  // geomorph target used both during transitions and along steady LOD edges.
  let parentGrid = null;
  let parentU0 = 0;
  let parentV0 = 0;
  let parentSize = 0;
  if (key.lod > 0) {
    const parentLod = key.lod - 1;
    const parentCount = 2 ** parentLod;
    const parentX = Math.floor(key.x / 2);
    const parentY = Math.floor(key.y / 2);
    parentU0 = -1 + 2 * parentX / parentCount;
    parentV0 = -1 + 2 * parentY / parentCount;
    parentSize = 2 / parentCount;
    parentGrid = new Float64Array(gridSize * gridSize * 3);
    for (let parentRow = 0; parentRow < gridSize; parentRow += 1) {
      for (let parentColumn = 0; parentColumn < gridSize; parentColumn += 1) {
        const parentIndex = parentRow * gridSize + parentColumn;
        const parentU = parentU0 + parentSize * (parentColumn / segments);
        const parentV = parentV0 + parentSize * (parentRow / segments);
        const parentDirection = faceDirection(key.face, parentU, parentV);
        const parentBase = sampleBase(base, parentU, parentV);
        const parentHeight = parentBase.height + terrainDetailHeightForLod(parentDirection, parentLod);
        const parentRadius = MARS_REFERENCE_RADIUS_M + parentHeight;
        for (let axis = 0; axis < 3; axis += 1) {
          parentGrid[parentIndex * 3 + axis] = parentDirection[axis] * parentRadius;
        }
      }
    }
  }

  for (let row = 0; row < gridSize; row += 1) {
    for (let column = 0; column < gridSize; column += 1) {
      const index = row * gridSize + column;
      const tu = column / segments;
      const tv = row / segments;
      const u = u0 + size * tu;
      const v = v0 + size * tv;
      const direction = faceDirection(key.face, u, v);
      const baseSample = sampleBase(base, u, v);
      const currentHeight = baseSample.height + terrainDetailHeightForLod(direction, key.lod);
      const radius = MARS_REFERENCE_RADIUS_M + currentHeight;
      const absolute = direction.map((component) => component * radius);
      for (let axis = 0; axis < 3; axis += 1) {
        positions[index * 3 + axis] = absolute[axis] - center[axis];
        planetDirections[index * 3 + axis] = direction[axis];
        morphDelta[index * 3 + axis] = 0;
      }
      if (parentGrid) {
        const parentGridX = Math.max(0, Math.min(segments, (u - parentU0) / parentSize * segments));
        const parentGridY = Math.max(0, Math.min(segments, (v - parentV0) / parentSize * segments));
        const parentColumn = Math.min(segments - 1, Math.floor(parentGridX));
        const parentRow = Math.min(segments - 1, Math.floor(parentGridY));
        const tx = parentGridX - parentColumn;
        const ty = parentGridY - parentRow;
        const a = parentRow * gridSize + parentColumn;
        const b = a + 1;
        const c = a + gridSize;
        const d = c + 1;
        for (let axis = 0; axis < 3; axis += 1) {
          let parentAxis;
          if (tx + ty <= 1) {
            const av = parentGrid[a * 3 + axis];
            parentAxis = av +
              (parentGrid[b * 3 + axis] - av) * tx +
              (parentGrid[c * 3 + axis] - av) * ty;
          } else {
            const dv = parentGrid[d * 3 + axis];
            parentAxis = dv +
              (parentGrid[c * 3 + axis] - dv) * (1 - tx) +
              (parentGrid[b * 3 + axis] - dv) * (1 - ty);
          }
          morphDelta[index * 3 + axis] = absolute[axis] - parentAxis;
        }
      }
      elevations[index] = currentHeight;
      areoidElevations[index] = baseSample.areoid;
      tileUv[index * 2] = tu;
      tileUv[index * 2 + 1] = tv;
      surface[index] = 1;
    }
  }

  for (let row = 0; row < gridSize; row += 1) {
    for (let column = 0; column < gridSize; column += 1) {
      const index = row * gridSize + column;
      const left = row * gridSize + Math.max(0, column - 1);
      const right = row * gridSize + Math.min(gridSize - 1, column + 1);
      const top = Math.max(0, row - 1) * gridSize + column;
      const bottom = Math.min(gridSize - 1, row + 1) * gridSize + column;
      const ax = positions[right * 3] - positions[left * 3];
      const ay = positions[right * 3 + 1] - positions[left * 3 + 1];
      const az = positions[right * 3 + 2] - positions[left * 3 + 2];
      const bx = positions[bottom * 3] - positions[top * 3];
      const by = positions[bottom * 3 + 1] - positions[top * 3 + 1];
      const bz = positions[bottom * 3 + 2] - positions[top * 3 + 2];
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const radialX = planetDirections[index * 3];
      const radialY = planetDirections[index * 3 + 1];
      const radialZ = planetDirections[index * 3 + 2];
      if (nx * radialX + ny * radialY + nz * radialZ < 0) {
        nx = -nx; ny = -ny; nz = -nz;
      }
      const normalLength = Math.hypot(nx, ny, nz) || 1;
      normals[index * 3] = nx / normalLength;
      normals[index * 3 + 1] = ny / normalLength;
      normals[index * 3 + 2] = nz / normalLength;
    }
  }

  const edgeSources = [];
  for (let column = 0; column < gridSize; column += 1) edgeSources.push(column);
  for (let row = 0; row < gridSize; row += 1) edgeSources.push(row * gridSize + segments);
  for (let column = segments; column >= 0; column -= 1) edgeSources.push(segments * gridSize + column);
  for (let row = segments; row >= 0; row -= 1) edgeSources.push(row * gridSize);
  for (let edgeIndex = 0; edgeIndex < edgeSources.length; edgeIndex += 1) {
    const sourceIndex = edgeSources[edgeIndex];
    const index = surfaceCount + edgeIndex;
    const orbitalReliefSkirtM = key.lod < 8 ? Math.abs(elevations[sourceIndex]) * 0.015 + 40 : 0;
    const dynamicSkirt = Math.max(localSkirtM, orbitalReliefSkirtM);
    for (let axis = 0; axis < 3; axis += 1) {
      const direction = planetDirections[sourceIndex * 3 + axis];
      positions[index * 3 + axis] = positions[sourceIndex * 3 + axis] - direction * dynamicSkirt;
      normals[index * 3 + axis] = normals[sourceIndex * 3 + axis];
      planetDirections[index * 3 + axis] = direction;
      morphDelta[index * 3 + axis] = morphDelta[sourceIndex * 3 + axis];
    }
    elevations[index] = elevations[sourceIndex] - dynamicSkirt;
    areoidElevations[index] = areoidElevations[sourceIndex];
    tileUv[index * 2] = tileUv[sourceIndex * 2];
    tileUv[index * 2 + 1] = tileUv[sourceIndex * 2 + 1];
    surface[index] = 0;
  }

  const surfaceIndexCount = segments * segments * 6;
  const skirtIndexCount = segments * 4 * 6;
  const indices = new Uint32Array(surfaceIndexCount + skirtIndexCount);
  let cursor = 0;
  for (let row = 0; row < segments; row += 1) {
    for (let column = 0; column < segments; column += 1) {
      const a = row * gridSize + column;
      const b = a + 1;
      const c = a + gridSize;
      const d = c + 1;
      // All six face mappings use the same UV orientation. Counter-clockwise
      // a-b-c / b-d-c winding points away from Mars so FrontSide terrain is
      // visible from orbit and from the surface.
      indices.set([a, b, c, b, d, c], cursor);
      cursor += 6;
    }
  }
  for (let edge = 0; edge < 4; edge += 1) {
    const edgeOffset = edge * gridSize;
    for (let step = 0; step < segments; step += 1) {
      const topA = edgeSources[edgeOffset + step];
      const topB = edgeSources[edgeOffset + step + 1];
      const bottomA = surfaceCount + edgeOffset + step;
      const bottomB = bottomA + 1;
      indices.set([topA, bottomA, topB, topB, bottomA, bottomB], cursor);
      cursor += 6;
    }
  }

  return {
    type: "generated",
    revision: TERRAIN_WORKER_REVISION,
    jobId,
    center,
    positions,
    normals,
    planetDirections,
    elevations,
    areoidElevations,
    morphDelta,
    tileUv,
    surface,
    indices,
    triangleCount: indices.length / 3,
  };
}

export { generate as generateTerrainTile, terrainDetailHeightForLod, TERRAIN_WORKER_REVISION };

if (typeof self !== "undefined") self.onmessage = (event) => {
  if (event.data?.type !== "generate") return;
  try {
    const result = generate(event.data);
    self.postMessage(result, [
      result.positions.buffer,
      result.normals.buffer,
      result.planetDirections.buffer,
      result.elevations.buffer,
      result.areoidElevations.buffer,
      result.morphDelta.buffer,
      result.tileUv.buffer,
      result.surface.buffer,
      result.indices.buffer,
    ]);
  } catch (error) {
    self.postMessage({ type: "error", jobId: event.data.jobId, message: error instanceof Error ? error.message : String(error) });
  }
};
