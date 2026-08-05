"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_CAMERA_ALTITUDE_M } from "../planet/constants";
import { PlanetEngine, type ObservedBody } from "../planet/PlanetEngine";
import { createSpacemanShareUrl, parseSpacemanShareLocation } from "../planet/shareLocation";
import type { PlanetTelemetry } from "../planet/types";
import { SovaTutorial } from "./SovaTutorial";

const SIMULATION_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const OBSERVATION_TARGETS: readonly ObservedBody[] = ["Mars", "Phobos", "Deimos"];

function createInitialTelemetry(simulationUtc: string): PlanetTelemetry {
  return {
    latitudeDeg: 18.65, longitudeDeg: -133.8, altitudeM: 10_000_000, desiredAltitudeM: 10_000_000, elevationM: 0, groundWidthM: 0,
    activeTiles: 0, loadingTiles: 0, queuedTiles: 0, minLod: 0, maxLod: 0, triangles: 0, drawCalls: 0,
    textureMemoryMb: 0, geometryMemoryMb: 0, workerQueue: 0, terrainNodes: 6, horizonCulled: 0,
    depthStrategy: "logarithmic", surfaceShadows: false, shadowExtentM: 0,
    nearM: 1, farM: 50_000_000, floatingOrigin: { x: 0, y: 0, z: 0 },
    frameMs: 16.67, fps: 60, simulationUtc, controlMode: "survey", surfaceReady: true, localProxyCoherent: true,
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

const VISTA_TARGETS: ReadonlyArray<{
  label: string;
  lat: number;
  lon: number;
  headingRad?: number;
}> = [
  // The summit is hundreds of kilometres wide and reads as a plain at human
  // scale. Spawn below the steep northern basal scarp and face the volcano so
  // its roughly eight-kilometre relief forms the horizon instead.
  { label: "Olympus Mons scarp", lat: 23.35, lon: -135.95, headingRad: Math.PI },
  { label: "Ius Chasma", lat: -7.29, lon: -84.39 },
  { label: "Noctis Labyrinthus", lat: -6.36, lon: -101.19 },
  { label: "Korolev ice crater", lat: 72.77, lon: 164.58 },
];

type ObserverActionPosition = { x: number; y: number };

function positionObserverAction(x: number, y: number): ObserverActionPosition {
  const edgeGap = 12;
  const cardWidth = Math.min(360, window.innerWidth - edgeGap * 2);
  const cardHeight = 152;
  const targetGap = 20;
  const fitsToRight = x + targetGap + cardWidth <= window.innerWidth - edgeGap;
  return {
    x: fitsToRight ? x + targetGap : Math.max(edgeGap, x - targetGap - cardWidth),
    y: Math.min(Math.max(edgeGap, y - 18), window.innerHeight - cardHeight - edgeGap),
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
  const [recoherenceVisible, setRecoherenceVisible] = useState(false);
  const [shareStatus, setShareStatus] = useState<"idle" | "copied" | "error">("idle");
  const [observedBody, setObservedBody] = useState<ObservedBody>("Mars");
  const [bodyMenuVisible, setBodyMenuVisible] = useState(false);
  const coherenceWasLostRef = useRef(false);
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
        (position) => setObserverAction(position ? positionObserverAction(position.x, position.y) : null),
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
  const moonMode = observedBody !== "Mars";
  const surfaceMode = !moonMode && telemetry.controlMode === "surface";
  const surfaceSettling = surfaceMode && !telemetry.surfaceReady;
  const localProxyCoherenceLost = surfaceMode && !telemetry.localProxyCoherent;
  const apertureFill = Math.max(1.5, Math.log10(telemetry.altitudeM + 1) / Math.log10(MAX_CAMERA_ALTITUDE_M + 1) * 100);

  useEffect(() => {
    const coherenceWasLost = coherenceWasLostRef.current;
    coherenceWasLostRef.current = localProxyCoherenceLost;
    if (localProxyCoherenceLost || !surfaceMode || !coherenceWasLost) return;
    const showTimeout = window.setTimeout(() => setRecoherenceVisible(true), 0);
    const hideTimeout = window.setTimeout(() => setRecoherenceVisible(false), 2_000);
    return () => {
      window.clearTimeout(showTimeout);
      window.clearTimeout(hideTimeout);
    };
  }, [localProxyCoherenceLost, surfaceMode]);

  return (
    <main className={`mars-shell${surfaceMode ? " surface-traverse" : ""}${moonMode ? " moon-lock" : ""}${localProxyCoherenceLost ? " coherence-loss" : ""}`}>
      <canvas ref={canvasRef} className="mars-canvas" tabIndex={0} aria-label={surfaceMode ? "Third-person astronaut traverse on Mars" : moonMode ? `Locked close-up rendering of ${observedBody}` : "Interactive three-dimensional rendering of Mars"} />
      <div className="hud-vignette" aria-hidden="true" />
      <div className="instrument-grid" aria-hidden="true" />
      {localProxyCoherenceLost && <div className="coherence-loss-field" aria-hidden="true" />}
      {surfaceSettling && <div className="surface-entry-screen" role="status" aria-live="polite">
        <i aria-hidden="true" />
        <span>RESOLVING LOCAL FIELD</span>
        <small>TERRAIN PHASE CONVERGENCE</small>
      </div>}
      {localProxyCoherenceLost && <aside className="coherence-warning" role="status" aria-live="polite">
        <strong>LOCAL PROXY COHERENCE LOST</strong>
        <span>Local field divergence · planetary aperture fallback armed</span>
      </aside>}
      {recoherenceVisible && !localProxyCoherenceLost && surfaceMode && <aside className="coherence-warning coherence-restored" role="status" aria-live="polite">
        <strong>LOCAL PROXY RECOHERENCE RESTORED</strong>
        <span>Local field reacquired · human-scale solution stable</span>
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
              >
                <span className="wordmark-barsoom">{observedBody.toUpperCase()}</span>
                <span className="wordmark-divider" aria-hidden="true">|</span>
                <span className="wordmark-mars">MARS</span>
                <i className="wordmark-chevron" aria-hidden="true" />
              </button>
            </h1>
            {bodyMenuVisible && <ul id="observation-target-menu" className="body-menu" role="listbox" aria-label="Select celestial body">
              {OBSERVATION_TARGETS.map((body) => <li key={body}>
                <button
                  type="button"
                  role="option"
                  aria-selected={body === observedBody}
                  onClick={() => selectObservedBody(body)}
                ><span>{body.toUpperCase()}</span><i aria-hidden="true">|</i><b>MARS</b></button>
              </li>)}
            </ul>}
          </div>
          <span className="mission-mode"><i /> {moonMode ? "SATELLITE APERTURE / ORBITAL TRACK LOCKED" : `${surfaceMode ? "LOCAL OBSERVER SOLUTION" : "PLANETARY APERTURE"} / PHASE LOCKED`}</span>
        </div>
        <div className="simulation-clock">
          <span>SOURCE EPOCH / UTC</span>
          <strong>{simulationLabel}</strong>
          <small>CAUSAL DELAY EMBEDDED · MODEL RATE 60×</small>
        </div>
        <div className="header-actions">
          <span className={`array-state${localProxyCoherenceLost ? " coherence-lost" : ""}`}><i /> {localProxyCoherenceLost ? "LOCAL PROXY / COHERENCE LOST" : "ARRAY 07 / COHERENT"}</span>
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
      {!moonMode && <section className="coordinate-panel" aria-label="Current Mars reconstruction coordinates">
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
      {!moonMode && <section className="altitude-gauge" aria-label="Reconstruction focal height">
        <span className="gauge-label">FOCAL<br />STANDOFF</span>
        <div className="gauge-track"><i style={{ height: `${apertureFill}%` }} /><b style={{ bottom: `${apertureFill}%` }} /></div>
        <div className="gauge-copy"><span>FAR FIELD</span><strong>{formatDistance(telemetry.altitudeM)}</strong><span>LOCAL FIELD</span></div>
      </section>}
      {!moonMode && <div className="scale-bar" aria-label={`Approximate scale ${formatDistance(telemetry.groundWidthM / 4)}`}><span>ANGULAR SOLUTION · {formatDistance(telemetry.groundWidthM / 4)}</span><i /></div>}
      {observerAction && !surfaceMode && <aside
        className="observer-action-card"
        style={{ left: observerAction.x, top: observerAction.y }}
        aria-label="Selected surface observer action"
      >
        <span>COORDINATE PHASE LOCKED</span>
        <button className="observer-action-primary" type="button" onClick={() => window.__BARSOOM__?.instantiateObserver()}><i aria-hidden="true" />Instantiate observer</button>
        <div className="observer-vistas">
          <span>HIGH-CONTRAST RELIEF FIELDS</span>
          <div>{VISTA_TARGETS.map((target) => <button
            key={target.label}
            type="button"
            onClick={() => window.__BARSOOM__?.instantiateObserverAt(target.lat, target.lon, target.headingRad)}
          >{target.label}</button>)}</div>
        </div>
      </aside>}
      {helpVisible && <aside className="help-panel" aria-label="Instrument controls and field guide">
        <button type="button" onClick={() => setHelpVisible(false)} aria-label="Close instrument guide">×</button>
        <p className="panel-index">FIELD MANUAL / QSI–04</p>
        <p className="eyebrow">{moonMode ? "SATELLITE TRACK" : surfaceMode ? "LOCAL OBSERVER CONTROLS" : "APERTURE CONTROLS"}</p>
        {moonMode ? <div className="instrument-principle">
          <strong>{observedBody.toUpperCase()} TRACK LOCKED.</strong>
          <p>The aperture follows {observedBody} in real time while retaining direct camera control.</p>
        </div> : !surfaceMode && <div className="instrument-principle">
          <strong>YOU ARE NOT MOVING FASTER THAN LIGHT.</strong>
          <p>CAUCHY combines entanglement-enhanced interferometry across heliocentric receivers with geodetic phase priors to solve the outgoing Martian light field. Zoom changes the inverse-model focal volume; it does not move the telescope. Source epoch already includes photon time-of-flight.</p>
        </div>}
        {moonMode ? <dl><div><dt>Rotate around moon</dt><dd>Middle-mouse drag</dd></div><div><dt>Pan across moon</dt><dd>Right-mouse drag</dd></div><div><dt>Change standoff</dt><dd>Mouse wheel</dd></div><div><dt>Retarget body</dt><dd>Identity menu</dd></div></dl> : (surfaceMode ? <>
          <dl><div><dt>Move / turn</dt><dd>W S / A D</dd></div><div><dt>Strafe</dt><dd>Q / E</dd></div><div><dt>Run</dt><dd>Hold Shift</dd></div><div><dt>Steer character + camera</dt><dd>Right-mouse drag</dd></div><div><dt>Free-look camera</dt><dd>Left-mouse drag</dd></div><div><dt>Mouse-run</dt><dd>Both mouse buttons</dd></div><div><dt>Auto-walk / run / stop</dt><dd>Press R repeatedly</dd></div><div><dt>Auto-run</dt><dd>Num Lock</dd></div><div><dt>Zoom / first person</dt><dd>Mouse wheel</dd></div><div><dt>Jump</dt><dd>Spacebar</dd></div><div><dt>Retarget field</dt><dd>~</dd></div><div><dt>Exit surface</dt><dd>Escape</dd></div></dl>
          <p>The human figure is a dimensional and kinematic reference inside the solved light field—not transported matter. Its ballistic arc uses measured Mars surface gravity: 3.721 m/s². Wheel zoom can exceed the human-scale coherence envelope briefly; if the local proxy cannot recover, the instrument releases it and resumes planetary observation.</p>
        </> : <>
          <dl><div><dt>Instantiate observer</dt><dd>~</dd></div><div><dt>Rotate solved field</dt><dd>Middle-mouse drag</dd></div><div><dt>Translate aperture</dt><dd>Right-mouse drag</dd></div><div><dt>Change focal volume</dt><dd>Mouse wheel</dd></div><div><dt>Phase-lock coordinate</dt><dd>Left click</dd></div><div><dt>Release phase lock</dt><dd>Right click</dd></div><div><dt>Tile residuals</dt><dd>F4</dd></div></dl>
          <p>Left-click a surface point to phase-lock wheel focus to the surface reticle. Press <kbd>~</kbd> to instantiate the observer at that exact coordinate. Right-click once to release the lock and return the solution to cursor-guided focus.</p>
        </>)}
      </aside>}
      <SovaTutorial libraryVisible={tutorialLibraryVisible} onCloseLibrary={() => setTutorialLibraryVisible(false)} />
      <footer className="mission-footer"><span>SPECTRAL ALBEDO · RELIEF PHASE / OBSERVATION PRIORS</span><span className={`footer-center${localProxyCoherenceLost ? " coherence-lost" : ""}`}><i /> {moonMode ? `${observedBody.toUpperCase()} EPHEMERIS TRACK LOCKED` : localProxyCoherenceLost ? "LOCAL PROXY COHERENCE LOST / ORBITAL LOCK HELD" : surfaceMode ? "LOCAL FIELD SOLUTION CONVERGED" : "PHOTONIC BASELINE COHERENT"}</span><span>RETARDED FIELD RECONSTRUCTION</span></footer>
      {error && <div className="render-error" role="alert">{error}</div>}
    </main>
  );
}
