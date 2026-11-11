#!/usr/bin/env python3
"""
Parametric cake swag (drape) stamp.

The tool is a curved backing plate that follows the side of a round cake, with a
thin embossing ridge along its bottom edge. Pressed against the frosting, the
ridge leaves one swag line; repeating it N times around the cake gives N swags
that meet point to point.

Geometry
--------
* The swag line is a hanging cable, designed in the flat "unrolled" side of the
  cake: s = distance along the circumference, z = height. The span is exactly
  1/N of the circumference of the FROSTED cake, and the sag (depth) is the
  requested drop. By default the cable is a garland that is fullest in the
  middle and tapers towards the points, which comes into the points more gently
  than a uniform cable (--taper 0 gives the pure catenary).
* That flat curve is then rolled onto the cylinder by arc length
  (angle = s / R_contact), so the span measured along the cake surface stays
  exactly 1/N of the circumference: N stampings close the loop with no gap and
  no overlap. (A cable hanging on a frictionless vertical cylinder takes this
  same rolled shape, so the curve is physically "right", not just a look-alike.)
* The ridge tip sits on the contact radius R_contact = cake radius + frosting
  allowance. The plate stands off the frosting by the ridge height, so only the
  ridge touches the cake.

Coordinates: cake axis = Z, the tool is centred on +Y, the swag end points are
at z = 0 and the bottom of the swag is at z = -drop. Units are mm.

Usage
-----
    python3 swag_tool.py                       # 7" cake, 1/8" frosting, 5 swags, 2" drop
    python3 swag_tool.py --frosting 0.25       # thicker frosting
    python3 swag_tool.py --cake-diameter 8 --swags 6 --drop 2.5

Needs: cadquery (pip install cadquery), numpy, scipy.
"""

import argparse
import json
import math
import os
from fractions import Fraction

import cadquery as cq
import numpy as np
from scipy.optimize import brentq

IN = 25.4


# ---------------------------------------------------------------------------
# Maths
# ---------------------------------------------------------------------------
def solve_catenary(half_span, sag):
    """Catenary parameter a with  a*(cosh(H/a) - 1) = sag."""
    return brentq(lambda a: a * (math.cosh(half_span / a) - 1.0) - sag,
                  half_span / 50.0, half_span * 100.0, xtol=1e-12)


class SwagCurve:
    """A hanging cable (garland) between the points (+-H, 0), sagging to (0, -sag).

    Its weight per unit length tapers from the middle towards the points:

        w(t) = (1 - taper) + taper * cos(pi t / 2),   t = |x| / H

    and the cable obeys ordinary cable statics, T_h * z'' = w * sqrt(1 + z'^2).
    taper = 0 is a uniform cable, i.e. an exact catenary. taper = 1 is a
    garland that is fullest in the middle and weighs nothing at the points (as
    fabric swags and piped garlands look). For the same span and sag it comes
    into the points less steeply, with a slightly rounder bottom.
    Beyond the points the curve continues with the end weight (used only to run
    cutting surfaces cleanly past the ends of the tool)."""

    def __init__(self, half_span, sag, taper=0.0, extend=10.0, n=40001):
        from scipy.integrate import solve_ivp
        H = self.H = half_span
        self.sag, self.taper = sag, taper
        X = H + extend

        def w(x):
            t = min(abs(x) / H, 1.0)
            return (1.0 - taper) + taper * math.cos(math.pi * t / 2.0)

        def solve(k):
            def f(x, y):
                g = math.sqrt(1.0 + y[1] * y[1])
                return [y[1], k * w(x) * g, g]
            return solve_ivp(f, [0.0, X], [0.0, 0.0, 0.0], method="DOP853",
                             rtol=1e-11, atol=1e-12, dense_output=True)

        k_cat = 1.0 / solve_catenary(H, sag)
        self.k = brentq(lambda k: solve(k).sol(H)[0] - sag, 0.3 * k_cat, 6.0 * k_cat,
                        xtol=1e-14)
        sol = solve(self.k)
        self._x = np.linspace(0.0, X, n)
        y = sol.sol(self._x)
        self._z = y[0] - sag            # z(0) = -sag, z(H) = 0
        self._zp = y[1]
        self._sig = y[2]                 # arc length from the middle
        self._sig_H = float(sol.sol(H)[2])
        self._zp_H = float(sol.sol(H)[1])
        self.bottom_radius = 1.0 / (self.k * w(0.0))

    def length(self):
        return 2.0 * self._sig_H

    def end_angle_deg(self):
        """Angle of the curve to the horizontal at the points."""
        return math.degrees(math.atan(self._zp_H))

    def sigma_of_u(self, u):
        u = np.asarray(u, float)
        return np.sign(u) * np.interp(np.abs(u), self._x, self._sig)

    def u_of_sigma(self, sigma):
        sigma = np.asarray(sigma, float)
        return np.sign(sigma) * np.interp(np.abs(sigma), self._sig, self._x)

    def offset(self, u, n):
        """Point at horizontal position u, offset by n along the outward
        (downward) normal. n > 0 is below/outside the U, n < 0 is inside it."""
        u = np.asarray(u, float)
        z = np.interp(np.abs(u), self._x, self._z)
        zp = np.sign(u) * np.interp(np.abs(u), self._x, self._zp)
        g = np.sqrt(1.0 + zp * zp)
        return u + n * zp / g, z - n / g


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------
def wrap(s, z, r, r_contact):
    """Roll developed (s, z) onto the cylinder of radius r, keeping arc length
    at the contact radius: angle = s / r_contact (0 at +Y)."""
    th = s / r_contact
    return cq.Vector(r * math.sin(th), r * math.cos(th), z)


