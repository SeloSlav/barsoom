"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_CAMERA_ALTITUDE_M } from "../planet/constants";
import { calculateMarsOrbiters, isMarsOrbiterName, MARS_ORBITER_NAMES } from "../planet/ephemeris";
import {
  GRAPHICS_PRESETS,
  loadGraphicsPreference,
  pendingGraphicsState,
  saveGraphicsPreference,
  type GraphicsPreference,
  type GraphicsRuntimeState,
} from "../planet/graphicsSettings";
import {
  PlanetEngine,
  type MarsFlightNavigationMarker,
  type MarsLandmarkHover,
  type MarsLandmarkMarker,
  type MarsOrbitalMarker,
  type ObservedBody,
} from "../planet/PlanetEngine";
import { createSpacemanShareUrl, parseSpacemanShareLocation } from "../planet/shareLocation";
import { SIMULATION_RATES, type SimulationRate } from "../planet/simulationClock";
import type { PlanetTelemetry } from "../planet/types";
import type { MarsWeatherPreset } from "../planet/render/WeatherRenderer";
import { SovaTutorial } from "./SovaTutorial";

const SIMULATION_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const OBSERVATION_TARGETS: readonly ObservedBody[] = ["Mars", "Phobos", "Deimos", ...MARS_ORBITER_NAMES];
const GRAPHICS_OPTIONS: readonly GraphicsPreference[] = ["auto", "ultra", "high", "medium", "low"];
const WEATHER_OPTIONS: readonly MarsWeatherPreset[] = ["auto", "clear", "cloudy", "dust-storm"];

function weatherLabel(preset: MarsWeatherPreset) {
  if (preset === "dust-storm") return "DUST";
  if (preset === "cloudy") return "CLOUDS";
  return preset.toUpperCase();
}

function targetShortName(body: ObservedBody) {
  if (body === "Mars") return "BARSOOM";
  if (body === "Mars Reconnaissance Orbiter") return "MRO";
  if (body === "Mars Odyssey") return "ODYSSEY";
  if (body === "Trace Gas Orbiter") return "TGO";
  return body.toUpperCase();
}

function createInitialTelemetry(simulationUtc: string): PlanetTelemetry {
  return {
    latitudeDeg: 18.65, longitudeDeg: -133.8, altitudeM: 10_000_000, desiredAltitudeM: 10_000_000, elevationM: 0, groundWidthM: 0,
    activeTiles: 0, loadingTiles: 0, queuedTiles: 0, minLod: 0, maxLod: 0, triangles: 0, drawCalls: 0,
    textureMemoryMb: 0, geometryMemoryMb: 0, workerQueue: 0, terrainNodes: 6, horizonCulled: 0,
    depthStrategy: "logarithmic", surfaceShadows: false, shadowExtentM: 0,
    nearM: 1, farM: 50_000_000, floatingOrigin: { x: 0, y: 0, z: 0 },
    frameMs: 16.67, fps: 60, simulationUtc, controlMode: "survey", traverseMode: "spaceman", surfaceReady: true,
    shipDistanceM: null, shipCanBoard: false, shipSpeedMps: 0,
    shipAutoFlightMode: "off", shipAutopilotPhase: "idle", shipAutopilotTargetName: null,
  };
}

function formatSimulationUtc(simulationUtc: string) {
  const date = new Date(simulationUtc);
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${pad(date.getUTCDate())} ${SIMULATION_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function formatDistance(metres: number, decimals = 1) {
  if (Math.abs(metres) < 1) return `${metres.toFixed(2)} m`;
  const sign = metres < 0 ? "−" : "";
  const absolute = Math.abs(metres);
  if (absolute < 1_000) return `${sign}${absolute.toFixed(absolute < 10 ? 1 : 0)} m`;
  if (absolute < 1_000_000) return `${sign}${(absolute / 1_000).toFixed(decimals)} km`;
  return `${sign}${(absolute / 1_000_000).toFixed(2)} Mm`;
}

function formatCoordinate(value: number, positive: string, negative: string) {
  return `${Math.abs(value).toFixed(4)}° ${value >= 0 ? positive : negative}`;
}

type ObserverActionPosition = {
  x: number;
  y: number;
  landmarkName?: string;
  landmarkKind?: "terrain" | "retired-rover";
};
type FlightActionPosition = ObserverActionPosition & { marker: MarsFlightNavigationMarker };
type PresentedLandmark = MarsLandmarkHover & { labelX: number; labelY: number };

function positionObserverAction(
  x: number,
  y: number,
  landmarkName?: string,
  landmarkKind?: "terrain" | "retired-rover",
): ObserverActionPosition {
  const edgeGap = 12;
  const cardWidth = Math.min(264, window.innerWidth - edgeGap * 2);
  const cardHeight = 74;
  const targetGap = 20;
  const fitsToRight = x + targetGap + cardWidth <= window.innerWidth - edgeGap;
  return {
    x: fitsToRight ? x + targetGap : Math.max(edgeGap, x - targetGap - cardWidth),
    y: Math.min(Math.max(edgeGap, y - 18), window.innerHeight - cardHeight - edgeGap),
    landmarkName,
    landmarkKind,
  };
}

function positionLandmarkLabel(landmark: MarsLandmarkHover): PresentedLandmark {
  const edgeGap = 12;
  const labelGap = 22;
  const labelWidth = Math.min(286, window.innerWidth - edgeGap * 2);
  const labelHeight = 91;
  const fitsToRight = landmark.x + labelGap + labelWidth <= window.innerWidth - edgeGap;
  return {
    ...landmark,
    labelX: fitsToRight
      ? landmark.x + labelGap
      : Math.max(edgeGap, landmark.x - labelGap - labelWidth),
    labelY: Math.min(
      Math.max(edgeGap, landmark.y - labelHeight / 2),
      window.innerHeight - labelHeight - edgeGap,
    ),
  };
}

function positionFlightAction(marker: MarsFlightNavigationMarker): FlightActionPosition {
  return { ...positionObserverAction(marker.x, marker.y), marker };
}

async function copyTextToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    try {
      document.body.appendChild(textarea);
      textarea.select();
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      textarea.remove();
    }
  }
}

