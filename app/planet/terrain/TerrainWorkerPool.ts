import { TERRAIN_CONFIG } from "../constants";
import type { MolaTileData } from "../mola";
import type { TileKey, Vec3 } from "../types";

export type GeneratedTileGeometry = {
  center: Vec3;
  positions: Float32Array;
  normals: Float32Array;
  planetDirections: Float32Array;
  elevations: Float32Array;
  areoidElevations: Float32Array;
  morphDelta: Float32Array;
  tileUv: Float32Array;
  surface: Float32Array;
  indices: Uint32Array;
  triangleCount: number;
};

type QueueJob = {
  id: number;
  key: TileKey;
  base: MolaTileData;
  priority: number;
  resolve: (geometry: GeneratedTileGeometry) => void;
  reject: (error: Error) => void;
  cancelled: boolean;
};

type WorkerSlot = {
  worker: Worker;
  job: QueueJob | null;
};

// Public workers are not fingerprinted by Vite. Keep this in lockstep with
// public/workers/terrain-worker.js so a new geometry algorithm always gets a
// new browser cache key and an old cached worker can never masquerade as new.
export const TERRAIN_WORKER_REVISION = "barsoom-terrain-geometry-v4";

export class TerrainWorkerPool {
  private nextJobId = 1;
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: QueueJob[] = [];
  private readonly jobs = new Map<number, QueueJob>();

  constructor() {
    const available = typeof navigator === "undefined" ? 1 : navigator.hardwareConcurrency || 2;
    const count = Math.max(1, Math.min(TERRAIN_CONFIG.workerCount, available - 1 || 1));
    for (let index = 0; index < count; index += 1) {
      const slot: WorkerSlot = {
        worker: new Worker(
          `/workers/terrain-worker.js?revision=${encodeURIComponent(TERRAIN_WORKER_REVISION)}`,
          { type: "module", name: `mars-terrain-${index}` },
        ),
        job: null,
      };
      slot.worker.onmessage = (event) => this.onMessage(slot, event.data);
      slot.worker.onerror = (event) => this.onWorkerError(slot, event.message);
      this.slots.push(slot);
    }
  }

  get queuedCount() {
    return this.queue.length;
  }

  get activeCount() {
    return this.slots.reduce((count, slot) => count + (slot.job ? 1 : 0), 0);
  }

  request(key: TileKey, base: MolaTileData, priority: number) {
    const id = this.nextJobId++;
    let resolve!: (geometry: GeneratedTileGeometry) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<GeneratedTileGeometry>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const job: QueueJob = { id, key, base, priority, resolve, reject, cancelled: false };
    this.jobs.set(id, job);
    this.queue.push(job);
    this.queue.sort((a, b) => b.priority - a.priority || a.id - b.id);
    this.pump();
    return { id, promise };
  }

  cancel(id: number) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.cancelled = true;
    const queueIndex = this.queue.indexOf(job);
    if (queueIndex >= 0) {
      this.queue.splice(queueIndex, 1);
      this.jobs.delete(id);
      job.reject(new DOMException("Terrain job superseded", "AbortError"));
    }
  }

  private pump() {
    for (const slot of this.slots) {
      if (slot.job) continue;
      let job: QueueJob | undefined;
      while ((job = this.queue.shift())) {
        if (!job.cancelled) break;
      }
      if (!job) return;
      slot.job = job;
      slot.worker.postMessage({
        type: "generate",
        jobId: job.id,
        key: job.key,
        base: {
          key: job.base.key,
          gridSize: job.base.gridSize,
          heightsM: job.base.heightsM,
          areoidM: job.base.areoidM,
        },
        segments: TERRAIN_CONFIG.meshSegments,
        skirtM: TERRAIN_CONFIG.skirtMinimumM,
      });
    }
  }

  private onMessage(slot: WorkerSlot, data: GeneratedTileGeometry & {
    type: string;
    jobId: number;
    message?: string;
    revision?: string;
  }) {
    const job = slot.job;
    slot.job = null;
    if (!job || data.jobId !== job.id) {
      this.pump();
      return;
    }
    this.jobs.delete(job.id);
    if (job.cancelled) {
      job.reject(new DOMException("Terrain job superseded", "AbortError"));
    } else if (data.type === "error") {
      job.reject(new Error(data.message || "Terrain worker failed"));
    } else if (data.revision !== TERRAIN_WORKER_REVISION) {
      job.reject(new Error(
        `Terrain worker revision mismatch: expected ${TERRAIN_WORKER_REVISION}, received ${data.revision ?? "unversioned"}`,
      ));
    } else {
      const rawCenter = data.center as unknown as Vec3 | [number, number, number];
      const center = Array.isArray(rawCenter)
        ? { x: rawCenter[0], y: rawCenter[1], z: rawCenter[2] }
        : rawCenter;
      job.resolve({
        center,
        positions: data.positions,
        normals: data.normals,
        planetDirections: data.planetDirections,
        elevations: data.elevations,
        areoidElevations: data.areoidElevations,
        morphDelta: data.morphDelta,
        tileUv: data.tileUv,
        surface: data.surface,
        indices: data.indices,
        triangleCount: data.triangleCount,
      });
    }
    this.pump();
  }

  private onWorkerError(slot: WorkerSlot, message: string) {
    const job = slot.job;
    slot.job = null;
    if (job) {
      this.jobs.delete(job.id);
      job.reject(new Error(message || "Terrain worker crashed"));
    }
    this.pump();
  }

  dispose() {
    for (const slot of this.slots) slot.worker.terminate();
    for (const job of this.jobs.values()) job.reject(new DOMException("Renderer disposed", "AbortError"));
    this.jobs.clear();
    this.queue.length = 0;
  }
}
