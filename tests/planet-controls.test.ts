import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_CAMERA_ALTITUDE_M, MARS_REFERENCE_RADIUS_M } from "../app/planet/constants";
import { dot3 } from "../app/planet/math";
import { PlanetControls } from "../app/planet/PlanetControls";

type Listener = (event: Record<string, unknown>) => void;

class FakeCanvas {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly captures = new Set<number>();

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON() {} };
  }

  setPointerCapture(pointerId: number) {
    this.captures.add(pointerId);
  }

  releasePointerCapture(pointerId: number) {
    this.captures.delete(pointerId);
  }

  hasPointerCapture(pointerId: number) {
    return this.captures.has(pointerId);
  }

  emit(type: string, values: Record<string, unknown>) {
    let prevented = false;
    const event = { preventDefault: () => { prevented = true; }, ...values };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return prevented;
  }
}

function pointer(canvas: FakeCanvas, type: string, button: number, x: number, y: number, pointerId = 1) {
  return canvas.emit(type, { button, clientX: x, clientY: y, pointerId });
}

function createHarness() {
  const canvas = new FakeCanvas();
  const camera = new THREE.PerspectiveCamera(42, 800 / 600, 0.1, 50_000_000);
  camera.updateProjectionMatrix();
  const prefetched: Array<{ x: number; y: number; z: number }> = [];
  const controls = new PlanetControls(
    canvas as unknown as HTMLCanvasElement,
    camera,
    () => 0,
    (direction) => prefetched.push({ ...direction }),
  );
  controls.update(1 / 60);
  return { canvas, camera, controls, prefetched };
}

const activeControls: PlanetControls[] = [];

afterEach(() => {
  while (activeControls.length) activeControls.pop()!.dispose();
});

function trackedHarness() {
  const harness = createHarness();
  activeControls.push(harness.controls);
  return harness;
}

