import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MARS_ORBITER_CATALOG } from "../app/planet/ephemeris";

type GltfAccessor = { count: number };
type GltfPrimitive = { indices?: number; attributes?: { POSITION?: number }; mode?: number };
type GltfDocument = {
  accessors?: GltfAccessor[];
  extensionsUsed?: string[];
  meshes?: Array<{ primitives: GltfPrimitive[] }>;
};

const MODEL_BUDGETS = new Map([
  ["mars-odyssey-web.glb", { bytes: 600_000, triangles: 10_000 }],
  ["mars-reconnaissance-orbiter-web.glb", { bytes: 500_000, triangles: 16_000 }],
  ["trace-gas-orbiter-web.glb", { bytes: 3_000_000, triangles: 12_000 }],
]);

function readGlbJson(file: Buffer): GltfDocument {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  expect(file.subarray(0, 4).toString("ascii")).toBe("glTF");
  expect(view.getUint32(4, true)).toBe(2);
  expect(view.getUint32(8, true)).toBe(file.byteLength);
  const jsonLength = view.getUint32(12, true);
  expect(file.subarray(16, 20).toString("ascii")).toBe("JSON");
  return JSON.parse(file.subarray(20, 20 + jsonLength).toString("utf8").trimEnd());
}

function triangleCount(document: GltfDocument) {
  return (document.meshes ?? []).reduce((total, mesh) => total + mesh.primitives.reduce((meshTotal, primitive) => {
    const accessorIndex = primitive.indices ?? primitive.attributes?.POSITION;
    const count = accessorIndex === undefined ? 0 : (document.accessors?.[accessorIndex]?.count ?? 0);
    if ((primitive.mode ?? 4) === 4) return meshTotal + Math.floor(count / 3);
    if (primitive.mode === 5 || primitive.mode === 6) return meshTotal + Math.max(0, count - 2);
    return meshTotal;
  }, 0), 0);
}

describe("lazy Mars orbiter models", () => {
  it("ships one optimized decoder-free GLB per selectable spacecraft", async () => {
    expect(MARS_ORBITER_CATALOG).toHaveLength(3);
    for (const orbiter of MARS_ORBITER_CATALOG) {
      const filename = orbiter.modelPath.split("/").at(-1)?.split("?")[0];
      expect(filename).toBeTruthy();
      const budget = MODEL_BUDGETS.get(filename!);
      expect(budget).toBeDefined();
      const file = await readFile(path.join(process.cwd(), "public", "models", filename!));
      expect(file.byteLength).toBeLessThanOrEqual(budget!.bytes);
      const document = readGlbJson(file);
      expect(document.extensionsUsed ?? []).not.toContain("KHR_draco_mesh_compression");
      expect(triangleCount(document)).toBeLessThanOrEqual(budget!.triangles);
    }
  });
});
