import * as THREE from "three";
import { ATMOSPHERE_CONFIG, MATERIAL_CONFIG, MARS_ATMOSPHERE_TOP_M, MARS_REFERENCE_RADIUS_M, RENDER_CONFIG } from "../constants";

export type TerrainMaterial = THREE.ShaderMaterial & {
  uniforms: {
    uSunDirection: { value: THREE.Vector3 };
    uCameraAltitude: { value: number };
    uTime: { value: number };
    uFade: { value: number };
    uFadeIn: { value: number };
    uMorph: { value: number };
    uTileLod: { value: number };
    uFaceIndex: { value: number };
    uTileOriginModulo: { value: THREE.Vector3 };
    uDebugTileBoundaries: { value: number };
    uDebugCubeFaces: { value: number };
    uDebugLod: { value: number };
    uDebugNormals: { value: number };
    uDebugMolaOnly: { value: number };
  };
};

const terrainVertex = /* glsl */ `
  #include <shadowmap_pars_vertex>

  attribute vec3 planetDirection;
  attribute float elevation;
  attribute float areoidElevation;
  attribute vec3 morphDelta;
  attribute vec2 tileUv;
  attribute float surfaceMask;

  uniform float uMorph;
  uniform vec3 uTileOriginModulo;

  varying vec3 vNormal;
  varying vec3 vWorldPosition;
  varying vec3 vPlanetDirection;
  varying float vElevation;
  varying float vAreoidElevation;
  varying vec2 vTileUv;
  varying float vSurfaceMask;
  varying vec3 vStableMetres;

  void main() {
    vec3 morphed = position - morphDelta * (1.0 - uMorph);
    vec4 world = modelMatrix * vec4(morphed, 1.0);
    vWorldPosition = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vPlanetDirection = normalize(planetDirection);
    vElevation = elevation;
    vAreoidElevation = areoidElevation;
    vTileUv = tileUv;
    vSurfaceMask = surfaceMask;
    vStableMetres = uTileOriginModulo + morphed;
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      vec3 shadowNormal = normalize(mat3(modelMatrix) * normal);
      #pragma unroll_loop_start
      for (int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i++) {
        vec4 shadowWorld = world;
        shadowWorld.xyz += shadowNormal * directionalLightShadows[i].shadowNormalBias;
        vDirectionalShadowCoord[i] = directionalShadowMatrix[i] * shadowWorld;
      }
      #pragma unroll_loop_end
    #endif
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const terrainFragment = /* glsl */ `
  precision highp float;

  #include <common>
  #include <packing>
  #include <shadowmap_pars_fragment>

  uniform vec3 uSunDirection;
  uniform float uCameraAltitude;
  uniform float uTime;
  uniform float uFade;
  uniform float uFadeIn;
  uniform float uTileLod;
  uniform float uFaceIndex;
  uniform float uDebugTileBoundaries;
  uniform float uDebugCubeFaces;
  uniform float uDebugLod;
  uniform float uDebugNormals;
  uniform float uDebugMolaOnly;

  varying vec3 vNormal;
  varying vec3 vWorldPosition;
  varying vec3 vPlanetDirection;
  varying float vElevation;
  varying float vAreoidElevation;
  varying vec2 vTileUv;
  varying float vSurfaceMask;
  varying vec3 vStableMetres;

  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float valueNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash31(i + vec3(0,0,0));
    float n100 = hash31(i + vec3(1,0,0));
    float n010 = hash31(i + vec3(0,1,0));
    float n110 = hash31(i + vec3(1,1,0));
    float n001 = hash31(i + vec3(0,0,1));
    float n101 = hash31(i + vec3(1,0,1));
    float n011 = hash31(i + vec3(0,1,1));
    float n111 = hash31(i + vec3(1,1,1));
    return mix(mix(mix(n000,n100,f.x),mix(n010,n110,f.x),f.y),mix(mix(n001,n101,f.x),mix(n011,n111,f.x),f.y),f.z);
  }

  float periodicNoiseMetres(vec3 metres, float wavelength) {
    vec3 p = metres / wavelength;
    float periodCells = 4096.0 / wavelength;
    vec3 i = mod(floor(p), periodCells);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash31(mod(i + vec3(0,0,0), periodCells));
    float n100 = hash31(mod(i + vec3(1,0,0), periodCells));
    float n010 = hash31(mod(i + vec3(0,1,0), periodCells));
    float n110 = hash31(mod(i + vec3(1,1,0), periodCells));
    float n001 = hash31(mod(i + vec3(0,0,1), periodCells));
    float n101 = hash31(mod(i + vec3(1,0,1), periodCells));
    float n011 = hash31(mod(i + vec3(0,1,1), periodCells));
    float n111 = hash31(mod(i + vec3(1,1,1), periodCells));
    return mix(mix(mix(n000,n100,f.x),mix(n010,n110,f.x),f.y),mix(mix(n001,n101,f.x),mix(n011,n111,f.x),f.y),f.z);
  }

  vec3 palette(float index) {
    if (index < 0.5) return vec3(0.70, 0.19, 0.08);
    if (index < 1.5) return vec3(0.12, 0.50, 0.72);
    if (index < 2.5) return vec3(0.73, 0.55, 0.12);
    if (index < 3.5) return vec3(0.50, 0.18, 0.72);
    if (index < 4.5) return vec3(0.16, 0.68, 0.38);
    return vec3(0.78, 0.31, 0.47);
  }

  void main() {
    float dither = hash31(vec3(gl_FragCoord.xy, 0.0));
    if (uFade < 0.999) {
      if (uFadeIn > 0.5 && dither > uFade) discard;
      if (uFadeIn < 0.5 && dither <= 1.0 - uFade) discard;
    }

    vec3 radial = normalize(vPlanetDirection);
    vec3 normal = normalize(vNormal);
    float slope = clamp(1.0 - dot(normal, radial), 0.0, 1.0);
    float latitude = abs(radial.y);
    float macro = valueNoise(radial * 17.0 + vec3(4.1, -8.2, 2.7));
    float regional = valueNoise(radial * 92.0 + vec3(-7.0, 2.0, 11.0));
    float grain = valueNoise(radial * mix(900.0, 18000.0, clamp(uTileLod / 18.0, 0.0, 1.0)));
    float closeDetail = smoothstep(10.0, 16.0, uTileLod);
    float metreVisibility = 0.0;
    float grainVisibility = 0.0;
    float metreVariation = 0.5;
    float fineGrain = 0.5;
    float pebbles = 0.0;
    if (uTileLod > 9.0) {
      float pixelFootprintM = max(0.01, length(fwidth(vStableMetres)));
      metreVisibility = closeDetail * (1.0 - smoothstep(1.2, 18.0, pixelFootprintM));
      grainVisibility = closeDetail * (1.0 - smoothstep(0.28, 3.2, pixelFootprintM));
      metreVariation = periodicNoiseMetres(vStableMetres, 64.0) * 0.58 +
        periodicNoiseMetres(vStableMetres + vec3(19.0, -7.0, 31.0), 8.0) * 0.42;
      fineGrain = periodicNoiseMetres(vStableMetres + vec3(-3.0, 11.0, 5.0), 2.0);
      pebbles = smoothstep(0.76, 0.94, periodicNoiseMetres(vStableMetres + vec3(1.7, 4.3, -2.1), 0.5));
    }
    float curvatureProxy = clamp((regional - macro) * 1.8 + 0.5, 0.0, 1.0);

    vec3 dust = vec3(${MATERIAL_CONFIG.dust.albedo.join(",")});
    vec3 regolith = vec3(${MATERIAL_CONFIG.regolith.albedo.join(",")});
    vec3 basalt = vec3(${MATERIAL_CONFIG.basalt.albedo.join(",")});
    vec3 lightRock = vec3(${MATERIAL_CONFIG.lightRock.albedo.join(",")});
    vec3 frost = vec3(${MATERIAL_CONFIG.frost.albedo.join(",")});

    float frostWeight = smoothstep(0.78, 0.96, latitude) * smoothstep(-1500.0, 3200.0, vElevation);
    float basaltWeight = smoothstep(0.25, 0.72, slope + (1.0 - curvatureProxy) * 0.46);
    float rockWeight = smoothstep(0.18, 0.6, slope + curvatureProxy * 0.24) * (1.0 - frostWeight);
    float dustWeight = clamp(0.62 + macro * 0.32 - slope * 1.7, 0.0, 1.0) * (1.0 - frostWeight);
    vec3 albedo = mix(regolith, dust, dustWeight);
    albedo = mix(albedo, basalt, basaltWeight * 0.72);
    albedo = mix(albedo, lightRock, rockWeight * 0.45);
    albedo = mix(albedo, frost, frostWeight * (0.64 + grain * 0.28));
    albedo *= 0.74 + macro * 0.30 + (grain - 0.5) * 0.08;
    albedo *= mix(1.0, 0.90 + metreVariation * 0.16, metreVisibility);
    albedo = mix(albedo, albedo * vec3(0.48, 0.40, 0.37), pebbles * grainVisibility * 0.42);
    albedo += vec3((fineGrain - 0.5) * 0.035 * grainVisibility);
    albedo *= mix(0.63, 1.0, vSurfaceMask);

    float roughness = mix(${MATERIAL_CONFIG.regolith.roughness.toFixed(3)}, ${MATERIAL_CONFIG.basalt.roughness.toFixed(3)}, basaltWeight);
    roughness = mix(roughness, ${MATERIAL_CONFIG.frost.roughness.toFixed(3)}, frostWeight);
    vec3 orbitalMicro = vec3(
      valueNoise(radial * 6200.0 + vec3(0.13,0,0)),
      valueNoise(radial * 6200.0 + vec3(0,0.19,0)),
      valueNoise(radial * 6200.0 + vec3(0,0,0.23))
    ) - 0.5;
    vec3 metreMicro = vec3(0.0);
    if (uTileLod > 9.0) {
      metreMicro = vec3(
        periodicNoiseMetres(vStableMetres + vec3(0.0, 1.3, 2.7), 2.0),
        periodicNoiseMetres(vStableMetres + vec3(3.1, 0.0, 1.1), 2.0),
        periodicNoiseMetres(vStableMetres + vec3(2.2, 4.7, 0.0), 2.0)
      ) - 0.5;
    }
    metreMicro -= radial * dot(metreMicro, radial);
    normal = normalize(normal + orbitalMicro * 0.025 + metreMicro * (0.12 * grainVisibility));

    vec3 sun = normalize(uSunDirection);
    float ndl = dot(normal, sun);
    float daylight = smoothstep(-0.08, 0.07, ndl);
    float diffuse = max(ndl, 0.0);
    float surfaceShadow = 1.0;
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      #pragma unroll_loop_start
      for (int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i++) {
        surfaceShadow *= getShadow(
          directionalShadowMap[i],
          directionalLightShadows[i].shadowMapSize,
          directionalLightShadows[i].shadowIntensity,
          directionalLightShadows[i].shadowBias,
          directionalLightShadows[i].shadowRadius,
          vDirectionalShadowCoord[i]
        );
      }
      #pragma unroll_loop_end
    #endif
    // Thin-atmosphere dust and ground bounce: still dark on the night side, but
    // enough energy remains in sunlit shadows to retain terrain relief.
    float bounced = 0.052 + 0.048 * max(dot(radial, sun), 0.0);
    vec3 viewDirection = normalize(-vWorldPosition);
    vec3 halfVector = normalize(sun + viewDirection);
    float specular = pow(max(dot(normal, halfVector), 0.0), mix(75.0, 8.0, roughness));
    vec3 colour = albedo * (bounced + diffuse * 1.24 * surfaceShadow) + vec3(1.0, 0.72, 0.47) * specular * (1.0 - roughness) * daylight * surfaceShadow;
    colour += albedo * 0.014 * (1.0 - daylight);

    float distanceM = length(vWorldPosition);
    float surfaceDensity = exp(-max(uCameraAltitude, 0.0) / ${ATMOSPHERE_CONFIG.scaleHeightM.toFixed(1)});
    float horizonPath = 1.0 - exp(-distanceM / 90000.0);
    float haze = clamp(horizonPath * surfaceDensity * ${ATMOSPHERE_CONFIG.aerialPerspective.toFixed(2)}, 0.0, 0.82);
    vec3 hazeColour = mix(vec3(0.15, 0.055, 0.035), vec3(0.72, 0.20, 0.075), pow(max(dot(viewDirection, sun), 0.0), 6.0));
    colour = mix(colour, hazeColour, haze * (0.42 + 0.58 * daylight));

    if (uDebugCubeFaces > 0.5) colour = mix(colour, palette(uFaceIndex), 0.54);
    if (uDebugLod > 0.5) colour = mix(colour, palette(mod(uTileLod, 6.0)), 0.58);
    if (uDebugNormals > 0.5) colour = normal * 0.5 + 0.5;
    if (uDebugMolaOnly > 0.5) {
      float topography = clamp((vElevation - vAreoidElevation + 8000.0) / 29000.0, 0.0, 1.0);
      colour = mix(vec3(0.08, 0.12, 0.20), vec3(0.95, 0.43, 0.13), topography);
    }
    if (uDebugTileBoundaries > 0.5) {
      float edge = min(min(vTileUv.x, 1.0 - vTileUv.x), min(vTileUv.y, 1.0 - vTileUv.y));
      float line = 1.0 - smoothstep(0.0, max(fwidth(edge) * 1.8, 0.0025), edge);
      colour = mix(colour, vec3(0.05, 0.95, 0.82), line * vSurfaceMask);
    }

    gl_FragColor = vec4(max(colour, vec3(0.0)), 1.0);
  }
