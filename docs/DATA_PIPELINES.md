# Static data pipelines

Both pipelines are deterministic, build-time tools. Runtime code performs no catalogue or PDS downloads.

## MOLA planetary radius and areoid

Source products:

- `MEGR90N000EB.IMG` — MOLA mean planetary radius, global 16 pixels/degree.
- `MEGA90N000EB.IMG` — MOLA areoid radius, global 16 pixels/degree.
- Data set `MGS-M-MOLA-5-MEGDR-L3-V1.0`, final product version 2.0, IAU 2000 planetocentric, east-positive longitude.

Download the two `.IMG` files and their detached `.LBL` files from the URLs in `public/data/mola/manifest.json`, then run:

```bash
node scripts/preprocess-mola.mjs \
  --radius path/to/megr90n000eb.img \
  --areoid path/to/mega90n000eb.img \
  --out public/data/mola \
  --max-lod 4 \
  --grid 65
```

The script validates label dimensions, big-endian signed 16-bit encoding, byte length and longitude direction. It applies PDS `OFFSET`/`SCALING_FACTOR`, wraps 0–360° longitude, clamps the poles, bilinearly samples the simple-cylindrical source at exact cube-sphere directions, and writes every LOD independently from the source. The runtime worker then samples those elevations into each mesh vertex before rendering. Independent inclusive border sampling keeps parent levels and face edges deterministic.

Runtime format `MOL2` stores two little-endian signed-int16 metre grids per tile: radius relative to 3,389,500 m and areoid radius relative to the same reference. A 24-byte header contains key, range metadata and payload CRC32. The manifest records SHA-256, CRC32, sizes, source products and preprocessing settings for all 2,046 files. Ordinary HTTP cache headers cache tile requests.

## Bright-star catalogue

Download HYG 4.1 `hygdata_v41.csv` and run:

```bash
node scripts/preprocess-stars.mjs path/to/hygdata_v41.csv public/data/stars
```

The script filters to apparent magnitude ≤ 6.25, sorts by brightness, and writes 16-byte binary records containing J2000 RA/declination, apparent visual magnitude, B−V colour index and Hipparcos ID. The committed catalogue contains 6,682 stars in 106,924 bytes instead of loading the 33.9 MB source CSV. Bright proper names are a separate optional JSON asset.
