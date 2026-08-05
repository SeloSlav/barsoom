import * as THREE from "three";
import {
  CAMERA_SURFACE_EPSILON_M,
  MAX_CAMERA_ALTITUDE_M,
  MARS_ATMOSPHERE_TOP_M,
  MARS_REFERENCE_RADIUS_M,
  MIN_CAMERA_ALTITUDE_M,
  RENDER_CONFIG,
} from "./constants";
import {
  cartesianToLatLonElevation,
  clamp,
  latLonElevationToCartesian,
  nonlinearZoomAltitude,
  raySphereIntersection,
} from "./math";
import type { Vec3 } from "./types";

export type PlanetControlState = {
  cameraAbsolute: Vec3;
  cameraDirection: Vec3;
  focusDirection: Vec3;
  focusAbsolute: Vec3;
  altitudeM: number;
  desiredAltitudeM: number;
  nearM: number;
  farM: number;
};

type PointerDrag = { id: number; button: number; lastX: number; lastY: number };

/**
 * Quaternion trackball controls for a curved, camera-relative planet.
 * The orbit vector has no Euler poles or horizontal/vertical angle limits.
 */
export class PlanetControls {
  private readonly focusDirection = new THREE.Vector3();
  private readonly orbitDirection = new THREE.Vector3();
  private readonly cameraAbsolute = new THREE.Vector3();
  private readonly cameraDirection = new THREE.Vector3();
  private readonly focusAbsolute = new THREE.Vector3();
  private readonly cursorNdc = new THREE.Vector2();
  private readonly scratchA = new THREE.Vector3();
  private readonly scratchB = new THREE.Vector3();
  private readonly scratchC = new THREE.Vector3();
  private readonly scratchD = new THREE.Vector3();
  private readonly scratchQuaternion = new THREE.Quaternion();
  private readonly yawQuaternion = new THREE.Quaternion();
  private readonly pitchQuaternion = new THREE.Quaternion();
  private zoomAnchor: THREE.Vector3 | null = null;
  private desiredAltitudeM = 10_000_000;
  private altitudeM = 10_000_000;
  private drag: PointerDrag | null = null;
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly terrainHeight: (direction: Vec3) => number,
    private readonly prefetch: (direction: Vec3) => void,
  ) {
    const initial = latLonElevationToCartesian(18.65, -133.8, 0, 1);
    this.focusDirection.set(initial.x, initial.y, initial.z).normalize();
    // Start on the local sky side of the selected point. A fixed world-space
    // vector can point through Mars at some longitudes, which made descent end
    // on the opposite hemisphere and presented as a black surface.
    this.orbitDirection.copy(this.focusDirection);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", this.onContextMenu);
    this.update(1 / 60);
  }

  private onContextMenu = (event: MouseEvent) => event.preventDefault();

  private updateCursor(event: PointerEvent | WheelEvent) {
    const bounds = this.canvas.getBoundingClientRect();
    this.cursorNdc.set(
      ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * 2 - 1,
      -((event.clientY - bounds.top) / Math.max(1, bounds.height)) * 2 + 1,
    );
  }

  private onPointerDown = (event: PointerEvent) => {
    this.updateCursor(event);
    if (event.button !== 1 && event.button !== 2) return;
    event.preventDefault();
    this.drag = { id: event.pointerId, button: event.button, lastX: event.clientX, lastY: event.clientY };
    this.canvas.setPointerCapture(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent) => {
    this.updateCursor(event);
    if (!this.drag || this.drag.id !== event.pointerId) return;
    const dx = event.clientX - this.drag.lastX;
    const dy = event.clientY - this.drag.lastY;
    this.drag.lastX = event.clientX;
    this.drag.lastY = event.clientY;
    if (this.drag.button === 1) this.orbit(dx, dy);
    else this.pan(dx, dy);
    event.preventDefault();
  };

  private onPointerUp = (event: PointerEvent) => {
    if (!this.drag || this.drag.id !== event.pointerId) return;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.drag = null;
  };

  private orbit(dx: number, dy: number) {
    // Axes come from the current camera plane, making drag direction stable at every
    // latitude and after any number of complete revolutions.
    const screenRight = this.scratchA.set(1, 0, 0).applyQuaternion(this.camera.quaternion).normalize();
    const screenUp = this.scratchB.set(0, 1, 0).applyQuaternion(this.camera.quaternion).normalize();
    this.yawQuaternion.setFromAxisAngle(screenUp, -dx * 0.0045);
    this.pitchQuaternion.setFromAxisAngle(screenRight, -dy * 0.0045);
    this.orbitDirection.applyQuaternion(this.yawQuaternion).applyQuaternion(this.pitchQuaternion).normalize();
  }

  private pan(dx: number, dy: number) {
    // Translate in the visible camera plane, project the displacement to the local
    // tangent, then rotate both target and orbit frame together around Mars.
    const oldFocus = this.scratchA.copy(this.focusDirection);
    const screenRight = this.scratchB.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const screenUp = this.scratchC.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    screenRight.addScaledVector(oldFocus, -screenRight.dot(oldFocus));
    screenUp.addScaledVector(oldFocus, -screenUp.dot(oldFocus));
    if (screenRight.lengthSq() < 1e-10) screenRight.crossVectors(screenUp, oldFocus);
    if (screenUp.lengthSq() < 1e-10) screenUp.crossVectors(oldFocus, screenRight);
    screenRight.normalize();
    screenUp.normalize();
    const metresPerPixel = 0.042 * (this.altitudeM + 24) ** 0.79;
    const nextFocus = this.scratchD.copy(oldFocus)
      .addScaledVector(screenRight, (-dx * metresPerPixel) / MARS_REFERENCE_RADIUS_M)
      .addScaledVector(screenUp, (dy * metresPerPixel) / MARS_REFERENCE_RADIUS_M)
      .normalize();
    this.scratchQuaternion.setFromUnitVectors(oldFocus, nextFocus);
    this.focusDirection.copy(nextFocus);
    this.orbitDirection.applyQuaternion(this.scratchQuaternion).normalize();
    this.prefetch(this.focusDirection);
  }

  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    this.updateCursor(event);
    const modeScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 480 : 1;
    const previous = this.desiredAltitudeM;
    this.desiredAltitudeM = nonlinearZoomAltitude(this.desiredAltitudeM, event.deltaY * modeScale);
    if (this.desiredAltitudeM < previous) this.zoomAnchor = this.cursorSurfacePoint();
  };

  private cursorSurfacePoint() {
    const ray = this.scratchA.set(this.cursorNdc.x, this.cursorNdc.y, 0.4).unproject(this.camera).normalize();
    const origin = { x: this.cameraAbsolute.x, y: this.cameraAbsolute.y, z: this.cameraAbsolute.z };
    let distance = raySphereIntersection(origin, ray, MARS_REFERENCE_RADIUS_M);
    if (distance === null) return null;
    const point = this.scratchB.copy(this.cameraAbsolute).addScaledVector(ray, distance);
    const direction = point.normalize();
    distance = raySphereIntersection(origin, ray, MARS_REFERENCE_RADIUS_M + this.terrainHeight(direction));
    if (distance === null) return direction.clone();
    return this.scratchB.copy(this.cameraAbsolute).addScaledVector(ray, distance).normalize().clone();
  }

  private moveFocusTowardZoomAnchor(amount: number) {
    if (!this.zoomAnchor) return;
    const oldFocus = this.scratchA.copy(this.focusDirection);
    this.focusDirection.lerp(this.zoomAnchor, amount).normalize();
    this.scratchQuaternion.setFromUnitVectors(oldFocus, this.focusDirection);
    this.orbitDirection.applyQuaternion(this.scratchQuaternion).normalize();
    if (this.altitudeM < 1 || this.focusDirection.angleTo(this.zoomAnchor) < 1e-7) this.zoomAnchor = null;
  }

  private solveCameraPosition(focusRadius: number, requestedAltitudeM: number) {
    let cameraRadius = MARS_REFERENCE_RADIUS_M + requestedAltitudeM;
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const projected = focusRadius * this.focusDirection.dot(this.orbitDirection);
      const discriminant = Math.max(0, projected * projected + cameraRadius * cameraRadius - focusRadius * focusRadius);
      const distance = Math.max(CAMERA_SURFACE_EPSILON_M, -projected + Math.sqrt(discriminant));
      this.cameraAbsolute.copy(this.focusAbsolute).addScaledVector(this.orbitDirection, distance);
      this.cameraDirection.copy(this.cameraAbsolute).normalize();
      const localHeight = this.terrainHeight(this.cameraDirection);
      cameraRadius = MARS_REFERENCE_RADIUS_M + localHeight + requestedAltitudeM + CAMERA_SURFACE_EPSILON_M;
    }
    if (this.cameraAbsolute.length() < cameraRadius) this.cameraAbsolute.setLength(cameraRadius);
    this.cameraDirection.copy(this.cameraAbsolute).normalize();
  }

  update(deltaSeconds: number): PlanetControlState {
    if (this.disposed) throw new Error("PlanetControls has been disposed");
    const smoothing = 1 - Math.exp(-Math.max(0, deltaSeconds) * 10.5);
    const altitudeDifference = this.desiredAltitudeM - this.altitudeM;
    this.altitudeM += altitudeDifference * smoothing;
    if (Math.abs(altitudeDifference) < 0.001) this.altitudeM = this.desiredAltitudeM;
    this.altitudeM = clamp(this.altitudeM, MIN_CAMERA_ALTITUDE_M, MAX_CAMERA_ALTITUDE_M);
    if (this.zoomAnchor && this.desiredAltitudeM <= this.altitudeM) {
      const strength = clamp((7.2 - Math.log10(this.altitudeM + 10)) * 0.018 + 0.005, 0.004, 0.06);
      this.moveFocusTowardZoomAnchor(strength * smoothing * 24);
    }

    const focusHeight = this.terrainHeight(this.focusDirection);
    const focusRadius = MARS_REFERENCE_RADIUS_M + focusHeight;
    this.focusAbsolute.copy(this.focusDirection).multiplyScalar(focusRadius);
    this.solveCameraPosition(focusRadius, this.altitudeM);
    const localHeight = this.terrainHeight(this.cameraDirection);
    const actualAltitude = Math.max(0, this.cameraAbsolute.length() - MARS_REFERENCE_RADIUS_M - localHeight - CAMERA_SURFACE_EPSILON_M);

    this.camera.position.set(0, 0, 0);
    const targetRelative = this.scratchA.copy(this.focusAbsolute).sub(this.cameraAbsolute);
    // Local radial up removes accumulated roll while quaternion orbiting avoids Euler poles.
    this.camera.up.copy(this.cameraDirection);
    if (Math.abs(this.scratchB.copy(targetRelative).normalize().dot(this.camera.up)) > 0.998) {
      this.camera.up.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    }
    this.camera.lookAt(targetRelative);
    const near = clamp(actualAltitude * 0.000006, RENDER_CONFIG.surfaceNearM, 180);
    const far = actualAltitude > 150_000
      ? actualAltitude + MARS_REFERENCE_RADIUS_M * 2.15 + MARS_ATMOSPHERE_TOP_M
      : Math.max(350_000, Math.sqrt(2 * MARS_REFERENCE_RADIUS_M * (actualAltitude + MARS_ATMOSPHERE_TOP_M)) * 3.2);
    if (Math.abs(this.camera.near - near) / near > 0.02 || Math.abs(this.camera.far - far) / far > 0.02) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld(true);

    return {
      cameraAbsolute: { x: this.cameraAbsolute.x, y: this.cameraAbsolute.y, z: this.cameraAbsolute.z },
      cameraDirection: { x: this.cameraDirection.x, y: this.cameraDirection.y, z: this.cameraDirection.z },
      focusDirection: { x: this.focusDirection.x, y: this.focusDirection.y, z: this.focusDirection.z },
      focusAbsolute: { x: this.focusAbsolute.x, y: this.focusAbsolute.y, z: this.focusAbsolute.z },
      altitudeM: actualAltitude < 0.02 ? 0 : actualAltitude,
      desiredAltitudeM: this.desiredAltitudeM,
      nearM: near,
      farM: far,
    };
  }

  setLocation(latitudeDeg: number, longitudeDeg: number, altitudeM = this.desiredAltitudeM) {
    const oldFocus = this.scratchA.copy(this.focusDirection);
    const direction = latLonElevationToCartesian(latitudeDeg, longitudeDeg, 0, 1);
    this.focusDirection.set(direction.x, direction.y, direction.z).normalize();
    this.scratchQuaternion.setFromUnitVectors(oldFocus, this.focusDirection);
    this.orbitDirection.applyQuaternion(this.scratchQuaternion).normalize();
    this.altitudeM = this.desiredAltitudeM = clamp(altitudeM, MIN_CAMERA_ALTITUDE_M, MAX_CAMERA_ALTITUDE_M);
    this.zoomAnchor = null;
    this.prefetch(this.focusDirection);
  }

  setAltitude(altitudeM: number, immediate = false) {
    this.desiredAltitudeM = clamp(altitudeM, MIN_CAMERA_ALTITUDE_M, MAX_CAMERA_ALTITUDE_M);
    if (immediate) this.altitudeM = this.desiredAltitudeM;
  }

  getState() {
    return {
      latitudeLongitude: cartesianToLatLonElevation(this.focusDirection, 1),
      altitudeM: this.altitudeM,
      desiredAltitudeM: this.desiredAltitudeM,
      orbitDirection: { x: this.orbitDirection.x, y: this.orbitDirection.y, z: this.orbitDirection.z },
    };
  }

  dispose() {
    this.disposed = true;
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
  }
}
