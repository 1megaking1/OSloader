# Nerf blaster test kit

- `parts/`: the 18 STL files of the kit, as published, all exported in one CAD
  frame (square to each other).
- `reference/assembled-reference.stl.zip`: the kit assembled by hand in STL
  Assembler (ASCII STL, one named solid per part). The poses were partly set
  with the gizmo, so they are close to correct but not exact. The back cap is
  about 38° off-square, the trigger and catch about 4–5°.
- `truth.json`: reference poses (file to assembly), extracted from the
  reference with exact vertex correspondence by `node test/real/make-truth.mjs test/real/nerf-blaster`.

Run the benchmark with `npm run test:real`. Rotations in the reference are
snapped to the nearest 90° step before comparing (when within 6°).
Alternatives that are not in the reference (`Back_Picatinny_V1`,
`Carriage_Bearing_V2`, `Side_Pic_Rail_V2`) are reported without a score.
