# Scientific data and software attribution

## Audio

The ambient wind, astronaut foley and instrument cues in `public/audio/` were generated specifically for Barsoom with the ElevenLabs Sound Effects API (`eleven_text_to_sound_v2`) on 2026-08-05. The 96-second instrumental survey score was composed with the ElevenLabs Music API (`music_v2`) after Music API access became available.

- `mars-wind-loop.mp3`: thin Martian wind and dust ambience
- `barsoom-survey-score.mp3`: 96-second beatless ambient score with a quiet rise-and-return structure
- `boot-step-a.mp3` through `boot-step-f.mp3`: shuffled natural regolith footstep variations
- `jump-launch.mp3`, `suit-land.mp3`: spacesuit movement foley
- `phase-lock.mp3`, `observer-transition.mp3`: scientific instrument sonification

No API key or other ElevenLabs account data is stored in this repository.

## SOVA mission intelligence

SOVA's original holographic portrait (`public/images/sova-profile.png`) was generated for Barsoom with OpenAI image generation. Her original custom voice was created with the ElevenLabs Voice Design API, then rendered through ElevenLabs Text to Speech for three tutorial briefings:

- `sova-quantum-telescope.mp3`: delayed-photon and quantum-metrology briefing
- `sova-surface-selection.mp3`: landing-site survey briefing
- `sova-spaceman.mp3`: local proxy and robotic-colonization briefing

The character, scripts, voice description and visual prompt were authored specifically for this project. The scientific copy treats the Cauchy Array as speculative fiction while explicitly preserving the no-faster-than-light and real-photon constraints of actual interferometry.

## Astronaut

The surface-traverse character is the rigged and animated **Astronaut** by Quaternius.

- Asset: `public/models/astronaut.glb`
- Creator: Quaternius
- License: Creative Commons Zero 1.0 Universal (CC0; attribution not required)
- Source: https://poly.pizza/m/3hC2i0CTuO
- Verified format and licence: animated GLTF, Public Domain (CC0)

The included humanoid rig supplies the idle, walk and run animation clips used by the third-person controller.

## Surface spacecraft

The flyable surface spacecraft uses the matching **Spaceship** model from Quaternius's **Ultimate Space Kit**.

- Included asset: `public/models/surface-spaceship.glb`
- Creator: Quaternius
- Pack: Ultimate Space Kit (March 2023)
- License: Creative Commons Zero 1.0 Universal (CC0; attribution not required)
- Official source: https://quaternius.com/packs/ultimatespacekit.html
- Public GLTF bundle: https://poly.pizza/bundle/Ultimate-Space-Kit-YWh743lqGX
- Adaptation: selected from the pack's spaceship variants, renamed for stable local loading, normalized to a 9.2 m flight length at runtime, and augmented with generated exhaust and trail effects

## Retired Mars rovers

The surface heritage sites use two lightweight static rover assets. Both are loaded only when the observer reaches a nearby, terrain-resolved surface view; the globe uses highlight beacons without downloading or drawing the models.

### Sojourner

- Included asset: `public/models/sojourner-rover.glb`
- Original model: **Mars Sojourner Rover** by argonius
- License: Creative Commons Zero / Public Domain
- Original source: https://blendswap.com/blend/15250
- Public-domain mirror used for the source Blender file: https://www.printables.com/model/411486-mars-sojourner-rover
- Adaptation: scene props removed, static rover hierarchy consolidated by material, exported as an uncompressed web GLB, and normalized to the rover's physical dimensions

### Spirit and Opportunity

Spirit and Opportunity were identical Mars Exploration Rover twins, so both sites share one official lightweight MER asset.

- Included asset: `public/models/mer-rover-web.glb`
- Original model: **Mars Exploration Rover Opportunity (MER-B)**
- Author/origin: NASA Ames Research Center
- Source: https://science.nasa.gov/3d-resources/
- Source repository: https://github.com/nasa/NASA-3D-Resources
- Usage: NASA content is generally not subject to copyright in the United States; NASA is acknowledged as the source and no endorsement is implied
- Guidelines: https://www.nasa.gov/nasa-brand-center/images-and-media/
- Adaptation: official Draco-compressed GLB decoded and re-exported as an uncompressed web GLB for decoder-free lazy loading, then normalized to MER's physical dimensions

## Active Mars orbiters

Barsoom tracks Mars Odyssey, Mars Reconnaissance Orbiter (MRO), and the ExoMars Trace Gas Orbiter (TGO) from Mars-centred NASA/JPL Horizons osculating elements at 2026-08-07 00:00 TDB. The propagated view is an educational visualization, not a navigation product. Spacecraft remain at physical orbital positions. Their detailed models download only after the player locks onto one, and are normalized to published deployed dimensions.

### Mars Odyssey

- Included asset: `public/models/mars-odyssey-web.glb`
- Original model: NASA Mars Odyssey
- Source: https://science.nasa.gov/3d-resources/mars-odyssey/
- Source repository: https://github.com/nasa/NASA-3D-Resources
- Adaptation: mesh quantization and WebP texture compression; 516,372 bytes and 8,642 triangles

### Mars Reconnaissance Orbiter

- Included asset: `public/models/mars-reconnaissance-orbiter-web.glb`
- Original model: NASA Mars Reconnaissance Orbiter (MRO) (C)
- Source: https://science.nasa.gov/3d-resources/mars-reconnaissance-orbiter-mro-c/
- Source repository: https://github.com/nasa/NASA-3D-Resources
- Adaptation: mesh quantization and WebP texture compression; 410,580 bytes and 14,753 triangles

