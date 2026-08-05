# Controls

| Action | Input | Behaviour |
|---|---|---|
| Deploy surface traverse | `~` | If a phase lock is active, instantiates the observer at that exact locked surface point. With no lock, chooses a uniformly random point on Mars. Pressing `~` again in traverse mode chooses another random landing site. |
| Orbit around geographic focus | Hold middle mouse and drag | Rotates a fixed-radius camera offset around the unchanged focus point with no yaw, pitch, pole, or roll limit. Rotations can wrap repeatedly; only a near-ground endpoint inside terrain is rejected. The first middle drag takes full manual control from the automatic approach composition. |
| Pan across Mars | Hold right mouse and drag | Clears any locked zoom point and takes manual composition control, then trucks the camera flat in its existing screen plane and reacquires the ground under the unchanged centre ray. Viewing direction and roll remain fixed; speed follows the visible scale. |
| Zoom | Mouse wheel | Exponential altitude curve, smoothed over time. With no selection, the surface point under the cursor anchors inward zoom. With a reticle selection, both inward and outward zoom remain locked to that point. An untouched descent eases from orbital nadir into a 48-degree RTS-style approach below 350 km AGL. |
| Lock zoom point | Left click | Places the scale-aware geographic acquisition reticle, locks wheel zoom, and opens an **Instantiate observer** action beside that surface point. The card also offers direct surface instantiation below the north scarp of Olympus Mons, at Ius Chasma, Noctis Labyrinthus, and Korolev crater. |
| Clear zoom point | Right click | Removes the reticle and returns wheel input to free cursor zoom. Holding the button and dragging continues to pan normally. |
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
| Auto-walk / auto-run | `R` | First press starts walking, second press switches to running, and third press stops. Pressing forward or backward also cancels it. |
| Auto-run | `Num Lock` | Toggles continuous running. Pressing forward or backward cancels it. |
| Zoom camera | Mouse wheel | Changes follow distance continuously from first person toward planetary scale. Crossing 200 m camera distance starts a three-second local-proxy coherence grace period. Crossing inward restores coherence; remaining outside the envelope terminates surface traverse and resumes maximum-altitude planetary observation above the same location. Zooming all the way in enters first person, and one outward step restores close third person. |
| Mars jump | `Space` | Launches at 4.8 m/s and falls at Mars surface gravity, 3.721 m/s². |
| Random teleport | `~` | Chooses a new random surface location while remaining in traverse mode. |
| Return to survey | `Escape` | Leaves the astronaut and returns to the maximum-altitude planetary view, centred above the same location. |

The browser context menu is suppressed only over the game canvas. Altitude is always above queried local terrain. The public limits are exactly 0 m and 30,000,000 m AGL; only the invisible collision/render epsilon remains below the displayed value.

Automated checks can read telemetry, place the camera at developer landmarks, and enable individual visual layers through the development API:

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
