import { RENDER_CONFIG, TERRAIN_CONFIG } from "./constants";

export type GraphicsPresetId = "ultra" | "high" | "medium" | "low";
export type GraphicsPreference = "auto" | GraphicsPresetId;

export type GraphicsPreset = {
  id: GraphicsPresetId;
  label: string;
  description: string;
  maxDevicePixelRatio: number;
  minimumResolutionScale: number;
  terrainScreenSpaceErrorPx: number;
  terrainMaxRenderLod: number;
  terrainMaxActiveTiles: number;
  terrainGeometryCacheSize: number;
  shadowMapSize: number;
  surfaceShadows: boolean;
  surfaceDetailLevel: 0 | 1 | 2;
};

export type GraphicsCapabilities = {
  gpuName: string;
  deviceMemoryGb: number | null;
  hardwareConcurrency: number;
  maxTextureSize: number;
  maxRenderbufferSize: number;
  displayMegapixels: number;
  mobile: boolean;
};

export type GraphicsRuntimeState = {
  preference: GraphicsPreference;
  presetId: GraphicsPresetId;
  rationale: string;
  capabilities: GraphicsCapabilities;
};

export const GRAPHICS_PREFERENCE_STORAGE_KEY = "barsoom.graphics.preference.v1";

export const GRAPHICS_PRESETS: Readonly<Record<GraphicsPresetId, GraphicsPreset>> = {
  ultra: {
    id: "ultra",
    label: "Ultra",
    description: "Original visuals, full terrain density, and 2K surface shadows.",
    maxDevicePixelRatio: RENDER_CONFIG.maxDevicePixelRatio,
    minimumResolutionScale: 0.72,
    terrainScreenSpaceErrorPx: TERRAIN_CONFIG.screenSpaceErrorPx,
    terrainMaxRenderLod: TERRAIN_CONFIG.maxRenderLod,
    terrainMaxActiveTiles: TERRAIN_CONFIG.maxActiveTiles,
    terrainGeometryCacheSize: TERRAIN_CONFIG.geometryCacheSize,
    shadowMapSize: RENDER_CONFIG.surfaceShadowMapSize,
    surfaceShadows: true,
    surfaceDetailLevel: 2,
  },
  high: {
    id: "high",
    label: "High",
    description: "Near-original detail with lighter terrain and 1K shadows.",
    maxDevicePixelRatio: 1.5,
    minimumResolutionScale: 0.68,
    terrainScreenSpaceErrorPx: 4.5,
    terrainMaxRenderLod: 17,
    terrainMaxActiveTiles: 170,
    terrainGeometryCacheSize: 420,
    shadowMapSize: 1024,
    surfaceShadows: true,
    surfaceDetailLevel: 2,
  },
  medium: {
    id: "medium",
    label: "Medium",
    description: "Reduced terrain density, display resolution, and small rocks.",
    maxDevicePixelRatio: 1.25,
    minimumResolutionScale: 0.62,
    terrainScreenSpaceErrorPx: 6,
    terrainMaxRenderLod: 16,
    terrainMaxActiveTiles: 120,
    terrainGeometryCacheSize: 300,
    shadowMapSize: 1024,
    surfaceShadows: true,
    surfaceDetailLevel: 1,
  },
  low: {
    id: "low",
    label: "Low",
    description: "Maximum speed: 1x display scale, simpler terrain, no shadows or rocks.",
    maxDevicePixelRatio: 1,
    minimumResolutionScale: 0.55,
    terrainScreenSpaceErrorPx: 8,
    terrainMaxRenderLod: 15,
    terrainMaxActiveTiles: 84,
    terrainGeometryCacheSize: 220,
    shadowMapSize: 512,
    surfaceShadows: false,
    surfaceDetailLevel: 0,
  },
};

const GRAPHICS_PREFERENCES: readonly GraphicsPreference[] = ["auto", "ultra", "high", "medium", "low"];

export function isGraphicsPreference(value: unknown): value is GraphicsPreference {
  return typeof value === "string" && GRAPHICS_PREFERENCES.includes(value as GraphicsPreference);
}

export function loadGraphicsPreference(storage: Pick<Storage, "getItem"> | null = null): GraphicsPreference {
  const source = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
  if (!source) return "auto";
  try {
    const value = source.getItem(GRAPHICS_PREFERENCE_STORAGE_KEY);
    return isGraphicsPreference(value) ? value : "auto";
  } catch {
    return "auto";
  }
}

export function saveGraphicsPreference(
  preference: GraphicsPreference,
  storage: Pick<Storage, "setItem"> | null = null,
) {
  const target = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
  if (!target) return;
  try {
    target.setItem(GRAPHICS_PREFERENCE_STORAGE_KEY, preference);
  } catch {
    // Storage may be unavailable in private or embedded browser contexts.
  }
}

function readGpuName(gl: WebGL2RenderingContext) {
  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info") as {
    UNMASKED_RENDERER_WEBGL: number;
  } | null;
  const renderer = debugInfo
    ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);
  return typeof renderer === "string" && renderer.trim() ? renderer.trim() : "WebGL 2 graphics adapter";
}