def wrapped_spline(cat, sigma, n, r, r_contact):
    """Spline through the rolled offset curve, parameterised by the swag
    line's arc length sigma, so curves at different radii/offsets correspond
    point by point (gives clean ruled surfaces between them)."""
    u = cat.u_of_sigma(sigma)
    s, z = cat.offset(u, n)
    pts = [wrap(si, zi, r, r_contact) for si, zi in zip(s, z)]
    return cq.Edge.makeSpline(pts, parameters=[float(v) for v in sigma])


def ruled_through(cat, sigma, sec1, sec2, t_lo, t_hi, r_contact):
    """Ruled surface whose rulings are the exact 3D lines through the rolled
    offset points sec1 = (n1, r1) and sec2 = (n2, r2), extended to line
    parameters t_lo..t_hi (0 at sec1, 1 at sec2)."""
    u = cat.u_of_sigma(sigma)
    (n1, r1), (n2, r2) = sec1, sec2
    s1, z1 = cat.offset(u, n1)
    s2, z2 = cat.offset(u, n2)
    q1 = [wrap(a, b, r1, r_contact) for a, b in zip(s1, z1)]
    q2 = [wrap(a, b, r2, r_contact) for a, b in zip(s2, z2)]
    par = [float(v) for v in sigma]
    lo = [p + (q - p) * t_lo for p, q in zip(q1, q2)]
    hi = [p + (q - p) * t_hi for p, q in zip(q1, q2)]
    return cq.Face.makeRuledSurface(cq.Edge.makeSpline(lo, parameters=par),
                                    cq.Edge.makeSpline(hi, parameters=par))


def annular_wedge(r_in, r_out, z0, z1, half_angle_deg):
    """Solid between two coaxial cylinders, +-half_angle about +Y."""
    h = z1 - z0
    base = cq.Vector(0, 0, z0)
    up = cq.Vector(0, 0, 1)
    outer = cq.Solid.makeCylinder(r_out, h, base, up, 2 * half_angle_deg)
    inner = cq.Solid.makeCylinder(r_in, h, base, up, 2 * half_angle_deg)
    w = outer.cut(inner)
    return w.rotate(cq.Vector(0, 0, 0), up, 90.0 - half_angle_deg)


def keep_piece(shape, point):
    """After a split, return the solid that contains `point`."""
    p = cq.Vector(*point)
    for sol in shape.Solids():
        if sol.isInside(p, 1e-6):
            return sol
    raise RuntimeError(f"no piece contains {point}")


def frac_label(x):
    f = Fraction(x).limit_denominator(64)
    if f.denominator == 1:
        return f"{f.numerator}"
    whole, rem = divmod(f.numerator, f.denominator)
    return (f"{whole} " if whole else "") + f"{rem}/{f.denominator}"


