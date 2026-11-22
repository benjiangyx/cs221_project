"""Split-conformal calibration of envelope scale k per method on the calibration split.

k_alpha is the pair-weighted alpha-quantile of normalized scores; constant baselines use the median train rate.
Usage: ml/.venv/bin/python ml/calibrate.py
"""

from __future__ import annotations

import json
import pickle

from common import (RESULTS, growth_geometry, load_pairs, normalized_scores, params_anderson, params_circle,
                    params_gbdt, params_gbdt_circle, params_wind_cone, weighted_quantile)

LEVELS = [0.5, 0.7, 0.8, 0.9, 0.95]


def method_params(d, models, const_rate):
    return {
        "gbdt": params_gbdt(models, d),
        "wind_cone_v1": params_wind_cone(d),
        "circle_const": params_circle(d, const_rate),
        "anderson_const": params_anderson(d, const_rate),
        # ablations
        "gbdt_circle": params_gbdt_circle(models, d),
        "gbdt_rate_circle": params_circle(d, 0).assign(rate_kmh=params_gbdt(models, d).rate_kmh),
        "gbdt_rate_anderson_shape": params_anderson(d, 0).assign(rate_kmh=params_gbdt(models, d).rate_kmh),
    }


def main():
    d = load_pairs()
    models = pickle.load(open(RESULTS / "models.pkl", "rb"))["models"]
    tr = d[d.split == "train"]
    const_rate = float(tr[tr.n_new > 0].rate_kmh.median())
    cal = d[(d.split == "cal") & (d.n_new > 0)]
    geom = growth_geometry(cal)
    out = {"const_rate_kmh": const_rate, "n_cal_pairs": int(len(cal)), "n_cal_fires": int(cal.fire_id.nunique()),
           "k": {}}
    for name, P in method_params(cal, models, const_rate).items():
        sc = normalized_scores(cal, P, geom)
        out["k"][name] = {str(a): weighted_quantile(sc, a) for a in LEVELS}
        print(f"  {name:26s} k90={out['k'][name]['0.9']:.3f}")
    (RESULTS / "calibration.json").write_text(json.dumps(out, indent=2))
    print(f"calibrated on {len(cal)} growth pairs from {cal.fire_id.nunique()} fires -> {RESULTS / 'calibration.json'}")


if __name__ == "__main__":
    main()
