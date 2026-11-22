"""Rear-focus fire ellipse geometry shared by labeling, calibration, and evaluation.

An ellipse with rear focus f, spread direction u, eccentricity e, and head distance h
(focus to head) contains p iff

    s(p; f) = (|p - f| - e * (p - f) . u) / (1 - e)  <=  h,

from the polar form r(phi) = h (1 - e) / (1 - e cos phi); e = 0 gives Euclidean distance.
The Huygens envelope is the union over footprint points, so s(p) = min_f s(p; f) and the
k-scaled envelope contains p iff s(p) <= k * h.
"""

from __future__ import annotations

import numpy as np

LB_GRID = np.array([1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0])
THETA_GRID_DEG = np.arange(0, 360, 10.0)


def ecc_from_lb(lb: np.ndarray | float) -> np.ndarray | float:
    """Eccentricity from length-to-breadth ratio (b/a = 1/LB)."""
    lb = np.maximum(lb, 1.0)
    return np.sqrt(1.0 - 1.0 / lb**2)


def bearing_to_unit(theta_deg: float) -> np.ndarray:
    """Compass bearing (deg clockwise from north) -> unit vector (east, north)."""
    t = np.deg2rad(theta_deg)
    return np.array([np.sin(t), np.cos(t)])


def elliptical_scores(
    new_xy: np.ndarray, foot_xy: np.ndarray, theta_deg: float, lb: float
) -> np.ndarray:
    """s(p) = min_f s(p; f) for each new pixel p (same units as the coordinates)."""
    if len(new_xy) == 0:
        return np.zeros(0)
    d = new_xy[:, None, :] - foot_xy[None, :, :]  # (N, F, 2)
    r = np.linalg.norm(d, axis=2)
    e = float(ecc_from_lb(lb))
    proj = d @ bearing_to_unit(theta_deg)
    return ((r - e * proj) / (1.0 - e)).min(axis=1)


def hull_edges(xy: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Convex-hull edge lengths and outward unit normals (empty if degenerate)."""
    from scipy.spatial import ConvexHull, QhullError

    if len(xy) < 3:
        return np.zeros(0), np.zeros((0, 2))
    try:
        hull = ConvexHull(xy)
    except QhullError:
        return np.zeros(0), np.zeros((0, 2))
    v = xy[hull.vertices]  # counter-clockwise
    edge = np.roll(v, -1, axis=0) - v
    length = np.linalg.norm(edge, axis=1)
    normal = np.stack([edge[:, 1], -edge[:, 0]], axis=1) / np.maximum(length, 1e-12)[:, None]
    return length, normal


def envelope_growth_area(
    head: float, lb: float, theta_deg: float, edge_len: np.ndarray, edge_normal: np.ndarray
) -> float:
    """area(K (+) E) - area(K) for convex K = sum_i L_i h_E(n_i) + area(E) (Steiner formula).

    h_E is the support function of E centered at the origin (the focus offset integrates to zero)."""
    e = float(ecc_from_lb(lb))
    a = head / (1.0 + e)
    b = a / lb
    u = bearing_to_unit(theta_deg)
    v = np.array([u[1], -u[0]])
    support = np.sqrt(a**2 * (edge_normal @ u) ** 2 + b**2 * (edge_normal @ v) ** 2)
    return float((edge_len * support).sum() + np.pi * a * b)


def fit_tightest_ellipse(
    new_xy: np.ndarray, foot_xy: np.ndarray, hull_xy: np.ndarray | None = None, q: float = 0.9
) -> tuple[float, float, float]:
    """Grid-search (theta_deg, lb, head) covering fraction q of new pixels with least added area over hull_xy."""
    edge_len, edge_normal = hull_edges(foot_xy if hull_xy is None else hull_xy)
    d = new_xy[:, None, :] - foot_xy[None, :, :]
    r = np.linalg.norm(d, axis=2)
    best = (np.nan, np.nan, np.nan, np.inf)
    for theta in THETA_GRID_DEG:
        proj = d @ bearing_to_unit(theta)
        for lb in LB_GRID:
            e = float(ecc_from_lb(lb))
            head = float(np.quantile(((r - e * proj) / (1.0 - e)).min(axis=1), q))
            area = envelope_growth_area(head, lb, theta, edge_len, edge_normal)
            if area < best[3]:
                best = (float(theta), float(lb), head, area)
    return best[0], best[1], best[2]