export function detectGraphicsCapabilities(gl: WebGL2RenderingContext): GraphicsCapabilities {
  const navigatorWithMemory = navigator as Navigator & { deviceMemory?: number };
  const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
  const displayPixels = window.screen.width * window.screen.height * devicePixelRatio ** 2;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && Math.min(window.screen.width, window.screen.height) < 900);
  return {
    gpuName: readGpuName(gl),
    deviceMemoryGb: Number.isFinite(navigatorWithMemory.deviceMemory)
      ? navigatorWithMemory.deviceMemory ?? null
      : null,
    hardwareConcurrency: Math.max(1, navigator.hardwareConcurrency || 1),
    maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0,
    maxRenderbufferSize: Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)) || 0,
    displayMegapixels: displayPixels / 1_000_000,
    mobile,
  };
}

export function chooseAutomaticGraphicsPreset(capabilities: GraphicsCapabilities): {
  presetId: GraphicsPresetId;
  rationale: string;
} {
  const gpu = capabilities.gpuName.toLowerCase();
  const softwareRenderer = /swiftshader|llvmpipe|software|microsoft basic render/.test(gpu);
  if (softwareRenderer) return { presetId: "low", rationale: "Software graphics adapter detected" };
  if (capabilities.maxTextureSize > 0 && capabilities.maxTextureSize < 8192) {
    return { presetId: "low", rationale: "Limited GPU texture capacity detected" };
  }
  if (capabilities.maxRenderbufferSize > 0 && capabilities.maxRenderbufferSize < 8192) {
    return { presetId: "low", rationale: "Limited GPU render-buffer capacity detected" };
  }
  if ((capabilities.deviceMemoryGb !== null && capabilities.deviceMemoryGb <= 4) ||
      capabilities.hardwareConcurrency <= 4) {
    return { presetId: "low", rationale: "Entry-level system resources detected" };
  }
  if (capabilities.mobile) {
    return capabilities.deviceMemoryGb !== null && capabilities.deviceMemoryGb <= 6
      ? { presetId: "low", rationale: "Mobile GPU with a limited memory budget detected" }
      : { presetId: "medium", rationale: "Mobile graphics adapter detected" };
  }

  const integratedGpu = /intel.*(?:uhd|hd graphics|iris)|(?:uhd|hd graphics|iris).*intel|radeon vega|amd radeon\(tm\) graphics/.test(gpu);
  if (integratedGpu) return { presetId: "medium", rationale: "Integrated graphics adapter detected" };

  const highEndGpu = /geforce rtx (?:30(?:70|80|90)|(?:40|50|60)\d{2})|radeon rx (?:6[789]\d{2}|[78]\d{3})|apple m[3-9]\b/.test(gpu);
  if (highEndGpu) return { presetId: "ultra", rationale: "High-performance graphics adapter detected" };

  const olderGpu = /geforce (?:gtx )?[6789]\d{2}|radeon (?:r[579] |hd )|apple m1\b/.test(gpu);
  if (olderGpu) return { presetId: "medium", rationale: "Previous-generation graphics adapter detected" };

  const midrangeGpu = /geforce (?:gtx 10|gtx 16|rtx 20|rtx 30(?:50|60))|radeon rx (?:4|5)\d{2}|radeon rx (?:5\d{3}|6[456]\d{2})|apple m2\b/.test(gpu);
  if (midrangeGpu) return { presetId: "high", rationale: "Midrange graphics adapter detected" };

  if ((capabilities.deviceMemoryGb !== null && capabilities.deviceMemoryGb <= 8) ||
      capabilities.hardwareConcurrency <= 8 || capabilities.displayMegapixels > 9) {
    return { presetId: "high", rationale: capabilities.displayMegapixels > 9
      ? "High-resolution display load detected"
      : "Balanced system resources detected" };
  }

  return { presetId: "ultra", rationale: "High-performance graphics and system resources detected" };
}

export function resolveGraphicsState(
  preference: GraphicsPreference,
  capabilities: GraphicsCapabilities,
): GraphicsRuntimeState {
  if (preference === "auto") {
    const detected = chooseAutomaticGraphicsPreset(capabilities);
    return { preference, presetId: detected.presetId, rationale: detected.rationale, capabilities };
  }
  return {
    preference,
    presetId: preference,
    rationale: `${GRAPHICS_PRESETS[preference].label} selected manually`,
    capabilities,
  };
}

export function pendingGraphicsState(preference: GraphicsPreference = "auto"): GraphicsRuntimeState {
  return {
    preference,
    presetId: preference === "auto" ? "ultra" : preference,
    rationale: preference === "auto" ? "Detecting active graphics adapter" : `${GRAPHICS_PRESETS[preference].label} selected manually`,
    capabilities: {
      gpuName: "Detecting active graphics adapter…",
      deviceMemoryGb: null,
      hardwareConcurrency: 0,
      maxTextureSize: 0,
      maxRenderbufferSize: 0,
      displayMegapixels: 0,
      mobile: false,
    },
  };
}