describe("PlanetControls integration", () => {
  it("reserves left drag, orbits only with middle drag, and pans only with right drag", () => {
    const { canvas, camera, controls } = trackedHarness();
    const initial = controls.getState();

    pointer(canvas, "pointerdown", 0, 400, 300);
    pointer(canvas, "pointermove", 0, 510, 350);
    pointer(canvas, "pointerup", 0, 510, 350);
    expect(controls.getState()).toEqual(initial);

    expect(pointer(canvas, "pointerdown", 1, 400, 300)).toBe(true);
    pointer(canvas, "pointermove", 1, 480, 340);
    pointer(canvas, "pointerup", 1, 480, 340);
    const orbited = controls.getState();
    expect(dot3(initial.orbitDirection, orbited.orbitDirection)).toBeLessThan(0.99);
    expect(orbited.latitudeLongitude.latitudeDeg).toBeCloseTo(initial.latitudeLongitude.latitudeDeg, 10);
    expect(orbited.latitudeLongitude.longitudeDeg).toBeCloseTo(initial.latitudeLongitude.longitudeDeg, 10);
    expect(orbited.cameraDistanceM).toBeCloseTo(initial.cameraDistanceM, 8);

    controls.update(1 / 60);
    const forwardBeforePan = camera.getWorldDirection(new THREE.Vector3());
    const orbitBeforePan = { ...orbited.orbitDirection };
    expect(pointer(canvas, "pointerdown", 2, 400, 300)).toBe(true);
    pointer(canvas, "pointermove", 2, 470, 260);
    pointer(canvas, "pointerup", 2, 470, 260);
    const panned = controls.getState();
    expect(panned.latitudeLongitude.latitudeDeg).not.toBeCloseTo(orbited.latitudeLongitude.latitudeDeg, 5);
    expect(panned.latitudeLongitude.longitudeDeg).not.toBeCloseTo(orbited.latitudeLongitude.longitudeDeg, 5);
    expect(panned.orbitDirection.x).toBeCloseTo(orbitBeforePan.x, 12);
    expect(panned.orbitDirection.y).toBeCloseTo(orbitBeforePan.y, 12);
    expect(panned.orbitDirection.z).toBeCloseTo(orbitBeforePan.z, 12);
    expect(panned.cameraDistanceM).toBeCloseTo(orbited.cameraDistanceM, 8);
    controls.update(1 / 60);
    expect(camera.getWorldDirection(new THREE.Vector3()).angleTo(forwardBeforePan)).toBeLessThan(1e-10);
  });

  it("keeps the orbit focus and radius fixed while preventing terrain tunnelling", () => {
    const { canvas, controls } = trackedHarness();
    const initial = controls.getState();
    pointer(canvas, "pointerdown", 1, 400, 300);
    for (let step = 1; step <= 360; step += 1) {
      pointer(canvas, "pointermove", 1, 400 + step * 23, 300 + step * 17);
      const frame = controls.update(1 / 120);
      const state = controls.getState();
      expect(state.latitudeLongitude.latitudeDeg).toBeCloseTo(initial.latitudeLongitude.latitudeDeg, 10);
      expect(state.latitudeLongitude.longitudeDeg).toBeCloseTo(initial.latitudeLongitude.longitudeDeg, 10);
      expect(state.cameraDistanceM).toBeCloseTo(initial.cameraDistanceM, 7);
      expect(dot3(state.orbitDirection, frame.focusDirection)).toBeGreaterThan(0);
      expect(frame.altitudeM).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(frame.cameraAbsolute.x + frame.cameraAbsolute.y + frame.cameraAbsolute.z)).toBe(true);
    }
    pointer(canvas, "pointerup", 1, 8_680, 6_420);
  });

  it("crosses the longitude seam and remains finite while panning over a pole", () => {
    const { canvas, controls } = trackedHarness();
    controls.setLocation(0, 179.8, 1_000_000);
    controls.update(1 / 60);
    pointer(canvas, "pointerdown", 2, 400, 300);
    for (let step = 1; step <= 8; step += 1) pointer(canvas, "pointermove", 2, 400 + step * 25, 300);
    pointer(canvas, "pointerup", 2, 600, 300);
    const seam = controls.getState().latitudeLongitude;
    expect(seam.longitudeDeg).toBeGreaterThanOrEqual(-180);
    expect(seam.longitudeDeg).toBeLessThan(0);

    controls.setLocation(89.95, 25, 50_000);
    controls.update(1 / 60);
    pointer(canvas, "pointerdown", 2, 400, 300);
    for (let step = 1; step <= 20; step += 1) pointer(canvas, "pointermove", 2, 400, 300 - step * 18);
    pointer(canvas, "pointerup", 2, 400, -60);
    const pole = controls.getState().latitudeLongitude;
    expect(pole.latitudeDeg).toBeGreaterThanOrEqual(-90);
    expect(pole.latitudeDeg).toBeLessThanOrEqual(90);
    expect(pole.longitudeDeg).toBeGreaterThanOrEqual(-180);
    expect(pole.longitudeDeg).toBeLessThan(180);
  });

  it("clamps both altitude limits and moves an off-centre focus only while zoom is progressing", () => {
    const { canvas, controls } = trackedHarness();
    controls.setAltitude(MAX_CAMERA_ALTITUDE_M * 2, true);
    expect(controls.getState().altitudeM).toBe(MAX_CAMERA_ALTITUDE_M);
    controls.setAltitude(10_000_000, true);
    controls.update(1 / 60);

    const before = controls.getState().latitudeLongitude;
    canvas.emit("wheel", { clientX: 500, clientY: 300, deltaY: -700, deltaMode: 0 });
    for (let frame = 0; frame < 360; frame += 1) controls.update(1 / 60);
    const settled = controls.getState();
    expect(settled.altitudeM).toBeLessThan(10_000_000);
    expect(settled.latitudeLongitude.longitudeDeg).not.toBeCloseTo(before.longitudeDeg, 7);

    const fixedFocus = { ...settled.latitudeLongitude };
    for (let frame = 0; frame < 360; frame += 1) controls.update(1 / 60);
    const afterIdle = controls.getState().latitudeLongitude;
    expect(afterIdle.latitudeDeg).toBeCloseTo(fixedFocus.latitudeDeg, 11);
    expect(afterIdle.longitudeDeg).toBeCloseTo(fixedFocus.longitudeDeg, 11);

    controls.setAltitude(-100, true);
    const surface = controls.update(1 / 60);
    expect(controls.getState().desiredAltitudeM).toBe(0);
    expect(surface.altitudeM).toBeLessThan(0.02);
    expect(Math.hypot(surface.cameraAbsolute.x, surface.cameraAbsolute.y, surface.cameraAbsolute.z)).toBeGreaterThanOrEqual(MARS_REFERENCE_RADIUS_M);
  });
});
