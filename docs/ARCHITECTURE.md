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
- nonlinear altitude zoom and ray/sphere cursor picking;
- camera-relative and high/low coordinate splitting.

## Terrain lifecycle

Each of the six root faces persists in a quadtree. Selection uses projected geometric error, viewport height, FOV, camera distance, a frustum sphere test, and a planetary horizon-angle test. Coarse parents are requested first. Children become visible only after all four are ready; a dithered fade and parent-height morph then replaces the parent without transparent overlap lines.

MOLA static tiles stop at LOD 2 because they are the complete global macro source. A render tile at a finer LOD samples its LOD-2 ancestor in the worker. Geometry continues to LOD 18 near the camera. Eight deterministic planet-space detail bands are introduced progressively, and every band is a continuous 3D function of the normalized planetary direction, so borders, cube-face edges, longitude seams and poles share identical samples.

All tiles use one fixed grid topology (24×24 cells) and edge skirts. Mesh/geometry containers are pooled, the ready cache is bounded to 280 tiles, MOLA data to 96 tiles, and two workers service a priority queue. Requests carry cancellation tokens; rapid camera movement removes queued jobs and rejects stale results. Missing or corrupt data retries through the nearest parent and logs a single warning per key.

## Render passes

1. A depth-independent astronomical pass renders HYG/Hipparcos round point-spread stars and angular Sun/planet/moon points into black space.
2. Depth is cleared while colour remains.
3. Camera-relative terrain renders with the shared Sun direction and generated material shader.
4. The atmosphere sphere adds limb scattering and surface horizon haze, while the terrain shader applies aerial perspective to distant ground.

The renderer requests reversed depth (`EXT_clip_control`) and logarithmic depth together so unsupported reversed depth retains the tested logarithmic fallback. Near/far planes change with altitude. ACES tone mapping and a single exposure preserve bright Sun, readable day terrain and a dark night side.

## Astronomy

Astronomy Engine supplies compact, tested VSOP87/NOVAS-derived heliocentric vectors. Planet vectors are made Mars-centred by subtracting Mars' heliocentric vector, then transformed from equatorial J2000 into the Mars IAU body frame using the time-dependent north pole and prime-meridian rotation. The same Sun vector drives terrain, atmosphere, terminator and solar disc. Phobos and Deimos use deterministic orbital periods and Mars-centred radii; terrain drawn after the sky naturally occludes every celestial object behind Mars.

## Recovery and extension

WebGL context loss pauses the loop, preserves navigation state and resumes on restoration. Atmosphere and material constants are centralized. Material blending is data-driven so a later terraforming layer can replace dust/regolith weights with water, soil and vegetation without replacing coordinates, terrain selection or controls.

