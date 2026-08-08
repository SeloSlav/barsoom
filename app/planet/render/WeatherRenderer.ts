import * as THREE from "three";
import { MARS_REFERENCE_RADIUS_M } from "../constants";
import { clamp } from "../math";
import type { Vec3 } from "../types";

const WATER_ICE_ALTITUDE_M = 32_000;
const CO2_ICE_ALTITUDE_M = 68_000;
const LOCAL_DUST_PARTICLE_COUNT = 900;

export type MarsWeatherPreset = "auto" | "clear" | "cloudy" | "dust-storm";

export type MarsWeatherState = {
  preset: MarsWeatherPreset;
  cloudCover: number;
  dustActivity: number;
  windSpeedMps: number;
};

type CloudMaterial = THREE.ShaderMaterial & {
  uniforms: {
    uSunDirection: { value: THREE.Vector3 };
    uCameraRadius: { value: number };
    uTime: { value: number };
    uCoverage: { value: number };
    uScale: { value: number };
    uOpacity: { value: number };
    uLayerKind: { value: number };
  };
};

const cloudVertex = /* glsl */ `
  varying vec3 vWorldPosition;
  varying vec3 vRadial;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    vRadial = normalize(position);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const cloudFragment = /* glsl */ `
  precision highp float;

  uniform vec3 uSunDirection;
  uniform float uCameraRadius;
  uniform float uTime;
  uniform float uCoverage;
  uniform float uScale;
  uniform float uOpacity;
  uniform float uLayerKind;

  varying vec3 vWorldPosition;
  varying vec3 vRadial;

  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float noise3(vec3 p) {
    vec3 cell = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash31(cell), hash31(cell + vec3(1,0,0)), f.x),
          mix(hash31(cell + vec3(0,1,0)), hash31(cell + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash31(cell + vec3(0,0,1)), hash31(cell + vec3(1,0,1)), f.x),
          mix(hash31(cell + vec3(0,1,1)), hash31(cell + vec3(1,1,1)), f.x), f.y),
      f.z
    );
  }

  float fbm(vec3 p) {
    float value = 0.0;
    float weight = 0.55;
    for (int octave = 0; octave < 4; octave++) {
      value += noise3(p) * weight;
      p = p * 2.03 + vec3(7.1, -4.3, 2.8);
      weight *= 0.48;
    }
    return value;
  }

  void main() {
    vec3 radial = normalize(vRadial);
    vec3 sun = normalize(uSunDirection);
    vec3 viewRay = normalize(vWorldPosition);
    vec3 drift = vec3(uTime * 0.000075, uTime * -0.000023, uTime * 0.000052);
    float broad = fbm(radial * uScale + drift);
    float filament = fbm(radial * uScale * 3.7 + drift * 2.4 + vec3(11.4, -3.1, 7.8));
    float latitudeBand = 0.72 + 0.28 * smoothstep(0.16, 0.92,
      noise3(vec3(radial.y * 5.0 + uTime * 0.000018, radial.x * 1.3, radial.z * 1.3))
    );
    float structure = (broad * 0.72 + filament * 0.28) * latitudeBand;
    float threshold = mix(0.76, 0.32, clamp(uCoverage, 0.0, 1.0));
    float cloud = smoothstep(threshold, threshold + 0.115, structure);
    cloud *= smoothstep(0.27, 0.60, filament);

    float sunHeight = dot(radial, sun);
    float daylight = smoothstep(-0.22, 0.10, sunHeight);
    float twilight = smoothstep(-0.34, -0.04, sunHeight) * (1.0 - smoothstep(0.12, 0.42, sunHeight));
    float forwardScatter = pow(max(dot(viewRay, sun), 0.0), 10.0);
    float facing = abs(dot(radial, -viewRay));
    float pathLength = clamp(0.24 / max(facing, 0.10), 0.38, 2.15);

    vec3 waterShadow = vec3(0.37, 0.34, 0.33);
    vec3 waterLight = vec3(0.82, 0.79, 0.75);
    vec3 colour = mix(waterShadow, waterLight, 0.22 + daylight * 0.70);
    float visibility = 0.32 + daylight * 0.68;

    if (uLayerKind > 0.5) {
      vec3 iridescence = 0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + filament * 8.0 + forwardScatter * 2.8);
      colour = mix(vec3(0.42, 0.46, 0.54), vec3(0.88, 0.82, 0.78), daylight * 0.52 + twilight * 0.48);
      colour = mix(colour, iridescence, twilight * (0.10 + forwardScatter * 0.18));
      visibility = 0.08 + twilight * 0.92 + daylight * 0.10;
      cloud *= 0.78;
    }

    colour += vec3(0.24, 0.16, 0.10) * forwardScatter * daylight * 0.25;
    float alpha = clamp(cloud * pathLength * uOpacity * visibility, 0.0, 0.72);
    if (alpha < 0.003) discard;
    gl_FragColor = vec4(max(colour, vec3(0.0)), alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createMarsCloudMaterial(layerKind: "water" | "co2") {
  const water = layerKind === "water";
  return new THREE.ShaderMaterial({
    name: water ? "Mars water-ice cloud layer" : "Mars high-altitude carbon-dioxide ice cloud layer",
    vertexShader: cloudVertex,
    fragmentShader: cloudFragment,
    uniforms: {
      uSunDirection: { value: new THREE.Vector3(1, 0.25, 0.2).normalize() },
      uCameraRadius: { value: MARS_REFERENCE_RADIUS_M + 1_000_000 },
      uTime: { value: 0 },
      uCoverage: { value: water ? 0.48 : 0.18 },
      uScale: { value: water ? 7.2 : 10.5 },
      uOpacity: { value: water ? 0.32 : 0.22 },
      uLayerKind: { value: water ? 0 : 1 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.FrontSide,
    blending: THREE.NormalBlending,
    toneMapped: true,
  }) as CloudMaterial;
}

type DustMaterial = THREE.ShaderMaterial & {
  uniforms: {
    uEast: { value: THREE.Vector3 };
    uNorth: { value: THREE.Vector3 };
    uUp: { value: THREE.Vector3 };
    uTime: { value: number };
    uActivity: { value: number };
    uCameraAltitude: { value: number };
    uPixelRatio: { value: number };
  };
};

const dustVertex = /* glsl */ `
  uniform vec3 uEast;
  uniform vec3 uNorth;
  uniform vec3 uUp;
  uniform float uTime;
  uniform float uActivity;
  uniform float uCameraAltitude;
  uniform float uPixelRatio;

  varying float vOpacity;
  varying float vWarmth;

  void main() {
    vec3 seed = position;
    float travel = fract(seed.x + uTime * (0.010 + seed.z * 0.012));
    float gust = 0.5 + 0.5 * sin(uTime * 0.72 + seed.y * 31.0 + seed.z * 13.0);
    float eastM = (travel - 0.5) * 420.0;
    float northM = (seed.y - 0.5) * 190.0 + sin(seed.x * 38.0 + uTime * 0.17) * 18.0;
    float groundRelativeM = pow(seed.z, 2.15) * (10.0 + gust * 14.0);
    float upM = groundRelativeM - min(uCameraAltitude, 8.0);
    vec3 relative = uEast * eastM + uNorth * northM + uUp * upM;
    vec4 mvPosition = modelViewMatrix * vec4(relative, 1.0);
    float distanceFade = 1.0 - smoothstep(70.0, 285.0, length(relative));
    float heightFade = 1.0 - smoothstep(5.0, 25.0, groundRelativeM);
    vOpacity = uActivity * distanceFade * heightFade * (0.20 + gust * 0.80);
    vWarmth = seed.x;
    gl_PointSize = clamp((1.0 + seed.z * 2.5) * uPixelRatio * 115.0 / max(12.0, -mvPosition.z), 0.7, 5.5);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const dustFragment = /* glsl */ `
  precision highp float;
  varying float vOpacity;
  varying float vWarmth;

  void main() {
    vec2 point = gl_PointCoord - 0.5;
    point.x *= 0.42;
    float soft = 1.0 - smoothstep(0.20, 0.50, length(point));
    if (soft <= 0.001 || vOpacity <= 0.001) discard;
    vec3 colour = mix(vec3(0.42, 0.16, 0.075), vec3(0.70, 0.30, 0.13), vWarmth);
    gl_FragColor = vec4(colour, soft * vOpacity * 0.38);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function createDustMaterial() {
  return new THREE.ShaderMaterial({
    name: "Mars camera-local windblown dust",
    vertexShader: dustVertex,
    fragmentShader: dustFragment,
    uniforms: {
      uEast: { value: new THREE.Vector3(1, 0, 0) },
      uNorth: { value: new THREE.Vector3(0, 0, 1) },
      uUp: { value: new THREE.Vector3(0, 1, 0) },
      uTime: { value: 0 },
      uActivity: { value: 0 },
      uCameraAltitude: { value: 1_000 },
      uPixelRatio: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    toneMapped: true,
  }) as DustMaterial;
}

function seededUnit(index: number, lane: number) {
  const value = Math.sin(index * 91.713 + lane * 37.119 + 13.37) * 43_758.5453;
  return value - Math.floor(value);
}

function createDustGeometry() {
  const positions = new Float32Array(LOCAL_DUST_PARTICLE_COUNT * 3);
  for (let index = 0; index < LOCAL_DUST_PARTICLE_COUNT; index += 1) {
    positions[index * 3] = seededUnit(index, 0);
    positions[index * 3 + 1] = seededUnit(index, 1);
    positions[index * 3 + 2] = seededUnit(index, 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return geometry;
}

export class WeatherRenderer {
  private readonly waterClouds: THREE.Mesh<THREE.SphereGeometry, CloudMaterial>;
  private readonly co2Clouds: THREE.Mesh<THREE.SphereGeometry, CloudMaterial>;
  private readonly localDust: THREE.Points<THREE.BufferGeometry, DustMaterial>;
  private readonly up = new THREE.Vector3();
  private readonly east = new THREE.Vector3();
  private readonly north = new THREE.Vector3();
  private readonly reference = new THREE.Vector3();
  private preset: MarsWeatherPreset = "auto";
  private state: MarsWeatherState = { preset: "auto", cloudCover: 0.48, dustActivity: 0.24, windSpeedMps: 8 };

  constructor(scene: THREE.Scene) {
    this.waterClouds = new THREE.Mesh(
      new THREE.SphereGeometry(MARS_REFERENCE_RADIUS_M + WATER_ICE_ALTITUDE_M, 96, 48),
      createMarsCloudMaterial("water"),
    );
    this.co2Clouds = new THREE.Mesh(
      new THREE.SphereGeometry(MARS_REFERENCE_RADIUS_M + CO2_ICE_ALTITUDE_M, 96, 48),
      createMarsCloudMaterial("co2"),
    );
    this.localDust = new THREE.Points(createDustGeometry(), createDustMaterial());
    this.waterClouds.name = "Mars water-ice cloud cover";
    this.co2Clouds.name = "Mars high-altitude carbon-dioxide ice wisps";
    this.localDust.name = "Mars active surface dust gusts";
    this.waterClouds.frustumCulled = false;
    this.co2Clouds.frustumCulled = false;
    this.localDust.frustumCulled = false;
    this.waterClouds.renderOrder = 19_200;
    this.co2Clouds.renderOrder = 19_300;
    this.localDust.renderOrder = 19_800;
    scene.add(this.waterClouds, this.co2Clouds, this.localDust);
  }

  setPreset(preset: MarsWeatherPreset) {
    this.preset = preset;
    this.state = { ...this.state, preset };
  }

  getState() {
    return { ...this.state };
  }

  update(
    cameraAbsolute: Vec3,
    cameraDirection: Vec3,
    altitudeM: number,
    sunDirection: Vec3,
    elapsedSeconds: number,
    pixelRatio: number,
    detailLevel: 0 | 1 | 2,
  ) {
    const locationPattern = 0.5 + 0.5 * Math.sin(
      cameraDirection.x * 19.7 + cameraDirection.y * 31.1 - cameraDirection.z * 13.3,
    );
    const slowWeather = 0.5 + 0.5 * Math.sin(elapsedSeconds * 0.0017 + locationPattern * 5.1);
    let cloudCover = clamp(0.24 + locationPattern * 0.16 + slowWeather * 0.08, 0, 1);
    let dustActivity = clamp(0.16 + (1 - locationPattern) * 0.24 + slowWeather * 0.14, 0, 1);
    if (this.preset === "clear") {
      cloudCover = 0.08;
      dustActivity = 0.08;
    } else if (this.preset === "cloudy") {
      cloudCover = 0.68;
      dustActivity = 0.24;
    } else if (this.preset === "dust-storm") {
      cloudCover = 0.22;
      dustActivity = 1;
    }
    const windSpeedMps = 3.5 + dustActivity * 18 + slowWeather * 4;
    this.state = { preset: this.preset, cloudCover, dustActivity, windSpeedMps };

    const cameraRadius = Math.hypot(cameraAbsolute.x, cameraAbsolute.y, cameraAbsolute.z);
    for (const [mesh, coverage, layerAltitudeM] of [
      [this.waterClouds, cloudCover, WATER_ICE_ALTITUDE_M],
      [this.co2Clouds, clamp((cloudCover - 0.32) * 0.36 + 0.10, 0.06, 0.32), CO2_ICE_ALTITUDE_M],
    ] as const) {
      mesh.position.set(-cameraAbsolute.x, -cameraAbsolute.y, -cameraAbsolute.z);
      mesh.material.uniforms.uCameraRadius.value = cameraRadius;
      mesh.material.uniforms.uSunDirection.value.set(sunDirection.x, sunDirection.y, sunDirection.z);
      mesh.material.uniforms.uTime.value = elapsedSeconds;
      mesh.material.uniforms.uCoverage.value = coverage;
      mesh.material.side = cameraRadius > MARS_REFERENCE_RADIUS_M + layerAltitudeM
        ? THREE.FrontSide
        : THREE.BackSide;
      mesh.visible = detailLevel > 0;
    }

    this.up.set(cameraDirection.x, cameraDirection.y, cameraDirection.z).normalize();
    this.reference.set(0, 1, 0);
    if (Math.abs(this.up.dot(this.reference)) > 0.92) this.reference.set(1, 0, 0);
    this.east.crossVectors(this.reference, this.up).normalize();
    this.north.crossVectors(this.up, this.east).normalize();
    this.localDust.material.uniforms.uEast.value.copy(this.east);
    this.localDust.material.uniforms.uNorth.value.copy(this.north);
    this.localDust.material.uniforms.uUp.value.copy(this.up);
    this.localDust.material.uniforms.uTime.value = elapsedSeconds * (0.55 + windSpeedMps / 18);
    this.localDust.material.uniforms.uActivity.value = dustActivity * (detailLevel === 2 ? 1 : 0.35);
    this.localDust.material.uniforms.uCameraAltitude.value = altitudeM;
    this.localDust.material.uniforms.uPixelRatio.value = pixelRatio;
    this.localDust.visible = detailLevel > 0 && altitudeM < 180;
  }

  dispose() {
    for (const mesh of [this.waterClouds, this.co2Clouds]) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.localDust.removeFromParent();
    this.localDust.geometry.dispose();
    this.localDust.material.dispose();
  }
}
