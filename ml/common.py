"""Shared features, per-method ellipse parameters, and envelope scoring.

Every method reduces to per-pair (theta_deg, lb, rate_kmh), then is calibrated and scored identically.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from ellipse import elliptical_scores, envelope_growth_area, hull_edges

ML = Path(__file__).resolve().parent
DATA, RESULTS = ML / "data", ML / "results"
RATE_EPS = 0.01  # km/h, floor for log-rate targets (zero-growth pairs)

# Features the live app can supply. It passes slope_wind and log_prev_rate as missing (trees handle NaN).
FEATURES = [
    "wind_ms", "gust_max_ms", "rh_pct", "temp_c", "vpd_kpa", "slope_wind",
    "hour_sin", "hour_cos", "month", "log_foot_area", "fuel_class",
    "log_frp_sum", "frp_max_t0", "log_n_det", "log_prev_rate", "night_t0",
]
FUEL_CLASSES = ["grass", "shrub", "timber"]  # fuel_class codes 0, 1, 2


def load_pairs(name: str = "pairs.parquet") -> pd.DataFrame:
    """Pairs >= 2 h apart (shorter ones are below VIIRS's geolocation noise floor), with derived features."""
    d = pd.read_parquet(DATA / name)
    d = d[~d.short_dt].reset_index(drop=True)
    d["log_foot_area"] = np.log1p(d.foot_area_km2)
    d["fuel_class"] = d[[f"fuel_{f}" for f in FUEL_CLASSES]].to_numpy().argmax(axis=1)
    d["downwind_deg"] = (d.wind_from_deg + 180) % 360
    d["log_frp_sum"] = np.log1p(d.frp_sum_t0)
    d["log_n_det"] = np.log1p(d.n_det_t0)
    d["log_prev_rate"] = np.log(d.prev_rate_kmh + RATE_EPS)
    d["night_t0"] = d.night_t0.astype(float)
    # radial label: 90th-pct distance of new pixels from the footprint / dt (0 if no growth)
    d["circ_rate_kmh"] = [
        float(np.quantile(cKDTree(np.reshape(f, (-1, 2))).query(np.reshape(n, (-1, 2)))[0], 0.9)) / 1000 / dt
        if len(n) else 0.0 for n, f, dt in zip(d.new_xy, d.foot_xy, d.dt_h)]
    return d


def angdiff(a, b):
    """Signed smallest difference a - b in degrees, in (-180, 180]."""
    return (np.asarray(a) - np.asarray(b) + 180) % 360 - 180


# ------------------------------------------------------------- per-method parameters
def anderson_lb(wind_ms) -> np.ndarray:
    """Anderson (1983) L:B from midflame wind (mph); 10 m wind x 0.4 midflame factor."""
    u = np.asarray(wind_ms) * 2.237 * 0.4
    lb = 0.936 * np.exp(0.2566 * u) + 0.461 * np.exp(-0.1548 * u) - 0.397
    return np.clip(lb, 1.0, 8.0)


def params_gbdt(models: dict, d: pd.DataFrame) -> pd.DataFrame:
    X = d[FEATURES]
    rate = np.exp(models["log_rate"].predict(X)) - RATE_EPS
    off = np.rad2deg(np.arctan2(models["dir_sin"].predict(X), models["dir_cos"].predict(X)))
    lb = np.clip(np.exp(models["log_lb"].predict(X)), 1.0, 8.0)
    return pd.DataFrame({"theta_deg": (d.downwind_deg + off) % 360, "lb": lb,
                         "rate_kmh": np.maximum(rate, 1e-3)}, index=d.index)


def params_gbdt_circle(models: dict, d: pd.DataFrame) -> pd.DataFrame:
    """Learned radial rate, circular envelope (the deployable model)."""
    rate = np.exp(models["log_circ_rate"].predict(d[FEATURES])) - RATE_EPS
    return pd.DataFrame({"theta_deg": 0.0, "lb": 1.0, "rate_kmh": np.maximum(rate, 1e-3)}, index=d.index)


def params_wind_cone(d: pd.DataFrame) -> pd.DataFrame:
    """Baseline: port of the app's original hand-tuned wind-cone-v1 heuristic."""
    hum = np.select([d.rh_pct < 20, d.rh_pct < 30], [1.4, 1.2], 1.0)
    fuel = np.choose(d.fuel_class.to_numpy(), [1.3, 1.2, 1.0])  # grass, shrub, timber
    rate = 0.6 * (1 + d.wind_ms / 10) * hum * fuel
    return pd.DataFrame({"theta_deg": d.downwind_deg, "lb": 2.0, "rate_kmh": rate}, index=d.index)


def params_circle(d: pd.DataFrame, rate: float) -> pd.DataFrame:
    """Constant-rate circle: the 'no model' envelope (calibration absorbs the scale)."""
    return pd.DataFrame({"theta_deg": 0.0, "lb": 1.0, "rate_kmh": rate}, index=d.index)


def params_anderson(d: pd.DataFrame, rate: float) -> pd.DataFrame:
    """Physics shape only: downwind ellipse with Anderson L:B, constant rate."""
    return pd.DataFrame({"theta_deg": d.downwind_deg, "lb": anderson_lb(d.wind_ms), "rate_kmh": rate}, index=d.index)


# ------------------------------------------------------------- envelope scoring
def growth_geometry(d: pd.DataFrame) -> list[tuple[np.ndarray, np.ndarray]]:
    """(new_xy_km, foot_xy_km) for each pair."""
    return [(np.asarray(n).reshape(-1, 2) / 1000, np.asarray(f).reshape(-1, 2) / 1000)
            for n, f in zip(d.new_xy, d.foot_xy)]


def normalized_scores(d: pd.DataFrame, P: pd.DataFrame, geom) -> list[np.ndarray]:
    """Per-pair s(p) / predicted head distance; p is inside the k-scaled envelope iff score <= k."""
    out = []
    for (new, foot), th, lb, r, dt in zip(geom, P.theta_deg, P.lb, P.rate_kmh, d.dt_h):
        out.append(elliptical_scores(new, foot, th, lb) / (r * dt) if len(new) else np.zeros(0))
    return out


def weighted_quantile(scores: list[np.ndarray], q: float) -> float:
    """Pixel quantile where each pair carries total weight 1 (large fires don't dominate)."""
    s = np.concatenate([x for x in scores if len(x)])
    w = np.concatenate([np.full(len(x), 1.0 / len(x)) for x in scores if len(x)])
    o = np.argsort(s)
    cw = np.cumsum(w[o]) / w.sum()
    return float(s[o][np.searchsorted(cw, q)])


def pair_coverage(scores: list[np.ndarray], k: float) -> np.ndarray:
    return np.array([(x <= k).mean() for x in scores if len(x)])


def envelope_areas(d: pd.DataFrame, P: pd.DataFrame, geom, k: float) -> np.ndarray:
    """Area added by the k-scaled envelope around each pair's local footprint hull."""
    out = []
    for (new, foot), th, lb, r, dt in zip(geom, P.theta_deg, P.lb, P.rate_kmh, d.dt_h):
        out.append(envelope_growth_area(k * r * dt, lb, th, *hull_edges(foot)) if len(new) else np.nan)
    return np.array(out)
