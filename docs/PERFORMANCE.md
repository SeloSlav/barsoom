# Performance and verification

## Baseline

The repository and upstream were empty before this implementation, so there was no previous renderer, frame profile, bundle or asset baseline to compare. The relevant “before” measurements are therefore zero application code/assets and no runnable frame loop.

## Current static profile

Measured on the production build in this repository:

| Item | Result |
|---|---:|
| MOLA runtime files | 2,047 files / 35,034,956 bytes total |
| Star runtime files | 3 files / 109,276 bytes total |
| Embedded rendered stars | 6,682 |
| MOLA files requested for a typical orbital view | small visible-face subset, not all 2,046 |
| Terrain mesh topology | 24×24 cells plus four skirts |
| Triangle count per tile | 1,344 |
| Ready geometry cache cap | 280 tiles |
| MOLA decoded cache cap | 96 tiles |
| Terrain workers | 2 |
| Maximum active tile budget | 220 |
| Device pixel ratio cap | 1.75 |
| Adaptive render scale floor | 0.72 |
| Near-surface solar shadow map | 2,048² below 80 km on the illuminated side |

`npm run build` completes without compilation errors. `npm test` currently covers 61 maths, data, generated-geometry, worker-scheduling, celestial, navigation, material-configuration, and precision cases, including every required screenshot altitude, cross-face 2:1 neighbour balancing, morph-aware shadow depth, and absolute light-plane shadow snapping. The separate server-render check verifies production metadata and removal of the starter.

## Terrain generation benchmark

`npm run benchmark:terrain` runs the exact browser worker generator against a committed 16-PPD MOLA tile after twelve warm-up jobs. On the development machine (Windows, Node 24.3.0), 120 LOD-12 tiles measured:

| Metric | Result |
|---|---:|
| Generated payload per tile | 65,428 bytes |
| Mean generation time | 3.39 ms |
| Median generation time | 3.23 ms |
| 95th percentile | 4.87 ms |
| Maximum | 5.76 ms |
| Two-worker P95 throughput estimate | 411 tiles/s |

This is a repeatable CPU throughput measurement, not a substitute for the live `F3` GPU/frame-time telemetry. The pre-implementation repository had no renderer or terrain job to benchmark, so its corresponding throughput and frame-time measurements are not applicable rather than zero.

## Frame-time instrumentation

The `F3` overlay reports exponentially smoothed frame time/FPS, active/loading tiles, retained nodes, selected LOD range, horizon rejections, triangles, draw calls, decoded MOLA memory, GPU geometry memory, worker queue, active depth strategy, local shadow extent, near/far planes and camera-relative origin. The horizon-audit toggle temporarily disables occlusion culling so its effect is directly measurable. Resolution changes at most once per 240 frames: sustained frame time over 22 ms lowers scale in 0.1 steps; sustained time below 15.2 ms restores it slowly. This keeps the orbital view sharp while providing a bounded recovery path on slower GPUs.

No geometry, material, texture or network request is constructed in the steady-state render loop. Tile-node arrays grow only on first subdivision. Mesh and geometry containers are reused. The asynchronous request queue rejects stale jobs after rapid movement, and every MOLA request uses browser HTTP caching.

## Visual verification matrix

The development API can place the camera deterministically at 30,000 km, 10,000 km, 1,000 km, 100 km, 10 km, 1 km, 100 m and 0 m AGL over Olympus Mons, Valles Marineris, Hellas Planitia, a polar region and a cube edge. Visual checks should keep the same canvas and camera active while moving between levels; the landmark buttons are debug-only shortcuts for repeatable inspection, not the normal navigation transition.
