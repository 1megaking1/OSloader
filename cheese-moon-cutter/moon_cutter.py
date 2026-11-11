#!/usr/bin/env python3
"""
Crescent moon cutter for cheese (1" moon).

The cut shape is a circle with an offset circle taken out of it:

    moon  = circle of diameter D
    bite  = circle of radius bite * R, centre offset * R towards +X
    horns = rounded with a small radius so the cheese tips don't snap off

The default bite (0.82 R at 0.42 R) puts the horn tips exactly at
(0.6 R, +-0.8 R) and leaves the back of the moon 0.6 R (7.6 mm) thick.

The blade's INSIDE face is the exact moon outline and is vertical, so the cheese
comes out the true size and releases cleanly. The OUTSIDE face tapers from
--wall-base at the top to --wall-edge at the cutting edge. A flat disk on top,
with a moon-shaped opening, stiffens the blade, gives a finger something to
press on, and lets you push the cheese out.

Built in print orientation: the disk lies on the bed at z = 0 and the cutting
edge points up. No supports. Units are mm.

    python3 moon_cutter.py                        # 1" moon
    python3 moon_cutter.py --diameter 1.5         # 1.5" moon
    python3 moon_cutter.py --bite 0.86 --offset 0.38   # slimmer crescent

Needs: cadquery (pip install cadquery); trimesh for the STL check.
"""

import argparse
import json
import math
import os

import cadquery as cq

IN = 25.4


def moon_face(R, bite, offset, tip_round):
    sk = (cq.Sketch().circle(R)
          .push([(offset * R, 0.0)]).circle(bite * R, mode="s")
          .reset().vertices().fillet(tip_round))
    return sk._faces.Faces()[0]


def build(p):
    R = p.diameter * IN / 2.0
    moon = moon_face(R, p.bite, p.offset, p.tip_round)
    outline = moon.outerWire()
    H = p.height

    # Blade: tapered outer face, exact vertical inner face.
    taper = math.degrees(math.atan((p.wall_base - p.wall_edge) / H))
    outer = outline.offset2D(p.wall_base, "arc")[0]
    blade = cq.Solid.extrudeLinear(outer, [], cq.Vector(0, 0, H), taper)

    # Top disk (on the bed): round, covering the moon's outline plus the wall.
    disk_r = R + p.wall_base + p.rim
    disk = cq.Solid.makeCylinder(disk_r, p.disk_thickness)

    hole = cq.Solid.extrudeLinear(outline, [], cq.Vector(0, 0, H + 2.0)).translate(
        cq.Vector(0, 0, -1.0))
    body = blade.fuse(disk).cut(hole).clean()

    # Soften the disk's upper outer edge (not the bed edge).
    rim_edges = [e for e in body.Edges() if e.geomType() == "CIRCLE"
                 and abs(e.radius() - disk_r) < 1e-6
                 and abs(e.Center().z - p.disk_thickness) < 1e-6]
    body = body.fillet(min(0.6, p.disk_thickness * 0.4), rim_edges)

    x_tip = (p.offset ** 2 + 1 - p.bite ** 2) / (2 * p.offset) * R
    info = {
        "moon_diameter_in": p.diameter,
        "moon_diameter_mm": round(2 * R, 3),
        "bite_radius_mm": round(p.bite * R, 3),
        "bite_offset_mm": round(p.offset * R, 3),
        "back_thickness_mm": round(R - p.bite * R + p.offset * R, 2),
        "horn_tips_mm": [round(x_tip, 2), round(math.sqrt(R * R - x_tip * x_tip), 2)],
        "horn_tip_radius_mm": p.tip_round,
        "moon_area_mm2": round(moon.Area(), 2),
        "height_mm": H,
        "wall_at_disk_mm": p.wall_base,
        "wall_at_cutting_edge_mm": p.wall_edge,
        "blade_taper_deg": round(taper, 3),
        "disk_diameter_mm": round(2 * disk_r, 2),
        "disk_thickness_mm": p.disk_thickness,
        "max_cheese_thickness_mm": round(H - p.disk_thickness, 1),
    }
    return body, info


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--diameter", type=float, default=1.0, help="moon diameter, inches")
    ap.add_argument("--bite", type=float, default=0.82, help="bite circle radius / moon radius")
    ap.add_argument("--offset", type=float, default=0.42, help="bite centre offset / moon radius")
    ap.add_argument("--tip-round", type=float, default=0.5, help="mm radius on the horn tips")
    ap.add_argument("--height", type=float, default=15.0, help="mm, disk to cutting edge")
    ap.add_argument("--wall-base", type=float, default=1.2, help="mm wall thickness at the disk")
    ap.add_argument("--wall-edge", type=float, default=0.5, help="mm wall thickness at the cutting edge")
    ap.add_argument("--rim", type=float, default=2.5, help="mm the disk extends past the wall")
    ap.add_argument("--disk-thickness", type=float, default=1.6, help="mm")
    ap.add_argument("--out-dir", default=os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument("--name", default=None)
    p = ap.parse_args()

    body, info = build(p)
    name = p.name or f"crescent_moon_cutter_{p.diameter:g}in"
    os.makedirs(p.out_dir, exist_ok=True)
    step = os.path.join(p.out_dir, name + ".step")
    stl = os.path.join(p.out_dir, name + ".stl")
    cq.exporters.export(body, step)
    cq.exporters.export(body, stl, tolerance=0.005, angularTolerance=0.05)
    try:
        import trimesh
        m = trimesh.load(stl)
        m.update_faces(m.nondegenerate_faces(height=1e-6))
        m.remove_unreferenced_vertices()
        m.merge_vertices()
        info["stl_watertight"] = bool(m.is_watertight and m.is_winding_consistent)
        m.export(stl)
    except ImportError:
        pass
    bb = body.BoundingBox()
    info["size_mm"] = [round(bb.xlen, 2), round(bb.ylen, 2), round(bb.zlen, 2)]
    info["volume_cm3"] = round(body.Volume() / 1000.0, 3)
    info["valid_brep"] = bool(body.isValid())
    with open(os.path.join(p.out_dir, name + ".json"), "w") as f:
        json.dump(info, f, indent=2)
    print(json.dumps(info, indent=2))
    print("wrote", step)
    print("wrote", stl)


if __name__ == "__main__":
    main()
