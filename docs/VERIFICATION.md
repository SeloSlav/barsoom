# Acceptance verification

This matrix distinguishes automated evidence from the live GPU evidence still required before completion. A green build is not treated as proof of visual quality.

## Automated gates

| Gate | Current evidence |
|---|---|
| Type safety | `npx tsc --noEmit` passes |
| Code quality | `npm run lint` passes |
| Maths, data, geometry, scheduling, astronomy, and controls | `npm test` passes 59 tests |
| Production application | `npm run build` passes |
| Rendered shell and metadata | `node --test tests/rendered-html.test.mjs` passes |
| Static runtime delivery | Page, MOLA manifest/tiles, star binary, and terrain worker return HTTP 200 on port 5190 |
| Terrain CPU throughput | 120 exact worker jobs: 3.39 ms mean, 4.87 ms P95; see `PERFORMANCE.md` |

## Numbered acceptance criteria

| # | Requirement | Evidence | State |
|---:|---|---|---|
| 1–2 | Continuous orbit → any surface → orbit | One control/camera state and terrain scene; altitude matrix and global landmark data tests | Awaiting live descent/ascent observation |
| 3 | Middle orbit, right pan, wheel zoom | Input integration tests, including fixed-focus unrestricted far-side orbit and view-preserving pan | Automated proof complete; live feel pending |
| 4–7 | Exact altitude limits, scale-aware zoom, cursor anchor | Required-altitude matrix, streamed-height clamp, nonlinear-zoom and off-centre anchor tests | Automated proof complete; live feel pending |
| 8 | Globally complete MOLA macro terrain | 2,046-tile manifest; every byte length, SHA-256, header and CRC verified; all global LOD-4 borders checked | Proven |
| 9 | Deterministic local detail | Shared planet-space octave code, edge tests, and byte-identical leave/return regeneration | Proven |
| 10 | Crack/pop-free LOD | Exhaustive MOLA borders, outward winding, skirts, 2:1 balance, geomorph and complementary dither-mask tests | Awaiting live transition observation |
| 11 | Generated coherent Mars materials | Data-driven dust/regolith/basalt/light-rock/frost shader with stable metre detail; no photographic imagery | Awaiting visual-quality observation |
| 12 | Orbit/ground atmosphere | Bounded single-scattering shader with optical depth, transmittance, Mars shadow and terrain aerial perspective | Awaiting orbit/ground visual observation |
| 13 | Catalogue stars | 6,682-record HYG binary, SHA/header/count/magnitude/colour tests | Proven |
| 14 | Mars-centred Sun and planets | Astronomy Engine vectors, Mars body-frame transform and deterministic celestial tests | Proven |
| 15 | Shared bright Sun lighting | One calculated Sun direction feeds terrain, atmosphere, terminator and disc; angular-size tests | Source/data proof complete; visual brightness pending |
| 16 | Planetary precision stability | Double-precision CPU state, camera-relative tiles, high/low tests, adaptive near/far depth strategy | Awaiting close-range jitter observation |
| 17 | Demand-streamed high resolution | LRU MOLA loader, visible quadtree selection, static per-tile requests, bounded caches | Proven by source and scheduling tests |
| 18 | No major streaming stalls | Worker priority/cancellation tests and 4.87 ms CPU P95 | Awaiting live 1080p F3 frame profile |
| 19 | Existing application builds/runs | Production build and rendered-shell test pass | Proven |
| 20 | Fully client-side/static runtime | Browser workers, static assets and client ephemerides; no terrain API/database/backend | Proven |

## Required live visual matrix

Open `http://localhost:5190`, hard-refresh, press `F3`, and use the debug-only altitude/location shortcuts. Capture the canvas with diagnostics visible after tile loading settles.

For repeatable celestial screenshots, freeze the simulation first with `window.__BARSOOM__.setSimulationUtc("2032-04-17T05:23:11.000Z", 0)`.

| View | Required checks | Evidence |
|---|---|---|
| 30,000 km | Complete planet, surrounding sky, stars/planet, thin limb | Pending screenshot + F3 |
| 10,000 km | Terminator readability and global colour coherence | Pending screenshot + F3 |
| 1,000 km | Regional MOLA relief and clean LOD transition | Pending screenshot + F3 |
| 100 km | Horizon haze, no cracks or black tiles | Pending screenshot + F3 |
| 10 km | Local terrain density and material continuity | Pending screenshot + F3 |
| 1 km | Stable depth, no swimming or repeated texture pattern | Pending screenshot + F3 |
| 100 m | Metre detail, pan precision and terrain collision | Pending screenshot + F3 |
| 0 m AGL | Surface epsilon, horizon atmosphere and no clipping | Pending screenshot + F3 |
| Olympus Mons / Valles Marineris / Hellas / pole / cube edge | Correct macro signatures and seamless global behavior | Pending screenshots |
| Night surface | Round catalogue stars, planets, extinction and Mars occlusion | Pending screenshot |

During the same session, middle-drag repeatedly through full rotations, right-drag without view rotation, zoom down and back up without a cut, and rapidly reverse zoom/pan to audit stale-job cancellation. Record steady-state FPS/frame time, active tiles, maximum LOD, draw calls, MOLA/geometry memory and worker queue from `F3`.
