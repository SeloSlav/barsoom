import * as THREE from "three";
import { ATMOSPHERE_CONFIG, MATERIAL_CONFIG, MARS_ATMOSPHERE_TOP_M, MARS_REFERENCE_RADIUS_M, RENDER_CONFIG } from "../constants";

export type TerrainMaterial = THREE.ShaderMaterial & {
  uniforms: {
    uSunDirection: { value: THREE.Vector3 };
    uCameraAltitude: { value: number };
    uOrbitalTexture: { value: THREE.Texture };
    uSurfaceDiffuse: { value: THREE.Texture };
    uSurfaceNormal: { value: THREE.Texture };
    uSurfaceRoughness: { value: THREE.Texture };
    uIceSurfaceDiffuse: { value: THREE.Texture };
    uIceSurfaceNormal: { value: THREE.Texture };
    uIceSurfaceRoughness: { value: THREE.Texture };
    uTime: { value: number };
    uMorph: { value: number };
    uEdgeMorph: { value: THREE.Vector4 };
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

export type OrbitalCoverageMaterial = THREE.ShaderMaterial & {
  uniforms: {
    uOrbitalTexture: { value: THREE.Texture };
    uSunDirection: { value: THREE.Vector3 };
  };
};

function createMarsOrbitalTexture() {
  let texture: THREE.Texture;
  if (typeof document === "undefined") {
    const pixels = new Uint8Array([151, 83, 45, 255]);
    texture = new THREE.DataTexture(pixels, 1, 1, THREE.RGBAFormat);
    texture.needsUpdate = true;
  } else {
    texture = new THREE.TextureLoader().load(
      "/textures/mars-viking-global-8k.jpg?revision=usgs-mdim21-8k-2026",
    );
  }
  texture.name = "NASA USGS Viking MDIM 2.1 Mars global albedo 8K";
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  return texture;
}

function createMarsSurfaceTexture(
  path: string,
  name: string,
  fallback: [number, number, number, number],
  colour = false,
) {
  let texture: THREE.Texture;
  if (typeof document === "undefined") {
    texture = new THREE.DataTexture(new Uint8Array(fallback), 1, 1, THREE.RGBAFormat);
    texture.needsUpdate = true;
  } else {
    texture = new THREE.TextureLoader().load(path);
  }
  texture.name = name;
  texture.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  return texture;
}

const terrainVertex = /* glsl */ `
  #include <shadowmap_pars_vertex>

  attribute vec3 planetDirection;
  attribute float elevation;
  attribute float areoidElevation;
  attribute vec3 morphDelta;
  attribute vec3 normalMorphDelta;
  attribute vec2 tileUv;
  attribute float surfaceMask;

  uniform float uMorph;
  uniform vec4 uEdgeMorph;
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
    const float edgeMorphBand = ${ (2 / 24).toFixed(12) };
    float westEdge = 1.0 - smoothstep(0.0, edgeMorphBand, tileUv.x);
    float eastEdge = 1.0 - smoothstep(0.0, edgeMorphBand, 1.0 - tileUv.x);
    float northEdge = 1.0 - smoothstep(0.0, edgeMorphBand, tileUv.y);
    float southEdge = 1.0 - smoothstep(0.0, edgeMorphBand, 1.0 - tileUv.y);
    float stitchedEdgeMorph = max(
      max(westEdge * uEdgeMorph.x, eastEdge * uEdgeMorph.y),
      max(northEdge * uEdgeMorph.z, southEdge * uEdgeMorph.w)
    );
    // Only edges touching a visible coarser neighbour resolve to the parent.
    // Spread that correction over two cells so the exact stitched edge cannot
    // turn into a one-row trench under grazing light.
    float morphWeight = max(1.0 - uMorph, stitchedEdgeMorph);
    vec3 morphed = position - morphDelta * morphWeight;
    vec3 morphedNormal = normalize(normal - normalMorphDelta * morphWeight);
    vec4 world = modelMatrix * vec4(morphed, 1.0);
    vWorldPosition = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * morphedNormal);
    vPlanetDirection = normalize(planetDirection);
    vElevation = elevation;
    vAreoidElevation = areoidElevation;
    vTileUv = tileUv;
    vSurfaceMask = surfaceMask;
    vStableMetres = uTileOriginModulo + morphed;
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      vec3 shadowNormal = normalize(mat3(modelMatrix) * morphedNormal);
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
  uniform sampler2D uOrbitalTexture;
  uniform sampler2D uSurfaceDiffuse;
  uniform sampler2D uSurfaceNormal;
  uniform sampler2D uSurfaceRoughness;
  uniform sampler2D uIceSurfaceDiffuse;
  uniform sampler2D uIceSurfaceNormal;
  uniform sampler2D uIceSurfaceRoughness;
  uniform float uTime;
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

  float stableSurfaceDither(vec3 metres) {
    // A two-centimetre, planet-anchored mask stays attached to the regolith as
    // the camera moves. Screen-pixel noise made LOD fades and the final grade
    // crawl independently over the ground.
    return hash31(floor(mod(metres, 4096.0) * 50.0));
  }

  vec3 sampleOrbitalGeography(vec2 uv) {
    const vec2 texel = vec2(0.0001220703125, 0.000244140625);
    vec3 centre = texture2D(uOrbitalTexture, uv).rgb * 0.40;
    vec3 cross = texture2D(uOrbitalTexture, uv + vec2(texel.x, 0.0)).rgb;
    cross += texture2D(uOrbitalTexture, uv - vec2(texel.x, 0.0)).rgb;
    cross += texture2D(uOrbitalTexture, uv + vec2(0.0, texel.y)).rgb;
    cross += texture2D(uOrbitalTexture, uv - vec2(0.0, texel.y)).rgb;
    return centre + cross * 0.15;
  }

  vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
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

  float distributionGgx(vec3 normal, vec3 halfway, float roughness) {
    float alpha = roughness * roughness;
    float alpha2 = alpha * alpha;
    float ndh = max(dot(normal, halfway), 0.0);
    float denominator = ndh * ndh * (alpha2 - 1.0) + 1.0;
    return alpha2 / max(3.14159265 * denominator * denominator, 0.00001);
  }

  float geometrySchlickGgx(float ndv, float roughness) {
    float r = roughness + 1.0;
    float k = r * r / 8.0;
    return ndv / max(ndv * (1.0 - k) + k, 0.00001);
  }

  float geometrySmith(vec3 normal, vec3 viewDirection, vec3 lightDirection, float roughness) {
    return geometrySchlickGgx(max(dot(normal, viewDirection), 0.0), roughness) *
      geometrySchlickGgx(max(dot(normal, lightDirection), 0.0), roughness);
  }

  vec3 fresnelSchlick(float cosineTheta, vec3 f0) {
    return f0 + (vec3(1.0) - f0) * pow(clamp(1.0 - cosineTheta, 0.0, 1.0), 5.0);
  }

  vec3 triplanarWeights(vec3 normal) {
    vec3 weights = pow(abs(normal), vec3(5.0));
    return weights / max(weights.x + weights.y + weights.z, 0.0001);
  }

  vec4 surfaceVariantHash(vec2 cell, float seed) {
    vec2 seededCell = cell + vec2(seed * 17.13, seed * -9.47);
    return vec4(hash22(seededCell), hash22(seededCell + vec2(41.7, -29.4)));
  }

  vec2 surfaceQuarterTurn(vec2 value, float turn) {
    if (turn < 1.0) return value;
    if (turn < 2.0) return vec2(-value.y, value.x);
    if (turn < 3.0) return -value;
    return vec2(value.y, -value.x);
  }

  vec2 inverseSurfaceQuarterTurn(vec2 value, float turn) {
    if (turn < 1.0) return value;
    if (turn < 2.0) return vec2(value.y, -value.x);
    if (turn < 3.0) return -value;
    return vec2(-value.y, value.x);
  }

  vec2 surfaceVariantUv(vec2 projectedMetres, vec4 variant) {
    float turn = floor(variant.z * 4.0);
    float scaleM = mix(3.0, 6.4, variant.w);
    return surfaceQuarterTurn(projectedMetres, turn) / scaleM + variant.xy * 37.0;
  }

  vec4 sampleStochasticSurfaceMap(sampler2D surfaceMap, vec2 projectedMetres, float seed) {
    // Each 5.3 m world cell blends the four variants anchored at its corners.
    // Adjacent cells share corner variants, so the result is seamless, while
    // every cell receives new phase, quarter-turn and physical scale choices.
    // Unlike two globally repeated UVs, this has no short repeating lattice.
    vec2 patchUv = projectedMetres / 5.3 - 0.5;
    vec2 cell = floor(patchUv);
    vec2 blendWeight = fract(patchUv);
    blendWeight = blendWeight * blendWeight * (3.0 - 2.0 * blendWeight);
    vec4 variant00 = surfaceVariantHash(cell, seed);
    vec4 variant10 = surfaceVariantHash(cell + vec2(1.0, 0.0), seed);
    vec4 variant01 = surfaceVariantHash(cell + vec2(0.0, 1.0), seed);
    vec4 variant11 = surfaceVariantHash(cell + vec2(1.0, 1.0), seed);
    vec4 sample00 = texture2D(surfaceMap, surfaceVariantUv(projectedMetres, variant00));
    vec4 sample10 = texture2D(surfaceMap, surfaceVariantUv(projectedMetres, variant10));
    vec4 sample01 = texture2D(surfaceMap, surfaceVariantUv(projectedMetres, variant01));
    vec4 sample11 = texture2D(surfaceMap, surfaceVariantUv(projectedMetres, variant11));
    return mix(
      mix(sample00, sample10, blendWeight.x),
      mix(sample01, sample11, blendWeight.x),
      blendWeight.y
    );
  }

  vec3 sampleSurfaceDiffuseProjection(sampler2D surfaceMap, vec2 projectedMetres, float seed) {
    return sampleStochasticSurfaceMap(surfaceMap, projectedMetres, seed).rgb;
  }

  float sampleSurfaceRoughnessProjection(sampler2D surfaceMap, vec2 projectedMetres, float seed) {
    return sampleStochasticSurfaceMap(surfaceMap, projectedMetres, seed).r;
  }

  vec3 sampleSurfaceNormalVariant(sampler2D surfaceMap, vec2 projectedMetres, vec4 variant) {
    float turn = floor(variant.z * 4.0);
    vec3 mapped = texture2D(surfaceMap, surfaceVariantUv(projectedMetres, variant)).xyz * 2.0 - 1.0;
    mapped.xy = inverseSurfaceQuarterTurn(mapped.xy, turn);
    return mapped;
  }

  vec3 sampleSurfaceNormalProjection(sampler2D surfaceMap, vec2 projectedMetres, float seed) {
    vec2 patchUv = projectedMetres / 5.3 - 0.5;
    vec2 cell = floor(patchUv);
    vec2 blendWeight = fract(patchUv);
    blendWeight = blendWeight * blendWeight * (3.0 - 2.0 * blendWeight);
    vec3 sample00 = sampleSurfaceNormalVariant(surfaceMap, projectedMetres, surfaceVariantHash(cell, seed));
    vec3 sample10 = sampleSurfaceNormalVariant(surfaceMap, projectedMetres, surfaceVariantHash(cell + vec2(1.0, 0.0), seed));
    vec3 sample01 = sampleSurfaceNormalVariant(surfaceMap, projectedMetres, surfaceVariantHash(cell + vec2(0.0, 1.0), seed));
    vec3 sample11 = sampleSurfaceNormalVariant(surfaceMap, projectedMetres, surfaceVariantHash(cell + vec2(1.0, 1.0), seed));
    return normalize(mix(
      mix(sample00, sample10, blendWeight.x),
      mix(sample01, sample11, blendWeight.x),
      blendWeight.y
    ));
  }

  vec3 sampleSurfaceDiffuse(sampler2D surfaceMap, vec3 metres, vec3 weights) {
    vec3 x = sampleSurfaceDiffuseProjection(surfaceMap, metres.yz, 0.17);
    vec3 y = sampleSurfaceDiffuseProjection(surfaceMap, metres.xz, 1.73);
    vec3 z = sampleSurfaceDiffuseProjection(surfaceMap, metres.xy, 3.41);
    return x * weights.x + y * weights.y + z * weights.z;
  }

  float sampleSurfaceRoughness(sampler2D surfaceMap, vec3 metres, vec3 weights) {
    float x = sampleSurfaceRoughnessProjection(surfaceMap, metres.yz, 0.17);
    float y = sampleSurfaceRoughnessProjection(surfaceMap, metres.xz, 1.73);
    float z = sampleSurfaceRoughnessProjection(surfaceMap, metres.xy, 3.41);
    return x * weights.x + y * weights.y + z * weights.z;
  }

  vec3 sampleSurfaceNormal(sampler2D surfaceMap, vec3 metres, vec3 baseNormal, vec3 weights) {
    vec3 mapX = sampleSurfaceNormalProjection(surfaceMap, metres.yz, 0.17);
    vec3 mapY = sampleSurfaceNormalProjection(surfaceMap, metres.xz, 1.73);
    vec3 mapZ = sampleSurfaceNormalProjection(surfaceMap, metres.xy, 3.41);
    vec3 signs = mix(vec3(-1.0), vec3(1.0), step(vec3(0.0), baseNormal));
    vec3 worldX = normalize(vec3(mapX.z * signs.x, mapX.x, mapX.y));
    vec3 worldY = normalize(vec3(mapY.x, mapY.z * signs.y, mapY.y));
    vec3 worldZ = normalize(vec3(mapZ.x, mapZ.y, mapZ.z * signs.z));
    return normalize(worldX * weights.x + worldY * weights.y + worldZ * weights.z);
  }

  void main() {
    float dither = stableSurfaceDither(vStableMetres);

    vec3 radial = normalize(vPlanetDirection);
    vec3 normal = normalize(vNormal);
    float slope = clamp(1.0 - dot(normal, radial), 0.0, 1.0);
    float latitude = abs(radial.y);
    float macro = valueNoise(radial * 17.0 + vec3(4.1, -8.2, 2.7));
    float regional = valueNoise(radial * 92.0 + vec3(-7.0, 2.0, 11.0));
    float pixelFootprintM = max(0.01, length(fwidth(vStableMetres)));
    float fineRegionalVisibility = 1.0 - smoothstep(90.0, 700.0, pixelFootprintM);
    float grain = mix(
      valueNoise(radial * 900.0 + vec3(1.7, -2.3, 4.1)),
      valueNoise(radial * 18000.0 + vec3(-3.1, 7.2, 0.8)),
      fineRegionalVisibility
    );
    // Camera and derivative metrics are continuous across a tile handoff.
    // A streamed-LOD gate made parent and child fragments visibly disagree
    // inside the complementary dither mask.
    float closeDetail = 1.0 - smoothstep(900.0, 6000.0, uCameraAltitude);
    float metreVisibility = 0.0;
    float grainVisibility = 0.0;
    float metreVariation = 0.5;
    float fineGrain = 0.5;
    float pebbles = 0.0;
    if (closeDetail > 0.001) {
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

    // Polar ice sits in low terrain as well as high terrain. The former
    // elevation gate incorrectly removed both real caps from the rendered
    // planet, especially the northern lowlands.
    float capLatitude = smoothstep(0.89, 0.975, latitude);
    float capBreakup = smoothstep(0.18, 0.78, regional * 0.62 + macro * 0.38);
    float frostWeight = capLatitude * (0.76 + capBreakup * 0.24);
    float basaltWeight = smoothstep(0.25, 0.72, slope + (1.0 - curvatureProxy) * 0.46);
    float rockWeight = smoothstep(0.18, 0.6, slope + curvatureProxy * 0.24) * (1.0 - frostWeight);
    float dustWeight = clamp(0.62 + macro * 0.32 - slope * 1.7, 0.0, 1.0) * (1.0 - frostWeight);
    vec3 albedo = mix(regolith, dust, dustWeight);
    albedo = mix(albedo, basalt, basaltWeight * 0.72);
    albedo = mix(albedo, lightRock, rockWeight * 0.45);
    albedo = mix(albedo, frost, frostWeight * (0.90 + grain * 0.08));
    albedo *= 0.74 + macro * 0.30 + (grain - 0.5) * 0.08;
    albedo *= mix(1.0, 0.90 + metreVariation * 0.16, metreVisibility);
    albedo = mix(albedo, albedo * vec3(0.48, 0.40, 0.37), pebbles * grainVisibility * 0.42);
    albedo += vec3((fineGrain - 0.5) * 0.035 * grainVisibility);

    float surfacePbrBlend = 0.0;
    float surfaceMaterialResponse = 0.0;
    float mappedRoughness = 0.94;
    vec3 mappedNormal = normal;
    if (uCameraAltitude < 68.0) {
      // Material visibility depends on continuous camera/fragment metrics,
      // never streamed LOD. This prevents a close PBR field from pulsing as
      // geometry refines beneath it.
      float surfaceAlbedoVisibility = 1.0 - smoothstep(24.0, 68.0, uCameraAltitude);
      surfacePbrBlend = surfaceAlbedoVisibility *
        (1.0 - smoothstep(2.5, 48.0, pixelFootprintM));
      surfaceMaterialResponse = surfacePbrBlend * (1.0 - smoothstep(9.0, 34.0, uCameraAltitude));
      vec3 textureWeights = triplanarWeights(normal);
      vec3 photographedRock = sampleSurfaceDiffuse(uSurfaceDiffuse, vStableMetres, textureWeights);
      vec3 martianRock = photographedRock * vec3(1.10, 0.67, 0.46);
      martianRock *= 0.88 + macro * 0.22;
      vec3 photographedIce = sampleSurfaceDiffuse(uIceSurfaceDiffuse, vStableMetres, textureWeights);
      float iceLuminance = dot(photographedIce, vec3(0.2126, 0.7152, 0.0722));
      vec3 martianIce = mix(photographedIce, vec3(iceLuminance), 0.34) * vec3(1.04, 1.02, 0.98);
      martianIce = mix(martianIce, frost, 0.22);
      albedo = mix(albedo, mix(martianRock, martianIce, frostWeight), surfacePbrBlend);
      if (surfaceMaterialResponse > 0.001) {
        float rockRoughness = sampleSurfaceRoughness(uSurfaceRoughness, vStableMetres, textureWeights);
        float iceRoughness = sampleSurfaceRoughness(uIceSurfaceRoughness, vStableMetres, textureWeights);
        mappedRoughness = mix(rockRoughness, iceRoughness, frostWeight);
        vec3 rockNormal = sampleSurfaceNormal(uSurfaceNormal, vStableMetres, normal, textureWeights);
        vec3 iceNormal = sampleSurfaceNormal(uIceSurfaceNormal, vStableMetres, normal, textureWeights);
        mappedNormal = normalize(mix(rockNormal, iceNormal, frostWeight));
      }
    }

    float longitude = atan(radial.z, radial.x);
    float latitudeRadians = asin(clamp(radial.y, -1.0, 1.0));
    vec2 orbitalUv = vec2(fract(longitude / 6.28318530718 + 0.5), latitudeRadians / 3.14159265359 + 0.5);
    // An 8K global map has roughly 2.6 km texels at the equator. Carrying it
    // unchanged into a regional field magnifies those texels into a false
    // grid. Complete the handoff before 180 km; below that point geographic
    // form comes from MOLA geometry rather than enlarged albedo pixels.
    float orbitalBlend = smoothstep(180000.0, 800000.0, uCameraAltitude);
    vec3 orbitalAlbedo = albedo;
    if (orbitalBlend > 0.001) {
      orbitalAlbedo = texture2D(uOrbitalTexture, orbitalUv).rgb;
      if (uCameraAltitude < 450000.0) {
        float orbitalSmoothing = 1.0 - smoothstep(180000.0, 450000.0, uCameraAltitude);
        orbitalAlbedo = mix(orbitalAlbedo, sampleOrbitalGeography(orbitalUv), orbitalSmoothing);
      }
    }
    vec3 orbitalDetailed = orbitalAlbedo * 0.94 * (0.90 + regional * 0.16 + grain * 0.05);
    albedo = mix(albedo, orbitalDetailed, orbitalBlend);

    float roughness = mix(${MATERIAL_CONFIG.regolith.roughness.toFixed(3)}, ${MATERIAL_CONFIG.basalt.roughness.toFixed(3)}, basaltWeight);
    roughness = mix(roughness, ${MATERIAL_CONFIG.frost.roughness.toFixed(3)}, frostWeight);
    roughness = clamp(roughness + (fineGrain - 0.5) * 0.12 * grainVisibility - pebbles * 0.08, 0.48, 0.99);
    roughness = mix(roughness, clamp(mappedRoughness, 0.24, 0.99), surfaceMaterialResponse);
    vec3 orbitalMicro = vec3(
      valueNoise(radial * 6200.0 + vec3(0.13,0,0)),
      valueNoise(radial * 6200.0 + vec3(0,0.19,0)),
      valueNoise(radial * 6200.0 + vec3(0,0,0.23))
    ) - 0.5;
    vec3 metreMicro = vec3(0.0);
    if (closeDetail > 0.001) {
      metreMicro = vec3(
        periodicNoiseMetres(vStableMetres + vec3(0.0, 1.3, 2.7), 2.0),
        periodicNoiseMetres(vStableMetres + vec3(3.1, 0.0, 1.1), 2.0),
        periodicNoiseMetres(vStableMetres + vec3(2.2, 4.7, 0.0), 2.0)
      ) - 0.5;
    }
    metreMicro -= radial * dot(metreMicro, radial);
    normal = normalize(normal + orbitalMicro * 0.025 + metreMicro * (0.12 * grainVisibility));
    normal = normalize(mix(normal, mappedNormal, surfaceMaterialResponse * 0.50));

    vec3 sun = normalize(uSunDirection);
    float ndl = max(dot(normal, sun), 0.0);
    float daylight = smoothstep(-0.08, 0.07, dot(radial, sun));
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
    vec3 viewDirection = normalize(-vWorldPosition);
    vec3 halfVector = normalize(sun + viewDirection);
    float ndv = max(dot(normal, viewDirection), 0.001);
    vec3 f0 = vec3(0.028);
    vec3 fresnel = fresnelSchlick(max(dot(halfVector, viewDirection), 0.0), f0);
    float distribution = distributionGgx(normal, halfVector, roughness);
    float geometry = geometrySmith(normal, viewDirection, sun, roughness);
    vec3 specular = distribution * geometry * fresnel / max(4.0 * ndv * ndl, 0.001);
    vec3 diffuse = (vec3(1.0) - fresnel) * albedo / 3.14159265;
    float cavity = clamp(0.72 + regional * 0.16 + metreVariation * 0.12, 0.52, 1.0);
    vec3 direct = (diffuse + specular) * ndl * 2.35 * surfaceShadow;
    // Mars has a bright dusty sky even when the direct sun is low. This fill
    // preserves readable rock and terrain form without flattening cast shadows.
    vec3 skyBounce = albedo * (0.075 + 0.105 * daylight) * cavity;
    vec3 colour = direct + skyBounce;
    colour += vec3(0.16, 0.055, 0.025) * albedo * 0.018 * (1.0 - daylight);

    float distanceM = length(vWorldPosition);
    float surfaceDensity = exp(-max(uCameraAltitude, 0.0) / ${ATMOSPHERE_CONFIG.scaleHeightM.toFixed(1)});
    float horizonPath = 1.0 - exp(-distanceM / 90000.0);
    float haze = clamp(horizonPath * surfaceDensity * ${ATMOSPHERE_CONFIG.aerialPerspective.toFixed(2)}, 0.0, 0.82);
    vec3 hazeColour = mix(vec3(0.15, 0.055, 0.035), vec3(0.72, 0.20, 0.075), pow(max(dot(viewDirection, sun), 0.0), 6.0));
    colour = mix(colour, hazeColour, haze * (0.42 + 0.58 * daylight));

    // A tiny linear-space finish opens the low mid-tones without lifting
    // true night-side black. It reuses the planet-anchored LOD dither already
    // computed for this fragment, so the grade adds no texture read or pass.
    float finishingLuma = dot(colour, vec3(0.2126, 0.7152, 0.0722));
    float visibleFinish = smoothstep(0.0025, 0.028, finishingLuma);
    float shadowFinish = (1.0 - smoothstep(0.045, 0.26, finishingLuma)) * visibleFinish;
    colour += vec3(0.0060, 0.0026, 0.0013) * shadowFinish;
    finishingLuma = dot(colour, vec3(0.2126, 0.7152, 0.0722));
    float finishingSaturation = mix(1.035, 1.01, smoothstep(0.45, 2.5, finishingLuma));
    colour = max(mix(vec3(finishingLuma), colour, finishingSaturation), vec3(0.0));

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

    float finishingDitherMask = smoothstep(0.002, 0.018, finishingLuma) *
      (1.0 - smoothstep(0.42, 1.6, finishingLuma));
    colour = max(colour + vec3((dither - 0.5) * (0.36 / 255.0) * finishingDitherMask), vec3(0.0));

    gl_FragColor = vec4(max(colour, vec3(0.0)), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createTerrainMaterial(): TerrainMaterial {
  const orbitalTexture = createMarsOrbitalTexture();
  const surfaceDiffuse = createMarsSurfaceTexture(
    "/textures/mars-rock-diffuse.jpg?revision=polyhaven-rocks-ground-02-1k",
    "Poly Haven rocks ground 02 diffuse, Mars colour grade",
    [128, 78, 48, 255],
    true,
  );
  const surfaceNormal = createMarsSurfaceTexture(
    "/textures/mars-rock-normal-gl.jpg?revision=polyhaven-rocks-ground-02-1k",
    "Poly Haven rocks ground 02 OpenGL normal",
    [128, 128, 255, 255],
  );
  const surfaceRoughness = createMarsSurfaceTexture(
    "/textures/mars-rock-roughness.jpg?revision=polyhaven-rocks-ground-02-1k",
    "Poly Haven rocks ground 02 roughness",
    [235, 235, 235, 255],
  );
  const iceSurfaceDiffuse = createMarsSurfaceTexture(
    "/textures/mars-ice-diffuse.jpg?revision=ambientcg-ice001-1k",
    "ambientCG Ice 001 diffuse, Mars polar colour grade",
    [184, 176, 168, 255],
    true,
  );
  const iceSurfaceNormal = createMarsSurfaceTexture(
    "/textures/mars-ice-normal-gl.jpg?revision=ambientcg-ice001-1k",
    "ambientCG Ice 001 OpenGL normal",
    [128, 128, 255, 255],
  );
  const iceSurfaceRoughness = createMarsSurfaceTexture(
    "/textures/mars-ice-roughness.jpg?revision=ambientcg-ice001-1k",
    "ambientCG Ice 001 roughness",
    [140, 140, 140, 255],
  );
  return new THREE.ShaderMaterial({
    name: "Mars procedural PBR terrain",
    vertexShader: terrainVertex,
    fragmentShader: terrainFragment,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.lights, {
      uSunDirection: { value: new THREE.Vector3(1, 0.25, 0.2).normalize() },
      uCameraAltitude: { value: 10_000_000 },
      uOrbitalTexture: { value: orbitalTexture },
      uSurfaceDiffuse: { value: surfaceDiffuse },
      uSurfaceNormal: { value: surfaceNormal },
      uSurfaceRoughness: { value: surfaceRoughness },
      uIceSurfaceDiffuse: { value: iceSurfaceDiffuse },
      uIceSurfaceNormal: { value: iceSurfaceNormal },
      uIceSurfaceRoughness: { value: iceSurfaceRoughness },
      uTime: { value: 0 },
      uMorph: { value: 1 },
      uEdgeMorph: { value: new THREE.Vector4() },
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

const orbitalCoverageVertex = /* glsl */ `
  varying vec3 vPlanetDirection;

  void main() {
    vPlanetDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const orbitalCoverageFragment = /* glsl */ `
  precision highp float;

  uniform sampler2D uOrbitalTexture;
  uniform vec3 uSunDirection;

  varying vec3 vPlanetDirection;

  void main() {
    vec3 radial = normalize(vPlanetDirection);
    float longitude = atan(radial.z, radial.x);
    float latitude = asin(clamp(radial.y, -1.0, 1.0));
    vec2 orbitalUv = vec2(
      fract(longitude / 6.28318530718 + 0.5),
      latitude / 3.14159265359 + 0.5
    );

    vec3 orbitalAlbedo = texture2D(uOrbitalTexture, orbitalUv).rgb;
    float sunAlignment = dot(radial, normalize(uSunDirection));
    float directLight = max(sunAlignment, 0.0);
    float daylight = smoothstep(-0.10, 0.08, sunAlignment);
    float illumination = directLight * 0.76 + daylight * 0.13 + 0.035;
    vec3 dustyBounce = orbitalAlbedo * vec3(0.14, 0.055, 0.026) * daylight;
    vec3 colour = orbitalAlbedo * illumination + dustyBounce;

    gl_FragColor = vec4(colour, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * Opaque safety layer below the lowest Martian relief. It is invisible under
 * healthy terrain depth and fills a transient orbital coverage void with a
 * stable, correctly registered Mars albedo instead of an animated effect.
 */
export function createOrbitalCoverageMaterial(
  orbitalTexture: THREE.Texture,
): OrbitalCoverageMaterial {
  return new THREE.ShaderMaterial({
    name: "Mars stable orbital coverage substrate",
    vertexShader: orbitalCoverageVertex,
    fragmentShader: orbitalCoverageFragment,
    uniforms: {
      uOrbitalTexture: { value: orbitalTexture },
      uSunDirection: { value: new THREE.Vector3(1, 0.25, 0.2).normalize() },
    },
    // Terrain writes first; this late pass only colours pixels that still
    // contain clear depth. Avoiding a substrate depth write is also important
    // on reversed-depth GPUs, where an early inner sphere can claim coverage.
    depthWrite: false,
    depthTest: true,
    transparent: false,
    side: THREE.FrontSide,
    toneMapped: true,
    glslVersion: THREE.GLSL1,
  }) as OrbitalCoverageMaterial;
}

const terrainShadowVertex = /* glsl */ `
  attribute vec3 morphDelta;
  attribute vec2 tileUv;
  attribute float surfaceMask;
  uniform float uMorph;
  uniform vec4 uEdgeMorph;
  varying float vSurfaceMask;
  void main() {
    const float edgeMorphBand = ${ (2 / 24).toFixed(12) };
    float westEdge = 1.0 - smoothstep(0.0, edgeMorphBand, tileUv.x);
    float eastEdge = 1.0 - smoothstep(0.0, edgeMorphBand, 1.0 - tileUv.x);
    float northEdge = 1.0 - smoothstep(0.0, edgeMorphBand, tileUv.y);
    float southEdge = 1.0 - smoothstep(0.0, edgeMorphBand, 1.0 - tileUv.y);
    float stitchedEdgeMorph = max(
      max(westEdge * uEdgeMorph.x, eastEdge * uEdgeMorph.y),
      max(northEdge * uEdgeMorph.z, southEdge * uEdgeMorph.w)
    );
    vec3 morphed = position - morphDelta * max(1.0 - uMorph, stitchedEdgeMorph);
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
  uniforms: {
    uMorph: { value: number };
    uEdgeMorph: { value: THREE.Vector4 };
  };
};

export function createTerrainShadowMaterial(): TerrainShadowMaterial {
  return new THREE.ShaderMaterial({
    name: "Mars morph-aware terrain shadow depth",
    vertexShader: terrainShadowVertex,
    fragmentShader: terrainShadowFragment,
    uniforms: {
      uMorph: { value: 1 },
      uEdgeMorph: { value: new THREE.Vector4() },
    },
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
    vec3 cameraUp = normalize(cameraFromCenter);
    vec3 sun = normalize(uSunDirection);
    vec2 atmosphereHit = raySphere(cameraFromCenter, viewRay, ATMOSPHERE_RADIUS);
    float rayStart = max(atmosphereHit.x, 0.0);
    float rayEnd = atmosphereHit.y;
    vec2 groundHit = raySphere(cameraFromCenter, viewRay, PLANET_RADIUS);
    if (groundHit.x > 0.0) {
      rayEnd = min(rayEnd, groundHit.x);
    } else if (cameraOutside) {
      // At the geometric limb, a ray that misses the ground suddenly sees the
      // far half of the atmosphere as well as the near half. Bringing that
      // contribution in gradually avoids a doubled, hard-edged horizon band.
      float closestDistance = max(rayStart, -dot(cameraFromCenter, viewRay));
      vec3 closestFromCenter = cameraFromCenter + viewRay * closestDistance;
      float tangentAltitude = max(0.0, length(closestFromCenter) - PLANET_RADIUS);
      float horizonFeather = smoothstep(0.0, 28000.0, tangentAltitude);
      rayEnd = mix(min(rayEnd, closestDistance), rayEnd, horizonFeather);
    }
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
    // The physical single-scatter pass is intentionally thin, but at the
    // surface it must still resolve as a dusty Martian sky rather than black
    // space. This term models the long near-ground aerosol path and the subtle
    // blue-grey aureole around the Sun seen by landers.
    float nearGround = exp(-max(uCameraAltitude, 0.0) / 18000.0);
    float viewElevation = dot(viewRay, cameraUp);
    float horizonGlow = pow(1.0 - clamp(abs(viewElevation), 0.0, 1.0), 2.2);
    float localDaylight = smoothstep(-0.16, 0.10, dot(cameraUp, sun));
    float solarAureole = pow(max(dot(viewRay, sun), 0.0), 18.0);
    vec3 dustySky = mix(vec3(0.13, 0.035, 0.018), vec3(0.70, 0.235, 0.075), horizonGlow);
    dustySky = mix(dustySky, vec3(0.34, 0.43, 0.52), solarAureole * 0.48);
    colour += dustySky * nearGround * (0.14 + horizonGlow * 0.38) * (0.22 + localDaylight * 0.78);
    float surfaceAlpha = nearGround * (0.14 + horizonGlow * 0.46) * (0.30 + localDaylight * 0.70);
    float alpha = clamp(max(surfaceAlpha, opticalAlpha * 0.92 + dot(colour, vec3(0.22))), 0.0, 0.96);
    float atmosphereLuma = dot(colour, vec3(0.2126, 0.7152, 0.0722));
    float atmosphereDitherMask = smoothstep(0.002, 0.018, atmosphereLuma) *
      (1.0 - smoothstep(0.42, 1.6, atmosphereLuma));
    float atmosphereDither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;
    colour = max(colour + vec3(atmosphereDither * (0.36 / 255.0) * atmosphereDitherMask), vec3(0.0));
    gl_FragColor = vec4(max(colour, vec3(0.0)), alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
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