# ---------------------------------------------------------------------------
# The tool
# ---------------------------------------------------------------------------
def build(p):
    R_cake = p.cake_diameter * IN / 2.0
    R_c = R_cake + p.frosting * IN            # ridge tip / frosting surface
    R_pi = R_c + p.ridge_height               # plate inner face
    R_po = R_pi + p.plate_thickness           # plate outer face
    span_angle = 2.0 * math.pi / p.swags      # rad
    half_deg = math.degrees(span_angle / 2.0)
    S = R_c * span_angle                      # developed span = arc length
    D = p.drop * IN
    cat = SwagCurve(S / 2.0, D, p.taper, p.extend + 2.0)

    tip_n = p.tip_width / 2.0                 # bottom edge offset (outer side)
    z_top = p.top_band
    z_lo = -D - 20.0

    # Sample the swag line uniformly by arc length, extended past the end
    # points so every cutting surface runs right through the tool.
    u_ext = cat.H + p.extend
    sig_e = float(cat.sigma_of_u(u_ext))
    sigma = np.linspace(-sig_e, sig_e, p.samples)

    # 1. Annular wedge: tip radius to plate outer radius, exactly +-180/N deg.
    body = annular_wedge(R_c, R_po, z_lo, z_top, half_deg)

    # 2. Bottom edge: radial ruled surface through the rolled curve offset
    #    tip_width/2 below the swag line. Keep everything above it.
    r_a, r_b = R_c - 2.0, R_po + 2.0
    bottom = cq.Face.makeRuledSurface(
        wrapped_spline(cat, sigma, tip_n, r_a, R_c),
        wrapped_spline(cat, sigma, tip_n, r_b, R_c))
    body = keep_piece(body.split(bottom), wrap(0.0, z_top - 1.0, R_po - 0.5, R_c))

    # 3. Ridge: hollow out the layer between the tip radius and the plate,
    #    leaving a ridge whose tip is tip_width wide on the swag line and whose
    #    upper side slopes at 45 deg back to the plate (printable, strong).
    #    Each ruling is the straight line from the tip's inner edge (on the
    #    contact cylinder) to the ridge root (on the plate face), extended a
    #    little both ways so the cut runs clean through.
    h = p.ridge_height
    slope = ruled_through(cat, sigma,
                          (-tip_n, R_c), (-tip_n - h * p.ridge_slope, R_pi),
                          -3.0 / h, 1.0 + 1.0 / h, R_c)
    layer = annular_wedge(R_c - 1.5, R_pi, z_lo, z_top + 5.0, half_deg + 1.5)
    relief = keep_piece(layer.split(slope), wrap(0.0, 0.0, R_pi - 0.3, R_c))
    body = body.cut(relief)

    # 4. Handle fin on the back, centred, standing on the flat top edge
    #    (which is the print-bed face). 45 deg underside, rounded edges.
    y0, y1 = R_po - 1.0, R_po + p.fin_depth
    fin_h = p.fin_height or min(55.0, 0.8 * (D + z_top))
    zf = z_top - fin_h
    fin = (cq.Workplane("YZ")
           .polyline([(y0, z_top), (y1, z_top), (y1, zf + (y1 - y0)), (y0, zf)])
           .close()
           .extrude(p.fin_thickness / 2.0, both=True))
    fin = fin.edges(cq.selectors.BoxSelector(
        (-50, y0 + 0.5, zf - 50), (50, y1 + 50, z_top - 0.5))).fillet(p.fin_fillet)
    fin_solid = fin.val()

    # Labels debossed into the fin's flat faces.
    yc = (y0 + y1) / 2.0 + 1.0
    zc = z_top - fin_h * 0.32
    label_a = f'{frac_label(p.cake_diameter)}in x{p.swags}'
    label_b = f'{frac_label(p.cake_diameter + 2 * p.frosting)}in'
    for side, txt in ((+1, label_a), (-1, label_b)):
        plane = cq.Plane(origin=(side * p.fin_thickness / 2.0, yc, zc),
                         xDir=(0, side, 0), normal=(side, 0, 0))
        t = cq.Workplane(plane).text(txt, p.label_size, -p.label_depth,
                                     kind="bold", font="DejaVu Sans",
                                     halign="center", valign="center",
                                     combine=False)
        fin_solid = fin_solid.cut(t.val())

    body = body.fuse(fin_solid).clean()

    info = {
        "cake_diameter_in": p.cake_diameter,
        "frosting_allowance_in": p.frosting,
        "frosted_diameter_in": round(2 * R_c / IN, 4),
        "swags": p.swags,
        "span_angle_deg": round(math.degrees(span_angle), 4),
        "arc_length_per_swag_in": round(S / IN, 4),
        "arc_length_per_swag_mm": round(S, 3),
        "arc_length_at_bare_cake_in": round(R_cake * span_angle / IN, 4),
        "chord_between_points_in": round(2 * R_c * math.sin(span_angle / 2) / IN, 4),
        "drop_in": p.drop,
        "curve": ("uniform hanging cable (catenary)" if p.taper == 0 else
                  "hanging garland, weight tapering towards the points "
                  "w = (1-taper) + taper*cos(pi*x/span)"),
        "taper": p.taper,
        "swag_line_length_in": round(cat.length() / IN, 4),
        "end_angle_from_horizontal_deg": round(cat.end_angle_deg(), 2),
        "uniform_cable_end_angle_deg": round(math.degrees(math.atan(
            math.sinh(cat.H / solve_catenary(cat.H, D)))), 2),
        "bottom_radius_mm": round(cat.bottom_radius, 2),
        "ridge_tip_radius_mm": round(R_c, 3),
        "plate_inner_radius_mm": round(R_pi, 3),
        "plate_outer_radius_mm": round(R_po, 3),
        "ridge_height_mm": p.ridge_height,
        "tip_width_mm": p.tip_width,
        "top_band_above_points_mm": p.top_band,
        # swag line in the unrolled side of the cake: [s along the cake, z] mm
        "swag_line_unrolled_mm": [[round(float(a), 3), round(float(b), 3)] for a, b in
                                  zip(*cat.offset(np.linspace(-cat.H, cat.H, 161), 0.0))],
    }
    return body, info


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cake-diameter", type=float, default=7.0, help="bare cake diameter, inches")
    ap.add_argument("--frosting", type=float, default=0.125,
                    help="frosting thickness per side, inches (tool fits cake + 2x this)")
    ap.add_argument("--swags", type=int, default=5, help="swags around the cake")
    ap.add_argument("--drop", type=float, default=2.0, help="swag depth, inches")
    ap.add_argument("--taper", type=float, default=1.0,
                    help="0 = uniform hanging cable (pure catenary, steepest at the points); "
                         "1 = garland fullest in the middle, tapering to nothing at the points "
                         "(gentler sides, same span and drop). Default 1")
    ap.add_argument("--ridge-height", type=float, default=3.0, help="mm, plate stand-off from frosting")
    ap.add_argument("--ridge-slope", type=float, default=1.0, help="ridge upper side run/rise (1 = 45 deg)")
    ap.add_argument("--tip-width", type=float, default=1.0, help="mm, width of the embossing tip")
    ap.add_argument("--plate-thickness", type=float, default=3.0, help="mm")
    ap.add_argument("--top-band", type=float, default=0.0,
                    help="mm of plate above the swag points (default 0: the top edge is level "
                         "with the points)")
    ap.add_argument("--fin-depth", type=float, default=22.0, help="mm the handle sticks out")
    ap.add_argument("--fin-height", type=float, default=None,
                    help="mm (default: 70%% of the tool height, at most 55)")
    ap.add_argument("--fin-thickness", type=float, default=6.0, help="mm")
    ap.add_argument("--fin-fillet", type=float, default=2.5, help="mm")
    ap.add_argument("--label-size", type=float, default=4.5, help="mm text height")
    ap.add_argument("--label-depth", type=float, default=0.6, help="mm")
    ap.add_argument("--extend", type=float, default=8.0, help=argparse.SUPPRESS)
    ap.add_argument("--samples", type=int, default=241, help=argparse.SUPPRESS)
    ap.add_argument("--stl-orientation", choices=("print", "cake"), default="print",
                    help="print: flipped onto its flat top edge at z=0, ready to slice (default); "
                         "cake: same coordinates as the STEP (cake axis = Z)")
    ap.add_argument("--out-dir", default=os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument("--name", default=None, help="output base name")
    p = ap.parse_args()
    export(p)


def export(p):
    body, info = build(p)
    name = p.name or "swag_stamp_{}in_{}swags_{}in_drop_{}in_frosted".format(
        f"{p.cake_diameter:g}", p.swags, f"{p.drop:g}",
        f"{p.cake_diameter + 2 * p.frosting:g}")
    os.makedirs(p.out_dir, exist_ok=True)
    step = os.path.join(p.out_dir, name + ".step")
    stl = os.path.join(p.out_dir, name + ".stl")
    cq.exporters.export(body, step)

    mesh_shape = body
    if p.stl_orientation == "print":
        # Upside down on the flat top edge: no supports needed.
        mesh_shape = body.rotate(cq.Vector(0, 0, 0), cq.Vector(0, 1, 0), 180)
        bb = mesh_shape.BoundingBox()
        mesh_shape = mesh_shape.translate(cq.Vector(-(bb.xmin + bb.xmax) / 2,
                                                    -(bb.ymin + bb.ymax) / 2, -bb.zmin))
    cq.exporters.export(mesh_shape, stl, tolerance=0.01, angularTolerance=0.05)
    try:  # drop zero-area slivers OCC sometimes leaves in text, re-check
        import trimesh
        m = trimesh.load(stl)
        m.update_faces(m.nondegenerate_faces(height=1e-6))
        m.remove_unreferenced_vertices()
        m.merge_vertices()
        info["stl_watertight"] = bool(m.is_watertight and m.is_winding_consistent)
        info["stl_triangles"] = int(len(m.faces))
        m.export(stl)
    except ImportError:
        pass
    info["stl_orientation"] = p.stl_orientation
    bb = body.BoundingBox()
    info["size_mm"] = [round(bb.xlen, 1), round(bb.ylen, 1), round(bb.zlen, 1)]
    info["volume_cm3"] = round(body.Volume() / 1000.0, 2)
    info["valid_brep"] = bool(body.isValid())
    with open(os.path.join(p.out_dir, name + ".json"), "w") as f:
        json.dump(info, f, indent=2)
    print(json.dumps(info, indent=2))
    print("wrote", step)
    print("wrote", stl)
    return info


if __name__ == "__main__":
    main()