`;

export function createTerrainMaterial(): TerrainMaterial {
  return new THREE.ShaderMaterial({
    name: "Mars procedural PBR terrain",
    vertexShader: terrainVertex,
    fragmentShader: terrainFragment,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.lights, {
      uSunDirection: { value: new THREE.Vector3(1, 0.25, 0.2).normalize() },
      uCameraAltitude: { value: 10_000_000 },
      uTime: { value: 0 },
      uFade: { value: 1 },
      uFadeIn: { value: 1 },
      uMorph: { value: 1 },
      uTileLod: { value: 0 },
      uFaceIndex: { value: 0 },
      uTileOriginModulo: { value: new THREE.Vector3() },
      uDebugTileBoundaries: { value: 0 },
      uDebugCubeFaces: { value: 0 },
      uDebugLod: { value: 0 },
      uDebugNormals: { value: 0 },
      uDebugMolaOnly: { value: 0 },
    }]),
    lights: true,
    depthWrite: true,
    depthTest: true,
    transparent: false,
    side: THREE.FrontSide,
    toneMapped: true,
    glslVersion: THREE.GLSL1,
  }) as TerrainMaterial;
}

const terrainShadowVertex = /* glsl */ `
  attribute vec3 morphDelta;
  attribute float surfaceMask;
  uniform float uMorph;
  varying float vSurfaceMask;
  void main() {
    vec3 morphed = position - morphDelta * (1.0 - uMorph);
    vSurfaceMask = surfaceMask;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(morphed, 1.0);
  }
