import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_CAMERA_ALTITUDE_M, MARS_REFERENCE_RADIUS_M, SURFACE_EYE_HEIGHT_M } from "../app/planet/constants";
import { directionToFaceUv, dot3, raySphereIntersection } from "../app/planet/math";
import { automaticApproachPitchDegrees, PlanetControls } from "../app/planet/PlanetControls";

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

function createHarness(terrainHeight: (direction: { x: number; y: number; z: number }) => number = () => 0) {
  const canvas = new FakeCanvas();
  const camera = new THREE.PerspectiveCamera(42, 800 / 600, 0.1, 50_000_000);
  camera.updateProjectionMatrix();
  const prefetched: Array<{ x: number; y: number; z: number }> = [];
  const controls = new PlanetControls(
    canvas as unknown as HTMLCanvasElement,
    camera,
    terrainHeight,
    (direction) => prefetched.push({ ...direction }),
  );
  controls.update(1 / 60);
  return { canvas, camera, controls, prefetched };
}

const activeControls: PlanetControls[] = [];

afterEach(() => {
  while (activeControls.length) activeControls.pop()!.dispose();
});

function trackedHarness(terrainHeight?: (direction: { x: number; y: number; z: number }) => number) {
  const harness = createHarness(terrainHeight);
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

  it("keeps the orbit focus and radius fixed through unrestricted repeated rotations", () => {
    const { canvas, controls } = trackedHarness();
    const initial = controls.getState();
    pointer(canvas, "pointerdown", 1, 400, 300);
    let crossedFarSide = false;
    for (let step = 1; step <= 360; step += 1) {
      pointer(canvas, "pointermove", 1, 400 + step * 23, 300 + step * 17);
      const frame = controls.update(1 / 120);
      const state = controls.getState();
      expect(state.latitudeLongitude.latitudeDeg).toBeCloseTo(initial.latitudeLongitude.latitudeDeg, 10);
      expect(state.latitudeLongitude.longitudeDeg).toBeCloseTo(initial.latitudeLongitude.longitudeDeg, 10);
      expect(state.cameraDistanceM).toBeCloseTo(initial.cameraDistanceM, 5);
      if (dot3(state.orbitDirection, frame.focusDirection) < -0.2) crossedFarSide = true;
      expect(frame.altitudeM).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(frame.cameraAbsolute.x + frame.cameraAbsolute.y + frame.cameraAbsolute.z)).toBe(true);
    }
    pointer(canvas, "pointerup", 1, 8_680, 6_420);
    expect(crossedFarSide).toBe(true);
  });

  it("eases into an RTS approach near the ground without overriding manual orbit", () => {
    const { canvas, camera, controls } = trackedHarness();
    controls.setLocation(-13.9, -59.2, 10_000);
    let frame = controls.update(1 / 60);
    for (let step = 0; step < 180; step += 1) frame = controls.update(1 / 60);
    const approach = controls.getState();
    expect(approach.automaticApproachEnabled).toBe(true);
    const expectedPitch = automaticApproachPitchDegrees(10_000);
    expect(approach.approachPitchDeg).toBeCloseTo(expectedPitch, 2);
    expect(Math.acos(dot3(approach.orbitDirection, frame.focusDirection)) * 180 / Math.PI).toBeCloseTo(expectedPitch, 2);
    expect(frame.altitudeM).toBeCloseTo(10_000, 3);

    const forwardBeforePan = camera.getWorldDirection(new THREE.Vector3());
    const focusBeforePan = { ...frame.focusDirection };
    pointer(canvas, "pointerdown", 2, 400, 300);
    pointer(canvas, "pointermove", 2, 485, 265);
    pointer(canvas, "pointerup", 2, 485, 265);
    frame = controls.update(1 / 60);
    expect(dot3(focusBeforePan, frame.focusDirection)).toBeLessThan(0.99999999);
    expect(camera.getWorldDirection(new THREE.Vector3()).angleTo(forwardBeforePan)).toBeLessThan(1e-4);
    expect(controls.getState().automaticApproachEnabled).toBe(true);

    pointer(canvas, "pointerdown", 1, 400, 300);
    pointer(canvas, "pointermove", 1, 520, 245);
    pointer(canvas, "pointerup", 1, 520, 245);
    const manualDirection = { ...controls.getState().orbitDirection };
    expect(controls.getState().automaticApproachEnabled).toBe(false);
    for (let step = 0; step < 180; step += 1) controls.update(1 / 60);
    const settledManualDirection = controls.getState().orbitDirection;
    expect(settledManualDirection.x).toBeCloseTo(manualDirection.x, 12);
    expect(settledManualDirection.y).toBeCloseTo(manualDirection.y, 12);
    expect(settledManualDirection.z).toBeCloseTo(manualDirection.z, 12);
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

  it("right-pans continuously across a cube-face boundary without rotating the view", () => {
    const { canvas, camera, controls } = trackedHarness();
    controls.setLocation(0, 44.6, 1_000_000);
    const beforeFrame = controls.update(1 / 60);
    const beforeFace = directionToFaceUv(beforeFrame.focusDirection).face;
    const forwardBefore = camera.getWorldDirection(new THREE.Vector3());
    pointer(canvas, "pointerdown", 2, 400, 300);
    pointer(canvas, "pointermove", 2, 640, 300);
    pointer(canvas, "pointerup", 2, 640, 300);
    const afterFrame = controls.update(1 / 60);
    const afterFace = directionToFaceUv(afterFrame.focusDirection).face;
    expect(afterFace).not.toBe(beforeFace);
    expect(camera.getWorldDirection(new THREE.Vector3()).angleTo(forwardBefore)).toBeLessThan(1e-10);
    expect(afterFrame.altitudeM).toBeGreaterThanOrEqual(0);
  });

  it("clamps both altitude limits and moves an off-centre focus only while zoom is progressing", () => {
    const { canvas, camera, controls } = trackedHarness();
    controls.setAltitude(MAX_CAMERA_ALTITUDE_M * 2, true);
    expect(controls.getState().altitudeM).toBe(MAX_CAMERA_ALTITUDE_M);
    controls.setAltitude(10_000_000, true);
    const orbitalFrame = controls.update(1 / 60);

    const before = controls.getState().latitudeLongitude;
    const cursorRay = new THREE.Vector3(0.25, 0, 0.4).unproject(camera).normalize();
    const hitDistance = raySphereIntersection(orbitalFrame.cameraAbsolute, cursorRay, MARS_REFERENCE_RADIUS_M);
    expect(hitDistance).not.toBeNull();
    const anchorDirection = new THREE.Vector3(
      orbitalFrame.cameraAbsolute.x,
      orbitalFrame.cameraAbsolute.y,
      orbitalFrame.cameraAbsolute.z,
    ).addScaledVector(cursorRay, hitDistance!).normalize();
    const projectAnchor = (frame: ReturnType<PlanetControls["update"]>) =>
      anchorDirection.clone().multiplyScalar(MARS_REFERENCE_RADIUS_M).sub(new THREE.Vector3(
        frame.cameraAbsolute.x,
        frame.cameraAbsolute.y,
        frame.cameraAbsolute.z,
      )).project(camera);
    const anchorBefore = projectAnchor(orbitalFrame);
    canvas.emit("wheel", { clientX: 500, clientY: 300, deltaY: -700, deltaMode: 0 });
    let zoomedFrame = orbitalFrame;
    for (let frame = 0; frame < 360; frame += 1) zoomedFrame = controls.update(1 / 60);
    const anchorAfter = projectAnchor(zoomedFrame);
    // Under one percent of normalized screen width (about three pixels in
    // this 800 px harness) is visually stationary through the smoothed step.
    expect(Math.abs(anchorAfter.x - anchorBefore.x)).toBeLessThan(0.01);
    expect(Math.abs(anchorAfter.y - anchorBefore.y)).toBeLessThan(0.01);
    const settled = controls.getState();
    expect(settled.altitudeM).toBeLessThan(10_000_000);
    expect(settled.latitudeLongitude.longitudeDeg).not.toBeCloseTo(before.longitudeDeg, 7);

    const fixedFocus = { ...settled.latitudeLongitude };
    for (let frame = 0; frame < 360; frame += 1) controls.update(1 / 60);
    const afterIdle = controls.getState().latitudeLongitude;
    expect(afterIdle.latitudeDeg).toBeCloseTo(fixedFocus.latitudeDeg, 11);
    expect(afterIdle.longitudeDeg).toBeCloseTo(fixedFocus.longitudeDeg, 11);

    controls.setAltitude(-100, true);
    let surface = controls.update(1 / 60);
    for (let frame = 0; frame < 120; frame += 1) surface = controls.update(1 / 60);
    expect(controls.getState().desiredAltitudeM).toBe(SURFACE_EYE_HEIGHT_M);
    expect(surface.altitudeM).toBeCloseTo(SURFACE_EYE_HEIGHT_M, 6);
    expect(controls.getState().approachPitchDeg).toBeGreaterThan(75);
    expect(Math.hypot(surface.cameraAbsolute.x, surface.cameraAbsolute.y, surface.cameraAbsolute.z)).toBeGreaterThanOrEqual(MARS_REFERENCE_RADIUS_M);
  });

  it("locks inward and outward zoom to a selected surface point until right click", () => {
    const { canvas, camera, controls } = trackedHarness();
    controls.setAltitude(10_000_000, true);
    let frame = controls.update(1 / 60);

    const anchorRay = new THREE.Vector3(0.2, -0.08, 0.4).unproject(camera).normalize();
    const hitDistance = raySphereIntersection(frame.cameraAbsolute, anchorRay, MARS_REFERENCE_RADIUS_M);
    expect(hitDistance).not.toBeNull();
    const anchorDirection = new THREE.Vector3(
      frame.cameraAbsolute.x,
      frame.cameraAbsolute.y,
      frame.cameraAbsolute.z,
    ).addScaledVector(anchorRay, hitDistance!).normalize();
    const projectAnchor = (current: ReturnType<PlanetControls["update"]>) =>
      anchorDirection.clone().multiplyScalar(MARS_REFERENCE_RADIUS_M).sub(new THREE.Vector3(
        current.cameraAbsolute.x,
        current.cameraAbsolute.y,
        current.cameraAbsolute.z,
      )).project(camera);

    controls.setZoomAnchor(anchorDirection);
    expect(controls.getState().zoomAnchorLocked).toBe(true);
    const screenPosition = projectAnchor(frame);
    canvas.emit("wheel", { clientX: 700, clientY: 80, deltaY: -700, deltaMode: 0 });
    for (let index = 0; index < 360; index += 1) frame = controls.update(1 / 60);
    const zoomedInPosition = projectAnchor(frame);
    expect(Math.abs(zoomedInPosition.x - screenPosition.x)).toBeLessThan(0.01);
    expect(Math.abs(zoomedInPosition.y - screenPosition.y)).toBeLessThan(0.01);

    canvas.emit("wheel", { clientX: 100, clientY: 520, deltaY: 700, deltaMode: 0 });
    for (let index = 0; index < 360; index += 1) frame = controls.update(1 / 60);
    const zoomedOutPosition = projectAnchor(frame);
    expect(Math.abs(zoomedOutPosition.x - screenPosition.x)).toBeLessThan(0.01);
    expect(Math.abs(zoomedOutPosition.y - screenPosition.y)).toBeLessThan(0.01);

    pointer(canvas, "pointerdown", 2, 400, 300);
    pointer(canvas, "pointerup", 2, 400, 300);
    expect(controls.getState().zoomAnchorLocked).toBe(false);
  });

  it.each([30_000_000, 10_000_000, 1_000_000, 100_000, 10_000, 1_000, 100, 0])(
    "resolves the visual-verification altitude %s m against local ground",
    (altitudeM) => {
      const { controls } = trackedHarness(() => 7_250);
      controls.setLocation(-13.9, -59.2, altitudeM);
      const frame = controls.update(1 / 60);
      const expectedAltitudeM = Math.max(altitudeM, SURFACE_EYE_HEIGHT_M);
      expect(frame.altitudeM).toBeCloseTo(expectedAltitudeM, 3);
      expect(frame.desiredAltitudeM).toBe(expectedAltitudeM);
    },
  );

  it("preserves requested AGL when streamed terrain changes underneath the camera", () => {
    let streamedHeightM = 0;
    const { controls } = trackedHarness(() => streamedHeightM);
    controls.setAltitude(MAX_CAMERA_ALTITUDE_M, true);
    controls.update(1 / 60);
    streamedHeightM = 18_000;
    const orbital = controls.update(1);
    expect(orbital.altitudeM).toBeCloseTo(MAX_CAMERA_ALTITUDE_M, 3);

    controls.setAltitude(SURFACE_EYE_HEIGHT_M, true);
    let surface = controls.update(1 / 60);
    streamedHeightM = -7_000;
    for (let frame = 0; frame < 90; frame += 1) surface = controls.update(1 / 60);
    expect(surface.altitudeM).toBeCloseTo(SURFACE_EYE_HEIGHT_M, 3);
    expect(Math.hypot(surface.cameraAbsolute.x, surface.cameraAbsolute.y, surface.cameraAbsolute.z)).toBeGreaterThan(MARS_REFERENCE_RADIUS_M - 7_001);
  });

  it("converges to the requested AGL across a strongly varying local slope", () => {
    const { controls } = trackedHarness((direction) => direction.y * 500_000);
    controls.setLocation(0, 0, 100);
    let frame = controls.update(1 / 60);
    for (let index = 0; index < 180; index += 1) frame = controls.update(1 / 60);
    expect(frame.desiredAltitudeM).toBe(100);
    expect(frame.altitudeM).toBeCloseTo(100, 1);
    expect(controls.getState().approachPitchDeg).toBeGreaterThan(75);
  });
});
