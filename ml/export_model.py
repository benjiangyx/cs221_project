"""Export the deployable spread model to data/models/spread_gbdt.json and tests/fixtures/gbdt_parity.json.

The JSON tree walker is checked against sklearn's predict() before anything is written.
Usage: ml/.venv/bin/python ml/export_model.py
"""

from __future__ import annotations

import json
import math
import pickle
import sys

import numpy as np

from common import FEATURES, FUEL_CLASSES, ML, RATE_EPS, RESULTS, load_pairs

REPO = ML.parent
MODEL_KEY, METHOD = "log_circ_rate", "gbdt_circle"
ELL_MODEL_KEY, ELL_METHOD = "log_rate", "gbdt_rate_anderson_shape"


def column_maps(model) -> tuple[list[int], dict[int, list]]:
    """(transformed -> FEATURES index, per-categorical ordinal -> raw category); sklearn moves categoricals first."""
    pp = model._preprocessor
    masks = {name: list(cols) for name, _, cols in pp.transformers_}
    order = [i for i, m in enumerate(masks["encoder"]) if m] + [i for i, m in enumerate(masks["numerical"]) if m]
    cats = {j: list(c) for j, c in enumerate(pp.named_transformers_["encoder"].categories_)}
    return order, cats


def export_tree(pred, order: list[int], cats: dict[int, list]) -> dict:
    n = pred.nodes
    bits = pred.raw_left_cat_bitsets
    nodes = []
    for i in range(len(n)):
        if n["is_leaf"][i]:
            nodes.append({"leaf": float(n["value"][i])})
            continue
        fi = int(n["feature_idx"][i])
        node = {"f": order[fi], "l": int(n["left"][i]), "r": int(n["right"][i]),
                "m": bool(n["missing_go_to_left"][i])}
        if n["is_categorical"][i]:
            b = bits[n["bitset_idx"][i]]
            ords = [c for c in range(32 * len(b)) if (int(b[c >> 5]) >> (c & 31)) & 1]
            node["cats"] = [int(cats[fi][o]) for o in ords if o < len(cats[fi])]
        else:
            # +inf thresholds (missing-only splits) aren't valid JSON; max double gives the same v <= t for finite v.
            t = float(n["num_threshold"][i])
            node["t"] = sys.float_info.max if t == math.inf else t
        nodes.append(node)
    return {"nodes": nodes}


def walk(model_json: dict, x: list[float]) -> float:
    """Reference walker (mirrors lib/spread-gbdt.ts)."""
    out = model_json["baseline"]
    for tree in model_json["trees"]:
        nodes, i = tree["nodes"], 0
        while "leaf" not in nodes[i]:
            nd, v = nodes[i], x[nodes[i]["f"]]
            if v is None or (isinstance(v, float) and math.isnan(v)):
                go_left = nd["m"]
            elif "cats" in nd:
                go_left = int(v) in nd["cats"]
            else:
                go_left = v <= nd["t"]
            i = nd["l"] if go_left else nd["r"]
        out += nodes[i]["leaf"]
    return out


