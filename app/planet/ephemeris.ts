import { Body, HelioVector } from "astronomy-engine";
import type { Vec3 } from "./types";

const AU_KM = 149_597_870.7;
const SUN_RADIUS_KM = 695_700;
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

export type CelestialBodyState = {
  name: string;
  direction: Vec3;
  distanceAu: number;
  angularRadiusRad: number;
  magnitude: number;
  colour: [number, number, number];
};

export type MarsSkyState = {
  utc: Date;
  sunDirection: Vec3;
  sunAngularRadiusRad: number;
  inertialToMarsFixed: number[];
  bodies: CelestialBodyState[];
  moons: MarsMoonState[];
};

export type MarsMoonState = {
  name: "Phobos" | "Deimos";
  positionM: Vec3;
  orbitNormal: Vec3;
  semiAxesM: readonly [number, number, number];
  albedo: number;
};

export type OrbitalSurveyComposition = {
  focusDirection: Vec3;
  featuredBody: string | null;
};

const BODY_DATA: Array<{
  body: Body;
  radiusKm: number;
  baseMagnitude: number;
  colour: [number, number, number];
}> = [
  { body: Body.Mercury, radiusKm: 2_439.7, baseMagnitude: -0.5, colour: [0.86, 0.79, 0.67] },
  { body: Body.Venus, radiusKm: 6_051.8, baseMagnitude: -4.1, colour: [1, 0.89, 0.66] },
  { body: Body.Earth, radiusKm: 6_371, baseMagnitude: -3.2, colour: [0.56, 0.73, 1] },
  { body: Body.Jupiter, radiusKm: 69_911, baseMagnitude: -2.5, colour: [0.94, 0.79, 0.61] },
  { body: Body.Saturn, radiusKm: 58_232, baseMagnitude: 0.1, colour: [0.92, 0.82, 0.58] },
  { body: Body.Uranus, radiusKm: 25_362, baseMagnitude: 5.4, colour: [0.52, 0.89, 0.93] },
  { body: Body.Neptune, radiusKm: 24_622, baseMagnitude: 7.7, colour: [0.34, 0.52, 0.98] },
];

type MarsMoonOrbit = Omit<MarsMoonState, "positionM" | "orbitNormal"> & {
  semiMajorAxisM: number;
  eccentricity: number;
  inclinationDeg: number;
  ascendingNodeDeg: number;
  argumentOfPeriapsisDeg: number;
  meanAnomalyDeg: number;
  ascendingNodeRateDegPerDay: number;
  argumentOfPeriapsisRateDegPerDay: number;
  meanAnomalyRateDegPerDay: number;
};

// NASA/JPL Horizons MAR099 osculating elements at 2026-08-06 00:00 TDB.
// The element rates are fitted across the following 32 days, preserving both
// satellites' measured sidereal periods while accounting for Mars-driven
// nodal and apsidal precession. TDB was 69.184 seconds ahead of UTC here.
const MARS_MOON_EPOCH_UTC_MS = Date.UTC(2026, 7, 5, 23, 58, 50, 816);
const MARS_MOON_ORBITS: readonly MarsMoonOrbit[] = [
  {
    name: "Phobos",
    semiMajorAxisM: 9_378_910.9136,
    eccentricity: 0.0151166761,
    inclinationDeg: 36.8852671233,
    ascendingNodeDeg: 45.8951085655,
    argumentOfPeriapsisDeg: 295.7971827254,
    meanAnomalyDeg: 75.2465669625,
    ascendingNodeRateDegPerDay: 0.0045342505,
    argumentOfPeriapsisRateDegPerDay: 0.379923283,
    meanAnomalyRateDegPerDay: 1128.4612988764,
    semiAxesM: [13_400, 11_200, 9_200],
    albedo: 0.071,
  },
  {
    name: "Deimos",
    semiMajorAxisM: 23_458_096.2594,
    eccentricity: 0.0002943221,
    inclinationDeg: 35.603413598,
    ascendingNodeDeg: 43.9697912737,
    argumentOfPeriapsisDeg: 61.3255860726,
    meanAnomalyDeg: 280.3007497933,
    ascendingNodeRateDegPerDay: 0.0009139681,
    argumentOfPeriapsisRateDegPerDay: 0.7958519855,
    meanAnomalyRateDegPerDay: 284.3646898275,
    semiAxesM: [7_500, 6_100, 5_200],
    albedo: 0.068,
  },
] as const;

