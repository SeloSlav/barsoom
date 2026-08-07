import * as THREE from "three";
import { BarsoomAudio } from "../audio/BarsoomAudio";
import { emitSovaTutorial } from "../tutorials/sova";
import { MAX_CAMERA_ALTITUDE_M, MARS_REFERENCE_RADIUS_M, RENDER_CONFIG } from "./constants";
import { calculateMarsSky, chooseOrbitalSurveyComposition, type MarsMoonState, type MarsSkyState } from "./ephemeris";
import { findMarsLandmarkAtDirection, landmarkDirection, MARS_LANDMARKS, type MarsLandmark } from "./landmarks";
import { cartesianToLatLonElevation, clamp, directionalShadowExtentM, latLonElevationToCartesian, nextAdaptiveResolutionScale, rayTerrainIntersection, snappedDirectionalShadowCenter, type DirectionalShadowSnap } from "./math";
import { PlanetControls, type PlanetControlState } from "./PlanetControls";
import { AtmosphereRenderer } from "./render/AtmosphereRenderer";
import { CelestialRenderer } from "./render/CelestialRenderer";
import { LocalLightingPhaseLock } from "./render/LocalLightingPhaseLock";
import { MoonRenderer } from "./render/MoonRenderer";
import { RetiredRoverRenderer } from "./render/RetiredRoverRenderer";
import { SurfaceDetailRenderer } from "./render/SurfaceDetailRenderer";
import { selectionReticleWorldScale } from "./selectionReticle";
import { randomMarsDaylightDirection, SurfaceTraverseController } from "./SurfaceTraverseController";
import { PlanetTerrain, type TerrainFrameStats } from "./terrain/PlanetTerrain";
import type { DebugFlags, PlanetTelemetry, SurfaceQuery } from "./types";

export type ObservedBody = "Mars" | MarsMoonState["name"];

export type MarsLandmarkHover = Pick<
  MarsLandmark,
  "id" | "name" | "featureType" | "latitudeDeg" | "longitudeDeg" | "kind"
> & { x: number; y: number };

export type MarsLandmarkMarker = Pick<MarsLandmark, "id" | "name"> & {
  kind: MarsLandmark["kind"];
  x: number;
  y: number;
  radiusPx: number;
};

type SurfaceSelectionPosition = {
  x: number;
  y: number;
  landmarkName?: string;
  landmarkKind?: MarsLandmark["kind"];
};

export type PlanetEngineApi = {
  getState: () => ReturnType<PlanetControls["getState"]> & { telemetry: PlanetTelemetry | null; controlMode: "survey" | "surface"; observedBody: ObservedBody };
  getSpacemanLocation: () => { latitudeDeg: number; longitudeDeg: number; headingRad: number } | null;
  setLocation: (latitudeDeg: number, longitudeDeg: number, altitudeM?: number) => void;
  setAltitude: (altitudeM: number, immediate?: boolean) => void;
  setDebug: (flag: keyof DebugFlags, value: boolean) => void;
  getDebug: () => DebugFlags;
  querySurface: (latitudeDeg: number, longitudeDeg: number) => Promise<SurfaceQuery>;
  setNightSide: (altitudeM?: number) => void;
  setTerminator: (altitudeM?: number) => void;
  setSimulationUtc: (utcIso: string, rate?: number) => void;
  instantiateObserver: () => void;
  instantiateObserverAt: (latitudeDeg: number, longitudeDeg: number, headingRad?: number) => void;
  teleportRandomSurface: () => void;
  exitSurfaceTraverse: () => void;
  getAudioMuted: () => boolean;
  setAudioMuted: (muted: boolean) => void;
  setNarrationActive: (active: boolean) => void;
  focusBody: (body: ObservedBody) => void;
};

declare global {
  interface Window {
    __BARSOOM__?: PlanetEngineApi;
  }
}