def main():
    models = pickle.load(open(RESULTS / "models.pkl", "rb"))["models"]
    model = models[MODEL_KEY]
    calib = json.loads((RESULTS / "calibration.json").read_text())
    test = json.loads((RESULTS / "metrics.json").read_text())
    hold = json.loads((RESULTS / "metrics_holdout.json").read_text())

    mj = {
        "model": "gbdt-conformal-v1",
        "target": "log(radial 90th-pct growth rate km/h + eps); envelope radius = k * rate * hours",
        "rate_eps": RATE_EPS,
        "features": FEATURES,
        "fuel_classes": FUEL_CLASSES,
        "baseline": float(np.ravel(model._baseline_prediction)[0]),
        "trees": [export_tree(t[0], *column_maps(model)) for t in model._predictors],
        "k": {a: calib["k"][METHOD][a] for a in calib["k"][METHOD]},
        "eval": {
            "calibration_fires": calib["n_cal_fires"],
            "test_fires": test["n_test_fires"],
            "test_coverage90": test["envelope"][METHOD]["coverage90"],
            "holdout_2025_fires": hold["n_test_fires"],
            "holdout_2025_coverage90": hold["envelope"][METHOD]["coverage90"],
            "direction_median_err_deg_downwind": test["point"]["direction_median_abs_err_deg"]["downwind"],
        },
    }

    # Optional wind ellipse (GBDT head rate + Anderson shape); the app defaults to the sharper circle.
    ell_model = models[ELL_MODEL_KEY]
    mj["shapes"] = {
        "wind_ellipse": {
            "description": "GBDT head rate + Anderson wind L:B, major axis downwind; envelope head distance = k * rate * hours",
            "baseline": float(np.ravel(ell_model._baseline_prediction)[0]),
            "trees": [export_tree(t[0], *column_maps(ell_model)) for t in ell_model._predictors],
            "k": {a: calib["k"][ELL_METHOD][a] for a in calib["k"][ELL_METHOD]},
            "lb_max": 8.0,
            "midflame_factor": 0.4,
            "eval": {
                "test_coverage90": test["envelope"][ELL_METHOD]["coverage90"],
                "holdout_2025_coverage90": hold["envelope"][ELL_METHOD]["coverage90"],
                "test_area_vs_circle": test["envelope"][ELL_METHOD]["rel_area_vs_circle"],
                "holdout_2025_area_vs_circle": hold["envelope"][ELL_METHOD]["rel_area_vs_circle"],
            },
        }
    }

    # parity on real rows, including missing prev rate / slope
    d = load_pairs()
    rows = d.sample(20, random_state=0)[FEATURES].astype(float)
    rows.iloc[0, FEATURES.index("log_prev_rate")] = np.nan
    rows.iloc[1, FEATURES.index("slope_wind")] = np.nan
    sk = model.predict(rows)
    js = np.array([walk(mj, [None if np.isnan(v) else float(v) for v in r]) for r in rows.to_numpy()])
    err = float(np.abs(sk - js).max())
    assert err < 1e-9, f"walker mismatch {err}"
    print(f"walker parity OK on 20 rows (max |diff| = {err:.2e}); {len(mj['trees'])} trees")
    ell = mj["shapes"]["wind_ellipse"]
    sk_ell = ell_model.predict(rows)
    js_ell = np.array([walk(ell, [None if np.isnan(v) else float(v) for v in r]) for r in rows.to_numpy()])
    err_ell = float(np.abs(sk_ell - js_ell).max())
    assert err_ell < 1e-9, f"wind_ellipse walker mismatch {err_ell}"
    print(f"wind_ellipse parity OK (max |diff| = {err_ell:.2e}); {len(ell['trees'])} trees")

    (REPO / "data" / "models").mkdir(parents=True, exist_ok=True)
    # allow_nan=False: fail rather than write NaN/Infinity, which JSON.parse rejects
    (REPO / "data" / "models" / "spread_gbdt.json").write_text(json.dumps(mj, separators=(",", ":"), allow_nan=False))
    (REPO / "tests" / "fixtures").mkdir(parents=True, exist_ok=True)
    (REPO / "tests" / "fixtures" / "gbdt_parity.json").write_text(json.dumps({
        "features": FEATURES,
        "rows": [[None if np.isnan(v) else float(v) for v in r] for r in rows.to_numpy()],
        "predictions": sk.tolist(),
        "wind_ellipse_predictions": sk_ell.tolist(),
    }, indent=1))
    size = (REPO / "data" / "models" / "spread_gbdt.json").stat().st_size
    print(f"-> data/models/spread_gbdt.json ({size / 1024:.0f} KB), tests/fixtures/gbdt_parity.json")


if __name__ == "__main__":
    main()
