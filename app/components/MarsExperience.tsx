"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_CAMERA_ALTITUDE_M } from "../planet/constants";
import { calculateMarsOrbiters, isMarsOrbiterName, MARS_ORBITER_NAMES } from "../planet/ephemeris";
import {
  PlanetEngine,
  type MarsLandmarkHover,
  type MarsLandmarkMarker,
  type MarsOrbitalMarker,
  type ObservedBody,
} from "../planet/PlanetEngine";
import { createSpacemanShareUrl, parseSpacemanShareLocation } from "../planet/shareLocation";
import type { PlanetTelemetry } from "../planet/types";
import { SovaTutorial } from "./SovaTutorial";

const SIMULATION_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const OBSERVATION_TARGETS: readonly ObservedBody[] = ["Mars", "Phobos", "Deimos", ...MARS_ORBITER_NAMES];

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
    frameMs: 16.67, fps: 60, simulationUtc, controlMode: "survey", surfaceReady: true,
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
  const [telemetry, setTelemetry] = useState<PlanetTelemetry>(() => createInitialTelemetry(initialSimulationUtc));
  const [error, setError] = useState<string | null>(null);
  const [helpVisible, setHelpVisible] = useState(false);
  const [tutorialLibraryVisible, setTutorialLibraryVisible] = useState(false);
  const [audioMuted, setAudioMuted] = useState(false);
  const [observerAction, setObserverAction] = useState<ObserverActionPosition | null>(null);
  const [hoveredLandmark, setHoveredLandmark] = useState<PresentedLandmark | null>(null);
  const [landmarkMarkers, setLandmarkMarkers] = useState<readonly MarsLandmarkMarker[]>([]);
  const [orbitalMarkers, setOrbitalMarkers] = useState<readonly MarsOrbitalMarker[]>([]);
  const [shareStatus, setShareStatus] = useState<"idle" | "copied" | "error">("idle");
  const [observedBody, setObservedBody] = useState<ObservedBody>("Mars");
  const [bodyMenuVisible, setBodyMenuVisible] = useState(false);
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
      if (event.code === "KeyH" && !event.ctrlKey && !event.metaKey) setHelpVisible((visible) => !visible);
    };
    window.addEventListener("keydown", keyHandler);
    return () => {
      window.removeEventListener("keydown", keyHandler);
      if (shareStatusTimeoutRef.current !== null) window.clearTimeout(shareStatusTimeoutRef.current);
      engine?.dispose();
    };
  }, [initialSimulationUtc]);

  useEffect(() => {
    if (!bodyMenuVisible) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!bodyMenuRef.current?.contains(event.target as Node)) setBodyMenuVisible(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setBodyMenuVisible(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [bodyMenuVisible]);

  const selectObservedBody = (body: ObservedBody) => {
    setObservedBody(body);
    setBodyMenuVisible(false);
    setHelpVisible(false);
    setTutorialLibraryVisible(false);
    setObserverAction(null);
    setHoveredLandmark(null);
    setLandmarkMarkers([]);
    setOrbitalMarkers([]);
    window.__BARSOOM__?.focusBody(body);
    canvasRef.current?.focus();
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
  const apertureFill = Math.max(1.5, Math.log10(telemetry.altitudeM + 1) / Math.log10(MAX_CAMERA_ALTITUDE_M + 1) * 100);

  return (
    <main className={`mars-shell${surfaceMode ? " surface-traverse" : ""}${orbitalMode ? " moon-lock" : ""}${hoveredLandmark ? " landmark-hover" : ""}`}>
      <canvas ref={canvasRef} className="mars-canvas" tabIndex={0} aria-label={surfaceMode ? "Third-person astronaut traverse on Mars" : orbitalMode ? `Locked close-up rendering of ${observedBody}` : "Interactive three-dimensional rendering of Mars. Hover named features, retired rover sites, moons, and active orbiters; then click one to select it."} />
      <div className="hud-vignette" aria-hidden="true" />
      <div className="instrument-grid" aria-hidden="true" />
      {surfaceSettling && <div className="surface-entry-screen" role="status" aria-live="polite">
        <i aria-hidden="true" />
        <span>RESOLVING LOCAL FIELD</span>
        <small>TERRAIN PHASE CONVERGENCE</small>
      </div>}
      {surfaceMode && <aside className="surface-exit-hint" aria-label="Spaceman mode remains active at every zoom level. Press Escape to exit.">
        <span>SPACEMAN MODE LOCKED</span>
        <strong><kbd>ESC</kbd> TO EXIT</strong>
      </aside>}
      <header className="mission-header">
        <div className="mission-identity">
          <div className="brand-lockup" ref={bodyMenuRef}>
            <span className="mission-kicker">CAUCHY ARRAY / QSI–04</span>
            <h1 className="wordmark-row">
              <button
                className="wordmark-trigger"
                type="button"
                onClick={() => setBodyMenuVisible((visible) => !visible)}
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
          <span className="mission-mode"><i /> {orbitalMode ? `${moonMode ? "SATELLITE" : "SPACECRAFT"} APERTURE / ORBITAL TRACK LOCKED` : `${surfaceMode ? "LOCAL OBSERVER SOLUTION" : "PLANETARY APERTURE"} / PHASE LOCKED`}</span>
        </div>
        <div className="simulation-clock">
          <span>SOURCE EPOCH / UTC</span>
          <strong>{simulationLabel}</strong>
          <small>CAUSAL DELAY EMBEDDED · MODEL RATE 60×</small>
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
              className="help-button"
              type="button"
              onClick={() => {
                setTutorialLibraryVisible(false);
                setHelpVisible((visible) => !visible);
              }}
              aria-expanded={helpVisible}
            >CONTROLS <kbd>H</kbd></button>
            <button
              className="tutorials-button"
              type="button"
              onClick={() => {
                setHelpVisible(false);
                setTutorialLibraryVisible((visible) => !visible);
              }}
              aria-expanded={tutorialLibraryVisible}
              aria-controls="sova-tutorial-library"
            >TUTORIALS</button>
          </div>
        </div>
      </header>
      {!orbitalMode && <section className="coordinate-panel" aria-label="Current Mars reconstruction coordinates">
        <div className="panel-index">SOLUTION / 01</div>
        <div className="eyebrow">VIRTUAL APERTURE SOLUTION</div>
        <div className="coordinate-grid">
          <div><span>SOLVED LATITUDE</span><strong>{formatCoordinate(telemetry.latitudeDeg, "N", "S")}</strong></div>
          <div><span>SOLVED LONGITUDE</span><strong>{formatCoordinate(telemetry.longitudeDeg, "E", "W")}</strong></div>
          <div><span>FOCAL HEIGHT / AGL</span><strong>{formatDistance(telemetry.altitudeM)}</strong></div>
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
        <p className="eyebrow">{orbitalMode ? `${moonMode ? "SATELLITE" : "SPACECRAFT"} TRACK` : surfaceMode ? "LOCAL OBSERVER CONTROLS" : "APERTURE CONTROLS"}</p>
        {orbitalMode ? <div className="instrument-principle">
          <strong>{targetShortName(observedBody)} TRACK LOCKED.</strong>
          <p>The aperture follows {observedBody} on the simulation clock while retaining direct camera control. {moonMode ? "The moon remains at its physical size and Mars can occult it." : "The official model is shown only in close inspection, at its published deployed scale; the globe highlight remains screen-readable without enlarging the spacecraft."}</p>
        </div> : !surfaceMode && <div className="instrument-principle">
          <strong>YOU ARE NOT MOVING FASTER THAN LIGHT.</strong>
          <p>CAUCHY combines entanglement-enhanced interferometry across heliocentric receivers with geodetic phase priors to solve the outgoing Martian light field. Zoom changes the inverse-model focal volume; it does not move the telescope. Source epoch already includes photon time-of-flight.</p>
        </div>}
        {orbitalMode ? <dl><div><dt>Rotate around target</dt><dd>Left / middle drag</dd></div><div><dt>Pan across target</dt><dd>Right-mouse drag</dd></div><div><dt>Change standoff</dt><dd>Mouse wheel</dd></div><div><dt>Retarget</dt><dd>Orbit highlight / menu</dd></div></dl> : (surfaceMode ? <>
          <dl><div><dt>Move / turn</dt><dd>W S / A D</dd></div><div><dt>Strafe</dt><dd>Q / E</dd></div><div><dt>Run</dt><dd>Hold Shift</dd></div><div><dt>Steer character + camera</dt><dd>Right-mouse drag</dd></div><div><dt>Free-look camera</dt><dd>Left-mouse drag</dd></div><div><dt>Mouse-run</dt><dd>Both mouse buttons</dd></div><div><dt>Auto-walk / run / stop</dt><dd>Press R repeatedly</dd></div><div><dt>Auto-run</dt><dd>Num Lock</dd></div><div><dt>Zoom / first person</dt><dd>Mouse wheel</dd></div><div><dt>Jump</dt><dd>Spacebar</dd></div><div><dt>Retarget field</dt><dd>~</dd></div><div><dt>Exit spaceman mode</dt><dd>Escape only</dd></div></dl>
          <p>The human figure is a dimensional and kinematic reference inside the solved light field—not transported matter. Its ballistic arc uses measured Mars surface gravity: 3.721 m/s². Spaceman mode stays locked to the figure at every wheel-zoom distance and exits only when you press <kbd>Esc</kbd>.</p>
        </> : <>
          <dl><div><dt>Named landmark</dt><dd>Hover + click</dd></div><div><dt>Retired rover</dt><dd>Cyan beacon + click</dd></div><div><dt>Instantiate observer</dt><dd>~</dd></div><div><dt>Rotate solved field</dt><dd>Left / middle drag</dd></div><div><dt>Translate aperture</dt><dd>Right-mouse drag</dd></div><div><dt>Change focal volume</dt><dd>Mouse wheel</dd></div><div><dt>Phase-lock other terrain</dt><dd>Left click</dd></div><div><dt>Release phase lock</dt><dd>Right click</dd></div><div><dt>Tile residuals</dt><dd>F4</dd></div></dl>
          <p>Move the pointer over significant terrain or a cyan retired-rover beacon, then click to lock the exact visit point. Choose <strong>Instantiate here</strong> in the confirmation card—or press <kbd>~</kbd>—to enter the surface. Unnamed terrain uses the same phase-lock flow.</p>
        </>)}
      </aside>}
      <SovaTutorial libraryVisible={tutorialLibraryVisible} onCloseLibrary={() => setTutorialLibraryVisible(false)} />
      <footer className="mission-footer"><span>SPECTRAL ALBEDO · RELIEF PHASE / OBSERVATION PRIORS</span><span className="footer-center"><i /> {orbitalMode ? `${targetShortName(observedBody)} EPHEMERIS TRACK LOCKED` : surfaceMode ? "SPACEMAN TRACK LOCKED · ESC TO EXIT" : "PHOTONIC BASELINE COHERENT"}</span><span>RETARDED FIELD RECONSTRUCTION</span></footer>
      {error && <div className="render-error" role="alert">{error}</div>}
    </main>
  );
}
