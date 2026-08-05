import * as THREE from "three";
import { MARS_REFERENCE_RADIUS_M, RENDER_CONFIG } from "./constants";
import { calculateMarsSky, chooseOrbitalSurveyComposition, type MarsSkyState } from "./ephemeris";
import { cartesianToLatLonElevation, clamp, latLonElevationToCartesian, rayTerrainIntersection, snappedDirectionalShadowCenter, type DirectionalShadowSnap } from "./math";
import { PlanetControls, type PlanetControlState } from "./PlanetControls";
import { AtmosphereRenderer } from "./render/AtmosphereRenderer";
import { CelestialRenderer } from "./render/CelestialRenderer";
import { SurfaceDetailRenderer } from "./render/SurfaceDetailRenderer";
import { PlanetTerrain, type TerrainFrameStats } from "./terrain/PlanetTerrain";
import type { DebugFlags, PlanetTelemetry, SurfaceQuery } from "./types";

export type PlanetEngineApi = {
  getState: () => ReturnType<PlanetControls["getState"]> & { telemetry: PlanetTelemetry | null };
  setLocation: (latitudeDeg: number, longitudeDeg: number, altitudeM?: number) => void;
  setAltitude: (altitudeM: number, immediate?: boolean) => void;
  setDebug: (flag: keyof DebugFlags, value: boolean) => void;
  getDebug: () => DebugFlags;
  querySurface: (latitudeDeg: number, longitudeDeg: number) => Promise<SurfaceQuery>;
  setNightSide: (altitudeM?: number) => void;
  setTerminator: (altitudeM?: number) => void;
  setSimulationUtc: (utcIso: string, rate?: number) => void;
};

declare global {
  interface Window {
    __BARSOOM__?: PlanetEngineApi;
  }
}

