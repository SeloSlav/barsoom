import { describe, expect, it } from "vitest";
import { createSpacemanShareUrl, parseSpacemanShareLocation } from "../app/planet/shareLocation";

describe("Spaceman share links", () => {
  it("round-trips exact coordinates and facing direction through URL parameters", () => {
    const location = {
      latitudeDeg: -7.29123456789012,
      longitudeDeg: -84.3987654321098,
      headingRad: -0.75,
    };
    const url = createSpacemanShareUrl("https://barsoom.example/?ref=field-note", location);
    const parsed = parseSpacemanShareLocation(new URL(url).search);

    expect(url).toContain("mode=spaceman");
    expect(url).toContain("ref=field-note");
    expect(parsed).toEqual({
      ...location,
      headingRad: Math.PI * 2 - 0.75,
    });
  });

  it("ignores incomplete, non-Spaceman, and out-of-range locations", () => {
    expect(parseSpacemanShareLocation("?lat=1&lon=2&heading=3")).toBeNull();
    expect(parseSpacemanShareLocation("?mode=spaceman&lat=91&lon=2&heading=3")).toBeNull();
    expect(parseSpacemanShareLocation("?mode=spaceman&lat=1&lon=181&heading=3")).toBeNull();
    expect(parseSpacemanShareLocation("?mode=spaceman&lat=1&lon=2")).toBeNull();
  });
});
