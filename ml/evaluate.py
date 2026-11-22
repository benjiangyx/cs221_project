"""Evaluate all methods on held-out test fires (or --holdout 2025) after calibrate.py.

Envelope coverage, added area, and area vs the constant circle (fire bootstrap CI); log-rate MAE and direction error.
Usage: ml/.venv/bin/python ml/evaluate.py [--holdout]
"""

from __future__ import annotations

import json
import pickle

import matplotlib
import numpy as np
import pandas as pd

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

from calibrate import LEVELS, method_params  # noqa: E402
from common import (RATE_EPS, RESULTS, angdiff, envelope_areas, growth_geometry, load_pairs,  # noqa: E402
                    normalized_scores, pair_coverage)

LABELS = {
    "circle_const": "Constant-rate circle (no model)",
    "wind_cone_v1": "App heuristic (wind-cone-v1)",
    "anderson_const": "Anderson wind ellipse",
    "gbdt": "GBDT (rate + direction + L:B)",
    "gbdt_rate_anderson_shape": "GBDT rate + Anderson shape",
    "gbdt_rate_circle": "GBDT ellipse-head rate + circle",
    "gbdt_circle": "GBDT radial rate + circle (deployable)",
}
REF = "circle_const"


def bootstrap_ci(log_ratio: np.ndarray, fires: np.ndarray, n=2000, seed=0):
    rng = np.random.default_rng(seed)
    uf = np.unique(fires)
    by = {f: log_ratio[fires == f] for f in uf}
    stats = [np.mean(np.concatenate([by[f] for f in rng.choice(uf, len(uf))])) for _ in range(n)]
    return float(np.exp(np.percentile(stats, 2.5))), float(np.exp(np.percentile(stats, 97.5)))


