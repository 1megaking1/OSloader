# STL Assembler

Drag-and-drop a whole kit of STL parts, laid flat for printing, and get one assembled model back. The tool finds bores, pegs, slots, tabs, rectangular keys and matching split faces on every part, works out how the parts fit together, and exports **one STL file with every part as a separate body** (or a 3MF). It is built for the case where the next tool in your chain, such as MatterHackers' Goop *Filament Paint Match*, a slicer or a renderer, needs the assembled model.

It is a CAD-style assembly workflow made for STLs, where most CAD tools are painful.

![Enclosure kit auto-assembled (exploded view)](docs/screenshot-enclosure.png)

## Use it on your Mac (Intel or Apple silicon)

There is nothing to install.

1. Download **[`dist/STL-Assembler.html`](dist/STL-Assembler.html)**: open it on GitHub, click *Download raw file*, and save it anywhere, e.g. your Desktop.
2. Double-click it. It opens in your default browser. **Chrome** is the fastest; Safari 15+, Edge and Firefox also work.
3. Drag a folder, a `.zip` you downloaded from Printables or Thingiverse, or a handful of `.stl`/`.obj`/`.3mf` files onto the window.

Everything runs locally in the browser. Your files are never uploaded, and the app works offline. Click **Load demo kit** on the start screen to try it without your own files.

## Workflow

1. **Drop the files.** Each part is analysed in parallel (one worker per CPU core), and part pairs are matched in parallel too. Multi-solid ASCII STLs, multi-object OBJ/3MF files and zipped folders are split into separate parts.
2. **Auto-assemble** runs automatically (`A` re-runs it). The largest part becomes the base. You can pick another with *Set as base*, or *Lock* parts you have already positioned.
3. **Review.** Parts with several plausible poses get a yellow **review** tag. Press `R` to jump to each one. The inspector lists its options:
   - Hover an option to see a ghost preview.
   - Click to apply it, or use `[` and `]` to cycle.
   - Press `Enter` to accept.
4. **Pick versions.** Near-identical files (e.g. `arm.stl`, `arm_v2.stl`, `lid_tight.stl`) are detected and **stacked in the same place**. Use *Measure*, *Section* or *Isolate* to compare them, then choose which one to keep with the radio button. The others are left out of the export.
5. **Fix anything by hand** (see below).
6. **Export.** Choose *Export → STL (one file, multiple bodies)*.

![Hinge part with a free angle, alternatives and inferred mates](docs/screenshot-hinge.png)

## What the auto-alignment does

Every part is segmented into surfaces, and these features are detected:

| Feature | Used for |
|---|---|
| **Cylinders**: bores/holes (concave) and pegs/bosses/pins (convex), including partial and D-shaped bores and split half-bores | two bores ↔ two pegs; peg in hole; screw holes lining up across parts (coaxial even across a gap); single bore + rotation search |
| **Flat faces** with their exact outlines | face contact; split parts glued along a cut (the outlines are matched with 2D ICP); lids sitting on floors |
| **Plane pairs**: slots (facing walls) and tabs/ribs/plate thickness (back-to-back walls) | tab centred in a slot with an **even gap** on both sides |
| **Rectangular holes and pegs** (two perpendicular slots or tabs) | rect key in rect hole, at all valid 90°/180° orientations |

For each pair of parts, the matcher generates candidate poses from these correspondences. Any freedom that remains, such as sliding along a pin or turning about a single bore, is resolved by face contacts, slot centring and an angle sweep. Each pose is then scored:

- **Contact.** Surfaces of both parts are sampled against each other's signed distance field. Contact that interlocks in several directions scores higher than one big flat face lying on another.
- **Interpenetration.** Overlapping material counts heavily against a pose, and so do two identical parts in the same spot.
- **Coincident features.** Bores lining up, tabs centred and rect pegs fitting all add to the score, and tighter clearances (0.05–0.3 mm) are preferred.

A global best-first loop then places the most confident part first, re-scoring every remaining option against everything already placed. Ambiguous parts wait until more context exists. Each placed part is **snapped exactly**: the tool infers coaxial, contact, centred and rect mates and solves them with least squares, dropping conflicting mates by priority. You get exact contact and centring instead of approximate poses.

**File names are used as hints.** `pin_x4.stl`, `foot (4x).stl` or `clip 6pcs.stl` get that many copies placed into free matching spots. `_v2`, `rev3`, `copy`, `tight`/`loose` and `(1)` suffixes help group versions. `left`/`right` names are never grouped as versions.

## Manual tools

