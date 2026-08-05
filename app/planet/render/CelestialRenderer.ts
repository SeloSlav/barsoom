import * as THREE from "three";
import type { MarsSkyState } from "../ephemeris";
import { loadStarCatalogue } from "../stars";
import type { Vec3 } from "../types";

const starVertex = /* glsl */ `
  attribute vec3 starColour;
  attribute float magnitude;
  uniform float uPixelRatio;
  uniform float uCameraAltitude;
  uniform float uDaylight;
  uniform vec3 uCameraUp;
  uniform vec3 uSunDirection;
  varying vec3 vColour;
  varying float vBrightness;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float flux = pow(2.512, -magnitude);
    gl_PointSize = clamp((7.4 - magnitude) * 1.08 * uPixelRatio, 1.8, 11.0);
    vColour = starColour;
    vec3 marsDirection = normalize((modelMatrix * vec4(position, 0.0)).xyz);
    float zenithCosine = max(0.055, dot(marsDirection, normalize(uCameraUp)));
    float airmass = min(18.0, 1.0 / zenithCosine);
    float density = exp(-max(uCameraAltitude, 0.0) / 10800.0);
    float sunProximity = pow(max(dot(marsDirection, normalize(uSunDirection)), 0.0), 3.0);
    float extinction = exp(-airmass * density * (0.38 + uDaylight * (8.2 + 7.0 * sunProximity)));
    vBrightness = clamp((0.72 + flux * 1.9) * extinction, 0.0, 8.0);
  }
`;

const starFragment = /* glsl */ `
  precision highp float;
  varying vec3 vColour;
  varying float vBrightness;
  void main() {
    vec2 centered = gl_PointCoord - 0.5;
    float radius = length(centered) * 2.0;
    if (radius > 1.0) discard;
    float psf = exp(-radius * radius * 4.6) * smoothstep(1.0, 0.42, radius);
    gl_FragColor = vec4(vColour * vBrightness * psf, min(1.0, psf * (0.65 + vBrightness)));
  }
`;

const bodyVertex = /* glsl */ `
  attribute vec3 bodyColour;
  attribute float pointSize;
  attribute float intensity;
  varying vec3 vColour;
  varying float vIntensity;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = pointSize;
    vColour = bodyColour;
    vIntensity = intensity;
  }
`;

const bodyFragment = /* glsl */ `
  precision highp float;
  varying vec3 vColour;
  varying float vIntensity;
  void main() {
    vec2 centered = gl_PointCoord - 0.5;
    float radius = length(centered) * 2.0;
    if (radius > 1.0) discard;
    float disc = smoothstep(1.0, 0.76, radius);
    float glare = exp(-radius * radius * 2.3) * max(vIntensity - 1.0, 0.0);
    gl_FragColor = vec4(vColour * (disc * vIntensity + glare), max(disc, glare * 0.12));
  }
`;

export class CelestialRenderer {
  readonly scene = new THREE.Scene();
  private starPoints: THREE.Points | null = null;
  private readonly bodyGeometry = new THREE.BufferGeometry();
  private readonly bodyPoints: THREE.Points;
  private readonly positions = new Float32Array(10 * 3);
  private readonly colours = new Float32Array(10 * 3);
  private readonly sizes = new Float32Array(10);
  private readonly intensities = new Float32Array(10);
  private bodyCount = 0;
  private skyMatrix = new THREE.Matrix4();

  constructor(private readonly camera: THREE.PerspectiveCamera) {
    this.scene.background = new THREE.Color(0x010104);
    this.bodyGeometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.bodyGeometry.setAttribute("bodyColour", new THREE.BufferAttribute(this.colours, 3));
    this.bodyGeometry.setAttribute("pointSize", new THREE.BufferAttribute(this.sizes, 1));
    this.bodyGeometry.setAttribute("intensity", new THREE.BufferAttribute(this.intensities, 1));
    this.bodyGeometry.setDrawRange(0, 0);
    const material = new THREE.ShaderMaterial({
      vertexShader: bodyVertex,
      fragmentShader: bodyFragment,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: true,
    });
    this.bodyPoints = new THREE.Points(this.bodyGeometry, material);
    this.bodyPoints.frustumCulled = false;
    this.scene.add(this.bodyPoints);
    void this.loadStars();
  }

