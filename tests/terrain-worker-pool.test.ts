import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MolaTileData } from "../app/planet/mola";
import { TerrainWorkerPool } from "../app/planet/terrain/TerrainWorkerPool";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: Array<Record<string, unknown>> = [];
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: Record<string, unknown>) {
    this.posted.push(message);
  }

  complete(jobId: number) {
    this.onmessage?.({ data: {
      type: "generated",
      jobId,
      center: [0, 0, 0],
      positions: new Float32Array(),
      normals: new Float32Array(),
      planetDirections: new Float32Array(),
      elevations: new Float32Array(),
      areoidElevations: new Float32Array(),
      morphDelta: new Float32Array(),
      normalMorphDelta: new Float32Array(),
      tileUv: new Float32Array(),
      surface: new Float32Array(),
      indices: new Uint32Array(),
      triangleCount: 0,
    } } as MessageEvent);
  }

  terminate() {
    this.terminated = true;
  }
}

const originalWorker = globalThis.Worker;

const base: MolaTileData = {
  key: { face: "px", lod: 0, x: 0, y: 0 },
  gridSize: 2,
  heightsM: new Int16Array(4),
  areoidM: new Int16Array(4),
  minHeightM: 0,
  maxHeightM: 0,
  minAreoidM: 0,
  maxAreoidM: 0,
  bytes: 16,
};

beforeEach(() => {
  FakeWorker.instances = [];
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
});

afterEach(() => {
  globalThis.Worker = originalWorker;
});

describe("terrain worker scheduling", () => {
  it("removes a rapid burst of obsolete queued jobs instead of letting the backlog grow", async () => {
    const pool = new TerrainWorkerPool();
    const workerCount = FakeWorker.instances.length;
    const active = Array.from({ length: workerCount }, (_, index) =>
      pool.request({ face: "px", lod: 3, x: index, y: 0 }, base, 10 - index),
    );
    const obsolete = Array.from({ length: 240 }, (_, index) =>
      pool.request({ face: "px", lod: 12, x: index, y: 0 }, base, index),
    );
    const settled = obsolete.map((job) => job.promise.catch((error) => error));
    expect(pool.queuedCount).toBe(240);
    for (const job of obsolete) pool.cancel(job.id);
    expect(pool.queuedCount).toBe(0);
    expect(pool.activeCount).toBe(workerCount);
    const results = await Promise.all(settled);
    expect(results.every((error) => error instanceof DOMException && error.name === "AbortError")).toBe(true);
    const activeSettled = active.map((job) => job.promise.catch(() => null));
    pool.dispose();
    await Promise.all(activeSettled);
    expect(FakeWorker.instances.every((worker) => worker.terminated)).toBe(true);
  });

  it("dispatches the highest-screen-importance queued tile first", async () => {
    const pool = new TerrainWorkerPool();
    const blockers = Array.from({ length: FakeWorker.instances.length }, (_, index) =>
      pool.request({ face: "px", lod: 3, x: index, y: 0 }, base, 1),
    );
    const low = pool.request({ face: "px", lod: 4, x: 0, y: 0 }, base, 2);
    const high = pool.request({ face: "px", lod: 4, x: 1, y: 0 }, base, 200);
    const medium = pool.request({ face: "px", lod: 4, x: 2, y: 0 }, base, 20);
    const promises = [...blockers, low, high, medium].map((job) => job.promise.catch(() => null));
    const worker = FakeWorker.instances[0];
    worker.complete(blockers[0].id);
    expect(worker.posted.at(-1)?.jobId).toBe(high.id);
    pool.dispose();
    await Promise.all(promises);
  });
});
