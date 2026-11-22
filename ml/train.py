"""Train GBDT regressors for the ellipse parameters on the train split (fire-grouped 5-fold CV).

Targets: log_rate and log_circ_rate (growth pairs), dir_sin/dir_cos vs downwind (L:B >= 1.5), log_lb (shape labels).
Usage: ml/.venv/bin/python ml/train.py
"""

from __future__ import annotations

import json
import pickle

import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.model_selection import GroupKFold, cross_val_score

from common import FEATURES, RATE_EPS, RESULTS, angdiff, load_pairs

GRID = [
    {"learning_rate": 0.05, "max_iter": 300, "max_leaf_nodes": 15, "min_samples_leaf": 40},
    {"learning_rate": 0.05, "max_iter": 300, "max_leaf_nodes": 31, "min_samples_leaf": 20},
    {"learning_rate": 0.03, "max_iter": 500, "max_leaf_nodes": 7, "min_samples_leaf": 60},
    {"learning_rate": 0.1, "max_iter": 150, "max_leaf_nodes": 15, "min_samples_leaf": 80},
]


def fit(X, y, groups, name):
    cat = [FEATURES.index("fuel_class")]
    best, best_score = None, -np.inf
    for hp in GRID:
        m = HistGradientBoostingRegressor(categorical_features=cat, l2_regularization=1.0, random_state=0, **hp)
        sc = cross_val_score(m, X, y, groups=groups, cv=GroupKFold(5), scoring="neg_mean_squared_error").mean()
        if sc > best_score:
            best, best_score = hp, sc
    cv_mse, var = -best_score, float(np.var(y))
    print(f"  {name:8s} n={len(y):5d}  CV MSE={cv_mse:.3f}  var(y)={var:.3f}  R2~{1 - cv_mse / var:.3f}  {best}")
    m = HistGradientBoostingRegressor(categorical_features=cat, l2_regularization=1.0, random_state=0, **best)
    return m.fit(X, y), {"cv_mse": cv_mse, "var_y": var, "hp": best, "n": int(len(y))}


def main():
    d = load_pairs()
    tr = d[d.split == "train"]
    print(f"train: {len(tr)} pairs from {tr.fire_id.nunique()} fires")
    models, info = {}, {}

    g = tr[tr.n_new > 0]
    models["log_rate"], info["log_rate"] = fit(
        g[FEATURES], np.log(g.rate_kmh + RATE_EPS).to_numpy(), g.fire_id, "log_rate")

    models["log_circ_rate"], info["log_circ_rate"] = fit(
        g[FEATURES], np.log(g.circ_rate_kmh + RATE_EPS).to_numpy(), g.fire_id, "circ_rate")

    sh = tr[tr.lb >= 1.5]
    off = np.deg2rad(angdiff(sh.theta_deg.to_numpy(), sh.downwind_deg.to_numpy()))
    models["dir_sin"], info["dir_sin"] = fit(sh[FEATURES], np.sin(off), sh.fire_id, "dir_sin")
    models["dir_cos"], info["dir_cos"] = fit(sh[FEATURES], np.cos(off), sh.fire_id, "dir_cos")

    lb = tr[tr.lb.notna()]
    models["log_lb"], info["log_lb"] = fit(lb[FEATURES], np.log(lb.lb).to_numpy(), lb.fire_id, "log_lb")

    RESULTS.mkdir(exist_ok=True)
    with open(RESULTS / "models.pkl", "wb") as f:
        pickle.dump({"models": models, "features": FEATURES}, f)
    (RESULTS / "train_info.json").write_text(json.dumps(info, indent=2))
    print(f"-> {RESULTS / 'models.pkl'}")


if __name__ == "__main__":
    main()
