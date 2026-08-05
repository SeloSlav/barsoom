"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_CAMERA_ALTITUDE_M, SURFACE_EYE_HEIGHT_M } from "../planet/constants";
import { PlanetEngine } from "../planet/PlanetEngine";
import type { DebugFlags, PlanetTelemetry } from "../planet/types";
import { SovaTutorial } from "./SovaTutorial";

const SIMULATION_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

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

const LANDMARKS = [
  { label: "Olympus Mons", lat: 18.65, lon: -133.8 },
  { label: "Valles Marineris", lat: -13.9, lon: -59.2 },
  { label: "Hellas Planitia", lat: -42.4, lon: 70.5 },
  { label: "Jezero Crater", lat: 18.38, lon: 77.58 },
  { label: "Gale Crater", lat: -5.4, lon: 137.8 },
  { label: "Korolev Crater", lat: 72.77, lon: 164.58 },
  { label: "North polar cap", lat: 86, lon: 30 },
  { label: "Cube face edge", lat: 0, lon: 45 },
] as const;

const DESCENT_TARGETS = [
  { label: "Jezero crater", lat: 18.38, lon: 77.58, altitudeM: 65_000 },
  { label: "Gale crater", lat: -5.4, lon: 137.8, altitudeM: 90_000 },
  { label: "Korolev ice crater", lat: 72.77, lon: 164.58, altitudeM: 70_000 },
] as const;

const VISTA_TARGETS = [
  { label: "Olympus Mons", lat: 18.65, lon: -133.8 },
  { label: "Ius Chasma", lat: -7.29, lon: -84.39 },
  { label: "Noctis Labyrinthus", lat: -6.36, lon: -101.19 },
  { label: "Korolev ice crater", lat: 72.77, lon: 164.58 },
] as const;

const QA_ALTITUDES = [
  { label: "30,000 km", metres: 30_000_000 },
  { label: "10,000 km", metres: 10_000_000 },
  { label: "1,000 km", metres: 1_000_000 },
  { label: "100 km", metres: 100_000 },
  { label: "10 km", metres: 10_000 },
  { label: "1 km", metres: 1_000 },
  { label: "100 m", metres: 100 },
  { label: "Surface", metres: SURFACE_EYE_HEIGHT_M },
] as const;

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