def main():
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--holdout", action="store_true", help="evaluate on the untouched 2025 fires")
    args = ap.parse_args()
    split, tag = ("holdout", "_holdout") if args.holdout else ("test", "")
    d = load_pairs("pairs_2025.parquet" if args.holdout else "pairs.parquet")
    if args.holdout:  # constant radial baseline still comes from the 2018-24 train split
        d_train = load_pairs()
        d = pd.concat([d, d_train[d_train.split == "train"]], ignore_index=True)
    models = pickle.load(open(RESULTS / "models.pkl", "rb"))["models"]
    calib = json.loads((RESULTS / "calibration.json").read_text())
    te_all = d[d.split == split]
    te = te_all[te_all.n_new > 0].reset_index(drop=True)
    geom = growth_geometry(te)
    params = method_params(te, models, calib["const_rate_kmh"])

    res, areas = {}, {}
    for name, P in params.items():
        sc = normalized_scores(te, P, geom)
        ks = calib["k"][name]
        k90 = ks["0.9"]
        areas[name] = envelope_areas(te, P, geom, k90)
        res[name] = {
            "coverage90": float(pair_coverage(sc, k90).mean()),
            "frac_pairs_cov_ge_90": float((pair_coverage(sc, k90) >= 0.9).mean()),
            "reliability": {a: float(pair_coverage(sc, ks[a]).mean()) for a in ks},
            "mean_area_km2": float(np.nanmean(areas[name])),
            "median_area_km2": float(np.nanmedian(areas[name])),
            "median_area_over_actual": float(np.nanmedian(areas[name] / te.new_area_km2)),
        }
    for name in params:
        lr = np.log(areas[name]) - np.log(areas[REF])
        ok = np.isfinite(lr)
        res[name]["rel_area_vs_circle"] = float(np.exp(lr[ok].mean()))
        res[name]["rel_area_ci95"] = bootstrap_ci(lr[ok], te.fire_id.to_numpy()[ok])

    y =np.log(te.rate_kmh + RATE_EPS)
    point = {
        "rate_mae_log": {
            "gbdt": float(np.abs(np.log(params["gbdt"].rate_kmh + RATE_EPS) - y).mean()),
            "wind_cone_v1": float(np.abs(np.log(params["wind_cone_v1"].rate_kmh + RATE_EPS) - y).mean()),
            "gbdt_circle (vs radial label)": float(np.abs(np.log(params["gbdt_circle"].rate_kmh + RATE_EPS)
                                                            - np.log(te.circ_rate_kmh + RATE_EPS)).mean()),
            "const_median (vs radial label)": float(np.abs(
                np.log(d[(d.split == "train") & (d.n_new > 0)].circ_rate_kmh.median() + RATE_EPS)
                - np.log(te.circ_rate_kmh + RATE_EPS)).mean()),
            "const_median": float(np.abs(np.log(calib["const_rate_kmh"] + RATE_EPS) - y).mean()),
        }
    }
    sh = te[te.lb >= 1.5]
    point["direction_median_abs_err_deg"] = {
        "gbdt": float(np.median(np.abs(angdiff(params["gbdt"].loc[sh.index].theta_deg, sh.theta_deg)))),
        "downwind": float(np.median(np.abs(angdiff(sh.downwind_deg, sh.theta_deg)))),
        "random_expected": 90.0,
    }
    point["n_shape_pairs"] = int(len(sh))

    out = {"n_test_growth_pairs": int(len(te)), "n_test_fires": int(te.fire_id.nunique()),
           "n_test_pairs_all": int(len(te_all)), "envelope": res, "point": point}
    (RESULTS / f"metrics{tag}.json").write_text(json.dumps(out, indent=2))

    rows = [{"method": LABELS[n], "coverage@90": r["coverage90"], "median area km2": r["median_area_km2"],
             "area vs circle": f"{r['rel_area_vs_circle']:.2f} [{r['rel_area_ci95'][0]:.2f}, {r['rel_area_ci95'][1]:.2f}]"}
            for n, r in res.items()]
    tab = pd.DataFrame(rows)
    print(f"\n{split.upper()}: {len(te)} growth pairs from {te.fire_id.nunique()} held-out fires\n")
    print(tab.to_string(index=False, float_format=lambda v: f"{v:.3f}"))
    print("\nrate MAE (log):", {k: round(v, 3) for k, v in point["rate_mae_log"].items()})
    print("direction median |err| (deg):", {k: round(v, 1) for k, v in point["direction_median_abs_err_deg"].items()},
          f"(n={len(sh)})")
    (RESULTS / f"results_table{tag}.md").write_text(tab.to_markdown(index=False, floatfmt=".3f") if hasattr(tab, "to_markdown") else tab.to_string())

    figs = RESULTS / "figs"
    figs.mkdir(parents=True, exist_ok=True)
    fig, ax = plt.subplots(1, 2, figsize=(11, 4.2))
    for name, r in res.items():
        ax[0].plot(LEVELS, [r["reliability"][str(a)] for a in LEVELS], "o-", label=LABELS[name], ms=4)
    ax[0].plot([0.45, 1], [0.45, 1], "k--", lw=1, label="perfect calibration")
    ax[0].set(xlabel="nominal coverage (set on calibration fires)", ylabel="empirical coverage (test fires)",
              title=f"Calibration on held-out fires ({'2025 holdout' if args.holdout else 'test split'})")
    ax[0].legend(fontsize=7)
    order = sorted(res, key=lambda n: res[n]["rel_area_vs_circle"])
    vals = [res[n]["rel_area_vs_circle"] for n in order]
    err = np.array([[v - res[n]["rel_area_ci95"][0], res[n]["rel_area_ci95"][1] - v] for n, v in zip(order, vals)]).T
    ax[1].barh([LABELS[n] for n in order], vals, xerr=err, color="#e76f51", alpha=0.8)
    ax[1].axvline(1, color="k", lw=1)
    ax[1].set(xlabel="area vs constant circle at 90% coverage (lower = sharper)",
              title="Sharpness at equal coverage")
    ax[1].tick_params(axis="y", labelsize=8)
    plt.tight_layout()
    plt.savefig(figs / f"calibration_sharpness{tag}.png", dpi=130)
    print(f"-> {RESULTS / f'metrics{tag}.json'}, {figs / f'calibration_sharpness{tag}.png'}")


if __name__ == "__main__":
    main()
