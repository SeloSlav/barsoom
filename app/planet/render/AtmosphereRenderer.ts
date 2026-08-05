import * as THREE from "three";
import { MARS_ATMOSPHERE_TOP_M, MARS_REFERENCE_RADIUS_M } from "../constants";
import type { Vec3 } from "../types";
import { createAtmosphereMaterial } from "./materials";

export class AtmosphereRenderer {
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, ReturnType<typeof createAtmosphereMaterial>>;

  constructor(scene: THREE.Scene) {
    const geometry = new THREE.SphereGeometry(MARS_REFERENCE_RADIUS_M + MARS_ATMOSPHERE_TOP_M, 96, 48);
    const material = createAtmosphereMaterial();
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = "Mars atmosphere";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20_000;
    scene.add(this.mesh);
  }

  update(cameraAbsolute: Vec3, altitudeM: number, sunDirection: Vec3) {
    this.mesh.position.set(-cameraAbsolute.x, -cameraAbsolute.y, -cameraAbsolute.z);
    this.mesh.material.uniforms.uPlanetCenter.value.copy(this.mesh.position);
    this.mesh.material.uniforms.uCameraRadius.value = Math.hypot(cameraAbsolute.x, cameraAbsolute.y, cameraAbsolute.z);
    this.mesh.material.uniforms.uCameraAltitude.value = altitudeM;
    this.mesh.material.uniforms.uSunDirection.value.set(sunDirection.x, sunDirection.y, sunDirection.z);
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