export function MarsExperience({ initialSimulationUtc }: { initialSimulationUtc: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [telemetry, setTelemetry] = useState<PlanetTelemetry>(() => createInitialTelemetry(initialSimulationUtc));
  const [error, setError] = useState<string | null>(null);
  const [helpVisible, setHelpVisible] = useState(false);
  const [audioMuted, setAudioMuted] = useState(false);
  const [observerAction, setObserverAction] = useState<ObserverActionPosition | null>(null);
  const [recoherenceVisible, setRecoherenceVisible] = useState(false);
  const coherenceWasLostRef = useRef(false);
  const [debug, setDebug] = useState<DebugFlags>({ overlay: false, tileBoundaries: false, cubeFaces: false, lodColours: false, normals: false, molaOnly: false, horizonCulling: false });

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
    } catch (caught) {
      engine?.dispose();
      const message = caught instanceof Error ? caught.message : "WebGL could not start on this device.";
      queueMicrotask(() => setError(message));
      return;
    }
    const keyHandler = (event: KeyboardEvent) => {
      if (event.code === "F3") setDebug((current) => ({ ...current, overlay: !current.overlay }));
      if (event.code === "KeyH" && !event.ctrlKey && !event.metaKey) setHelpVisible((visible) => !visible);
    };
    window.addEventListener("keydown", keyHandler);
    return () => { window.removeEventListener("keydown", keyHandler); engine?.dispose(); };
  }, [initialSimulationUtc]);

  const simulationLabel = useMemo(() => formatSimulationUtc(telemetry.simulationUtc), [telemetry.simulationUtc]);
  const surfaceMode = telemetry.controlMode === "surface";
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

  const toggleDebug = (flag: keyof DebugFlags) => {
    const next = !debug[flag];
    setDebug((current) => ({ ...current, [flag]: next }));
    window.__BARSOOM__?.setDebug(flag, next);
  };

  return (
    <main className={`mars-shell${surfaceMode ? " surface-traverse" : ""}${localProxyCoherenceLost ? " coherence-loss" : ""}`}>
      <canvas ref={canvasRef} className="mars-canvas" tabIndex={0} aria-label={surfaceMode ? "Third-person astronaut traverse on Mars" : "Interactive three-dimensional rendering of Mars"} />
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
          <div className="brand-lockup">
            <span className="mission-kicker">CAUCHY ARRAY / QSI–04</span>
            <h1 className="wordmark-row">
              <span className="wordmark-barsoom">BARSOOM</span>
              <span className="wordmark-divider" aria-hidden="true">|</span>
              <span className="wordmark-mars">MARS</span>
            </h1>
          </div>
          <span className="mission-mode"><i /> {surfaceMode ? "LOCAL OBSERVER SOLUTION" : "PLANETARY APERTURE"} / PHASE LOCKED</span>
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
            <button className="help-button" type="button" onClick={() => setHelpVisible((visible) => !visible)} aria-expanded={helpVisible}>INSTRUMENT <kbd>H</kbd></button>
          </div>
        </div>
      </header>
      <section className="coordinate-panel" aria-label="Current Mars reconstruction coordinates">
        <div className="panel-index">SOLUTION / 01</div>
        <div className="eyebrow">VIRTUAL APERTURE SOLUTION</div>
        <div className="coordinate-grid">
          <div><span>SOLVED LATITUDE</span><strong>{formatCoordinate(telemetry.latitudeDeg, "N", "S")}</strong></div>
          <div><span>SOLVED LONGITUDE</span><strong>{formatCoordinate(telemetry.longitudeDeg, "E", "W")}</strong></div>
          <div><span>FOCAL HEIGHT / AGL</span><strong>{formatDistance(telemetry.altitudeM)}</strong></div>
          <div><span>SOLVED DATUM OFFSET</span><strong>{telemetry.elevationM >= 0 ? "+" : ""}{formatDistance(telemetry.elevationM)}</strong></div>
        </div>
        <div className="ground-span"><span>RECONSTRUCTED FIELD</span><b>{formatDistance(telemetry.groundWidthM)}</b></div>
      </section>
      <section className="altitude-gauge" aria-label="Reconstruction focal height">
        <span className="gauge-label">FOCAL<br />STANDOFF</span>
        <div className="gauge-track"><i style={{ height: `${apertureFill}%` }} /><b style={{ bottom: `${apertureFill}%` }} /></div>
        <div className="gauge-copy"><span>FAR FIELD</span><strong>{formatDistance(telemetry.altitudeM)}</strong><span>LOCAL FIELD</span></div>
      </section>
      <div className="scale-bar" aria-label={`Approximate scale ${formatDistance(telemetry.groundWidthM / 4)}`}><span>ANGULAR SOLUTION · {formatDistance(telemetry.groundWidthM / 4)}</span><i /></div>
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
            onClick={() => window.__BARSOOM__?.instantiateObserverAt(target.lat, target.lon)}
          >{target.label}</button>)}</div>
        </div>
      </aside>}
      {helpVisible && <aside className="help-panel" aria-label="Instrument controls and field guide">
        <button type="button" onClick={() => setHelpVisible(false)} aria-label="Close instrument guide">×</button>
        <p className="panel-index">FIELD MANUAL / QSI–04</p>
        <p className="eyebrow">{surfaceMode ? "LOCAL OBSERVER CONTROLS" : "APERTURE CONTROLS"}</p>
        {!surfaceMode && <div className="instrument-principle">
          <strong>YOU ARE NOT MOVING FASTER THAN LIGHT.</strong>
          <p>CAUCHY combines entanglement-enhanced interferometry across heliocentric receivers with geodetic phase priors to solve the outgoing Martian light field. Zoom changes the inverse-model focal volume; it does not move the telescope. Source epoch already includes photon time-of-flight.</p>
        </div>}
        {surfaceMode ? <>
          <dl><div><dt>Move / turn</dt><dd>W S / A D</dd></div><div><dt>Strafe</dt><dd>Q / E</dd></div><div><dt>Run</dt><dd>Hold Shift</dd></div><div><dt>Steer character + camera</dt><dd>Right-mouse drag</dd></div><div><dt>Free-look camera</dt><dd>Left-mouse drag</dd></div><div><dt>Mouse-run</dt><dd>Both mouse buttons</dd></div><div><dt>Auto-walk / run / stop</dt><dd>Press R repeatedly</dd></div><div><dt>Auto-run</dt><dd>Num Lock</dd></div><div><dt>Zoom / first person</dt><dd>Mouse wheel</dd></div><div><dt>Jump</dt><dd>Spacebar</dd></div><div><dt>Retarget field</dt><dd>~</dd></div><div><dt>Exit surface</dt><dd>Escape</dd></div></dl>
          <p>The human figure is a dimensional and kinematic reference inside the solved light field—not transported matter. Its ballistic arc uses measured Mars surface gravity: 3.721 m/s². Wheel zoom can exceed the human-scale coherence envelope briefly; if the local proxy cannot recover, the instrument releases it and resumes planetary observation.</p>
        </> : <>
          <dl><div><dt>Instantiate observer</dt><dd>~</dd></div><div><dt>Rotate solved field</dt><dd>Middle-mouse drag</dd></div><div><dt>Translate aperture</dt><dd>Right-mouse drag</dd></div><div><dt>Change focal volume</dt><dd>Mouse wheel</dd></div><div><dt>Phase-lock coordinate</dt><dd>Left click</dd></div><div><dt>Release phase lock</dt><dd>Right click</dd></div><div><dt>Solver diagnostics</dt><dd>F3</dd></div><div><dt>Tile residuals</dt><dd>F4</dd></div></dl>
          <p>Left-click a surface point to phase-lock wheel focus to the surface reticle. Press <kbd>~</kbd> to instantiate the observer at that exact coordinate. Right-click once to release the lock and return the solution to cursor-guided focus.</p>
          <div className="descent-targets"><p className="eyebrow">CALIBRATED FOCAL FIELDS</p><div>{DESCENT_TARGETS.map((target) => <button key={target.label} type="button" onClick={() => { window.__BARSOOM__?.setLocation(target.lat, target.lon, target.altitudeM); setHelpVisible(false); }}>{target.label}</button>)}</div></div>
        </>}
      </aside>}
      {debug.overlay && <aside className="debug-panel" aria-label="Planet renderer diagnostics">
        <div className="debug-heading"><span>INVERSE SOLVER DIAGNOSTICS</span><b>{telemetry.fps.toFixed(0)} FPS</b></div>
        <div className="debug-metrics"><span>Focal target</span><b>{formatDistance(telemetry.desiredAltitudeM)}</b></div>
        <div className="debug-metrics"><span>Frame</span><b>{telemetry.frameMs.toFixed(2)} ms</b><span>Tiles</span><b>{telemetry.activeTiles} active / {telemetry.loadingTiles} loading</b><span>Nodes</span><b>{telemetry.terrainNodes} retained</b><span>LOD</span><b>{telemetry.minLod}—{telemetry.maxLod}</b><span>Horizon</span><b>{telemetry.horizonCulled} culled</b><span>Triangles</span><b>{telemetry.triangles.toLocaleString()}</b><span>Draw calls</span><b>{telemetry.drawCalls}</b><span>Relief cache</span><b>{telemetry.textureMemoryMb.toFixed(2)} MB</b><span>Geometry</span><b>{telemetry.geometryMemoryMb.toFixed(2)} MB</b><span>Worker queue</span><b>{telemetry.workerQueue}</b><span>Depth mode</span><b>{telemetry.depthStrategy}</b><span>Surface shadows</span><b>{telemetry.surfaceShadows ? `on / ${formatDistance(telemetry.shadowExtentM)}` : "off"}</b><span>Depth</span><b>{formatDistance(telemetry.nearM)} / {formatDistance(telemetry.farM)}</b><span>Origin X</span><b>{formatDistance(telemetry.floatingOrigin.x)}</b><span>Origin Y</span><b>{formatDistance(telemetry.floatingOrigin.y)}</b><span>Origin Z</span><b>{formatDistance(telemetry.floatingOrigin.z)}</b></div>
        <div className="debug-switches">{(["tileBoundaries", "cubeFaces", "lodColours", "normals", "molaOnly", "horizonCulling"] as const).map((flag) => <button key={flag} type="button" className={debug[flag] ? "active" : ""} onClick={() => toggleDebug(flag)}>{flag === "horizonCulling" ? "horizon audit" : flag === "molaOnly" ? "base relief" : flag.replace(/([A-Z])/g, " $1")}</button>)}</div>
        <div className="qa-altitudes" aria-label="Visual QA altitudes">{QA_ALTITUDES.map((level) => <button key={level.metres} type="button" onClick={() => window.__BARSOOM__?.setAltitude(level.metres, true)}>{level.label}</button>)}</div>
        <div className="landmarks">{LANDMARKS.map((place) => <button key={place.label} type="button" onClick={() => window.__BARSOOM__?.setLocation(place.lat, place.lon, Math.max(telemetry.altitudeM, 2_000_000))}>{place.label}</button>)}</div>
        <div className="sky-checks"><button type="button" onClick={() => window.__BARSOOM__?.setTerminator()}>Terminator orbit</button><button type="button" onClick={() => window.__BARSOOM__?.setNightSide()}>Night surface</button></div>
      </aside>}
      <SovaTutorial />
      <footer className="mission-footer"><span>SPECTRAL ALBEDO · RELIEF PHASE / OBSERVATION PRIORS</span><span className={`footer-center${localProxyCoherenceLost ? " coherence-lost" : ""}`}><i /> {localProxyCoherenceLost ? "LOCAL PROXY COHERENCE LOST / ORBITAL LOCK HELD" : surfaceMode ? "LOCAL FIELD SOLUTION CONVERGED" : "PHOTONIC BASELINE COHERENT"}</span><span>RETARDED FIELD RECONSTRUCTION</span></footer>
      {error && <div className="render-error" role="alert">{error}</div>}
    </main>
  );
}