function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function dot(a: Vec3, b: Vec3) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function sphericalInterpolate(from: Vec3, to: Vec3, fraction: number): Vec3 {
  const cosine = Math.max(-1, Math.min(1, dot(from, to)));
  const angle = Math.acos(cosine);
  if (angle < 1e-8) return normalize(from);
  const sine = Math.sin(angle);
  const a = Math.sin((1 - fraction) * angle) / sine;
  const b = Math.sin(fraction * angle) / sine;
  return normalize({ x: from.x * a + to.x * b, y: from.y * a + to.y * b, z: from.z * a + to.z * b });
}

export function chooseOrbitalSurveyComposition(
  sky: MarsSkyState,
  limbOffsetDegrees = 18,
  minimumDaylight = 0.28,
): OrbitalSurveyComposition {
  const antiSun = { x: -sky.sunDirection.x, y: -sky.sunDirection.y, z: -sky.sunDirection.z };
  const offset = limbOffsetDegrees * Math.PI / 180;
  let best: { score: number; focusDirection: Vec3; name: string } | null = null;
  for (const body of sky.bodies) {
    if (body.name === "Phobos" || body.name === "Deimos") continue;
    const separation = Math.acos(Math.max(-1, Math.min(1, dot(body.direction, antiSun))));
    if (separation <= offset + 0.02) continue;
    const viewCenter = sphericalInterpolate(body.direction, antiSun, offset / separation);
    const focusDirection = { x: -viewCenter.x, y: -viewCenter.y, z: -viewCenter.z };
    const daylight = dot(focusDirection, sky.sunDirection);
    if (daylight < minimumDaylight) continue;
    const score = body.magnitude + (1 - daylight) * 2.5;
    if (!best || score < best.score) best = { score, focusDirection, name: body.name };
  }
  return best
    ? { focusDirection: best.focusDirection, featuredBody: best.name }
    : { focusDirection: normalize(sky.sunDirection), featuredBody: null };
}

export function marsOrientationMatrix(utc: Date) {
  const days = (utc.getTime() - J2000_MS) / 86_400_000;
  const centuries = days / 36_525;
  const ra = (317.68143 - 0.1061 * centuries) * Math.PI / 180;
  const dec = (52.8865 - 0.0609 * centuries) * Math.PI / 180;
  const rotation = ((176.63 + 350.89198226 * days) % 360) * Math.PI / 180;
  const pole = normalize({ x: Math.cos(dec) * Math.cos(ra), y: Math.cos(dec) * Math.sin(ra), z: Math.sin(dec) });
  const node = normalize(cross({ x: 0, y: 0, z: 1 }, pole));
  const quadrature = normalize(cross(pole, node));
  const prime = normalize({
    x: node.x * Math.cos(rotation) + quadrature.x * Math.sin(rotation),
    y: node.y * Math.cos(rotation) + quadrature.y * Math.sin(rotation),
    z: node.z * Math.cos(rotation) + quadrature.z * Math.sin(rotation),
  });
  const east = normalize(cross(pole, prime));
  return [prime.x, prime.y, prime.z, pole.x, pole.y, pole.z, east.x, east.y, east.z];
}

export function inertialToMarsFixedVector(vector: Vec3, matrix: number[]): Vec3 {
  return { x: dot(vector, { x: matrix[0], y: matrix[1], z: matrix[2] }), y: dot(vector, { x: matrix[3], y: matrix[4], z: matrix[5] }), z: dot(vector, { x: matrix[6], y: matrix[7], z: matrix[8] }) };
}

function solveEccentricAnomaly(meanAnomaly: number, eccentricity: number) {
  let eccentricAnomaly = meanAnomaly;
  for (let iteration = 0; iteration < 6; iteration += 1) {
    eccentricAnomaly -= (
      eccentricAnomaly - eccentricity * Math.sin(eccentricAnomaly) - meanAnomaly
    ) / (1 - eccentricity * Math.cos(eccentricAnomaly));
  }
  return eccentricAnomaly;
}