  private async loadStars() {
    try {
      const catalogue = await loadStarCatalogue();
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array(catalogue.directions.length);
      for (let index = 0; index < catalogue.count; index += 1) {
        positions[index * 3] = catalogue.directions[index * 3] * 10;
        positions[index * 3 + 1] = catalogue.directions[index * 3 + 1] * 10;
        positions[index * 3 + 2] = catalogue.directions[index * 3 + 2] * 10;
      }
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("starColour", new THREE.BufferAttribute(catalogue.colours, 3));
      geometry.setAttribute("magnitude", new THREE.BufferAttribute(catalogue.magnitudes, 1));
      const material = new THREE.ShaderMaterial({
        vertexShader: starVertex,
        fragmentShader: starFragment,
        uniforms: {
          uPixelRatio: { value: 1 },
          uCameraAltitude: { value: 1_000_000 },
          uDaylight: { value: 0 },
          uCameraUp: { value: new THREE.Vector3(0, 1, 0) },
          uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
        },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: true,
      });
      this.starPoints = new THREE.Points(geometry, material);
      this.starPoints.name = `HYG/Hipparcos bright stars (${catalogue.count})`;
      this.starPoints.frustumCulled = false;
      this.starPoints.matrixAutoUpdate = false;
      this.scene.add(this.starPoints);
    } catch (error) {
      console.warn("The embedded star catalogue could not be loaded", error);
    }
  }

  update(
    sky: MarsSkyState,
    viewportHeight: number,
    fovRadians: number,
    pixelRatio: number,
    cameraAltitudeM: number,
    cameraDirection: Vec3,
    daylight: number,
  ) {
    this.camera.position.set(0, 0, 0);
    const matrix = sky.inertialToMarsFixed;
    this.skyMatrix.set(
      matrix[0], matrix[1], matrix[2], 0,
      matrix[3], matrix[4], matrix[5], 0,
      matrix[6], matrix[7], matrix[8], 0,
      0, 0, 0, 1,
    );
    if (this.starPoints) {
      this.starPoints.matrix.copy(this.skyMatrix);
      this.starPoints.matrixWorldNeedsUpdate = true;
      const material = this.starPoints.material as THREE.ShaderMaterial;
      material.uniforms.uPixelRatio.value = pixelRatio;
      material.uniforms.uCameraAltitude.value = cameraAltitudeM;
      material.uniforms.uDaylight.value = daylight;
      material.uniforms.uCameraUp.value.set(cameraDirection.x, cameraDirection.y, cameraDirection.z);
      material.uniforms.uSunDirection.value.set(sky.sunDirection.x, sky.sunDirection.y, sky.sunDirection.z);
    }

    this.bodyCount = Math.min(1 + sky.bodies.length, 10);
    const pixelsPerRadian = viewportHeight / (2 * Math.tan(fovRadians * 0.5));
    for (let index = 0; index < this.bodyCount; index += 1) {
      const direction = index === 0 ? sky.sunDirection : sky.bodies[index - 1].direction;
      const angularRadiusRad = index === 0 ? 0.00465 : sky.bodies[index - 1].angularRadiusRad;
      const magnitude = index === 0 ? -26.7 : sky.bodies[index - 1].magnitude;
      const colour = index === 0 ? ([1, 0.91, 0.66] as const) : sky.bodies[index - 1].colour;
      this.positions[index * 3] = direction.x * 9.5;
      this.positions[index * 3 + 1] = direction.y * 9.5;
      this.positions[index * 3 + 2] = direction.z * 9.5;
      this.colours.set(colour, index * 3);
      const physicalSize = angularRadiusRad * 2 * pixelsPerRadian * pixelRatio;
      this.sizes[index] = Math.max(index === 0 ? 9 : 3.2, Math.min(index === 0 ? 80 : 22, physicalSize));
      const zenithCosine = Math.max(0.055,
        direction.x * cameraDirection.x + direction.y * cameraDirection.y + direction.z * cameraDirection.z,
      );
      const airmass = Math.min(18, 1 / zenithCosine);
      const atmosphereDensity = Math.exp(-Math.max(cameraAltitudeM, 0) / 10_800);
      const sunProximity = Math.max(0,
        direction.x * sky.sunDirection.x + direction.y * sky.sunDirection.y + direction.z * sky.sunDirection.z,
      ) ** 3;
      const extinction = Math.exp(-airmass * atmosphereDensity * (0.38 + daylight * (8.2 + 7 * sunProximity)));
      const unextinguished = index === 0 ? 12 : Math.max(0.72, Math.min(4.5, 2.512 ** (-magnitude * 0.2)));
      this.intensities[index] = unextinguished * Math.max(index === 0 ? 0.08 : 0.012, extinction);
    }
    (this.bodyGeometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.bodyGeometry.getAttribute("bodyColour") as THREE.BufferAttribute).needsUpdate = true;
    (this.bodyGeometry.getAttribute("pointSize") as THREE.BufferAttribute).needsUpdate = true;
    (this.bodyGeometry.getAttribute("intensity") as THREE.BufferAttribute).needsUpdate = true;
    this.bodyGeometry.setDrawRange(0, this.bodyCount);
  }

  dispose() {
    this.starPoints?.geometry.dispose();
    (this.starPoints?.material as THREE.Material | undefined)?.dispose();
    this.bodyGeometry.dispose();
    (this.bodyPoints.material as THREE.Material).dispose();
    this.scene.clear();
  }
}
