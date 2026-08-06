# Planet renderer architecture

## Coordinate and precision model

Metres are authoritative. CPU positions remain JavaScript double-precision values in Mars-centred body-fixed coordinates. The camera never carries the 3.4-million-metre planet offset into GPU transforms: every visible tile owns a local centre, vertex positions are relative to that centre, and the mesh centre is translated by `tileCenterAbsolute - cameraAbsolute` each frame. The render camera remains at `(0, 0, 0)`. This is a floating-origin/camera-relative renderer without discontinuous origin shifts.

`MARS_REFERENCE_RADIUS_M` is 3,389,500 m. MOLA radius height is physical planetary radius minus this reference. UI areoid elevation is the MOLA radius minus the MOLA areoid. Camera altitude is queried against local MOLA plus deterministic collision detail and is clamped to 0–30,000,000 m AGL; a 0.12 m internal epsilon prevents near-plane intersection while the HUD reports 0 m.

The maths module covers:

- planetocentric latitude/longitude/elevation ↔ Cartesian;
- local east/north/up bases, including both poles;
- normalized cube-sphere face/UV selection;
- quadtree keys, parents, children, and cross-face neighbours;
- bilinear height interpolation;
- nonlinear altitude zoom and iterative actual-terrain cursor picking, including elevated limb relief;
- camera-relative and high/low coordinate splitting.

The gameplay query path samples deterministic height independently of render-mesh resolution and derives a finite-difference normal and slope in the local ENU frame. `window.__BARSOOM__.querySurface(latitude, longitude)` exposes the same result for construction and integration tests.

## Terrain lifecycle

Each of the six root faces persists in a quadtree. Selection uses projected geometric error, viewport height, FOV, camera distance, a frustum sphere test, and a planetary horizon-angle test. Coarse parents are requested first. Children become visible only after all four are ready; a dithered fade and parent-height morph then replaces the parent without transparent overlap lines.

MOLA static tiles stop at LOD 4 because they are the complete global macro source. A render tile at a finer LOD samples its LOD-4 ancestor in the worker and bakes the sampled planetary-radius elevation into its vertex positions. Geometry continues to LOD 18 near the camera. Fourteen deterministic planet-space detail bands are introduced progressively: regional relief is extended by six near-ground bands with characteristic spacing from roughly 70 m down to 1.2 m. Every band is a continuous 3D function of the normalized planetary direction, so borders, cube-face edges, longitude seams and poles share identical samples. Fragment detail remains visual dressing; the playable close-range relief is present in the mesh and in the independent collision/query height function.

The default wheel descent remains nadir at planetary scale and eases to a 62-degree-from-vertical oblique survey composition between 350 km and 25 km AGL, making regional canyon walls and scarps readable before the final approach. The pitch changes camera offset while re-solving distance against terrain, so it does not alter requested altitude. A middle-mouse orbit or right-mouse pan disables the assist and leaves the manual composition authoritative; pan translates the camera in the existing view plane, then reacquires the centre-ray terrain intersection without changing view direction or roll.

All tiles use one fixed grid topology (24×24 cells) and edge skirts. Neighbour forcing maintains a 2:1 balanced quadtree before skirts bridge residual edge tessellation. Mesh/geometry containers are pooled, the ready cache is bounded to 520 tiles, MOLA data to 96 tiles, and four workers service a priority queue. Requests carry cancellation tokens; rapid camera movement removes queued jobs and rejects stale results. Missing or corrupt data retries through the nearest parent and logs a single warning per key. Stale node subtrees are pruned after a bounded retention window.

## Render passes

1. A depth-independent astronomical pass renders HYG/Hipparcos round point-spread stars and angular Sun/planet points into black space.
2. Depth is cleared while colour remains.
3. Camera-relative terrain renders with the shared Sun direction and generated material shader.
4. A bounded ray-marched atmosphere pass integrates Rayleigh and dust/Mie single scattering, view and solar optical depth, transmittance, and Mars shadowing. The terrain shader applies matching aerial perspective to distant ground.

The renderer probes `EXT_clip_control` before construction. Supported GPUs use reversed depth; other WebGL 2 devices use logarithmic depth instead, never both simultaneously. Near/far planes change with altitude. Below 80 km on the illuminated side, a 2,048² directional solar shadow map follows the camera; its orthographic centre is snapped in absolute Mars-fixed light-plane coordinates before conversion back to camera-relative space, so floating-origin motion cannot make shadows swim. A morph-aware depth material excludes skirts and follows tile geomorphing. ACES tone mapping and a single exposure preserve a bright Sun, readable day terrain and a dark night side.

## Astronomy

Astronomy Engine supplies compact, tested VSOP87/NOVAS-derived heliocentric vectors. Planet vectors are made Mars-centred by subtracting Mars' heliocentric vector, then transformed from equatorial J2000 into the Mars IAU body frame using the time-dependent north pole and prime-meridian rotation. The same Sun vector drives terrain, atmosphere, terminator and solar disc. Phobos and Deimos use a compact NASA/JPL Horizons MAR099 model: current osculating elements and fitted nodal, apsidal and mean-anomaly rates are transformed through the same Mars body frame. Their physical-scale meshes share the terrain depth buffer, so Mars naturally occludes a moon on the far side while foreground transits remain possible.

## Recovery and extension

WebGL context loss pauses the loop, preserves navigation state and resumes on restoration. Atmosphere and material constants are centralized. Material blending is data-driven so a later terraforming layer can replace dust/regolith weights with water, soil and vegetation without replacing coordinates, terrain selection or controls.