`;

const terrainShadowFragment = /* glsl */ `
  precision highp float;
  varying float vSurfaceMask;
  void main() {
    if (vSurfaceMask < 0.5) discard;
    gl_FragColor = vec4(1.0);
  }
`;

export type TerrainShadowMaterial = THREE.ShaderMaterial & {
  uniforms: { uMorph: { value: number } };
};

export function createTerrainShadowMaterial(): TerrainShadowMaterial {
  return new THREE.ShaderMaterial({
    name: "Mars morph-aware terrain shadow depth",
    vertexShader: terrainShadowVertex,
    fragmentShader: terrainShadowFragment,
    uniforms: { uMorph: { value: 1 } },
    depthTest: true,
    depthWrite: true,
    side: THREE.FrontSide,
  }) as TerrainShadowMaterial;
}

const atmosphereVertex = /* glsl */ `
  varying vec3 vWorldPosition;
  varying vec3 vRadial;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    vRadial = normalize(position);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const atmosphereFragment = /* glsl */ `
  precision highp float;
  uniform vec3 uSunDirection;
  uniform vec3 uPlanetCenter;
  uniform float uCameraRadius;
  uniform float uCameraAltitude;
  uniform float uExposure;
  varying vec3 vWorldPosition;
  varying vec3 vRadial;

  const float PLANET_RADIUS = ${MARS_REFERENCE_RADIUS_M.toFixed(1)};
  const float ATMOSPHERE_RADIUS = ${(MARS_REFERENCE_RADIUS_M + MARS_ATMOSPHERE_TOP_M).toFixed(1)};
  const float RAYLEIGH_HEIGHT = ${ATMOSPHERE_CONFIG.scaleHeightM.toFixed(1)};
  const float DUST_HEIGHT = ${ATMOSPHERE_CONFIG.dustScaleHeightM.toFixed(1)};
  const float PI = 3.141592653589793;

  vec2 raySphere(vec3 origin, vec3 direction, float radius) {
    float b = dot(origin, direction);
    float c = dot(origin, origin) - radius * radius;
    float h = b * b - c;
    if (h < 0.0) return vec2(1e20, -1e20);
    h = sqrt(h);
    return vec2(-b - h, -b + h);
  }

  float rayleighPhase(float cosineAngle) {
    return 3.0 * (1.0 + cosineAngle * cosineAngle) / (16.0 * PI);
  }

  float miePhase(float cosineAngle) {
    float g = ${ATMOSPHERE_CONFIG.mieG.toFixed(3)};
    float denominator = max(0.035, 1.0 + g * g - 2.0 * g * cosineAngle);
    return 3.0 * (1.0 - g * g) * (1.0 + cosineAngle * cosineAngle) /
      (8.0 * PI * (2.0 + g * g) * pow(denominator, 1.5));
  }

  void main() {
    bool cameraOutside = uCameraRadius > ATMOSPHERE_RADIUS;
    if ((cameraOutside && !gl_FrontFacing) || (!cameraOutside && gl_FrontFacing)) discard;

    vec3 viewRay = normalize(vWorldPosition);
    vec3 cameraFromCenter = -uPlanetCenter;
    vec3 sun = normalize(uSunDirection);
    vec2 atmosphereHit = raySphere(cameraFromCenter, viewRay, ATMOSPHERE_RADIUS);
    float rayStart = max(atmosphereHit.x, 0.0);
    float rayEnd = atmosphereHit.y;
    vec2 groundHit = raySphere(cameraFromCenter, viewRay, PLANET_RADIUS);
    if (groundHit.x > 0.0) rayEnd = min(rayEnd, groundHit.x);
    if (rayEnd <= rayStart) discard;

    vec3 betaRayleigh = vec3(${ATMOSPHERE_CONFIG.rayleigh.join(",")}) * ${ATMOSPHERE_CONFIG.density.toFixed(3)};
    vec3 betaDust = (vec3(${ATMOSPHERE_CONFIG.mie.join(",")}) * 0.48 + vec3(${ATMOSPHERE_CONFIG.dust.join(",")}) * 0.72) * ${ATMOSPHERE_CONFIG.density.toFixed(3)};
    float mu = dot(viewRay, sun);
    float phaseR = rayleighPhase(mu);
    float phaseM = miePhase(mu);
    float segmentLength = (rayEnd - rayStart) / ${RENDER_CONFIG.atmosphereQualitySteps.toFixed(1)};
    float opticalViewR = 0.0;
    float opticalViewM = 0.0;
    vec3 inscatter = vec3(0.0);

    for (int viewStep = 0; viewStep < ${RENDER_CONFIG.atmosphereQualitySteps}; viewStep++) {
      float sampleDistance = rayStart + (float(viewStep) + 0.5) * segmentLength;
      vec3 sampleFromCenter = cameraFromCenter + viewRay * sampleDistance;
      float altitude = max(0.0, length(sampleFromCenter) - PLANET_RADIUS);
      float densityR = exp(-altitude / RAYLEIGH_HEIGHT);
      float densityM = exp(-altitude / DUST_HEIGHT);
      opticalViewR += densityR * segmentLength / RAYLEIGH_HEIGHT;
      opticalViewM += densityM * segmentLength / DUST_HEIGHT;

      vec3 sampleUp = normalize(sampleFromCenter);
      vec2 sunGroundHit = raySphere(sampleFromCenter + sampleUp * 24.0, sun, PLANET_RADIUS);
      float illuminated = sunGroundHit.x > 0.0 ? 0.0 : 1.0;
      vec2 sunAtmosphereHit = raySphere(sampleFromCenter, sun, ATMOSPHERE_RADIUS);
      float sunLength = max(0.0, sunAtmosphereHit.y);
      float opticalSunR = 0.0;
      float opticalSunM = 0.0;
      for (int sunStep = 0; sunStep < 3; sunStep++) {
        vec3 sunSample = sampleFromCenter + sun * ((float(sunStep) + 0.5) * sunLength / 3.0);
        float sunAltitude = max(0.0, length(sunSample) - PLANET_RADIUS);
        opticalSunR += exp(-sunAltitude / RAYLEIGH_HEIGHT) * sunLength / (3.0 * RAYLEIGH_HEIGHT);
        opticalSunM += exp(-sunAltitude / DUST_HEIGHT) * sunLength / (3.0 * DUST_HEIGHT);
      }

      vec3 transmittance = exp(-(
        betaRayleigh * (opticalViewR + opticalSunR) +
        betaDust * (opticalViewM + opticalSunM)
      ));
      vec3 localScatter = betaRayleigh * densityR * phaseR / RAYLEIGH_HEIGHT +
        betaDust * densityM * phaseM / DUST_HEIGHT;
      inscatter += localScatter * transmittance * segmentLength * illuminated;
    }

    vec3 viewTransmittance = exp(-(betaRayleigh * opticalViewR + betaDust * opticalViewM));
    float opticalAlpha = 1.0 - dot(viewTransmittance, vec3(0.299, 0.587, 0.114));
    vec3 colour = inscatter * uExposure * ${ATMOSPHERE_CONFIG.limbStrength.toFixed(3)};
    float alpha = clamp(opticalAlpha * 0.92 + dot(colour, vec3(0.22)), 0.0, 0.94);
    gl_FragColor = vec4(max(colour, vec3(0.0)), alpha);
  }
`;

export type AtmosphereMaterial = THREE.ShaderMaterial & {
  uniforms: {
    uSunDirection: { value: THREE.Vector3 };
    uPlanetCenter: { value: THREE.Vector3 };
    uCameraRadius: { value: number };
    uCameraAltitude: { value: number };
    uExposure: { value: number };
  };
};

export function createAtmosphereMaterial(): AtmosphereMaterial {
  return new THREE.ShaderMaterial({
    name: "Mars ray-marched Rayleigh-Mie atmosphere",
    vertexShader: atmosphereVertex,
    fragmentShader: atmosphereFragment,
    uniforms: {
      uSunDirection: { value: new THREE.Vector3(1, 0.25, 0.2).normalize() },
      uPlanetCenter: { value: new THREE.Vector3() },
      uCameraRadius: { value: MARS_REFERENCE_RADIUS_M + 1_000_000 },
      uCameraAltitude: { value: 1_000_000 },
      uExposure: { value: ATMOSPHERE_CONFIG.exposure },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    toneMapped: true,
  }) as AtmosphereMaterial;
}