- **Mate (`M`).** Click a bore, peg or face on the part to move, then the feature to mate it to. The available mates are coaxial (optionally with locked or flipped direction), contact, flush, parallel, *centred (even gap)* and *axis on mid-plane*. Every mate can take an **offset in mm**. Mates can be switched off to free a degree of freedom, or deleted.
- **Free angle.** A part held only by one bore and a mid-plane (a lever on a pivot pin) keeps its rotation free. The inspector shows a *Free rotation* control to set any angle, and its mates stay satisfied.
- **Move / rotate.** Move by an exact X/Y/Z offset, rotate by an exact angle, or use the gizmo (`G` move, `T` rotate). Parts mated to a moved part follow it.
- **Auto-place** a single part, **Snap to neighbours** (infer mates with whatever it touches), **+ copy** (add another instance and auto-place it), **Stack as version of…** (register one part onto another).
- **Measure (`D`).** Diameters, face sizes, gaps between parallel faces, axis distances, radial clearance and angles.
- **Section, Explode, Axes, Collisions.** Section clips the view along X, Y or Z to inspect peg engagement. Explode spreads the parts out. Axes shows the detected bore axes (orange = hole, green = peg). Collisions lists every intersecting pair of parts.
- **Assembly orientation.** *Square to grid* (done automatically) aligns the main faces with X/Y/Z and puts the biggest face down. *Lay flat on face…* and the 90° rotate buttons adjust it from there.
- **Undo/redo**: `⌘Z` / `⌘⇧Z`.

## Export formats

| Format | Notes |
|---|---|
| **STL – one file, multiple bodies (binary)** | Every part stays a separate closed shell, so slicers (*Split to parts/objects*), Fusion (*Separate*), Blender (*Separate by loose parts*) and similar tools split it back into bodies. |
| **STL – named solids (ASCII)** | One `solid <name> … endsolid` block per part. Bigger file, but the part names are kept. |
| **3MF – separate objects** / **one object, multiple parts** | Names kept. The second mode loads as a single multi-part object in PrusaSlicer, Bambu Studio and OrcaSlicer. |
| **ZIP of STLs** | Each part in its assembled position, as its own file. |
| **Project (.json)** / **project + meshes (.zip)** | Poses, mates, versions and copies. Drop the project file together with the STLs (or just the zip) to continue later. |

*Drop assembly onto Z=0* is on by default. Hidden parts are skipped unless *Include hidden parts* is ticked, and excluded parts and non-kept versions are always left out.

## Keyboard

`A` auto-assemble · `R` review next · `[` `]` cycle options · `Enter` accept · `M` mate · `D` measure · `F` fit (selected) · `G`/`T` gizmo · `H` hide · `I` isolate · `Del` exclude/include · `Esc` cancel · double-click a part to zoom to it · hold `Alt` while hovering to name a feature.

## Tips for best results

- The detector is tuned for CAD-exported meshes (Fusion, Onshape, SolidWorks, FreeCAD, OpenSCAD, Blender booleans), where bore and face vertices lie exactly on the true surfaces. Sculpted or scanned parts still assemble through flat cut faces and pin holes, but they have fewer features to match.
- If a fit is looser or tighter than the defaults expect, open ⚙ Settings and adjust the contact distance, the peg and slot clearances, or the screw-hole gap.
- Parts with nothing to mate to (stickers, badges, decorative shells) stay **not placed** next to the assembly. Place them with *Mate* or the gizmo.
- Kits whose parts only connect through hardware that isn't in the files (screws, motors, hotends, bearings) are the hardest case. Expect more parts in *review*, and check them with Section view and Collisions. On the Voron Stealthburner + Clockwork2 STLs (11 parts, about 330k triangles), it takes roughly 10 s: 3 parts are placed confidently, 5 are offered with options, and 3 that only touch through hardware stay unplaced.
- Big parts are fine: a 250k-triangle part analyses in about 9 s on one core, and all parts are analysed in parallel.

## Development

```bash
npm install
```

```bash
npm run build
```

```bash
npm test
```

```bash
npm run test:browser
```

- `npm run build` writes the single-file app `dist/STL-Assembler.html` (`npm run dev` rebuilds on change).
- `npm test` runs the unit tests and the alignment accuracy test on the synthetic kits.
- `npm run test:browser` builds the app and runs the headless UI tests (Playwright + Chromium).
- `node test/gen-fixtures.mjs` regenerates the test kits (built with manifold-3d, then laid flat at random orientations).

Source layout:

```
src/core/   geometry engine (no DOM; runs in workers and in Node)
  stl.js threemf.js zip.js   file formats
  mesh.js                    welding, adjacency, mass properties, connectivity
  segment.js fit.js          planar segmentation, cylinder detection, circle fits
  features.js sdf.js         features, slot/tab pairs, rect holes/pegs, samples, signed distance field
  match.js                   pairwise mating hypotheses and scoring
  assemble.js                versions, global placement, copies, mate inference and snapping
  solver.js                  mate constraint solver (Levenberg–Marquardt) and free-motion analysis
src/app/    browser UI (three.js viewer, worker pool, panels, I/O)
test/       synthetic kits with ground truth, accuracy and browser tests
```

`test/run-tests.mjs` reassembles three synthetic kits (21 files, 27 placed parts including copies) from random lay-flat orientations and compares every pose with ground truth. Parts that are genuinely ambiguous (symmetric keys, a pin that fits two hole types) pass when the correct pose is among the options offered.
