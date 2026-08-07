# Controls

| Action | Input | Behaviour |
|---|---|---|
| Deploy surface traverse | `~` | If a phase lock is active, instantiates the observer at that exact locked surface point. With no lock, chooses a uniformly random point on Mars. Pressing `~` again in traverse mode chooses another random landing site. |
| Orbit around geographic focus | Hold middle mouse and drag | Rotates a fixed-radius camera offset around the unchanged focus point with no yaw, pitch, pole, or roll limit. Rotations can wrap repeatedly; only a near-ground endpoint inside terrain is rejected. The first middle drag takes full manual control from the automatic approach composition. |
| Pan across Mars | Hold right mouse and drag | Clears any locked zoom point and takes manual composition control, then trucks the camera flat in its existing screen plane and reacquires the ground under the unchanged centre ray. Viewing direction and roll remain fixed; speed follows the visible scale. |
| Zoom | Mouse wheel | Exponential altitude curve, smoothed over time. With no selection, the surface point under the cursor anchors inward zoom. With a reticle selection, both inward and outward zoom remain locked to that point. An untouched descent eases from orbital nadir into a 48-degree RTS-style approach below 350 km AGL. |
| Select a named feature | Hover, then left click | Significant Martian regions carry subtle pulsing acquisition circles. Hovering one reveals its name and coordinates; clicking it locks the exact point and opens an **Instantiate here** confirmation rather than entering surface mode automatically. |
| Lock any other terrain point | Left click | Places the scale-aware geographic acquisition reticle, locks wheel zoom, and opens the same **Instantiate here** action beside that surface point. |
| Clear zoom point | Right click | Removes the reticle and returns wheel input to free cursor zoom. Holding the button and dragging continues to pan normally. |
| Toggle tile boundaries | `F4` | Draws cube-sphere tile edges. |
| Toggle help | `H` | Opens or closes the control reference. |
| Toggle audio | `AUDIO ON/OFF` button | Enables or mutes the ambient score, wind, instrument sonification and astronaut movement sounds. The preference persists in the browser. |
| Select simulation rate | `MODEL RATE` menu | Changes moon and spacecraft propagation between 60× survey speed, 6× observation speed, and 1× real time without jumping the current simulation epoch. |
| Manage tutorials | `TUTORIALS` button | Opens the SOVA briefing library. Each tutorial can be played independently; **Reset & restart** clears session-only skipped/heard state and restarts Briefing 01. |

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
| Zoom camera | Mouse wheel | Changes follow distance continuously from first person toward planetary scale while remaining locked to the spaceman's movement. Zooming all the way in enters first person, and one outward step restores close third person. |
| Mars jump | `Space` | Launches at 4.8 m/s and falls at Mars surface gravity, 3.721 m/s². |
| Random teleport | `~` | Chooses a new random surface location while remaining in traverse mode. |
| Return to survey | `Escape` | The only way to leave spaceman mode. Returns to the maximum-altitude planetary view, centred above the same location. |

## Surface spacecraft

A flyable spacecraft is instantiated roughly 20 metres from the spaceman at every surface landing. Its movement always uses real elapsed time and is independent of the `MODEL RATE` setting.

| Action | Input | Notes |
| --- | --- | --- |
| Board spacecraft | `E` | Approach within 5.5 m; the on-screen indicator changes to `BOARD SPACECRAFT` when in range. |
| Point spacecraft | Move mouse | Pointer distance from the screen centre controls pitch and yaw. |
| Turn left / right | `A` / `D` or left / right arrows | Applies direct yaw, allowing the craft to turn even while the camera is orbiting. |
| Pitch up / down | Up / down arrows | Applies direct pitch in addition to mouse steering. |
| Thrust / reverse | `W` / `S` | Accelerates forward or applies reverse thrust to decelerate and back up. |
| Toggle cruise thrust | `R` | Locks forward thrust on for long flights. Press `R` again to coast; reverse thrust or auto-brake cancels cruise. |
| Boost + sharp maneuver | Hold `Shift` | Raises engine thrust and turn rates for climbs, fast acceleration, and tight turns. The exhaust switches to a longer, denser orange boost plume. |
| Auto-brake / position hold | `X` | Engages flight assist, rapidly cancels momentum, and holds the exact stopped position until the next thrust, strafe, or vertical input. |
| Roll | `Q` / `E` | Rolls left or right. |
| Strafe | `Z` / `C` | Applies lateral maneuvering thrust. |
| Rise / descend | `Space` / `Ctrl` | Applies vertical thrust away from or toward Mars regardless of craft roll. |
| Orbit camera | Hold left or middle mouse and drag | Orbits freely around the moving spacecraft without turning it; the camera follows the drag direction. |
| Change follow distance | Mouse wheel | Zooms continuously from an 8 m chase view to the 30,000 km planetary-scale view while remaining locked to the moving spacecraft. |
| Stop and disembark | `Escape` | Cancels all ship velocity, leaves it parked at its exact position, and restores the spaceman beside it at that location. Press `Escape` again as the spaceman to return to survey. |

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
window.__BARSOOM__.setSimulationRate(6)
window.__BARSOOM__.getState()
window.__BARSOOM__.teleportRandomSurface()
window.__BARSOOM__.exitSurfaceTraverse()
window.__BARSOOM__.getAudioMuted()
window.__BARSOOM__.setAudioMuted(true)
```
