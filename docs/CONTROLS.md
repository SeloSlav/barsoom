# Controls

| Action | Input | Behaviour |
|---|---|---|
| Deploy surface traverse | `~` | If a phase lock is active, instantiates the observer at that exact locked surface point. With no lock, chooses a uniformly random point on Mars. Pressing `~` again in traverse mode chooses another random landing site. |
| Orbit around geographic focus | Hold middle mouse and drag | Rotates a fixed-radius camera offset around the unchanged focus point with no yaw, pitch, pole, or roll limit. Rotations can wrap repeatedly; only a near-ground endpoint inside terrain is rejected. The first middle drag takes full manual control from the automatic approach composition. |
| Pan across Mars | Hold right mouse and drag | Clears any locked zoom point, then translates camera and focus together using the current screen-right/screen-up basis, preserving viewing direction and roll. Speed follows the visible scale. |
| Zoom | Mouse wheel | Exponential altitude curve, smoothed over time. With no selection, the surface point under the cursor anchors inward zoom. With a reticle selection, both inward and outward zoom remain locked to that point. An untouched descent eases from orbital nadir into a 48-degree RTS-style approach below 350 km AGL. |
| Lock zoom point | Left click | Places the scale-aware geographic acquisition reticle and locks wheel zoom to that surface point until cleared or replaced. |
| Clear zoom point | Right click | Removes the reticle and returns wheel input to free cursor zoom. Holding the button and dragging continues to pan normally. |
| Toggle diagnostics | `F3` | FPS, timing, tiles, LOD, triangles, calls, tile memory, worker queue, depth range and floating origin. |
| Toggle tile boundaries | `F4` | Draws cube-sphere tile edges. |
| Toggle help | `H` | Opens or closes the control reference. |
| Toggle audio | `AUDIO ON/OFF` button | Enables or mutes the ambient score, wind, instrument sonification and astronaut movement sounds. The preference persists in the browser. |

## Third-person surface traverse

| Action | Input | Behaviour |
|---|---|---|
| Move forward / backward | `W` / `S` | Moves relative to the astronaut's facing direction. Hold `Shift` to run. |
| Turn | `A` / `D` | Turns the astronaut and follow camera. While holding right mouse, these keys strafe instead. |
| Strafe | `Q` / `E` | Strafes left or right, matching standard World of Warcraft bindings. |
| Steer character and camera | Hold right mouse and drag | Turns the camera and makes the astronaut face it. |
| Free-look orbit | Hold left mouse and drag | Orbits the camera without changing the astronaut's facing direction. |
| Mouse-run | Hold both mouse buttons | Moves forward while the camera remains under mouse control. |
| Auto-run | `Num Lock` or `R` | Toggles continuous forward movement. Pressing forward or backward cancels it. |
| Zoom camera | Mouse wheel | Changes follow distance out to 39 m. Zooming all the way in enters first person; one outward step restores close third person. |
| Mars jump | `Space` | Launches at 4.8 m/s and falls at Mars surface gravity, 3.721 m/s². |
| Random teleport | `~` | Chooses a new random surface location while remaining in traverse mode. |
| Return to survey | `Escape` | Leaves the astronaut and returns to planetary survey above the same location. |

The browser context menu is suppressed only over the game canvas. Altitude is always above queried local terrain. The public limits are exactly 0 m and 30,000,000 m AGL; only the invisible collision/render epsilon remains below the displayed value.

Developer landmarks and individual visual layers are available only inside the `F3` diagnostics panel. Automated checks can use:

```js
window.__BARSOOM__.setLocation(latitudeDeg, longitudeDeg, altitudeM)
window.__BARSOOM__.setAltitude(altitudeM, true)
window.__BARSOOM__.setDebug("tileBoundaries", true)
window.__BARSOOM__.querySurface(latitudeDeg, longitudeDeg)
window.__BARSOOM__.setTerminator(altitudeM)
window.__BARSOOM__.setNightSide(altitudeM)
window.__BARSOOM__.setSimulationUtc("2032-04-17T05:23:11.000Z", 0)
window.__BARSOOM__.getState()
window.__BARSOOM__.teleportRandomSurface()
window.__BARSOOM__.exitSurfaceTraverse()
window.__BARSOOM__.getAudioMuted()
window.__BARSOOM__.setAudioMuted(true)
```