const MOON_CAMERA_STANDOFF_RADII = 3.1;

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
  private readonly moons: MoonRenderer;
  private readonly surfaceDetails: SurfaceDetailRenderer;
  private readonly retiredRovers: RetiredRoverRenderer;
  private readonly localLightingPhaseLock = new LocalLightingPhaseLock();
  private readonly surfaceTraverse: SurfaceTraverseController;
  private readonly audio: BarsoomAudio;
  private readonly resizeObserver: ResizeObserver;
  private readonly selection: THREE.Group;
  private readonly viewportSize = new THREE.Vector2();
  private readonly selectionReferenceNormal = new THREE.Vector3(0, 0, 1);
  private readonly landmarkDirections = new Map(
    MARS_LANDMARKS.map((landmark) => {
      const direction = landmarkDirection(landmark);
      return [landmark.id, new THREE.Vector3(direction.x, direction.y, direction.z)] as const;
    }),
  );
  private readonly moonCameraAbsolute = new THREE.Vector3();
  private readonly moonFocusDirection = new THREE.Vector3();
  private readonly moonFocusAbsolute = new THREE.Vector3();
  private readonly moonOrbitDirection = new THREE.Vector3();
  private readonly moonFrameRight = new THREE.Vector3();
  private readonly moonFrameUp = new THREE.Vector3();
  private readonly moonTangent = new THREE.Vector3();
  private readonly moonTargetRelative = new THREE.Vector3();
  private readonly moonViewUp = new THREE.Vector3();
  private selectionDirection: THREE.Vector3 | null = null;
  private selectionHeadingRad: number | undefined;
  private pointerDown: { x: number; y: number } | null = null;
  private landmarkPointerDownId: string | null = null;
  private hoveredLandmarkId: string | null = null;
  private lastLandmarkMarkerTime = -Infinity;
  private landmarkMarkerSignature = "";
  private controlState!: PlanetControlState;
  private skyState: MarsSkyState;
  private simulationStartUtc: Date;
  private simulationStartPerformance: number;
  private simulationRate: number;
  private lastFrameTime = performance.now();
  private lastTelemetryTime = -Infinity;
  private smoothedFrameMs = 16.67;
  private framesSinceQualityChange = 0;
  private qualityScale = 1;
  private surfaceShadowsEnabled = false;
  private surfaceShadowExtentM = 0;
  private paused = false;
  private disposed = false;
  private surfaceEntryRevision = 0;
  private observedBody: ObservedBody = "Mars";
  private moonOrbitYawRad = 0;
  private moonOrbitPitchRad = 0;
  private moonPanX = 0;
  private moonPanY = 0;
  private moonStandoffRadii = MOON_CAMERA_STANDOFF_RADII;
  private moonDrag: { id: number; button: number; lastX: number; lastY: number } | null = null;
  private telemetry: PlanetTelemetry | null = null;
  private debug: DebugFlags = {
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
    private readonly onSelectionChange: (position: SurfaceSelectionPosition | null) => void = () => {},
    private readonly onLandmarkHoverChange: (landmark: MarsLandmarkHover | null) => void = () => {},
    private readonly onLandmarkMarkersChange: (markers: readonly MarsLandmarkMarker[]) => void = () => {},
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
    this.renderer.toneMappingExposure = 1.18;
    this.renderer.shadowMap.enabled = true;
    // r185 maps the removed PCFSoft mode to PCF and logs every surface entry.
    // Select the effective mode directly so the render path stays warning-free.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
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
    this.audio = new BarsoomAudio();

    this.sunShadowLight.name = "Mars local directional sunlight shadows";
    this.sunShadowTarget.name = "Mars shadow-map snapped target";
    this.sunShadowLight.target = this.sunShadowTarget;
    this.sunShadowLight.castShadow = false;
    this.sunShadowLight.shadow.mapSize.set(RENDER_CONFIG.surfaceShadowMapSize, RENDER_CONFIG.surfaceShadowMapSize);
    this.sunShadowLight.shadow.bias = -0.00012;
    this.sunShadowLight.shadow.normalBias = 0.12;
    this.sunShadowLight.shadow.radius = 1.35;
    this.sunShadowLight.shadow.intensity = 0.88;
    this.scene.add(this.sunShadowTarget, this.sunShadowLight);

    this.skyState = calculateMarsSky(this.simulationStartUtc);
    this.terrain = new PlanetTerrain(this.scene);
    this.surfaceDetails = new SurfaceDetailRenderer(
      this.scene,
      (direction) => this.terrain.sampleVisibleRenderedSurface(direction),
    );
    this.retiredRovers = new RetiredRoverRenderer(
      this.scene,
      (direction) => this.terrain.sampleVisibleRenderedSurface(direction),
    );
    this.controls = new PlanetControls(
      canvas,
      this.camera,
      (direction) => this.terrain.sampleHeight(direction),
      (direction) => void this.terrain.prefetch(direction),
    );
    this.surfaceTraverse = new SurfaceTraverseController(
      this.scene,
      canvas,
      this.camera,
      (direction) => this.terrain.sampleRenderedSurface(direction),
      (direction) => void this.terrain.prefetch(direction),
      (message) => this.onError(message),
      (event) => this.audio.handleTraverseEvent(event),
    );
    // Begin above the illuminated hemisphere for a legible first descent. The
    // simulation remains physically time-based; this only chooses the landing
    // point, it does not move the Sun or add a scene-wide fill light.
    const composition = chooseOrbitalSurveyComposition(this.skyState);
    const initialPoint = cartesianToLatLonElevation(composition.focusDirection, 1);
    this.controls.setLocation(initialPoint.latitudeDeg, initialPoint.longitudeDeg, 10_000_000);
    this.atmosphere = new AtmosphereRenderer(this.scene);
    this.celestial = new CelestialRenderer(this.skyCamera);
    this.moons = new MoonRenderer(this.scene, this.camera, this.skyState.moons);
    // Submit both cameras under one outer render call. Besides avoiding an
    // unnecessary renderer-state teardown, this keeps the path ready for a
    // single output stage on future renderers without changing scene order.
    this.scene.onBeforeRender = this.renderCelestialLayer;

    this.selection = new THREE.Group();
    const selectionGuideMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd1ad,
      transparent: true,
      opacity: 0.48,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const selectionAccentMaterial = new THREE.MeshBasicMaterial({
      color: 0xffa15f,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const outerRing = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 64), selectionGuideMaterial);
    const innerRing = new THREE.Mesh(new THREE.RingGeometry(0.33, 0.39, 48), selectionAccentMaterial);
    const horizontalGuide = new THREE.Mesh(new THREE.PlaneGeometry(2.56, 0.018), selectionGuideMaterial);
    const verticalGuide = new THREE.Mesh(new THREE.PlaneGeometry(0.018, 2.56), selectionGuideMaterial);
    const acquisitionPoint = new THREE.Mesh(new THREE.CircleGeometry(0.065, 16), selectionAccentMaterial);
    this.selection.add(horizontalGuide, verticalGuide, outerRing, innerRing, acquisitionPoint);
    this.selection.name = "Selected surface point";
    this.selection.visible = false;
    this.selection.traverse((object) => { object.renderOrder = 10_000; });
    this.scene.add(this.selection);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.resize();
    canvas.addEventListener("pointerdown", this.onSelectionPointerDown);
    canvas.addEventListener("pointermove", this.onLandmarkPointerMove);
    canvas.addEventListener("pointerleave", this.onLandmarkPointerLeave);
    canvas.addEventListener("pointerup", this.onSelectionPointerUp);
    canvas.addEventListener("pointerdown", this.onMoonPointerDown);
    canvas.addEventListener("pointermove", this.onMoonPointerMove);
    canvas.addEventListener("pointerup", this.onMoonPointerUp);
    canvas.addEventListener("pointercancel", this.onMoonPointerUp);
    canvas.addEventListener("wheel", this.onMoonWheel, { passive: false });
    canvas.addEventListener("webglcontextlost", this.onContextLost, false);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored, false);
    window.addEventListener("keydown", this.onKeyDown);
    window.__BARSOOM__ = {
      getState: () => ({
        ...this.controls.getState(),
        telemetry: this.telemetry,
        controlMode: this.surfaceTraverse.active ? "surface" : "survey",
        observedBody: this.observedBody,
      }),
      getSpacemanLocation: () => {
        if (!this.surfaceTraverse.active) return null;
        const coordinates = cartesianToLatLonElevation(this.surfaceTraverse.getSurfaceDirection(), 1);
        return {
          latitudeDeg: coordinates.latitudeDeg,
          longitudeDeg: coordinates.longitudeDeg,
          headingRad: this.surfaceTraverse.getHeadingRad(),
        };
      },
      setLocation: (latitudeDeg, longitudeDeg, altitudeM) => {
        if (this.surfaceTraverse.active) this.exitSurfaceTraverse();
        this.clearSelection();
        this.controls.setLocation(latitudeDeg, longitudeDeg, altitudeM);
      },
      setAltitude: (altitudeM, immediate) => {
        if (this.surfaceTraverse.active) this.exitSurfaceTraverse();
        this.controls.setAltitude(altitudeM, immediate);
      },
      setDebug: (flag, value) => { this.debug[flag] = value; },
      getDebug: () => ({ ...this.debug }),
      querySurface: (latitudeDeg, longitudeDeg) => {
        const direction = latLonElevationToCartesian(latitudeDeg, longitudeDeg, 0, 1);
        return this.terrain.querySurface(direction);
      },
      setNightSide: (altitudeM = 100) => {
        if (this.surfaceTraverse.active) this.exitSurfaceTraverse();
        this.clearSelection();
        const night = cartesianToLatLonElevation({
          x: -this.skyState.sunDirection.x,
          y: -this.skyState.sunDirection.y,
          z: -this.skyState.sunDirection.z,
        }, 1);
        this.controls.setLocation(night.latitudeDeg, night.longitudeDeg, altitudeM);
      },
      setTerminator: (altitudeM = 10_000_000) => {
        if (this.surfaceTraverse.active) this.exitSurfaceTraverse();
        this.clearSelection();
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
        this.localLightingPhaseLock.reset();
      },
      instantiateObserver: () => {
        if (!this.surfaceTraverse.active && this.selectionDirection) {
          void this.enterSurfaceTraverse(this.selectionDirection, this.selectionHeadingRad);
        }
      },
      instantiateObserverAt: (latitudeDeg, longitudeDeg, headingRad) => {
        if (this.surfaceTraverse.active) return;
        const target = latLonElevationToCartesian(latitudeDeg, longitudeDeg, 0, 1);
        void this.enterSurfaceTraverse(new THREE.Vector3(target.x, target.y, target.z), headingRad);
      },
      teleportRandomSurface: () => { void this.enterSurfaceTraverse(null); },
      exitSurfaceTraverse: () => this.exitSurfaceTraverse(),
      getAudioMuted: () => this.getAudioMuted(),
      setAudioMuted: (muted) => this.setAudioMuted(muted),
      setNarrationActive: (active) => this.audio.setNarrationActive(active),
      focusBody: (body) => this.focusBody(body),
    };
    this.renderer.setAnimationLoop(this.animate);
  }

  getAudioMuted() {
    return this.audio.isMuted();
  }

  setAudioMuted(muted: boolean) {
    this.audio.setMuted(muted);
  }

  private focusBody(body: ObservedBody) {
    this.observedBody = body;
    if (body === "Mars") {
      this.releaseMoonDrag();
      this.controls.setEnabled(true);
      return;
    }
    if (this.surfaceTraverse.active) this.exitSurfaceTraverse();
    this.controls.setEnabled(false);
    this.clearSelection();
    this.moonOrbitYawRad = 0;
    this.moonOrbitPitchRad = 0;
    this.moonPanX = 0;
    this.moonPanY = 0;
    this.moonStandoffRadii = MOON_CAMERA_STANDOFF_RADII;
  }

  private updateMoonObservation(body: MarsMoonState["name"]): PlanetControlState {
    const moon = this.skyState.moons.find((candidate) => candidate.name === body);
    if (!moon) {
      this.focusBody("Mars");
      return this.controls.update(0);
    }
    const radiusM = Math.max(...moon.semiAxesM);
    const standoffM = radiusM * this.moonStandoffRadii;
    this.moonFocusDirection.set(moon.positionM.x, moon.positionM.y, moon.positionM.z).normalize();
    this.moonViewUp.set(moon.orbitNormal.x, moon.orbitNormal.y, moon.orbitNormal.z).normalize();
    this.moonTangent.crossVectors(this.moonViewUp, this.moonFocusDirection).normalize();
    const cosPitch = Math.cos(this.moonOrbitPitchRad);
    this.moonOrbitDirection
      .copy(this.moonFocusDirection)
      .multiplyScalar(cosPitch * Math.cos(this.moonOrbitYawRad))
      .addScaledVector(this.moonTangent, cosPitch * Math.sin(this.moonOrbitYawRad))
      .addScaledVector(this.moonViewUp, Math.sin(this.moonOrbitPitchRad))
      .normalize();
    this.moonFrameRight.crossVectors(this.moonViewUp, this.moonOrbitDirection).normalize();
    this.moonFrameUp.crossVectors(this.moonOrbitDirection, this.moonFrameRight).normalize();
    this.moonFocusAbsolute
      .set(moon.positionM.x, moon.positionM.y, moon.positionM.z)
      .addScaledVector(this.moonFrameRight, this.moonPanX * radiusM)
      .addScaledVector(this.moonFrameUp, this.moonPanY * radiusM);
    this.moonCameraAbsolute
      .copy(this.moonFocusAbsolute)
      .addScaledVector(this.moonOrbitDirection, standoffM);
    this.moonTargetRelative.copy(this.moonOrbitDirection).multiplyScalar(-standoffM);
    this.camera.position.set(0, 0, 0);
    this.camera.up.copy(this.moonFrameUp);
    this.camera.lookAt(this.moonTargetRelative);
    this.camera.near = Math.max(1, radiusM * 0.002);
    this.camera.far = Math.max(50_000_000, this.moonCameraAbsolute.length() + 30_000_000);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    const altitudeM = Math.max(0, this.moonCameraAbsolute.length() - MARS_REFERENCE_RADIUS_M);
    return {
      cameraAbsolute: { x: this.moonCameraAbsolute.x, y: this.moonCameraAbsolute.y, z: this.moonCameraAbsolute.z },
      cameraDirection: { x: this.moonFocusDirection.x, y: this.moonFocusDirection.y, z: this.moonFocusDirection.z },
      focusDirection: { x: this.moonFocusDirection.x, y: this.moonFocusDirection.y, z: this.moonFocusDirection.z },
      focusAbsolute: { x: this.moonFocusAbsolute.x, y: this.moonFocusAbsolute.y, z: this.moonFocusAbsolute.z },
      altitudeM,
      desiredAltitudeM: altitudeM,
      cameraDistanceM: standoffM,
      nearM: this.camera.near,
      farM: this.camera.far,
    };
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
    this.audio.update(deltaSeconds);
    this.smoothedFrameMs += (frameMs - this.smoothedFrameMs) * 0.06;
    this.framesSinceQualityChange += 1;
    const marsControlState = this.surfaceTraverse.active
      ? this.surfaceTraverse.update(deltaSeconds)
      : this.controls.update(deltaSeconds);
    const simulationUtc = new Date(
      this.simulationStartUtc.getTime() + (time - this.simulationStartPerformance) * this.simulationRate,
    );
    // Keep the accelerated ephemeris continuous in orbit. Close to the surface
    // the reconstructed field is phase-locked instead: rotating a directional
    // shadow projection at 60x makes an otherwise stationary ground shimmer.
    this.skyState = calculateMarsSky(simulationUtc);
    this.controlState = this.observedBody === "Mars"
      ? marsControlState
      : this.updateMoonObservation(this.observedBody);
    const renderSkyState = this.localLightingPhaseLock.resolve(
      this.skyState,
      this.controlState.altitudeM <= RENDER_CONFIG.surfaceShadowMaxAltitudeM,
    );
    const cameraDirection = this.controlState.cameraDirection;
    const daylight = clamp(
      cameraDirection.x * renderSkyState.sunDirection.x +
        cameraDirection.y * renderSkyState.sunDirection.y +
        cameraDirection.z * renderSkyState.sunDirection.z,
      0,
      1,
    );
    this.updateSurfaceShadows(renderSkyState.sunDirection, daylight);
    const viewport = this.renderer.getDrawingBufferSize(this.viewportSize);
    const terrainStats = this.terrain.update(
      this.controlState.cameraAbsolute,
      this.controlState.focusDirection,
      this.camera,
      viewport.y,
      time / 1000,
      this.controlState.altitudeM,
      renderSkyState.sunDirection,
      this.debug,
    );
    this.surfaceDetails.update(
      this.controlState.cameraAbsolute,
      this.controlState.cameraDirection,
      this.controlState.altitudeM,
    );
    this.retiredRovers.update(this.controlState.cameraAbsolute, this.controlState.altitudeM);
    this.atmosphere.update(this.controlState.cameraAbsolute, this.controlState.altitudeM, renderSkyState.sunDirection);
    this.moons.update(this.skyState, this.controlState.cameraAbsolute);
    this.updateSelection();
    this.updateLandmarkMarkers(time);
    this.skyCamera.quaternion.copy(this.camera.quaternion);
    this.skyCamera.updateMatrixWorld(true);
    this.celestial.update(
      renderSkyState,
      viewport.y,
      THREE.MathUtils.degToRad(this.skyCamera.fov),
      this.renderer.getPixelRatio(),
      this.controlState.altitudeM,
      this.controlState.cameraDirection,
      daylight,
    );

    this.renderer.info.reset();
    this.renderer.render(this.scene, this.camera);
    if (time - this.lastTelemetryTime > 100) {
      this.emitTelemetry(simulationUtc, terrainStats);
      this.lastTelemetryTime = time;
    }
    this.adjustQuality();
  };

  private renderCelestialLayer = (renderer: THREE.WebGLRenderer) => {
    renderer.clear(true, true, true);
    renderer.render(this.celestial.scene, this.skyCamera);
    renderer.clearDepth();
  };

  private onMoonPointerDown = (event: PointerEvent) => {
    if (this.observedBody === "Mars" || (event.button !== 0 && event.button !== 1 && event.button !== 2)) return;
    event.preventDefault();
    this.moonDrag = { id: event.pointerId, button: event.button, lastX: event.clientX, lastY: event.clientY };
    this.canvas.setPointerCapture(event.pointerId);
  };

  private onMoonPointerMove = (event: PointerEvent) => {
    if (this.observedBody === "Mars" || !this.moonDrag || event.pointerId !== this.moonDrag.id) return;
    const deltaX = event.clientX - this.moonDrag.lastX;
    const deltaY = event.clientY - this.moonDrag.lastY;
    this.moonDrag.lastX = event.clientX;
    this.moonDrag.lastY = event.clientY;
    if (this.moonDrag.button === 0 || this.moonDrag.button === 1) {
      this.moonOrbitYawRad -= deltaX * 0.0042;
      this.moonOrbitPitchRad = clamp(this.moonOrbitPitchRad + deltaY * 0.0032, -1.2, 1.2);
      return;
    }
    const height = Math.max(1, this.canvas.clientHeight);
    const panUnitsPerPixel = 2 * this.moonStandoffRadii
      * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) * 0.5) / height;
    this.moonPanX -= deltaX * panUnitsPerPixel;
    this.moonPanY += deltaY * panUnitsPerPixel;
    const panLength = Math.hypot(this.moonPanX, this.moonPanY);
    if (panLength > 0.78) {
      this.moonPanX *= 0.78 / panLength;
      this.moonPanY *= 0.78 / panLength;
    }
  };

  private onMoonPointerUp = (event: PointerEvent) => {
    if (!this.moonDrag || event.pointerId !== this.moonDrag.id) return;
    this.releaseMoonDrag();
  };

  private releaseMoonDrag() {
    if (!this.moonDrag) return;
    if (this.canvas.hasPointerCapture(this.moonDrag.id)) this.canvas.releasePointerCapture(this.moonDrag.id);
    this.moonDrag = null;
  }

  private onMoonWheel = (event: WheelEvent) => {
    if (this.observedBody === "Mars") return;
    event.preventDefault();
    const modeScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Math.max(1, this.canvas.clientHeight) : 1;
    this.moonStandoffRadii = clamp(
      this.moonStandoffRadii * Math.exp(event.deltaY * modeScale * 0.0012),
      1.8,
      12,
    );
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
      desiredAltitudeM: this.controlState.desiredAltitudeM,
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
      controlMode: this.surfaceTraverse.active ? "surface" : "survey",
      surfaceReady: this.surfaceTraverse.surfaceReady,
    };
    this.onTelemetry(this.telemetry);
  }

  private updateSurfaceShadows(sunDirection: MarsSkyState["sunDirection"], daylight: number) {
    const altitudeM = this.controlState.altitudeM;
    const enabled = altitudeM <= RENDER_CONFIG.surfaceShadowMaxAltitudeM && daylight > 0.01;
    this.surfaceShadowsEnabled = enabled;
    this.sunShadowLight.castShadow = enabled;
    if (!enabled) {
      this.surfaceShadowExtentM = 0;
      return;
    }

    const extentM = directionalShadowExtentM(
      altitudeM,
      this.surfaceTraverse.active,
      this.controlState.cameraDistanceM,
    );
    this.surfaceShadowExtentM = extentM;
    const snap = snappedDirectionalShadowCenter(
      this.controlState.cameraAbsolute,
      sunDirection,
      extentM,
      RENDER_CONFIG.surfaceShadowMapSize,
      this.shadowSnap,
    );
    // Match the receiver offset to the world-space texel size. A constant
    // 0.8 m offset detached the close astronaut shadow from the boots, while
    // a tiny constant is insufficient for kilometre-scale survey shadows.
    this.sunShadowLight.shadow.normalBias = clamp(snap.texelWorldM * 0.18, 0.12, 2);
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
    if (!RENDER_CONFIG.adaptiveResolution) return;
    if (this.surfaceTraverse.active) {
      // Resizing a live WebGL drawing buffer can expose its cleared backing
      // store for one presentation. Keep a single allocation throughout each
      // spaceman session; survey mode may resume adapting after a fresh dwell.
      this.framesSinceQualityChange = 0;
      return;
    }
    if (this.framesSinceQualityChange < 240) return;
    const next = nextAdaptiveResolutionScale(this.qualityScale, this.smoothedFrameMs, true);
    if (next !== this.qualityScale) {
      this.qualityScale = next;
      this.framesSinceQualityChange = 0;
      this.resize();
    }
  }

  private onSelectionPointerDown = (event: PointerEvent) => {
    if (this.surfaceTraverse.active || this.observedBody !== "Mars") return;
    if (event.button === 0) {
      this.pointerDown = { x: event.clientX, y: event.clientY };
      this.landmarkPointerDownId = this.findLandmarkHit(event.clientX, event.clientY)?.landmark.id ?? null;
    } else if (event.button === 2) {
      this.clearSelection();
    }
  };

  private onSelectionPointerUp = (event: PointerEvent) => {
    if (this.surfaceTraverse.active || this.observedBody !== "Mars") return;
    if (event.button !== 0 || !this.pointerDown) return;
    const moved = Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y);
    this.pointerDown = null;
    const landmarkHit = moved <= 5 ? this.findLandmarkHit(event.clientX, event.clientY) : null;
    const landmarkClicked = landmarkHit && landmarkHit.landmark.id === this.landmarkPointerDownId
      ? landmarkHit
      : null;
    this.landmarkPointerDownId = null;
    if (moved > 5) return;
    if (landmarkClicked) {
      const { landmark } = landmarkClicked;
      this.clearLandmarkHover();
      const landingDirection = landmark.landingLatitudeDeg !== undefined && landmark.landingLongitudeDeg !== undefined
        ? latLonElevationToCartesian(landmark.landingLatitudeDeg, landmark.landingLongitudeDeg, 0, 1)
        : landmarkDirection(landmark);
      this.lockSurfaceSelection(
        new THREE.Vector3(
          landingDirection.x,
          landingDirection.y,
          landingDirection.z,
        ),
        event.clientX,
        event.clientY,
        landmark.name,
        landmark.kind,
        landmark.headingRad,
      );
      return;
    }
    if (this.selectionDirection) {
      this.clearSelection();
      return;
    }
    if (!this.controlState) return;
    const bounds = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * 2 - 1,
      -((event.clientY - bounds.top) / Math.max(1, bounds.height)) * 2 + 1,
    );
    const direction = new THREE.Vector3(ndc.x, ndc.y, 0.4).unproject(this.camera).normalize();
    const hit = rayTerrainIntersection(this.controlState.cameraAbsolute, direction, (sampleDirection) => this.terrain.sampleHeight(sampleDirection));
    if (!hit) return;
    this.lockSurfaceSelection(
      new THREE.Vector3(hit.direction.x, hit.direction.y, hit.direction.z),
      event.clientX,
      event.clientY,
    );
  };

  private lockSurfaceSelection(
    direction: THREE.Vector3,
    x: number,
    y: number,
    landmarkName?: string,
    landmarkKind?: MarsLandmark["kind"],
    headingRad?: number,
  ) {
    this.selectionDirection = direction.normalize();
    this.selectionHeadingRad = headingRad;
    this.controls.setZoomAnchor(this.selectionDirection);
    this.onSelectionChange({ x, y, landmarkName, landmarkKind });
    this.audio.playPhaseLock();
    emitSovaTutorial("surface");
    void this.terrain.prefetch(this.selectionDirection);
  }

  private onLandmarkPointerMove = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    if (this.selectionDirection) {
      this.clearLandmarkHover();
      return;
    }
    const hit = this.findLandmarkHit(event.clientX, event.clientY);
    if (!hit) {
      this.clearLandmarkHover();
      return;
    }
    const { landmark } = hit;
    this.hoveredLandmarkId = landmark.id;
    this.onLandmarkHoverChange({
      id: landmark.id,
      name: landmark.name,
      featureType: landmark.featureType,
      latitudeDeg: landmark.latitudeDeg,
      longitudeDeg: landmark.longitudeDeg,
      kind: landmark.kind,
      x: event.clientX,
      y: event.clientY,
    });
  };

  private onLandmarkPointerLeave = () => {
    this.clearLandmarkHover();
  };

  private findLandmarkHit(clientX: number, clientY: number) {
    if (!this.controlState || this.surfaceTraverse.active || this.observedBody !== "Mars") return null;
    const bounds = this.canvas.getBoundingClientRect();
    if (
      clientX < bounds.left || clientX > bounds.right ||
      clientY < bounds.top || clientY > bounds.bottom
    ) return null;

    const ndc = new THREE.Vector2(
      ((clientX - bounds.left) / Math.max(1, bounds.width)) * 2 - 1,
      -((clientY - bounds.top) / Math.max(1, bounds.height)) * 2 + 1,
    );
    const ray = new THREE.Vector3(ndc.x, ndc.y, 0.4).unproject(this.camera).normalize();
    const surfaceHit = rayTerrainIntersection(
      this.controlState.cameraAbsolute,
      ray,
      (sampleDirection) => this.terrain.sampleHeight(sampleDirection),
    );
    if (!surfaceHit) return null;

    const geographicHit = findMarsLandmarkAtDirection(surfaceHit.direction);
    let closest = geographicHit
      ? { landmark: geographicHit.landmark, score: geographicHit.angularDistanceRad / geographicHit.radiusRad }
      : null;

    // Small craters would be nearly impossible to discover at planetary scale
    // using their physical footprint alone. Give every visible named feature a
    // modest screen-space acquisition radius while retaining geographic hit
    // regions for broad provinces and basins.
    const pointerX = clientX - bounds.left;
    const pointerY = clientY - bounds.top;
    for (const landmark of MARS_LANDMARKS) {
      const projected = this.projectLandmark(landmark, bounds);
      if (!projected) continue;
      const pixelRadius = Math.max(34, projected.radiusPx);
      const score = Math.hypot(pointerX - projected.localX, pointerY - projected.localY) / pixelRadius;
      if (score <= 1 && (!closest || score < closest.score)) closest = { landmark, score };
    }
    return closest ? { ...closest, surfaceDirection: surfaceHit.direction } : null;
  }

  private projectLandmark(landmark: MarsLandmark, bounds: DOMRect) {
    const direction = this.landmarkDirections.get(landmark.id);
    if (!direction) return null;
    const radius = MARS_REFERENCE_RADIUS_M + this.terrain.sampleHeight(direction);
    const absolute = direction.clone().multiplyScalar(radius);
    const relative = absolute.clone().sub(this.controlState.cameraAbsolute);
    const toCamera = relative.clone().multiplyScalar(-1);
    if (direction.dot(toCamera) <= 0) return null;
    const distanceM = relative.length();
    const projected = relative.project(this.camera);
    if (projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1) return null;
    const localX = (projected.x * 0.5 + 0.5) * bounds.width;
    const localY = (-projected.y * 0.5 + 0.5) * bounds.height;
    const metresPerPixel = 2 * Math.max(1, distanceM)
      * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) * 0.5)
      / Math.max(1, bounds.height);
    return {
      localX,
      localY,
      x: bounds.left + localX,
      y: bounds.top + localY,
      radiusPx: clamp(landmark.hoverRadiusKm * 1_000 / metresPerPixel, 12, 46),
    };
  }

  private updateLandmarkMarkers(time: number) {
    if (time - this.lastLandmarkMarkerTime < 40) return;
    this.lastLandmarkMarkerTime = time;
    const markers: MarsLandmarkMarker[] = [];
    if (!this.surfaceTraverse.active && this.observedBody === "Mars") {
      const bounds = this.canvas.getBoundingClientRect();
      for (const landmark of MARS_LANDMARKS) {
        const projected = this.projectLandmark(landmark, bounds);
        if (!projected) continue;
        markers.push({
          id: landmark.id,
          name: landmark.name,
          kind: landmark.kind,
          x: projected.x,
          y: projected.y,
          radiusPx: projected.radiusPx,
        });
      }
    }
    const signature = markers
      .map((marker) => `${marker.id}:${Math.round(marker.x)}:${Math.round(marker.y)}:${Math.round(marker.radiusPx)}`)
      .join("|");
    if (signature === this.landmarkMarkerSignature) return;
    this.landmarkMarkerSignature = signature;
    this.onLandmarkMarkersChange(markers);
  }

  private clearLandmarkHover() {
    if (this.hoveredLandmarkId === null) return;
    this.hoveredLandmarkId = null;
    this.onLandmarkHoverChange(null);
  }

  private updateSelection() {
    if (this.surfaceTraverse.active || this.observedBody !== "Mars") {
      this.selection.visible = false;
      return;
    }
    if (!this.selectionDirection) {
      this.selection.visible = false;
      return;
    }
    const direction = this.selectionDirection;
    const height = this.terrain.sampleHeight(direction);
    const radius = MARS_REFERENCE_RADIUS_M + height;
    this.selection.position.set(
      direction.x * radius - this.controlState.cameraAbsolute.x,
      direction.y * radius - this.controlState.cameraAbsolute.y,
      direction.z * radius - this.controlState.cameraAbsolute.z,
    );
    const markerSize = selectionReticleWorldScale(
      this.selection.position.length(),
      this.canvas.clientHeight,
      THREE.MathUtils.degToRad(this.camera.fov),
    );
    this.selection.position.addScaledVector(direction, Math.max(0.4, markerSize * 0.002));
    this.selection.quaternion.setFromUnitVectors(this.selectionReferenceNormal, direction);
    this.selection.scale.setScalar(markerSize);
    this.selection.visible = true;
  }

  private clearSelection() {
    this.pointerDown = null;
    this.landmarkPointerDownId = null;
    this.selectionDirection = null;
    this.selectionHeadingRad = undefined;
    this.controls.setZoomAnchor(null);
    this.onSelectionChange(null);
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.code === "Backquote" && !event.repeat && this.observedBody === "Mars") {
      event.preventDefault();
      void this.enterSurfaceTraverse();
    } else if (event.code === "Escape" && this.surfaceTraverse.active) {
      event.preventDefault();
      this.exitSurfaceTraverse();
    } else if (event.code === "F4") {
      event.preventDefault();
      this.debug.tileBoundaries = !this.debug.tileBoundaries;
    }
  };

  private async enterSurfaceTraverse(
    targetDirection: THREE.Vector3 | null = this.selectionDirection,
    headingRad?: number,
  ) {
    const destination = targetDirection?.clone() ?? new THREE.Vector3().copy(
      randomMarsDaylightDirection(this.skyState.sunDirection),
    );
    const entryRevision = ++this.surfaceEntryRevision;
    this.controls.setEnabled(false);
    this.clearSelection();
    await this.terrain.prefetch(destination);
    if (this.disposed || entryRevision !== this.surfaceEntryRevision) return;
    this.surfaceTraverse.teleportTo(destination, headingRad);
    // A retargeted local field receives a fresh, internally coherent lighting
    // solution on its next frame, then remains stable at the new coordinate.
    this.localLightingPhaseLock.reset();
    this.audio.setSurfaceMode(true);
    this.audio.playObserverTransition(true);
    emitSovaTutorial("spaceman");
    this.lastTelemetryTime = -Infinity;
  }

  private exitSurfaceTraverse() {
    this.surfaceEntryRevision += 1;
    if (!this.surfaceTraverse.active) return;
    const direction = this.surfaceTraverse.getSurfaceDirection();
    const location = cartesianToLatLonElevation(direction, 1);
    this.surfaceTraverse.deactivate();
    this.localLightingPhaseLock.reset();
    this.audio.setSurfaceMode(false);
    this.audio.playObserverTransition(false);
    this.controls.setEnabled(true);
    this.clearSelection();
    this.controls.setLocation(location.latitudeDeg, location.longitudeDeg, MAX_CAMERA_ALTITUDE_M);
    this.lastTelemetryTime = -Infinity;
  }

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
    this.surfaceTraverse.dispose();
    this.surfaceDetails.dispose();
    this.retiredRovers.dispose();
    this.terrain.dispose();
    this.atmosphere.dispose();
    this.celestial.dispose();
    this.moons.dispose();
    this.scene.onBeforeRender = () => {};
    this.audio.dispose();
    this.selection.removeFromParent();
    const selectionMaterials = new Set<THREE.Material>();
    this.selection.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => selectionMaterials.add(material));
    });
    selectionMaterials.forEach((material) => material.dispose());
    this.sunShadowLight.removeFromParent();
    this.sunShadowTarget.removeFromParent();
    this.sunShadowLight.shadow.dispose();
    this.renderer.dispose();
    this.onLandmarkMarkersChange([]);
    this.canvas.removeEventListener("pointerdown", this.onSelectionPointerDown);
    this.canvas.removeEventListener("pointermove", this.onLandmarkPointerMove);
    this.canvas.removeEventListener("pointerleave", this.onLandmarkPointerLeave);
    this.canvas.removeEventListener("pointerup", this.onSelectionPointerUp);
    this.canvas.removeEventListener("pointerdown", this.onMoonPointerDown);
    this.canvas.removeEventListener("pointermove", this.onMoonPointerMove);
    this.canvas.removeEventListener("pointerup", this.onMoonPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onMoonPointerUp);
    this.canvas.removeEventListener("wheel", this.onMoonWheel);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    window.removeEventListener("keydown", this.onKeyDown);
    if (window.__BARSOOM__) delete window.__BARSOOM__;
  }
}