### Trace Gas Orbiter

- Included asset: `public/models/trace-gas-orbiter-web.glb`
- Original model: ExoMars Trace Gas Orbiter, distributed by NASA Science
- Source: https://science.nasa.gov/resource/trace-gas-orbiter-3d-model/
- Adaptation: mesh quantization with original texture encoding retained; 2,865,068 bytes and 10,179 triangles

NASA is acknowledged as the source of these three downloadable model assets and no endorsement is implied. NASA states that its 3D polygon and texture content is generally not subject to copyright in the United States; NASA identifiers and logos are excluded from that general permission. Usage guidance: https://www.nasa.gov/nasa-brand-center/images-and-media/

- Orbit source: https://ssd.jpl.nasa.gov/horizons/
- Horizons targets: Mars Odyssey (-53), MRO (-74), TGO (-143)
- Centre/frame: Mars-centred ICRF geometric elements transformed into Barsoom's Mars body-fixed frame

## MOLA

Mars macro terrain is derived from the Mars Global Surveyor Mars Orbiter Laser Altimeter Mission Experiment Gridded Data Record:

- Data set: `MGS-M-MOLA-5-MEGDR-L3-V1.0`
- Products: `MEGR90N000EB.IMG` (planetary radius) and `MEGA90N000EB.IMG` (areoid)
- Product version: 2.0, created 2003-04-03
- Producers: MGS MOLA Team / David E. Smith, NASA Goddard Space Flight Center
- Archive: NASA Planetary Data System Geosciences Node, Washington University in St. Louis
- Product page: https://pds-geosciences.wustl.edu/missions/mgs/megdr.html

The PDS product labels state that the radius map represents MOLA altimetry accumulated across the primary and extended Mars Global Surveyor mission, adjusted using the mission crossover solution, in the IAU 2000 body-fixed planetocentric coordinate system.

MOLA supplies physical macro shape only. Barsoom adds deterministic terrain functions and blends in close-range physically based surface maps for ground colour, normal variation and roughness.

## Polar ice surface material

Close views of mapped polar ice fields, including the Spaceman traverse, use the **Ice 001** PBR material from ambientCG. The source maps are stochastically triplanar-mapped in planet-stable metres and colour-graded in the terrain shader; the same ice diffuse, OpenGL normal and roughness response therefore remains attached to the ground across terrain tile and view-mode changes.

- Included assets: `public/textures/mars-ice-diffuse.jpg`, `public/textures/mars-ice-normal-gl.jpg`, `public/textures/mars-ice-roughness.jpg`
- Source asset: https://ambientcg.com/view?id=Ice001
- License: Creative Commons Zero 1.0 Universal (CC0)

## Mars orbital imagery

The far-orbit albedo layer uses NASA's Mars image texture, derived from Viking imagery processed by the USGS and distributed for 3D model texturing.

- Asset: `public/textures/mars-viking-global.jpg`
- Title: *Mars Image Texture*
- Credit: NASA / Jet Propulsion Laboratory / Caltech
- Source page: https://science.nasa.gov/3d-resources/mars/
- Source file: https://assets.science.nasa.gov/content/dam/science/cds/3d/resources/image/mars/Mars.jpg

The orbital image fades out during descent. Near the surface, the physically based procedural material takes over so photographic lighting is not magnified into ground-scale geometry.

## Stars

The embedded subset is processed from HYG Database 4.1 by David Nash / Astronexus, which combines Hipparcos, the Yale Bright Star Catalogue and Gliese data. HYG 4.1 is licensed under Creative Commons Attribution-ShareAlike 4.0 International.

- Source: https://github.com/astronexus/HYG-Database/tree/main/hyg/CURRENT
- License: https://creativecommons.org/licenses/by-sa/4.0/
- Hipparcos catalogue reference: ESA, 1997, *The Hipparcos and Tycho Catalogues*, ESA SP-1200.

## Astronomy Engine

Planet and Sun vectors use Astronomy Engine by Don Cross, MIT licensed. It implements compact VSOP87/NOVAS-derived models and documents verification against NOVAS and JPL Horizons.

- Project: https://github.com/cosinekitty/astronomy
- Installed package: `astronomy-engine` 2.1.19

## Phobos and Deimos

The Mars moon renderer uses physical dimensions, albedo and NASA/JPL Horizons
MAR099 osculating elements. The reference state is 2026-08-06 00:00 TDB, with
local nodal, apsidal and mean-anomaly rates fitted across the following 32 days.
Both irregular meshes remain at physical scale and rotate synchronously toward
Mars. Their detailed equirectangular albedo maps are AI-assisted artistic
interpretations designed to resemble neutral spacecraft surface imaging; they
are not scientific products or spacecraft image mosaics.

- Assets: `public/textures/phobos-albedo.png`, `public/textures/deimos-albedo.png`
- Generated with: OpenAI built-in image generation, 2026-08-06
- Texture brief: shadow-free photorealistic 2:1 global albedo maps; battered,
  grooved Stickney-dominated terrain for Phobos and smoother dust-mantled
  regolith for Deimos

- Orbit source: https://ssd.jpl.nasa.gov/horizons/
- Ephemeris: MAR099 (Phobos 401, Deimos 402, Mars-centred ICRF elements)
- Physical overview: https://science.nasa.gov/mars/moons/facts/
