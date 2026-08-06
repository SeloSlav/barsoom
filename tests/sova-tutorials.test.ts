import { describe, expect, it } from "vitest";
import { SOVA_TUTORIALS } from "../app/tutorials/sova";

describe("SOVA tutorials", () => {
  it("keeps every briefing to one paragraph and at most 30 seconds of speech", () => {
    for (const tutorial of Object.values(SOVA_TUTORIALS)) {
      const words = tutorial.body[0].trim().split(/\s+/);

      expect(tutorial.body).toHaveLength(1);
      expect(words.length).toBeLessThanOrEqual(60);
    }
  });
});