export class PlanetEngine {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly depthStrategy: "reversed" | "logarithmic";
  private readonly scene = new THREE.Scene();
  private readonly sunShadowLight = new THREE.DirectionalLight(0xffffff, 1);
  private readonly sunShadowTarget = new THREE.Object3D();
  private readonly shadowSun = new THREE.Vector3();
  private readonly shadowSnap: DirectionalShadowSnap = {
    sun: { x: 0, y: 0, z: 0 }, right: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 0 },
    centerAbsolute: { x: 0, y: 0, z: 0 }, centerRelative: { x: 0, y: 0, z: 0 }, texelWorldM: 0,
  };
  private readonly camera = new THREE.PerspectiveCamera(RENDER_CONFIG.fovDegrees, 1, 0.1, 50_000_000);
  private readonly skyCamera = new THREE.PerspectiveCamera(RENDER_CONFIG.fovDegrees, 1, 0.01, 50);
  private readonly terrain: PlanetTerrain;
  private readonly controls: PlanetControls;
  private readonly atmosphere: AtmosphereRenderer;
  private readonly celestial: CelestialRenderer;
  private readonly surfaceDetails: SurfaceDetailRenderer;
  private readonly resizeObserver: ResizeObserver;
  private readonly selection: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly viewportSize = new THREE.Vector2();
  private readonly selectionReferenceNormal = new THREE.Vector3(0, 0, 1);
  private selectionDirection: THREE.Vector3 | null = null;
  private pointerDown: { x: number; y: number } | null = null;
  private controlState!: PlanetControlState;
  private skyState: MarsSkyState;
  private simulationStartUtc: Date;
  private simulationStartPerformance: number;
  private simulationRate: number;
  private lastFrameTime = performance.now();
  private lastSkyUpdate = -Infinity;
  private lastTelemetryTime = -Infinity;
  private smoothedFrameMs = 16.67;
  private framesSinceQualityChange = 0;
  private qualityScale = 1;
  private surfaceShadowsEnabled = false;
  private surfaceShadowExtentM = 0;
  private paused = false;
  private disposed = false;
  private telemetry: PlanetTelemetry | null = null;
  private debug: DebugFlags = {
    overlay: false,
    tileBoundaries: false,
    cubeFaces: false,
    lodColours: false,
    normals: false,
    molaOnly: false,
    horizonCulling: false,
  };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onTelemetry: (telemetry: PlanetTelemetry) => void,
    private readonly onError: (message: string | null) => void,
    initialSimulationUtc: string | Date = new Date(),
    simulationRate = 60,
  ) {
    const requestedEpoch = initialSimulationUtc instanceof Date
      ? new Date(initialSimulationUtc)
      : new Date(initialSimulationUtc);
    this.simulationStartUtc = Number.isFinite(requestedEpoch.getTime()) ? requestedEpoch : new Date();
    this.simulationStartPerformance = performance.now();
    this.simulationRate = Number.isFinite(simulationRate) ? simulationRate : 60;
    const context = canvas.getContext("webgl2", {
      alpha: false,
      antialias: true,
      depth: true,
      stencil: false,
      powerPreference: "high-performance",
    });
    if (!context) throw new Error("Barsoom requires a WebGL 2 capable browser and GPU.");
    const reversedDepthSupported = context.getExtension("EXT_clip_control") !== null;
    this.depthStrategy = reversedDepthSupported ? "reversed" : "logarithmic";
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      context,
      antialias: true,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: "high-performance",
      reversedDepthBuffer: reversedDepthSupported,
      logarithmicDepthBuffer: !reversedDepthSupported,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.14;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.debug.checkShaderErrors = true;
    this.renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
      const details = [
        gl.getProgramInfoLog(program),
        gl.getShaderInfoLog(vertexShader),
        gl.getShaderInfoLog(fragmentShader),
      ].filter(Boolean).join("\n");
      console.error("Barsoom GPU shader compilation failed", details);
      this.onError("A Mars rendering shader could not compile on this GPU. Details are in the browser console.");
    };
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;
    this.scene.background = null;

    this.sunShadowLight.name = "Mars local directional sunlight shadows";
    this.sunShadowTarget.name = "Mars shadow-map snapped target";
    this.sunShadowLight.target = this.sunShadowTarget;
    this.sunShadowLight.castShadow = false;
    this.sunShadowLight.shadow.mapSize.set(RENDER_CONFIG.surfaceShadowMapSize, RENDER_CONFIG.surfaceShadowMapSize);
    this.sunShadowLight.shadow.bias = -0.00012;
    this.sunShadowLight.shadow.normalBias = 0.8;
    this.sunShadowLight.shadow.radius = 1.35;
    this.sunShadowLight.shadow.intensity = 0.88;
    this.scene.add(this.sunShadowTarget, this.sunShadowLight);

    this.skyState = calculateMarsSky(this.simulationStartUtc);
    this.terrain = new PlanetTerrain(this.scene);
    this.surfaceDetails = new SurfaceDetailRenderer(
      this.scene,
      (direction) => this.terrain.sampleHeight(direction),
    );
    this.controls = new PlanetControls(
      canvas,
      this.camera,
      (direction) => this.terrain.sampleHeight(direction),
      (direction) => void this.terrain.prefetch(direction),
    );
    // Begin above the illuminated hemisphere for a legible first descent. The
    // simulation remains physically time-based; this only chooses the landing
    // point, it does not move the Sun or add a scene-wide fill light.
    const composition = chooseOrbitalSurveyComposition(this.skyState);
    const initialPoint = cartesianToLatLonElevation(composition.focusDirection, 1);
    this.controls.setLocation(initialPoint.latitudeDeg, initialPoint.longitudeDeg, 10_000_000);
    this.atmosphere = new AtmosphereRenderer(this.scene);
    this.celestial = new CelestialRenderer(this.skyCamera);

    this.selection = new THREE.Mesh(
      new THREE.RingGeometry(0.72, 1, 64),
      new THREE.MeshBasicMaterial({ color: 0xffb36b, transparent: true, opacity: 0.88, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.selection.name = "Selected surface point";
    this.selection.visible = false;
    this.selection.renderOrder = 10_000;
    this.scene.add(this.selection);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.resize();
    canvas.addEventListener("pointerdown", this.onSelectionPointerDown);
    canvas.addEventListener("pointerup", this.onSelectionPointerUp);
    canvas.addEventListener("webglcontextlost", this.onContextLost, false);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored, false);
    window.addEventListener("keydown", this.onKeyDown);
    window.__BARSOOM__ = {
      getState: () => ({ ...this.controls.getState(), telemetry: this.telemetry }),
      setLocation: (latitudeDeg, longitudeDeg, altitudeM) => this.controls.setLocation(latitudeDeg, longitudeDeg, altitudeM),
      setAltitude: (altitudeM, immediate) => this.controls.setAltitude(altitudeM, immediate),
      setDebug: (flag, value) => { this.debug[flag] = value; },
      getDebug: () => ({ ...this.debug }),
      querySurface: (latitudeDeg, longitudeDeg) => {
        const direction = latLonElevationToCartesian(latitudeDeg, longitudeDeg, 0, 1);
        return this.terrain.querySurface(direction);
      },
      setNightSide: (altitudeM = 100) => {
        const night = cartesianToLatLonElevation({
          x: -this.skyState.sunDirection.x,
          y: -this.skyState.sunDirection.y,
          z: -this.skyState.sunDirection.z,
        }, 1);
        this.controls.setLocation(night.latitudeDeg, night.longitudeDeg, altitudeM);
      },
      setTerminator: (altitudeM = 10_000_000) => {
        const sun = new THREE.Vector3(
          this.skyState.sunDirection.x,
          this.skyState.sunDirection.y,
          this.skyState.sunDirection.z,
        );
        const reference = Math.abs(sun.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        const terminator = new THREE.Vector3().crossVectors(sun, reference).normalize();
        const location = cartesianToLatLonElevation(terminator, 1);
        this.controls.setLocation(location.latitudeDeg, location.longitudeDeg, altitudeM);
      },
      setSimulationUtc: (utcIso, rate = this.simulationRate) => {
        const epoch = new Date(utcIso);
        if (!Number.isFinite(epoch.getTime())) throw new RangeError(`Invalid simulation UTC: ${utcIso}`);
        if (!Number.isFinite(rate)) throw new RangeError(`Invalid simulation rate: ${rate}`);
        this.simulationStartUtc = epoch;
        this.simulationStartPerformance = performance.now();
        this.simulationRate = rate;
        this.skyState = calculateMarsSky(epoch);
        this.lastSkyUpdate = -Infinity;
      },
    };
    this.renderer.setAnimationLoop(this.animate);
  }

  private resize() {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, RENDER_CONFIG.maxDevicePixelRatio) * this.qualityScale;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.skyCamera.aspect = width / height;
    this.skyCamera.updateProjectionMatrix();
  }

  private animate = (time: number) => {
    if (this.disposed || this.paused) return;
    const deltaSeconds = Math.min(0.1, Math.max(0.001, (time - this.lastFrameTime) / 1000));
    this.lastFrameTime = time;
    const frameMs = deltaSeconds * 1000;
    this.smoothedFrameMs += (frameMs - this.smoothedFrameMs) * 0.06;
    this.framesSinceQualityChange += 1;
    this.controlState = this.controls.update(deltaSeconds);
    const simulationUtc = new Date(
      this.simulationStartUtc.getTime() + (time - this.simulationStartPerformance) * this.simulationRate,
    );
    if (time - this.lastSkyUpdate > 250) {
      this.skyState = calculateMarsSky(simulationUtc);
      this.lastSkyUpdate = time;
    }
    const cameraDirection = this.controlState.cameraDirection;
    const daylight = clamp(
      cameraDirection.x * this.skyState.sunDirection.x +
        cameraDirection.y * this.skyState.sunDirection.y +
        cameraDirection.z * this.skyState.sunDirection.z,
      0,
      1,
    );
    this.updateSurfaceShadows(daylight);
    const viewport = this.renderer.getDrawingBufferSize(this.viewportSize);
    const terrainStats = this.terrain.update(
      this.controlState.cameraAbsolute,
      this.camera,
      viewport.y,
      time / 1000,
      this.controlState.altitudeM,
      this.skyState.sunDirection,
      this.debug,
    );
    this.surfaceDetails.update(
      this.controlState.cameraAbsolute,
      this.controlState.cameraDirection,
      this.controlState.altitudeM,
    );
    this.atmosphere.update(this.controlState.cameraAbsolute, this.controlState.altitudeM, this.skyState.sunDirection);
    this.updateSelection();
    this.skyCamera.quaternion.copy(this.camera.quaternion);
    this.skyCamera.updateMatrixWorld(true);
    this.celestial.update(
      this.skyState,
      viewport.y,
      THREE.MathUtils.degToRad(this.skyCamera.fov),
      this.renderer.getPixelRatio(),
      this.controlState.altitudeM,
      this.controlState.cameraDirection,
      daylight,
    );

    this.renderer.info.reset();
    this.renderer.clear(true, true, true);
    this.renderer.render(this.celestial.scene, this.skyCamera);
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.camera);
    if (time - this.lastTelemetryTime > 100) {
      this.emitTelemetry(simulationUtc, terrainStats);
      this.lastTelemetryTime = time;
    }
    this.adjustQuality();
  };

  private emitTelemetry(simulationUtc: Date, terrainStats: TerrainFrameStats) {
    const focusCoordinates = cartesianToLatLonElevation(this.controlState.focusDirection, 1);
    const surface = this.terrain.sampleSurface(this.controlState.focusDirection);
    const groundWidth = Math.max(
      0.01,
      2 * Math.max(this.controlState.cameraDistanceM, 0.1) *
        Math.tan(THREE.MathUtils.degToRad(this.camera.fov) * 0.5) * this.camera.aspect,
    );
    this.telemetry = {
      latitudeDeg: focusCoordinates.latitudeDeg,
      longitudeDeg: focusCoordinates.longitudeDeg,
      altitudeM: this.controlState.altitudeM,
      elevationM: surface.areoidElevationM,
      groundWidthM: groundWidth,
      activeTiles: terrainStats.activeTiles,
      loadingTiles: terrainStats.loadingTiles,
      queuedTiles: terrainStats.queuedTiles,
      minLod: terrainStats.minLod,
      maxLod: terrainStats.maxLod,
      triangles: terrainStats.triangles,
      drawCalls: this.renderer.info.render.calls,
      textureMemoryMb: terrainStats.tileDataBytes / (1024 * 1024),
      geometryMemoryMb: terrainStats.geometryBytes / (1024 * 1024),
      workerQueue: terrainStats.workerQueue,
      terrainNodes: terrainStats.nodeCount,
      horizonCulled: terrainStats.horizonCulled,
      depthStrategy: this.depthStrategy,
      surfaceShadows: this.surfaceShadowsEnabled,
      shadowExtentM: this.surfaceShadowExtentM,
      nearM: this.controlState.nearM,
      farM: this.controlState.farM,
      floatingOrigin: { ...this.controlState.cameraAbsolute },
      frameMs: this.smoothedFrameMs,
      fps: 1000 / Math.max(0.01, this.smoothedFrameMs),
      simulationUtc: simulationUtc.toISOString(),
    };
    this.onTelemetry(this.telemetry);
  }

  private updateSurfaceShadows(daylight: number) {
    const altitudeM = this.controlState.altitudeM;
    const enabled = altitudeM <= RENDER_CONFIG.surfaceShadowMaxAltitudeM && daylight > 0.01;
    this.surfaceShadowsEnabled = enabled;
    this.sunShadowLight.castShadow = enabled;
    if (!enabled) {
      this.surfaceShadowExtentM = 0;
      return;
    }

    const extentM = clamp(800 + altitudeM * 2.2, 800, 120_000);
    this.surfaceShadowExtentM = extentM;
    const snap = snappedDirectionalShadowCenter(
      this.controlState.cameraAbsolute,
      this.skyState.sunDirection,
      extentM,
      RENDER_CONFIG.surfaceShadowMapSize,
      this.shadowSnap,
    );
    this.shadowSun.set(snap.sun.x, snap.sun.y, snap.sun.z);
    this.sunShadowTarget.position.set(snap.centerRelative.x, snap.centerRelative.y, snap.centerRelative.z);
    const lightDistanceM = extentM * 2.5 + 60_000;
    this.sunShadowLight.position.copy(this.sunShadowTarget.position).addScaledVector(this.shadowSun, lightDistanceM);

    const shadowCamera = this.sunShadowLight.shadow.camera;
    shadowCamera.left = -extentM;
    shadowCamera.right = extentM;
    shadowCamera.top = extentM;
    shadowCamera.bottom = -extentM;
    shadowCamera.near = 1;
    shadowCamera.far = lightDistanceM * 2;
    shadowCamera.updateProjectionMatrix();
    this.sunShadowTarget.updateMatrixWorld(true);
    this.sunShadowLight.updateMatrixWorld(true);
  }

  private adjustQuality() {
    if (!RENDER_CONFIG.adaptiveResolution || this.framesSinceQualityChange < 240) return;
    let next = this.qualityScale;
    if (this.smoothedFrameMs > 22 && next > 0.72) next = Math.max(0.72, next - 0.1);
    else if (this.smoothedFrameMs < 15.2 && next < 1) next = Math.min(1, next + 0.05);
    if (next !== this.qualityScale) {
      this.qualityScale = next;
      this.framesSinceQualityChange = 0;
      this.resize();
    }
  }

  private onSelectionPointerDown = (event: PointerEvent) => {
    if (event.button === 0) this.pointerDown = { x: event.clientX, y: event.clientY };
  };

  private onSelectionPointerUp = (event: PointerEvent) => {
    if (event.button !== 0 || !this.pointerDown) return;
    const moved = Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y);
    this.pointerDown = null;
    if (moved > 5 || !this.controlState) return;
    const bounds = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * 2 - 1,
      -((event.clientY - bounds.top) / Math.max(1, bounds.height)) * 2 + 1,
    );
    const direction = new THREE.Vector3(ndc.x, ndc.y, 0.4).unproject(this.camera).normalize();
    const hit = rayTerrainIntersection(this.controlState.cameraAbsolute, direction, (sampleDirection) => this.terrain.sampleHeight(sampleDirection));
    if (!hit) return;
    this.selectionDirection = new THREE.Vector3(hit.direction.x, hit.direction.y, hit.direction.z);
    void this.terrain.prefetch(this.selectionDirection);
  };

  private updateSelection() {
    if (!this.selectionDirection) {
      this.selection.visible = false;
      return;
    }
    const direction = this.selectionDirection;
    const height = this.terrain.sampleHeight(direction);
    const radius = MARS_REFERENCE_RADIUS_M + height;
    const markerSize = clamp(this.controlState.altitudeM * 0.012, 2.5, 160_000);
    this.selection.position.set(
      direction.x * (radius + Math.max(0.4, markerSize * 0.002)) - this.controlState.cameraAbsolute.x,
      direction.y * (radius + Math.max(0.4, markerSize * 0.002)) - this.controlState.cameraAbsolute.y,
      direction.z * (radius + Math.max(0.4, markerSize * 0.002)) - this.controlState.cameraAbsolute.z,
    );
    this.selection.quaternion.setFromUnitVectors(this.selectionReferenceNormal, direction);
    this.selection.scale.setScalar(markerSize);
    this.selection.visible = true;
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.code === "F3") {
      event.preventDefault();
      this.debug.overlay = !this.debug.overlay;
    } else if (event.code === "F4") {
      event.preventDefault();
      this.debug.tileBoundaries = !this.debug.tileBoundaries;
    }
  };

  private onContextLost = (event: Event) => {
    event.preventDefault();
    this.paused = true;
    this.onError("Graphics context was interrupted. Restoring Mars…");
  };

  private onContextRestored = () => {
    this.paused = false;
    this.lastFrameTime = performance.now();
    this.onError(null);
    this.renderer.setAnimationLoop(this.animate);
  };

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.surfaceDetails.dispose();
    this.terrain.dispose();
    this.atmosphere.dispose();
    this.celestial.dispose();
    this.selection.removeFromParent();
    this.selection.geometry.dispose();
    this.selection.material.dispose();
    this.sunShadowLight.removeFromParent();
    this.sunShadowTarget.removeFromParent();
    this.sunShadowLight.shadow.dispose();
    this.renderer.dispose();
    this.canvas.removeEventListener("pointerdown", this.onSelectionPointerDown);
    this.canvas.removeEventListener("pointerup", this.onSelectionPointerUp);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    window.removeEventListener("keydown", this.onKeyDown);
    if (window.__BARSOOM__) delete window.__BARSOOM__;
  }
}