function rotatePerifocalToInertial(
  x: number,
  y: number,
  inclination: number,
  ascendingNode: number,
  argumentOfPeriapsis: number,
): Vec3 {
  const cosNode = Math.cos(ascendingNode);
  const sinNode = Math.sin(ascendingNode);
  const cosPeriapsis = Math.cos(argumentOfPeriapsis);
  const sinPeriapsis = Math.sin(argumentOfPeriapsis);
  const cosInclination = Math.cos(inclination);
  const sinInclination = Math.sin(inclination);
  return {
    x: (cosNode * cosPeriapsis - sinNode * sinPeriapsis * cosInclination) * x
      + (-cosNode * sinPeriapsis - sinNode * cosPeriapsis * cosInclination) * y,
    y: (sinNode * cosPeriapsis + cosNode * sinPeriapsis * cosInclination) * x
      + (-sinNode * sinPeriapsis + cosNode * cosPeriapsis * cosInclination) * y,
    z: sinPeriapsis * sinInclination * x + cosPeriapsis * sinInclination * y,
  };
}

export function calculateMarsMoons(utc: Date, matrix = marsOrientationMatrix(utc)): MarsMoonState[] {
  const daysFromEpoch = (utc.getTime() - MARS_MOON_EPOCH_UTC_MS) / 86_400_000;
  const radians = Math.PI / 180;
  return MARS_MOON_ORBITS.map((orbit) => {
    const inclination = orbit.inclinationDeg * radians;
    const ascendingNode = (
      orbit.ascendingNodeDeg + orbit.ascendingNodeRateDegPerDay * daysFromEpoch
    ) * radians;
    const argumentOfPeriapsis = (
      orbit.argumentOfPeriapsisDeg + orbit.argumentOfPeriapsisRateDegPerDay * daysFromEpoch
    ) * radians;
    const meanAnomaly = (
      orbit.meanAnomalyDeg + orbit.meanAnomalyRateDegPerDay * daysFromEpoch
    ) * radians;
    const eccentricAnomaly = solveEccentricAnomaly(meanAnomaly, orbit.eccentricity);
    const x = orbit.semiMajorAxisM * (Math.cos(eccentricAnomaly) - orbit.eccentricity);
    const y = orbit.semiMajorAxisM * Math.sqrt(1 - orbit.eccentricity ** 2) * Math.sin(eccentricAnomaly);
    const positionM = inertialToMarsFixedVector(
      rotatePerifocalToInertial(x, y, inclination, ascendingNode, argumentOfPeriapsis),
      matrix,
    );
    const orbitNormal = normalize(inertialToMarsFixedVector({
      x: Math.sin(inclination) * Math.sin(ascendingNode),
      y: -Math.sin(inclination) * Math.cos(ascendingNode),
      z: Math.cos(inclination),
    }, matrix));
    return {
      name: orbit.name,
      positionM,
      orbitNormal,
      semiAxesM: orbit.semiAxesM,
      albedo: orbit.albedo,
    };
  });
}

export function calculateMarsSky(utc: Date): MarsSkyState {
  const mars = HelioVector(Body.Mars, utc);
  const sunDistanceAu = Math.hypot(mars.x, mars.y, mars.z);
  const matrix = marsOrientationMatrix(utc);
  const sunInertial = normalize({ x: -mars.x, y: -mars.y, z: -mars.z });
  const bodies: CelestialBodyState[] = BODY_DATA.map((entry) => {
    const vector = HelioVector(entry.body, utc);
    const relative = { x: vector.x - mars.x, y: vector.y - mars.y, z: vector.z - mars.z };
    const distanceAu = Math.hypot(relative.x, relative.y, relative.z);
    return {
      name: entry.body,
      direction: normalize(inertialToMarsFixedVector(normalize(relative), matrix)),
      distanceAu,
      angularRadiusRad: Math.asin(Math.min(1, entry.radiusKm / (distanceAu * AU_KM))),
      magnitude: entry.baseMagnitude + 5 * Math.log10(Math.max(0.2, distanceAu)),
      colour: entry.colour,
    };
  });
  return {
    utc,
    sunDirection: normalize(inertialToMarsFixedVector(sunInertial, matrix)),
    sunAngularRadiusRad: Math.asin(Math.min(1, SUN_RADIUS_KM / (sunDistanceAu * AU_KM))),
    inertialToMarsFixed: matrix,
    bodies,
    moons: calculateMarsMoons(utc, matrix),
  };
}
