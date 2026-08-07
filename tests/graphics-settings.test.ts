import { describe, expect, it } from "vitest";
import { RENDER_CONFIG, TERRAIN_CONFIG } from "../app/planet/constants";
import {
  chooseAutomaticGraphicsPreset,
  GRAPHICS_PRESETS,
  loadGraphicsPreference,
  resolveGraphicsState,
  saveGraphicsPreference,
  type GraphicsCapabilities,
} from "../app/planet/graphicsSettings";

function capabilities(overrides: Partial<GraphicsCapabilities> = {}): GraphicsCapabilities {
  return {
    gpuName: "ANGLE (NVIDIA GeForce RTX 4090 Direct3D11)",
    // Chromium deliberately rounds and caps this signal, even on systems with
    // much more physical RAM. A recognised high-end GPU must still get Ultra.
    deviceMemoryGb: 8,
    hardwareConcurrency: 24,
    maxTextureSize: 16_384,
    maxRenderbufferSize: 16_384,
    displayMegapixels: 8.3,
    mobile: false,
    ...overrides,
  };
}

describe("graphics profile detection", () => {
  it("keeps the existing renderer values exactly on Ultra", () => {
    expect(GRAPHICS_PRESETS.ultra.maxDevicePixelRatio).toBe(RENDER_CONFIG.maxDevicePixelRatio);
    expect(GRAPHICS_PRESETS.ultra.shadowMapSize).toBe(RENDER_CONFIG.surfaceShadowMapSize);
    expect(GRAPHICS_PRESETS.ultra.terrainScreenSpaceErrorPx).toBe(TERRAIN_CONFIG.screenSpaceErrorPx);
    expect(GRAPHICS_PRESETS.ultra.terrainMaxRenderLod).toBe(TERRAIN_CONFIG.maxRenderLod);
    expect(GRAPHICS_PRESETS.ultra.terrainMaxActiveTiles).toBe(TERRAIN_CONFIG.maxActiveTiles);
    expect(GRAPHICS_PRESETS.ultra.terrainGeometryCacheSize).toBe(TERRAIN_CONFIG.geometryCacheSize);
  });

  it("selects Ultra for a current high-end desktop GPU", () => {
    expect(chooseAutomaticGraphicsPreset(capabilities()).presetId).toBe("ultra");
  });

  it("selects High for a 6 GB-class RTX 3060 laptop GPU", () => {
    expect(chooseAutomaticGraphicsPreset(capabilities({
      gpuName: "ANGLE (NVIDIA GeForce RTX 3060 Laptop GPU Direct3D11)",
      hardwareConcurrency: 16,
    })).presetId).toBe("high");
  });

  it("selects Medium when a dual-GPU laptop browser is using Intel graphics", () => {
    expect(chooseAutomaticGraphicsPreset(capabilities({
      gpuName: "ANGLE (Intel(R) UHD Graphics Direct3D11)",
      hardwareConcurrency: 16,
    })).presetId).toBe("medium");
  });

  it("selects Low for software rendering or a small hardware budget", () => {
    expect(chooseAutomaticGraphicsPreset(capabilities({ gpuName: "Google SwiftShader" })).presetId).toBe("low");
    expect(chooseAutomaticGraphicsPreset(capabilities({
      gpuName: "WebGL 2 graphics adapter",
      deviceMemoryGb: 4,
      hardwareConcurrency: 4,
    })).presetId).toBe("low");
  });

  it("honours a manual setting over automatic detection", () => {
    const state = resolveGraphicsState("low", capabilities());
    expect(state.preference).toBe("low");
    expect(state.presetId).toBe("low");
  });

  it("persists valid preferences and rejects stale values", () => {
    let stored: string | null = null;
    const storage = {
      getItem: () => stored,
      setItem: (_key: string, value: string) => { stored = value; },
    };
    saveGraphicsPreference("medium", storage);
    expect(loadGraphicsPreference(storage)).toBe("medium");
    stored = "cinematic";
    expect(loadGraphicsPreference(storage)).toBe("auto");
  });
});
