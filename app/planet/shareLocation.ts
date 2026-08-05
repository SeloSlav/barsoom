export type SpacemanShareLocation = {
  latitudeDeg: number;
  longitudeDeg: number;
  headingRad: number;
};

const TWO_PI = Math.PI * 2;

function parseFiniteNumber(value: string | null) {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function wrapHeadingRadians(headingRad: number) {
  const wrapped = ((headingRad % TWO_PI) + TWO_PI) % TWO_PI;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

export function parseSpacemanShareLocation(search: string): SpacemanShareLocation | null {
  const params = new URLSearchParams(search);
  if (params.get("mode") !== "spaceman") return null;

  const latitudeDeg = parseFiniteNumber(params.get("lat"));
  const longitudeDeg = parseFiniteNumber(params.get("lon"));
  const headingRad = parseFiniteNumber(params.get("heading"));
  if (
    latitudeDeg === null || latitudeDeg < -90 || latitudeDeg > 90 ||
    longitudeDeg === null || longitudeDeg < -180 || longitudeDeg > 180 ||
    headingRad === null
  ) return null;

  return { latitudeDeg, longitudeDeg, headingRad: wrapHeadingRadians(headingRad) };
}

export function createSpacemanShareUrl(baseUrl: string, location: SpacemanShareLocation) {
  const url = new URL(baseUrl);
  url.searchParams.set("mode", "spaceman");
  url.searchParams.set("lat", String(location.latitudeDeg));
  url.searchParams.set("lon", String(location.longitudeDeg));
  url.searchParams.set("heading", String(wrapHeadingRadians(location.headingRad)));
  return url.toString();
}
