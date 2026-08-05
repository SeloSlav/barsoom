"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_CAMERA_ALTITUDE_M } from "../planet/constants";
import { PlanetEngine } from "../planet/PlanetEngine";
import type { DebugFlags, PlanetTelemetry } from "../planet/types";

const SIMULATION_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function createInitialTelemetry(simulationUtc: string): PlanetTelemetry {
  return {
    latitudeDeg: 18.65, longitudeDeg: -133.8, altitudeM: 10_000_000, elevationM: 0, groundWidthM: 0,
    activeTiles: 0, loadingTiles: 0, queuedTiles: 0, minLod: 0, maxLod: 0, triangles: 0, drawCalls: 0,
    textureMemoryMb: 0, geometryMemoryMb: 0, workerQueue: 0, terrainNodes: 6, horizonCulled: 0,
    depthStrategy: "logarithmic", nearM: 1, farM: 50_000_000, floatingOrigin: { x: 0, y: 0, z: 0 },
    frameMs: 16.67, fps: 60, simulationUtc,
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
  { label: "North polar cap", lat: 86, lon: 30 },
  { label: "Cube face edge", lat: 0, lon: 45 },
] as const;

const QA_ALTITUDES = [
  { label: "30,000 km", metres: 30_000_000 },
  { label: "10,000 km", metres: 10_000_000 },
  { label: "1,000 km", metres: 1_000_000 },
  { label: "100 km", metres: 100_000 },
  { label: "10 km", metres: 10_000 },
  { label: "1 km", metres: 1_000 },
  { label: "100 m", metres: 100 },
  { label: "0 m", metres: 0 },
] as const;

export function MarsExperience({ initialSimulationUtc }: { initialSimulationUtc: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [telemetry, setTelemetry] = useState<PlanetTelemetry>(() => createInitialTelemetry(initialSimulationUtc));
  const [error, setError] = useState<string | null>(null);
  const [helpVisible, setHelpVisible] = useState(false);
  const [debug, setDebug] = useState<DebugFlags>({ overlay: false, tileBoundaries: false, cubeFaces: false, lodColours: false, normals: false, molaOnly: false, horizonCulling: false });

  useEffect(() => {
    if (!canvasRef.current) return;
    let engine: PlanetEngine;
    try {
      engine = new PlanetEngine(canvasRef.current, setTelemetry, setError, initialSimulationUtc);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "WebGL could not start on this device.";
      queueMicrotask(() => setError(message));
      return;
    }
    const keyHandler = (event: KeyboardEvent) => {
      if (event.code === "F3") setDebug((current) => ({ ...current, overlay: !current.overlay }));
      if (event.code === "KeyH" && !event.ctrlKey && !event.metaKey) setHelpVisible((visible) => !visible);
    };
    window.addEventListener("keydown", keyHandler);
    return () => { window.removeEventListener("keydown", keyHandler); engine.dispose(); };
  }, [initialSimulationUtc]);

  const simulationLabel = useMemo(() => formatSimulationUtc(telemetry.simulationUtc), [telemetry.simulationUtc]);

  const toggleDebug = (flag: keyof DebugFlags) => {
    const next = !debug[flag];
    setDebug((current) => ({ ...current, [flag]: next }));
    window.__BARSOOM__?.setDebug(flag, next);
  };

  return (
    <main className="mars-shell">
      <canvas ref={canvasRef} className="mars-canvas" aria-label="Interactive three-dimensional rendering of Mars" />
      <div className="hud-vignette" aria-hidden="true" />
      <header className="mission-header">
        <div className="mission-identity"><span className="mission-kicker">ARES CARTOGRAPHY NETWORK</span><h1>BARSOOM</h1><span className="mission-mode"><i /> PLANETARY SURVEY / LIVE</span></div>
        <div className="simulation-clock"><span>SIMULATION UTC</span><strong>{simulationLabel}</strong><small>60× CELESTIAL TIME</small></div>
        <button className="help-button" type="button" onClick={() => setHelpVisible((visible) => !visible)} aria-expanded={helpVisible}>CONTROLS <kbd>H</kbd></button>
      </header>
      <section className="coordinate-panel" aria-label="Current Mars coordinates">
        <div className="eyebrow">GEOGRAPHIC FOCUS</div>
        <div className="coordinate-grid">
          <div><span>LATITUDE</span><strong>{formatCoordinate(telemetry.latitudeDeg, "N", "S")}</strong></div>
          <div><span>LONGITUDE</span><strong>{formatCoordinate(telemetry.longitudeDeg, "E", "W")}</strong></div>
          <div><span>ALTITUDE AGL</span><strong>{formatDistance(telemetry.altitudeM)}</strong></div>
          <div><span>AREOID ELEV.</span><strong>{telemetry.elevationM >= 0 ? "+" : ""}{formatDistance(telemetry.elevationM)}</strong></div>
        </div>
        <div className="ground-span"><span>FRAME GROUND WIDTH</span><b>{formatDistance(telemetry.groundWidthM)}</b></div>
      </section>
      <section className="altitude-gauge" aria-label="Zoom altitude">
        <div className="gauge-track"><i style={{ height: `${Math.max(1.5, Math.log10(telemetry.altitudeM + 1) / Math.log10(MAX_CAMERA_ALTITUDE_M + 1) * 100)}%` }} /></div>
        <div className="gauge-copy"><span>ORBIT</span><strong>{formatDistance(telemetry.altitudeM)}</strong><span>SURFACE</span></div>
      </section>
      <div className="scale-bar" aria-label={`Approximate scale ${formatDistance(telemetry.groundWidthM / 4)}`}><span>{formatDistance(telemetry.groundWidthM / 4)}</span><i /></div>
      {helpVisible && <aside className="help-panel">
        <button type="button" onClick={() => setHelpVisible(false)} aria-label="Close controls">×</button><p className="eyebrow">PLANET CONTROLS</p>
        <dl><div><dt>Orbit focus</dt><dd>Middle-mouse drag</dd></div><div><dt>Move across Mars</dt><dd>Right-mouse drag</dd></div><div><dt>Zoom at cursor</dt><dd>Mouse wheel</dd></div><div><dt>Select ground</dt><dd>Left click</dd></div><div><dt>Diagnostics</dt><dd>F3</dd></div><div><dt>Tile boundaries</dt><dd>F4</dd></div></dl>
        <p>Wheel movement scales continuously from intercontinental orbit changes to centimetres near the regolith.</p>
      </aside>}
      {debug.overlay && <aside className="debug-panel" aria-label="Planet renderer diagnostics">
        <div className="debug-heading"><span>RENDER DIAGNOSTICS</span><b>{telemetry.fps.toFixed(0)} FPS</b></div>
        <div className="debug-metrics"><span>Frame</span><b>{telemetry.frameMs.toFixed(2)} ms</b><span>Tiles</span><b>{telemetry.activeTiles} active / {telemetry.loadingTiles} loading</b><span>Nodes</span><b>{telemetry.terrainNodes} retained</b><span>LOD</span><b>{telemetry.minLod}—{telemetry.maxLod}</b><span>Horizon</span><b>{telemetry.horizonCulled} culled</b><span>Triangles</span><b>{telemetry.triangles.toLocaleString()}</b><span>Draw calls</span><b>{telemetry.drawCalls}</b><span>MOLA cache</span><b>{telemetry.textureMemoryMb.toFixed(2)} MB</b><span>Geometry</span><b>{telemetry.geometryMemoryMb.toFixed(2)} MB</b><span>Worker queue</span><b>{telemetry.workerQueue}</b><span>Depth mode</span><b>{telemetry.depthStrategy}</b><span>Depth</span><b>{formatDistance(telemetry.nearM)} / {formatDistance(telemetry.farM)}</b><span>Origin X</span><b>{formatDistance(telemetry.floatingOrigin.x)}</b><span>Origin Y</span><b>{formatDistance(telemetry.floatingOrigin.y)}</b><span>Origin Z</span><b>{formatDistance(telemetry.floatingOrigin.z)}</b></div>
        <div className="debug-switches">{(["tileBoundaries", "cubeFaces", "lodColours", "normals", "molaOnly", "horizonCulling"] as const).map((flag) => <button key={flag} type="button" className={debug[flag] ? "active" : ""} onClick={() => toggleDebug(flag)}>{flag === "horizonCulling" ? "horizon audit" : flag.replace(/([A-Z])/g, " $1")}</button>)}</div>
        <div className="qa-altitudes" aria-label="Visual QA altitudes">{QA_ALTITUDES.map((level) => <button key={level.metres} type="button" onClick={() => window.__BARSOOM__?.setAltitude(level.metres, true)}>{level.label}</button>)}</div>
        <div className="landmarks">{LANDMARKS.map((place) => <button key={place.label} type="button" onClick={() => window.__BARSOOM__?.setLocation(place.lat, place.lon, Math.max(telemetry.altitudeM, 2_000_000))}>{place.label}</button>)}</div>
        <div className="sky-checks"><button type="button" onClick={() => window.__BARSOOM__?.setTerminator()}>Terminator orbit</button><button type="button" onClick={() => window.__BARSOOM__?.setNightSide()}>Night surface</button></div>
      </aside>}
      <footer className="mission-footer"><span>MOLA MEGDR 16 PPD · IAU 2000</span><span className="footer-center"><i /> GLOBAL TERRAIN STREAM NOMINAL</span><span>CAMERA-RELATIVE / CUBE-SPHERE</span></footer>
      {error && <div className="render-error" role="alert">{error}</div>}
    </main>
  );
}