export function MarsExperience({ initialSimulationUtc }: { initialSimulationUtc: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bodyMenuRef = useRef<HTMLDivElement>(null);
  const rateMenuRef = useRef<HTMLDivElement>(null);
  const graphicsButtonRef = useRef<HTMLButtonElement>(null);
  const graphicsPanelRef = useRef<HTMLElement>(null);
  const [telemetry, setTelemetry] = useState<PlanetTelemetry>(() => createInitialTelemetry(initialSimulationUtc));
  const [error, setError] = useState<string | null>(null);
  const [helpVisible, setHelpVisible] = useState(false);
  const [tutorialLibraryVisible, setTutorialLibraryVisible] = useState(false);
  const [audioMuted, setAudioMuted] = useState(false);
  const [observerAction, setObserverAction] = useState<ObserverActionPosition | null>(null);
  const [hoveredLandmark, setHoveredLandmark] = useState<PresentedLandmark | null>(null);
  const [landmarkMarkers, setLandmarkMarkers] = useState<readonly MarsLandmarkMarker[]>([]);
  const [orbitalMarkers, setOrbitalMarkers] = useState<readonly MarsOrbitalMarker[]>([]);
  const [flightNavigationMarkers, setFlightNavigationMarkers] = useState<readonly MarsFlightNavigationMarker[]>([]);
  const [flightAction, setFlightAction] = useState<FlightActionPosition | null>(null);
  const [shareStatus, setShareStatus] = useState<"idle" | "copied" | "error">("idle");
  const [observedBody, setObservedBody] = useState<ObservedBody>("Mars");
  const [bodyMenuVisible, setBodyMenuVisible] = useState(false);
  const [simulationRate, setSimulationRate] = useState<SimulationRate>(60);
  const [rateMenuVisible, setRateMenuVisible] = useState(false);
  const [graphicsVisible, setGraphicsVisible] = useState(false);
  const [graphicsState, setGraphicsState] = useState<GraphicsRuntimeState>(() => pendingGraphicsState());
  const [weatherPreset, setWeatherPreset] = useState<MarsWeatherPreset>("auto");
  const shareStatusTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    let engine: PlanetEngine | null = null;
    try {
      engine = new PlanetEngine(
        canvasRef.current,
        setTelemetry,
        setError,
        initialSimulationUtc,
        (position) => setObserverAction(position ? positionObserverAction(
          position.x,
          position.y,
          position.landmarkName,
          position.landmarkKind,
        ) : null),
        (landmark) => setHoveredLandmark(landmark ? positionLandmarkLabel(landmark) : null),
        setLandmarkMarkers,
        setOrbitalMarkers,
        60,
        loadGraphicsPreference(),
        setGraphicsState,
        setObservedBody,
        (markers) => {
          setFlightNavigationMarkers(markers);
          setFlightAction((current) => current && !markers.some((marker) => (
            marker.id === current.marker.id && marker.kind === current.marker.kind
          )) ? null : current);
        },
      );
      setAudioMuted(engine.getAudioMuted());
      const sharedLocation = parseSpacemanShareLocation(window.location.search);
      if (sharedLocation) {
        window.__BARSOOM__?.instantiateObserverAt(
          sharedLocation.latitudeDeg,
          sharedLocation.longitudeDeg,
          sharedLocation.headingRad,
        );
      }
    } catch (caught) {
      engine?.dispose();
      const message = caught instanceof Error ? caught.message : "WebGL could not start on this device.";
      queueMicrotask(() => setError(message));
      return;
    }
    const keyHandler = (event: KeyboardEvent) => {
      if (event.code === "KeyH" && !event.ctrlKey && !event.metaKey) {
        setGraphicsVisible(false);
        setHelpVisible((visible) => !visible);
      }
    };
    window.addEventListener("keydown", keyHandler);
    return () => {
      window.removeEventListener("keydown", keyHandler);
      if (shareStatusTimeoutRef.current !== null) window.clearTimeout(shareStatusTimeoutRef.current);
      engine?.dispose();
    };
  }, [initialSimulationUtc]);

  useEffect(() => {
    if (!bodyMenuVisible && !rateMenuVisible && !graphicsVisible) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!bodyMenuRef.current?.contains(event.target as Node)) setBodyMenuVisible(false);
      if (!rateMenuRef.current?.contains(event.target as Node)) setRateMenuVisible(false);
      if (!graphicsPanelRef.current?.contains(event.target as Node) &&
          !graphicsButtonRef.current?.contains(event.target as Node)) setGraphicsVisible(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setBodyMenuVisible(false);
        setRateMenuVisible(false);
        setGraphicsVisible(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [bodyMenuVisible, graphicsVisible, rateMenuVisible]);

  const selectObservedBody = (body: ObservedBody) => {
    setObservedBody(body);
    setBodyMenuVisible(false);
    setRateMenuVisible(false);
    setGraphicsVisible(false);
    setHelpVisible(false);
    setTutorialLibraryVisible(false);
    setObserverAction(null);
    setHoveredLandmark(null);
    setLandmarkMarkers([]);
    setOrbitalMarkers([]);
    setFlightNavigationMarkers([]);
    setFlightAction(null);
    window.__BARSOOM__?.focusBody(body);
    canvasRef.current?.focus();
  };

  const selectSimulationRate = (rate: SimulationRate) => {
    setSimulationRate(rate);
    setRateMenuVisible(false);
    setGraphicsVisible(false);
    window.__BARSOOM__?.setSimulationRate(rate);
    canvasRef.current?.focus();
  };

  const engageSelectedFlightAutopilot = () => {
    if (!flightAction) return;
    const engaged = window.__BARSOOM__?.engageFlightAutopilot(
      flightAction.marker.kind,
      flightAction.marker.id,
    );
    if (engaged) setFlightAction(null);
    canvasRef.current?.focus();
  };

  const selectGraphicsPreference = (preference: GraphicsPreference) => {
    saveGraphicsPreference(preference);
    const next = window.__BARSOOM__?.setGraphicsPreference(preference);
    if (next) setGraphicsState(next);
  };

  const shareSpacemanLocation = async () => {
    const location = window.__BARSOOM__?.getSpacemanLocation();
    if (!location) return;
    const shareUrl = createSpacemanShareUrl(window.location.href, location);
    const copied = await copyTextToClipboard(shareUrl);
    setShareStatus(copied ? "copied" : "error");
    if (shareStatusTimeoutRef.current !== null) window.clearTimeout(shareStatusTimeoutRef.current);
    shareStatusTimeoutRef.current = window.setTimeout(() => setShareStatus("idle"), 2_400);
  };

  const simulationLabel = useMemo(() => formatSimulationUtc(telemetry.simulationUtc), [telemetry.simulationUtc]);
  const orbitalMode = observedBody !== "Mars";
  const moonMode = observedBody === "Phobos" || observedBody === "Deimos";
  const selectedOrbiter = useMemo(() => {
    if (!isMarsOrbiterName(observedBody)) return null;
    return calculateMarsOrbiters(new Date(telemetry.simulationUtc))
      .find((candidate) => candidate.name === observedBody) ?? null;
  }, [observedBody, telemetry.simulationUtc]);
  const surfaceMode = !orbitalMode && telemetry.controlMode === "surface";
  const surfaceSettling = surfaceMode && !telemetry.surfaceReady;
  const spaceshipMode = surfaceMode && telemetry.traverseMode === "spaceship";
  const shipIndicatorVisible = surfaceMode && !spaceshipMode && telemetry.shipDistanceM !== null && telemetry.shipDistanceM <= 36;
  const apertureFill = Math.max(1.5, Math.log10(telemetry.altitudeM + 1) / Math.log10(MAX_CAMERA_ALTITUDE_M + 1) * 100);
  const shipAutoFlightLabel = telemetry.shipAutopilotTargetName
    ? telemetry.shipAutopilotPhase === "landing"
      ? `AUTOLAND / ${telemetry.shipAutopilotTargetName.toUpperCase()}`
      : telemetry.shipAutopilotPhase === "braking" || telemetry.shipAutopilotPhase === "approach"
        ? `APPROACH / ${telemetry.shipAutopilotTargetName.toUpperCase()}`
        : `AUTOPILOT / ${telemetry.shipAutopilotTargetName.toUpperCase()}`
    : telemetry.shipAutoFlightMode === "full"
      ? "AUTO FLIGHT / FULL THRUST"
      : telemetry.shipAutoFlightMode === "cruise"
        ? "AUTO FLIGHT / CRUISE"
        : "SPACECRAFT FLIGHT";

  return (
    <main className={`mars-shell${surfaceMode ? " surface-traverse" : ""}${spaceshipMode ? " ship-flight" : ""}${orbitalMode ? " moon-lock" : ""}${hoveredLandmark ? " landmark-hover" : ""}`}>
      <canvas ref={canvasRef} className="mars-canvas" tabIndex={0} aria-label={spaceshipMode ? "Third-person free-flight spacecraft over Mars" : surfaceMode ? "Third-person astronaut traverse on Mars" : orbitalMode ? `Locked close-up rendering of ${observedBody}` : "Interactive three-dimensional rendering of Mars. Hover named features, retired rover sites, moons, and active orbiters; then click one to select it."} />
      <div className="hud-vignette" aria-hidden="true" />
      <div className="instrument-grid" aria-hidden="true" />
      {surfaceSettling && <div className="surface-entry-screen" role="status" aria-live="polite">
        <i aria-hidden="true" />
        <span>RESOLVING LOCAL FIELD</span>
        <small>TERRAIN PHASE CONVERGENCE</small>
      </div>}
      {surfaceMode && <aside className="surface-exit-hint" aria-label={spaceshipMode ? "Press Escape to rematerialize safely on the ground below with the spacecraft nearby." : "Spaceman mode remains active. Press Escape to exit."}>
        <span>{spaceshipMode ? shipAutoFlightLabel : "SPACEMAN MODE LOCKED"}</span>
        <strong><kbd>ESC</kbd> {spaceshipMode ? "GROUND REMATERIALIZE" : "TO EXIT"}</strong>
      </aside>}
      {shipIndicatorVisible && <aside className={`ship-board-indicator${telemetry.shipCanBoard ? " ready" : ""}`} aria-live={telemetry.shipCanBoard ? "polite" : "off"}>
        <span><i aria-hidden="true" /> SPACECRAFT {formatDistance(telemetry.shipDistanceM ?? 0)}</span>
        <strong>{telemetry.shipCanBoard ? <><kbd>E</kbd> BOARD SPACECRAFT</> : "APPROACH TO BOARD"}</strong>
      </aside>}
      {spaceshipMode && <div className="ship-flight-reticle" aria-hidden="true"><i /><span /></div>}
      {spaceshipMode && flightNavigationMarkers.length > 0 && <>
        <aside className="flight-nav-status" aria-label={`${flightNavigationMarkers.filter((marker) => marker.kind === "landmark" || marker.kind === "rover").length} surface destinations and ${flightNavigationMarkers.filter((marker) => marker.kind === "moon" || marker.kind === "orbiter").length} orbital destinations highlighted`}>
          <span>NAV / LOCAL + ORBITAL</span>
          <small><i className="surface" /> SURFACE <i className="orbital" /> ORBITAL</small>
        </aside>
        <div className="flight-nav-layer" aria-label="Spacecraft navigation highlights">
          {flightNavigationMarkers.map((marker, index) => <button
            key={`${marker.kind}-${marker.id}`}
            className={`flight-nav-marker ${marker.kind}${marker.edge ? ` offscreen edge-${marker.edge}` : " in-view"}${marker.occulted ? " occulted" : ""}${flightAction?.marker.id === marker.id && flightAction.marker.kind === marker.kind ? " selected" : ""}`}
            type="button"
            style={{
              left: marker.x,
              top: marker.y,
              animationDelay: `${-(index % 7) * 0.31}s`,
            }}
            onClick={(event) => {
              event.stopPropagation();
              setFlightAction(positionFlightAction(marker));
            }}
            aria-label={`${marker.name}, ${marker.featureType}, ${formatDistance(marker.rangeM, 0)} away${marker.edge ? ", outside the current view" : ""}. Plot autopilot course.`}
          >
            {marker.edge && <i className="flight-nav-pointer" style={{ transform: `rotate(${marker.angleRad}rad)` }} aria-hidden="true" />}
            <i className="flight-nav-sight" aria-hidden="true"><b /></i>
            <span className="flight-nav-copy">
              <strong>{marker.shortName}</strong>
              <small>{marker.kind === "orbiter" ? "ORBITER" : marker.kind === "moon" ? "MOON" : marker.kind === "rover" ? "ROVER" : "LANDMARK"} / {formatDistance(marker.rangeM, 0)}{marker.occulted ? " / MASKED" : ""}</small>
            </span>
          </button>)}
        </div>
      </>}
      {spaceshipMode && flightAction && <aside
        className="observer-action-card flight-action-card"
        style={{ left: flightAction.x, top: flightAction.y }}
        aria-label={`Autopilot course to ${flightAction.marker.name}`}
      >
        <span>COURSE LOCK / {flightAction.marker.shortName}</span>
        <button className="observer-action-primary" type="button" onClick={engageSelectedFlightAutopilot}><i aria-hidden="true" />Autopilot to here</button>
      </aside>}
      <header className="mission-header">
        <div className="mission-identity">
          <div className="brand-lockup" ref={bodyMenuRef}>
            <span className="mission-kicker">CAUCHY ARRAY / QSI–04</span>
            <h1 className="wordmark-row">
              <button
                className="wordmark-trigger"
                type="button"
                onClick={() => {
                  setRateMenuVisible(false);
                  setGraphicsVisible(false);
                  setBodyMenuVisible((visible) => !visible);
                }}
                aria-expanded={bodyMenuVisible}
                aria-haspopup="listbox"
                aria-controls="observation-target-menu"
                disabled={surfaceMode}
                title={surfaceMode ? "Press Escape to exit spaceman mode before changing targets" : "Select celestial body"}
              >
                <span className="wordmark-barsoom">{targetShortName(observedBody)}</span>
                <span className="wordmark-divider" aria-hidden="true">|</span>
                <span className="wordmark-mars">MARS</span>
                <i className="wordmark-chevron" aria-hidden="true" />
              </button>
            </h1>
            {bodyMenuVisible && !surfaceMode && <ul id="observation-target-menu" className="body-menu" role="listbox" aria-label="Select celestial body">
              {OBSERVATION_TARGETS.map((body) => <li key={body}>
                <button
                  type="button"
                  role="option"
                  aria-selected={body === observedBody}
                  onClick={() => selectObservedBody(body)}
                ><span>{body.toUpperCase()}</span><i aria-hidden="true">|</i><b>{body === "Mars" ? "PLANET" : body === "Phobos" || body === "Deimos" ? "MOON" : "ORBITER"}</b></button>
              </li>)}
            </ul>}
          </div>
          <span className="mission-mode"><i /> {orbitalMode ? `${moonMode ? "SATELLITE" : "SPACECRAFT"} APERTURE / ORBITAL TRACK LOCKED` : spaceshipMode ? "LOCAL SPACECRAFT / REAL-TIME FLIGHT" : `${surfaceMode ? "LOCAL OBSERVER SOLUTION" : "PLANETARY APERTURE"} / PHASE LOCKED`}</span>
        </div>
        <div className="simulation-clock">
          <span>SOURCE EPOCH / UTC</span>
          <strong>{simulationLabel}</strong>
          <div className="simulation-clock-meta">
            <small>CAUSAL DELAY EMBEDDED ·</small>
            <div className="simulation-rate" ref={rateMenuRef}>
              <button
                className="simulation-rate-trigger"
                type="button"
                onClick={() => {
                  setBodyMenuVisible(false);
                  setGraphicsVisible(false);
                  setRateMenuVisible((visible) => !visible);
                }}
                aria-expanded={rateMenuVisible}
                aria-haspopup="listbox"
                aria-controls="simulation-rate-menu"
                title="Select orbital simulation rate"
              >MODEL RATE <b>{simulationRate}×</b><i aria-hidden="true" /></button>
              {rateMenuVisible && <ul id="simulation-rate-menu" className="simulation-rate-menu" role="listbox" aria-label="Select simulation rate">
                {SIMULATION_RATES.map((rate) => <li key={rate}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={rate === simulationRate}
                    onClick={() => selectSimulationRate(rate)}
                  ><span>{rate}×</span><b>{rate === 60 ? "SURVEY" : rate === 6 ? "OBSERVE" : "REAL TIME"}</b></button>
                </li>)}
              </ul>}
            </div>
          </div>
        </div>
        <div className="header-actions">
          <span className="array-state"><i /> ARRAY 07 / COHERENT</span>
          <div className="header-buttons">
            <button
              className={`audio-button${audioMuted ? " muted" : ""}`}
              type="button"
              onClick={() => {
                const next = !audioMuted;
                setAudioMuted(next);
                window.__BARSOOM__?.setAudioMuted(next);
              }}
              aria-label={audioMuted ? "Enable Barsoom audio" : "Mute Barsoom audio"}
              aria-pressed={!audioMuted}
            ><i aria-hidden="true" /> AUDIO {audioMuted ? "OFF" : "ON"}</button>
            <button
              className={`weather-button weather-${weatherPreset}`}
              type="button"
              onClick={() => {
                const currentIndex = WEATHER_OPTIONS.indexOf(weatherPreset);
                const next = WEATHER_OPTIONS[(currentIndex + 1) % WEATHER_OPTIONS.length];
                setWeatherPreset(next);
                window.__BARSOOM__?.setWeatherPreset(next);
              }}
              aria-label={`Mars weather: ${weatherPreset}. Activate next weather regime`}
              title="Cycle clear air, ice-cloud cover, and dust-storm weather"
            >WEATHER <b>{weatherLabel(weatherPreset)}</b></button>
            <button
              className="help-button"
              type="button"
              onClick={() => {
                setGraphicsVisible(false);
                setTutorialLibraryVisible(false);
                setHelpVisible((visible) => !visible);
              }}
              aria-expanded={helpVisible}
            >CONTROLS <kbd>H</kbd></button>
            <button
              className="tutorials-button"
              type="button"
              onClick={() => {
                setGraphicsVisible(false);
                setHelpVisible(false);
                setTutorialLibraryVisible((visible) => !visible);
              }}
              aria-expanded={tutorialLibraryVisible}
              aria-controls="sova-tutorial-library"
            >TUTORIALS</button>
            <button
              ref={graphicsButtonRef}
              className="graphics-button"
              type="button"
              onClick={() => {
                setBodyMenuVisible(false);
                setRateMenuVisible(false);
                setHelpVisible(false);
                setTutorialLibraryVisible(false);
                setGraphicsVisible((visible) => !visible);
              }}
              aria-expanded={graphicsVisible}
              aria-controls="graphics-settings-panel"
            >GRAPHICS <b>{GRAPHICS_PRESETS[graphicsState.presetId].label.toUpperCase()}</b></button>
          </div>
        </div>
      </header>
      {graphicsVisible && <aside
        ref={graphicsPanelRef}
        id="graphics-settings-panel"
        className="graphics-panel"
        aria-labelledby="graphics-settings-title"
      >
        <button
          className="graphics-panel-close"
          type="button"
          onClick={() => setGraphicsVisible(false)}
          aria-label="Close graphics settings"
        >×</button>
        <p className="panel-index">RENDER PROFILE / LOCAL DEVICE</p>
        <h2 id="graphics-settings-title">Graphics settings</h2>
        <p className="graphics-intro">Auto selects a profile from the active GPU and browser hardware limits. Changes apply immediately and are saved on this device.</p>
        <div className="graphics-detection" aria-live="polite">
          <span>{graphicsState.preference === "auto" ? "AUTO-DETECTED" : "ACTIVE PROFILE"}</span>
          <strong>{GRAPHICS_PRESETS[graphicsState.presetId].label.toUpperCase()}</strong>
          <small>{graphicsState.rationale}</small>
        </div>
        <div className="graphics-device" title={graphicsState.capabilities.gpuName}>
          <span>ACTIVE ADAPTER</span>
          <strong>{graphicsState.capabilities.gpuName}</strong>
          <div>
            {graphicsState.capabilities.hardwareConcurrency > 0 && <small>{graphicsState.capabilities.hardwareConcurrency} CPU THREADS</small>}
            {graphicsState.capabilities.deviceMemoryGb !== null && <small>{graphicsState.capabilities.deviceMemoryGb} GB SYSTEM MEMORY</small>}
            {graphicsState.capabilities.maxTextureSize > 0 && <small>{graphicsState.capabilities.maxTextureSize}px GPU TEXTURE LIMIT</small>}
          </div>
        </div>
        <div className="graphics-options" role="group" aria-label="Graphics quality">
          {GRAPHICS_OPTIONS.map((option) => {
            const auto = option === "auto";
            const preset = option === "auto"
              ? GRAPHICS_PRESETS[graphicsState.presetId]
              : GRAPHICS_PRESETS[option];
            return <button
              key={option}
              type="button"
              className={graphicsState.preference === option ? "selected" : ""}
              onClick={() => selectGraphicsPreference(option)}
              aria-pressed={graphicsState.preference === option}
            >
              <span><strong>{auto ? "Auto" : preset.label}</strong><b>{auto ? `DETECTED ${GRAPHICS_PRESETS[graphicsState.presetId].label.toUpperCase()}` : option === "ultra" ? "ORIGINAL" : "MANUAL"}</b></span>
              <small>{auto ? "Recommended. Matches the active adapter and display load." : preset.description}</small>
            </button>;
          })}
        </div>
        <p className="graphics-note">On dual-GPU laptops, the active adapter above should be the dedicated GPU. If it shows Intel graphics, select the high-performance GPU for your browser in Windows Graphics settings.</p>
      </aside>}
      {!orbitalMode && <section className="coordinate-panel" aria-label="Current Mars reconstruction coordinates">
        <div className="panel-index">SOLUTION / 01</div>
        <div className="eyebrow">VIRTUAL APERTURE SOLUTION</div>
        <div className="coordinate-grid">
          <div><span>SOLVED LATITUDE</span><strong>{formatCoordinate(telemetry.latitudeDeg, "N", "S")}</strong></div>
          <div><span>SOLVED LONGITUDE</span><strong>{formatCoordinate(telemetry.longitudeDeg, "E", "W")}</strong></div>
          <div><span>{spaceshipMode ? "FLIGHT HEIGHT / AGL" : "FOCAL HEIGHT / AGL"}</span><strong>{formatDistance(telemetry.altitudeM)}</strong></div>
          <div><span>SOLVED DATUM OFFSET</span><strong>{telemetry.elevationM >= 0 ? "+" : ""}{formatDistance(telemetry.elevationM)}</strong></div>
        </div>
        <div className="ground-span"><span>RECONSTRUCTED FIELD</span><b>{formatDistance(telemetry.groundWidthM)}</b></div>
        {surfaceMode && <div className="coordinate-share">
          <button type="button" onClick={shareSpacemanLocation}>
            <i aria-hidden="true" />
            {shareStatus === "copied" ? "LOCATION LINK COPIED" : shareStatus === "error" ? "COPY FAILED — TRY AGAIN" : "SHARE EXACT LOCATION"}
          </button>
          <span className="sr-only" role="status" aria-live="polite">
            {shareStatus === "copied" ? "Exact Spaceman location link copied to clipboard." : shareStatus === "error" ? "Could not copy the location link." : ""}
          </span>
        </div>}
      </section>}
      {!orbitalMode && <section className="altitude-gauge" aria-label="Reconstruction focal height">
        <span className="gauge-label">FOCAL<br />STANDOFF</span>
        <div className="gauge-track"><i style={{ height: `${apertureFill}%` }} /><b style={{ bottom: `${apertureFill}%` }} /></div>
        <div className="gauge-copy"><span>FAR FIELD</span><strong>{formatDistance(telemetry.altitudeM)}</strong><span>LOCAL FIELD</span></div>
      </section>}
      {!orbitalMode && <div className="scale-bar" aria-label={`Approximate scale ${formatDistance(telemetry.groundWidthM / 4)}`}><span>ANGULAR SOLUTION · {formatDistance(telemetry.groundWidthM / 4)}</span><i /></div>}
      {selectedOrbiter && <section className="orbiter-telemetry" aria-label={`${selectedOrbiter.name} orbital telemetry`}>
        <div className="panel-index">HORIZONS TRACK / 01</div>
        <div className="eyebrow">ACTIVE MARS SPACECRAFT</div>
        <strong className="orbiter-name">{selectedOrbiter.name}</strong>
        <span className="orbiter-agency">{selectedOrbiter.agency}</span>
        <dl>
          <div><dt>ALTITUDE</dt><dd>{formatDistance(selectedOrbiter.altitudeM)}</dd></div>
          <div><dt>ORBITAL SPEED</dt><dd>{(selectedOrbiter.speedMps / 1_000).toFixed(2)} km/s</dd></div>
          <div><dt>ORBIT PERIOD</dt><dd>{(selectedOrbiter.orbitPeriodS / 60).toFixed(1)} min</dd></div>
          <div><dt>MARS-EQUATOR INCL.</dt><dd>{(Math.acos(Math.max(-1, Math.min(1, selectedOrbiter.orbitNormal.y))) * 180 / Math.PI).toFixed(1)}°</dd></div>
        </dl>
        <p>{selectedOrbiter.status}</p>
        <small>{selectedOrbiter.objective}</small>
      </section>}
      {!surfaceMode && !orbitalMode && landmarkMarkers.length > 0 && <div className="planet-landmark-layer" aria-hidden="true">
        {landmarkMarkers.map((marker, index) => <i
          key={marker.id}
          className={`planet-landmark-beacon${marker.kind === "retired-rover" ? " rover" : ""}${hoveredLandmark?.id === marker.id ? " active" : ""}`}
          style={{
            left: marker.x,
            top: marker.y,
            width: marker.radiusPx * 2,
            height: marker.radiusPx * 2,
            animationDelay: `${-(index % 6) * 0.38}s`,
          }}
          title={marker.name}
        />)}
      </div>}
      {!surfaceMode && !orbitalMode && orbitalMarkers.length > 0 && <div className="orbital-target-layer" aria-label="Visible Mars orbital targets">
        {orbitalMarkers.map((marker, index) => <button
          key={marker.id}
          className={`orbital-target-marker ${marker.kind}`}
          type="button"
          style={{
            left: marker.x,
            top: marker.y,
            width: marker.radiusPx * 2,
            height: marker.radiusPx * 2,
            animationDelay: `${-(index % 5) * 0.42}s`,
          }}
          onClick={() => selectObservedBody(marker.id)}
          aria-label={`Lock camera to ${marker.name}`}
          title={`Lock camera to ${marker.name}`}
        ><i aria-hidden="true" /><span>{marker.shortName}</span></button>)}
      </div>}
      {hoveredLandmark && !surfaceMode && !orbitalMode && <>
        <i
          className="planet-feature-reticle"
          style={{ left: hoveredLandmark.x, top: hoveredLandmark.y }}
          aria-hidden="true"
        />
        <aside
          className="planet-feature-label"
          style={{ left: hoveredLandmark.labelX, top: hoveredLandmark.labelY }}
          aria-label={`${hoveredLandmark.name}, ${hoveredLandmark.featureType}. Click to select this landing point.`}
        >
          <span>{hoveredLandmark.featureType}</span>
          <strong>{hoveredLandmark.name}</strong>
          <small>{formatCoordinate(hoveredLandmark.latitudeDeg, "N", "S")} · {formatCoordinate(hoveredLandmark.longitudeDeg, "E", "W")}</small>
          <b>{hoveredLandmark.kind === "retired-rover" ? "CLICK TO SELECT ROVER VISIT POINT" : "CLICK TO SELECT LANDING POINT"}</b>
        </aside>
      </>}
      {observerAction && !surfaceMode && <aside
        className="observer-action-card"
        style={{ left: observerAction.x, top: observerAction.y }}
        aria-label="Selected surface observer action"
      >
        <span>{observerAction.landmarkName ? `${observerAction.landmarkName.toUpperCase()} ${observerAction.landmarkKind === "retired-rover" ? "VISIT POINT" : "LOCKED"}` : "TERRAIN COORDINATE LOCKED"}</span>
        <button className="observer-action-primary" type="button" onClick={() => window.__BARSOOM__?.instantiateObserver()}><i aria-hidden="true" />{observerAction.landmarkKind === "retired-rover" ? "Instantiate at rover" : "Instantiate here"}</button>
      </aside>}
      {helpVisible && <aside className="help-panel" aria-label="Instrument controls and field guide">
        <button type="button" onClick={() => setHelpVisible(false)} aria-label="Close instrument guide">×</button>
        <p className="panel-index">FIELD MANUAL / QSI–04</p>
        <p className="eyebrow">{orbitalMode ? `${moonMode ? "SATELLITE" : "SPACECRAFT"} TRACK` : spaceshipMode ? "SPACECRAFT FLIGHT CONTROLS" : surfaceMode ? "LOCAL OBSERVER CONTROLS" : "APERTURE CONTROLS"}</p>
        {orbitalMode ? <div className="instrument-principle">
          <strong>{targetShortName(observedBody)} TRACK LOCKED.</strong>
          <p>The aperture follows {observedBody} on the simulation clock while retaining direct camera control. {moonMode ? "The moon remains at its physical size and Mars can occult it." : "The official model is shown only in close inspection, at its published deployed scale; the globe highlight remains screen-readable without enlarging the spacecraft."}</p>
        </div> : !surfaceMode && <div className="instrument-principle">
          <strong>YOU ARE NOT MOVING FASTER THAN LIGHT.</strong>
          <p>CAUCHY combines entanglement-enhanced interferometry across heliocentric receivers with geodetic phase priors to solve the outgoing Martian light field. Zoom changes the inverse-model focal volume; it does not move the telescope. Source epoch already includes photon time-of-flight.</p>
        </div>}
        {orbitalMode ? <dl><div><dt>Rotate around target</dt><dd>Left / middle drag</dd></div><div><dt>Pan across target</dt><dd>Right-mouse drag</dd></div><div><dt>Change standoff</dt><dd>Mouse wheel</dd></div><div><dt>Retarget</dt><dd>Orbit highlight / menu</dd></div></dl> : (surfaceMode ? <>
          {spaceshipMode ? <>
            <dl><div><dt>Plot destination</dt><dd>Click HUD marker</dd></div><div><dt>Aim camera + nose</dt><dd>Move mouse</dd></div><div><dt>Mouse thrust</dt><dd>Hold left + right</dd></div><div><dt>Pitch nose up / down</dt><dd>↑ / ↓</dd></div><div><dt>Thrust</dt><dd>W</dd></div><div><dt>Assisted full stop</dt><dd>Hold S</dd></div><div><dt>Auto-flight cycle</dt><dd>R · cruise / full / coast</dd></div><div><dt>Boost</dt><dd>Hold Shift</dd></div><div><dt>Ultra warp burst</dt><dd>F</dd></div><div><dt>Position hold</dt><dd>X</dd></div><div><dt>Roll left / right</dt><dd>Q / E</dd></div><div><dt>Strafe</dt><dd>Z / C</dd></div><div><dt>Rise / descend</dt><dd>Space / Ctrl</dd></div><div><dt>Camera-led turn</dt><dd>Left / middle drag</dd></div><div><dt>Free-look around ship</dt><dd>Hold Alt + drag</dd></div><div><dt>Chase to planet zoom</dt><dd>Mouse wheel</dd></div><div><dt>Safe ground return</dt><dd>Escape</dd></div></dl>
            <p>Destination autopilot sustains the full 180 km/s warp-burst speed on its corrected cruise course, brakes before arrival, performs a cinematic descent, lands on the selected surface point, and returns you to spaceman mode automatically. R cycles cruise, full thrust, and coast; any manual flight input cancels automation while camera control remains available. F delivers the same 180 km/s ultra-warp speed on demand with expanded field of view and dedicated audio. The craft coasts naturally, S performs a strong assisted stop, and camera-led turns are rate-limited.</p>
          </> : <>
            <dl><div><dt>Move / turn</dt><dd>W S / A D</dd></div><div><dt>Strafe</dt><dd>Q / E</dd></div><div><dt>Run</dt><dd>Hold Shift</dd></div><div><dt>Steer character + camera</dt><dd>Right-mouse drag</dd></div><div><dt>Free-look camera</dt><dd>Left-mouse drag</dd></div><div><dt>Mouse-run</dt><dd>Both mouse buttons</dd></div><div><dt>Auto-walk / run / stop</dt><dd>Press R repeatedly</dd></div><div><dt>Auto-run</dt><dd>Num Lock</dd></div><div><dt>Zoom / first person</dt><dd>Mouse wheel</dd></div><div><dt>Jump</dt><dd>Spacebar</dd></div><div><dt>Board spacecraft</dt><dd>Approach + E</dd></div><div><dt>Retarget field</dt><dd>~</dd></div><div><dt>Exit spaceman mode</dt><dd>Escape only</dd></div></dl>
            <p>The human figure is a dimensional and kinematic reference inside the solved light field—not transported matter. Its ballistic arc uses measured Mars surface gravity: 3.721 m/s². A spacecraft is instantiated nearby at every landing site.</p>
          </>}
        </> : <>
          <dl><div><dt>Named landmark</dt><dd>Hover + click</dd></div><div><dt>Retired rover</dt><dd>Cyan beacon + click</dd></div><div><dt>Instantiate observer</dt><dd>~</dd></div><div><dt>Rotate solved field</dt><dd>Left / middle drag</dd></div><div><dt>Translate aperture</dt><dd>Right-mouse drag</dd></div><div><dt>Change focal volume</dt><dd>Mouse wheel</dd></div><div><dt>Phase-lock other terrain</dt><dd>Left click</dd></div><div><dt>Release phase lock</dt><dd>Right click</dd></div><div><dt>Tile residuals</dt><dd>F4</dd></div></dl>
          <p>Move the pointer over significant terrain or a cyan retired-rover beacon, then click to lock the exact visit point. Choose <strong>Instantiate here</strong> in the confirmation card—or press <kbd>~</kbd>—to enter the surface. Unnamed terrain uses the same phase-lock flow.</p>
        </>)}
      </aside>}
      <SovaTutorial libraryVisible={tutorialLibraryVisible} onCloseLibrary={() => setTutorialLibraryVisible(false)} />
      <footer className="mission-footer"><span>SPECTRAL ALBEDO · RELIEF PHASE / OBSERVATION PRIORS</span><span className="footer-center"><i /> {orbitalMode ? `${targetShortName(observedBody)} EPHEMERIS TRACK LOCKED` : spaceshipMode ? `SPACECRAFT ${formatDistance(telemetry.shipSpeedMps)}/s · REAL-TIME FLIGHT` : surfaceMode ? "SPACEMAN TRACK LOCKED · ESC TO EXIT" : "PHOTONIC BASELINE COHERENT"}</span><span>RETARDED FIELD RECONSTRUCTION</span></footer>
      {error && <div className="render-error" role="alert">{error}</div>}
    </main>
  );
}
