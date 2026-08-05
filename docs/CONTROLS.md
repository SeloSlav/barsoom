# Controls

| Action | Input | Behaviour |
|---|---|---|
| Orbit around geographic focus | Hold middle mouse and drag | Rotates a fixed-radius camera offset around the unchanged focus point with no yaw, pitch, pole, or roll limit. Rotations can wrap repeatedly; only a near-ground endpoint inside terrain is rejected. The first middle drag takes full manual control from the automatic approach composition. |
| Pan across Mars | Hold right mouse and drag | Translates camera and focus together using the current screen-right/screen-up basis, preserving viewing direction and roll. Speed follows the visible scale. |
| Zoom | Mouse wheel | Exponential altitude curve, smoothed over time. The surface point under the cursor becomes the zoom anchor when the cursor ray hits Mars. An untouched descent eases from orbital nadir into a 48-degree RTS-style approach below 350 km AGL. |
| Select surface point | Left click | Leaves left mouse free for gameplay and places a scale-aware geographic marker. |
| Toggle diagnostics | `F3` | FPS, timing, tiles, LOD, triangles, calls, tile memory, worker queue, depth range and floating origin. |
| Toggle tile boundaries | `F4` | Draws cube-sphere tile edges. |
| Toggle help | `H` | Opens or closes the control reference. |

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
```
