"""Build the VIIRS overpass-pair dataset (CAL FIRE perimeters, FIRMS, ERA5, LANDFIRE) -> ml/data/pairs.parquet.

Stages are cached under ml/data/. Coordinates are EPSG:3310 meters; interval-mean weather stands in for a forecast.

Usage:
  ml/.venv/bin/python ml/build_dataset.py --years 2018-2024
  ml/.venv/bin/python ml/build_dataset.py --years 2020 --limit-fires 10   # quick smoke test
  ml/.venv/bin/python ml/build_dataset.py --years 2025                     # untouched holdout -> pairs_2025.parquet
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from pyproj import Transformer
from scipy.spatial import cKDTree
from shapely import STRtree, points as shp_points
from shapely.geometry import shape

from ellipse import envelope_growth_area, fit_tightest_ellipse, hull_edges

ROOT = Path(__file__).resolve().parent / "data"
RAW, INTERIM, CACHE = ROOT / "raw", ROOT / "interim", ROOT / "cache"

PERIM_URL = (
    "https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/arcgis/rest/services/"
    "California_Historic_Fire_Perimeters/FeatureServer/0/query"
)
FIRMS_URL = "https://firms.modaps.eosdis.nasa.gov/data/country/{s}/{y}/{s}_{y}_United_States.csv"
FIRMS_SATS = {"viirs-snpp": "SNPP", "viirs-jpss1": "NOAA20"}
METEO_URL = "https://archive-api.open-meteo.com/v1/archive"
LF_FUEL_URL = "https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2016/LF2016_FBFM40_CONUS/ImageServer/getSamples"
LF_ELEV_URL = "https://lfps.usgs.gov/arcgis/rest/services/Landfire_Topo/LF2020_Elev_CONUS/ImageServer/getSamples"

CA_BBOX = (-124.5, 32.5, -114.1, 42.1)  # lon_min, lat_min, lon_max, lat_max
MIN_ACRES = 300
PERIM_BUFFER_M = 1000  # max detection distance from the final perimeter
PASS_GAP_MIN = 20  # same-satellite detections within this many minutes form one pass
NEW_PIXEL_M = 500  # min distance from the footprint for a t1 detection to count as new
DEDUP_GRID_M = 200  # footprint snap grid (removes repeat detections)
FOOT_RADIUS_M = 10_000  # footprint points farther than this from all new pixels can't matter
MAX_FOOT, MAX_NEW = 800, 600  # caps for the O(N*F) label fit
MAX_DT_H = 26.0
MIN_DT_H = 2.0  # see short_dt flag in main()
MIN_NEW_FOR_SHAPE = 5  # min new pixels to label direction and L:B
LINK_M = 1500  # single-linkage distance splitting complexes into components
PREV_MATCH_M = 5000  # max distance to match the previous pair's component
CAL_MIN_FIRES = 40  # below this, use the grouped random split

WEATHER_VARS = [
    "wind_speed_10m", "wind_gusts_10m", "wind_direction_10m",
    "temperature_2m", "relative_humidity_2m", "vapour_pressure_deficit",
]

TO_3310 = Transformer.from_crs(4326, 3310, always_xy=True)
TO_4326 = Transformer.from_crs(3310, 4326, always_xy=True)

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "flashpoint-research-dataset/0.1"


def get(url: str, *, params=None, data=None, timeout=120, tries=4) -> requests.Response:
    for i in range(tries):
        try:
            r = (SESSION.post(url, data=data, timeout=timeout) if data is not None
                 else SESSION.get(url, params=params, timeout=timeout))
            if r.status_code == 429:
                time.sleep(30 * (i + 1))
                continue
            r.raise_for_status()
            return r
        except requests.RequestException:
            if i == tries - 1:
                raise
            time.sleep(5 * (i + 1))
    raise RuntimeError(f"giving up on {url}")


# ---------------------------------------------------------------- 1. fires
def stage_fires(years: list[int]) -> pd.DataFrame:
    holdout = min(years) >= 2025
    out = RAW / ("perimeters_2025.parquet" if holdout else "perimeters.parquet")
    if out.exists():
        df = pd.read_parquet(out)
        return df[df.year.isin(years)].reset_index(drop=True)
    rows, offset = [], 0
    y0, y1 = (2025, 2025) if holdout else (2018, 2024)
    where = f"YEAR_ >= {y0} AND YEAR_ <= {y1} AND GIS_ACRES >= {MIN_ACRES} AND ALARM_DATE IS NOT NULL"
    while True:
        js = get(PERIM_URL, params={
            "where": where, "outFields": "OBJECTID,YEAR_,FIRE_NAME,INC_NUM,UNIT_ID,ALARM_DATE,CONT_DATE,GIS_ACRES",
            "outSR": 3310, "maxAllowableOffset": 50, "f": "geojson",
            "resultOffset": offset, "resultRecordCount": 200,
        }).json()
        feats = js.get("features", [])
        for f in feats:
            p = f["properties"]
            if not f.get("geometry"):
                continue
            rows.append({
                "fire_id": f"{p['YEAR_']}_{p['UNIT_ID']}_{p['INC_NUM'] or p['OBJECTID']}",
                "name": p["FIRE_NAME"], "year": int(p["YEAR_"]), "acres": p["GIS_ACRES"],
                "alarm": pd.to_datetime(p["ALARM_DATE"], unit="ms", utc=True),
                "cont": pd.to_datetime(p["CONT_DATE"], unit="ms", utc=True) if p["CONT_DATE"] else pd.NaT,
                "wkb": shape(f["geometry"]).buffer(0).wkb,
            })
        if len(feats) < 200:
            break
        offset += 200
    df = pd.DataFrame(rows).drop_duplicates("fire_id").reset_index(drop=True)
    df.to_parquet(out)
    print(f"[fires] {len(df)} perimeters")
    return df[df.year.isin(years)].reset_index(drop=True)


# ---------------------------------------------------------------- 2. firms
def stage_firms(years: list[int]) -> pd.DataFrame:
    frames = []
    for slug, sat in FIRMS_SATS.items():
        for y in years:
            out = RAW / f"firms_{sat}_{y}.parquet"
            if out.exists() and "scan" not in pd.read_parquet(out).columns:
                out.unlink()  # older cache without pixel-size columns
            if not out.exists():
                print(f"[firms] downloading {slug} {y} ...")
                df = pd.read_csv(io.BytesIO(get(FIRMS_URL.format(s=slug, y=y), timeout=600).content))
                lo0, la0, lo1, la1 = CA_BBOX
                df = df[df.longitude.between(lo0, lo1) & df.latitude.between(la0, la1)]
                df = df[(df["type"] == 0) & (df.confidence != "l")]  # vegetation fires, nominal/high conf
                df["t"] = pd.to_datetime(
                    df.acq_date + df.acq_time.astype(str).str.zfill(4), format="%Y-%m-%d%H%M", utc=True)
                df["x"], df["y"] = TO_3310.transform(df.longitude.values, df.latitude.values)
                df["sat"] = sat
                df[["t", "x", "y", "frp", "scan", "track", "daynight", "sat", "longitude", "latitude"]].to_parquet(out)
            frames.append(pd.read_parquet(out))
    det = pd.concat(frames, ignore_index=True)
    print(f"[firms] {len(det):,} CA vegetation detections")
    return det


# ---------------------------------------------------------------- 3. pairs
def assign_detections(fires: pd.DataFrame, det: pd.DataFrame) -> pd.DataFrame:
    """Assign each detection to the fire whose buffered perimeter and date window contain it."""
    from shapely import from_wkb

    geoms = [from_wkb(w).buffer(PERIM_BUFFER_M) for w in fires.wkb]
    tree = STRtree(geoms)
    start = fires.alarm - pd.Timedelta(days=1)
    end = fires.cont.fillna(fires.alarm + pd.Timedelta(days=60)) + pd.Timedelta(days=1)
    det_idx, fire_idx = tree.query(shp_points(det.x.values, det.y.values), predicate="within")
    t = det.t.values[det_idx]
    ok = (t >= start.values[fire_idx]) & (t <= end.values[fire_idx])
    det_idx, fire_idx = det_idx[ok], fire_idx[ok]
    # overlapping fires: keep the one with the closest alarm date
    gap = np.abs((det.t.values[det_idx] - fires.alarm.values[fire_idx]).astype("timedelta64[h]").astype(float))
    m = pd.DataFrame({"d": det_idx, "f": fire_idx, "gap": gap}).sort_values("gap").drop_duplicates("d")
    out = det.iloc[m.d.values].copy()
    out["fire_id"] = fires.fire_id.values[m.f.values]
    return out


def split_passes(g: pd.DataFrame) -> list[pd.DataFrame]:
    g = g.sort_values("t")
    new = (g.sat != g.sat.shift()) | (g.t.diff() > pd.Timedelta(minutes=PASS_GAP_MIN))
    return [p for _, p in g.groupby(new.cumsum())]


def dedup(xy: np.ndarray) -> np.ndarray:
    return np.unique(np.round(xy / DEDUP_GRID_M) * DEDUP_GRID_M, axis=0)


def thin(xy: np.ndarray, n: int, seed: int) -> np.ndarray:
    if len(xy) <= n:
        return xy
    return xy[np.random.default_rng(seed).choice(len(xy), n, replace=False)]


def components(xy: np.ndarray, link_m: float) -> np.ndarray:
    """Single-linkage connected-component labels at distance link_m."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    e = cKDTree(xy).query_pairs(link_m, output_type="ndarray")
    g = coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(len(xy), len(xy)))
    return connected_components(g, directed=False)[1]


def label_component(F: np.ndarray, N: np.ndarray, dt_h: float) -> dict:
    """Tightest 90% Huygens ellipse label for one component (meters)."""
    if len(N) == 0:
        near, new_fit, theta, lb, head = F[:0], N, np.nan, np.nan, 0.0
    else:
        near = F[cKDTree(N).query(F, distance_upper_bound=FOOT_RADIUS_M)[0] < np.inf]
        near, new_fit = thin(near, MAX_FOOT, 0), thin(N, MAX_NEW, 1)
        if len(N) >= MIN_NEW_FOR_SHAPE:
            theta, lb, head = fit_tightest_ellipse(new_fit / 1000, near / 1000, hull_xy=F / 1000)
        else:  # too few pixels for a shape: circular head distance only
            head = float(np.quantile(cKDTree(near / 1000).query(new_fit / 1000)[0], 0.9))
            theta, lb = np.nan, np.nan
    return {
        "head_km": head, "rate_kmh": head / dt_h, "theta_deg": theta, "lb": lb,
        "label_growth_km2": envelope_growth_area(
            head, lb if lb == lb else 1.0, theta if theta == theta else 0.0, *hull_edges(F / 1000)),
        "new_xy": new_fit.ravel().tolist(), "foot_xy": near.ravel().tolist(),
    }


def stage_pairs(fires: pd.DataFrame, det: pd.DataFrame, tag: str = "") -> pd.DataFrame:
    """One row per (fire, component active at t0, consecutive pass pair).

    Unconnected new pixels are counted as ignitions, not spread. A t1 detection is new only if
    farther than max(NEW_PIXEL_M, its pixel size) from the footprint, suppressing cross-satellite
    geolocation jitter near the scan edge."""
    out = INTERIM / f"pairs_geom{tag}.parquet"
    key = hashlib.md5(("labels-v3|" + ",".join(sorted(fires.fire_id))).encode()).hexdigest()[:10]
    if out.exists() and pd.read_parquet(out, columns=["cache_key"]).cache_key.iloc[0] == key:
        return pd.read_parquet(out)
    det = assign_detections(fires, det)
    rows = []
    for fid, g in det.groupby("fire_id"):
        passes = split_passes(g)
        prev_rows: list[dict] = []
        for i in range(len(passes) - 1):
            p0, p1 = passes[i], passes[i + 1]
            t0, t1 = p0.t.median(), p1.t.median()
            dt_h = (t1 - t0).total_seconds() / 3600
            if dt_h > MAX_DT_H or dt_h <= 0:
                prev_rows = []
                continue
            foot = dedup(pd.concat(passes[: i + 1])[["x", "y"]].to_numpy())
            p1xy = p1[["x", "y"]].to_numpy()
            pix_m = 1000 * np.maximum(p1.scan.values, p1.track.values)
            new = dedup(p1xy[cKDTree(foot).query(p1xy)[0] > np.maximum(NEW_PIXEL_M, pix_m)])

            lab = components(np.vstack([foot, new]), LINK_M)
            lab_f, lab_n = lab[: len(foot)], lab[len(foot):]
            p0xy = p0[["x", "y"]].to_numpy()
            act_lab = lab_f[cKDTree(foot).query(p0xy)[1]]  # component of each active t0 detection
            n_ignitions = int((~np.isin(lab_n, lab_f)).sum())

            cur_rows = []
            for c in np.unique(act_lab):
                A = p0[act_lab == c]
                F, N = foot[lab_f == c], new[lab_n == c]
                front = A[["x", "y"]].to_numpy().mean(axis=0)  # active front at t0 (known at t0)
                prev = None
                if prev_rows:
                    dprev = [np.hypot(*(front - (r["front_x"], r["front_y"]))) for r in prev_rows]
                    if min(dprev) < PREV_MATCH_M:
                        prev = prev_rows[int(np.argmin(dprev))]
                row = {
                    "fire_id": fid, "comp": int(c), "t0": t0, "t1": t1, "dt_h": dt_h,
                    "sat0": p0.sat.iloc[0], "sat1": p1.sat.iloc[0], "front_x": front[0], "front_y": front[1],
                    "n_foot": len(F), "foot_area_km2": len(F) * (DEDUP_GRID_M / 1000) ** 2,
                    "n_det_t0": len(A), "frp_sum_t0": A.frp.sum(), "frp_max_t0": A.frp.max(),
                    "night_t0": p0.daynight.iloc[0] == "N", "n_new": len(N),
                    "new_area_km2": len(N) * (DEDUP_GRID_M / 1000) ** 2, "n_new_ignitions_pair": n_ignitions,
                    "prev_rate_kmh": prev["rate_kmh"] if prev else np.nan,
                    "prev_theta_deg": prev["theta_deg"] if prev else np.nan,
                    "prev_lb": prev["lb"] if prev else np.nan,
                }
                row.update(label_component(F, N, dt_h))
                cur_rows.append(row)
            rows.extend(cur_rows)
            prev_rows = cur_rows
    df = pd.DataFrame(rows)
    df["cache_key"] = key
    df.to_parquet(out)
    print(f"[pairs] {len(df):,} component-pairs from {df.fire_id.nunique()} fires")
    return df


# ---------------------------------------------------------------- 4. weather
def stage_weather(pairs: pd.DataFrame) -> pd.DataFrame:
    (CACHE / "weather").mkdir(parents=True, exist_ok=True)
    lon, lat = TO_4326.transform(pairs.front_x.values, pairs.front_y.values)
    pairs = pairs.assign(front_lon=lon, front_lat=lat,
                         cell_lat=np.round(lat * 4) / 4, cell_lon=np.round(lon * 4) / 4)  # ERA5 0.25 deg
    series = {}
    for (fid, clat, clon), g in pairs.groupby(["fire_id", "cell_lat", "cell_lon"]):
        s, e = (g.t0.min() - pd.Timedelta(hours=2)).date(), (g.t1.max() + pd.Timedelta(hours=2)).date()
        f = CACHE / "weather" / f"{clat}_{clon}_{s}_{e}.json"
        if not f.exists():
            js = get(METEO_URL, params={
                "latitude": clat, "longitude": clon, "start_date": str(s), "end_date": str(e),
                "hourly": ",".join(WEATHER_VARS), "wind_speed_unit": "ms", "timezone": "GMT",
            }).json()
            f.write_text(json.dumps(js["hourly"]))
            time.sleep(0.2)
        h = pd.DataFrame(json.loads(f.read_text()))
        h["time"] = pd.to_datetime(h.time, utc=True)
        series[(fid, clat, clon)] = h.set_index("time")

    feats = []
    for r in pairs.itertuples():
        h = series[(r.fire_id, r.cell_lat, r.cell_lon)]
        w = h.loc[r.t0.floor("h"): r.t1.ceil("h")].dropna()
        if w.empty:
            feats.append({})
            continue
        # vector-average the wind (direction is meteorological "from")
        rad = np.deg2rad(w.wind_direction_10m.values)
        u = (w.wind_speed_10m.values * np.sin(rad)).mean()
        v = (w.wind_speed_10m.values * np.cos(rad)).mean()
        feats.append({
            "wind_ms": w.wind_speed_10m.mean(), "wind_max_ms": w.wind_speed_10m.max(),
            "gust_max_ms": w.wind_gusts_10m.max(),
            "wind_from_deg": float(np.rad2deg(np.arctan2(u, v)) % 360),
            "wind_steadiness": float(np.hypot(u, v) / max(w.wind_speed_10m.mean(), 1e-6)),
            "temp_c": w.temperature_2m.mean(), "rh_pct": w.relative_humidity_2m.mean(),
            "rh_min_pct": w.relative_humidity_2m.min(), "vpd_kpa": w.vapour_pressure_deficit.mean(),
        })
    print(f"[weather] {len(series)} ERA5 series")
    return pd.concat([pairs.reset_index(drop=True), pd.DataFrame(feats)], axis=1)


# ---------------------------------------------------------------- 5. landfire
FUEL_GROUPS = {"grass": range(101, 124 + 1), "shrub": range(141, 149 + 1), "timber": range(161, 189 + 1),
               "slash": range(201, 204 + 1), "nonburn": range(91, 99 + 1)}  # GS (121-124) -> grass


def sample_points(url: str, lonlat: list[tuple[float, float]], cache: dict, tag: str) -> list[float]:
    keys = [f"{tag}:{lo:.5f},{la:.5f}" for lo, la in lonlat]
    todo = sorted({(k, p) for k, p in zip(keys, lonlat) if k not in cache})
    for i in range(0, len(todo), 400):
        batch = todo[i: i + 400]
        geom = {"points": [list(p) for _, p in batch], "spatialReference": {"wkid": 4326}}
        js = get(url, data={"geometry": json.dumps(geom), "geometryType": "esriGeometryMultipoint",
                            "returnFirstValueOnly": "true", "f": "json"}).json()
        vals = {s["locationId"]: s.get("value") for s in js.get("samples", [])}
        for j, (k, _) in enumerate(batch):
            v = vals.get(j)
            cache[k] = float(v) if v not in (None, "NoData", "") else None
        print(f"[landfire] {tag} {min(i + 400, len(todo))}/{len(todo)}", end="\r")
    return [cache[k] for k in keys]


def offset_lonlat(x, y, bearing_deg, dist_m):
    b = np.deg2rad(bearing_deg)
    return TO_4326.transform(x + dist_m * np.sin(b), y + dist_m * np.cos(b))


def stage_landfire(pairs: pd.DataFrame) -> pd.DataFrame:
    cf = CACHE / "landfire.json"
    cache = json.loads(cf.read_text()) if cf.exists() else {}
    down = (pairs.wind_from_deg.fillna(0).values + 180) % 360
    fx, fy = pairs.front_x.values, pairs.front_y.values

    # fuel: front + downwind sector (0.5/1/2 km at -30/0/+30 deg)
    fuel_pts = [list(zip(*TO_4326.transform(fx, fy)))]
    for dist in (500, 1000, 2000):
        for off in (-30, 0, 30):
            fuel_pts.append(list(zip(*offset_lonlat(fx, fy, down + off, dist))))
    fuel = np.array([sample_points(LF_FUEL_URL, pts, cache, "fuel") for pts in fuel_pts], dtype=float).T
    # elevation: front, 1 km downwind, 1 km upwind
    elev = np.array([sample_points(LF_ELEV_URL, list(zip(*xy)), cache, "elev") for xy in (
        TO_4326.transform(fx, fy), offset_lonlat(fx, fy, down, 1000), offset_lonlat(fx, fy, down + 180, 1000))],
        dtype=float).T
    cf.write_text(json.dumps(cache))
    print()

    out = pairs.copy()
    n_valid = np.isfinite(fuel).sum(axis=1).clip(min=1)
    for g, codes in FUEL_GROUPS.items():
        out[f"fuel_{g}"] = np.isin(fuel, list(codes)).sum(axis=1) / n_valid
    out["elev_m"] = elev[:, 0]
    out["slope_wind"] = (elev[:, 1] - elev[:, 2]) / 2000.0  # rise/run along the downwind direction
    return out


# ---------------------------------------------------------------- 6. assemble
def assign_splits(df: pd.DataFrame) -> pd.DataFrame:
    year = df.fire_id.str.slice(0, 4).astype(int)
    df["year"] = year
    df["split_year"] = np.select([year <= 2021, year == 2022], ["train", "cal"], "test")
    fires = np.sort(df.fire_id.unique())
    rng = np.random.default_rng(221)
    u = pd.Series(rng.random(len(fires)), index=fires)
    df["split_random"] = np.select([df.fire_id.map(u) < 0.6, df.fire_id.map(u) < 0.8], ["train", "cal"], "test")
    n_cal = df.loc[df.split_year == "cal"].fire_id.nunique()
    df["split"] = df.split_year if n_cal >= CAL_MIN_FIRES else df.split_random
    print(f"[split] calibration year has {n_cal} fires with pairs -> using "
          f"{'year' if n_cal >= CAL_MIN_FIRES else 'grouped-random'} split")
    return df


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", default="2018-2024")
    ap.add_argument("--limit-fires", type=int, default=None)
    args = ap.parse_args()
    a, _, b = args.years.partition("-")
    years = list(range(int(a), int(b or a) + 1))
    for d in (RAW, INTERIM, CACHE):
        d.mkdir(parents=True, exist_ok=True)

    fires = stage_fires(years)
    if args.limit_fires:
        fires = fires.sort_values("acres", ascending=False).head(args.limit_fires).reset_index(drop=True)
    det = stage_firms(years)
    holdout = min(years) >= 2025
    pairs = stage_pairs(fires, det, tag="_2025" if holdout else "")
    pairs = stage_weather(pairs)
    pairs = stage_landfire(pairs)
    if holdout:  # untouched final test set
        pairs["year"] = pairs.fire_id.str.slice(0, 4).astype(int)
        pairs["split"] = pairs["split_year"] = pairs["split_random"] = "holdout"
    else:
        pairs = assign_splits(pairs)

    t0_local_h = (pairs.t0.dt.hour + pairs.t0.dt.minute / 60 + pairs.front_lon / 15) % 24
    pairs["hour_sin"], pairs["hour_cos"] = np.sin(2 * np.pi * t0_local_h / 24), np.cos(2 * np.pi * t0_local_h / 24)
    pairs["month"] = pairs.t0.dt.month
    # ~50-min cross-satellite pairs are below VIIRS's geolocation noise floor (1 pixel / 0.85 h
    # ~ 0.7-1.5 km/h apparent spread): kept but flagged and excluded from rate labels.
    pairs["short_dt"] = pairs.dt_h < MIN_DT_H
    pairs = pairs.drop(columns=["cache_key"])
    suffix = ("_2025" if holdout and args.limit_fires is None else
              "" if (args.limit_fires is None and years == list(range(2018, 2025))) else "_subset")
    out = ROOT / f"pairs{suffix}.parquet"
    pairs.to_parquet(out)

    summary = pairs.groupby("split").agg(fires=("fire_id", "nunique"), pairs=("fire_id", "size"),
                                         growth_pairs=("n_new", lambda s: int((s > 0).sum())),
                                         shape_pairs=("lb", lambda s: int(s.notna().sum())),
                                         long_dt_pairs=("short_dt", lambda s: int((~s).sum())))
    print(summary.to_string())
    print(pairs[["dt_h", "rate_kmh", "lb", "wind_ms", "rh_pct", "slope_wind"]].describe().round(3).to_string())
    print(f"-> {out}")


if __name__ == "__main__":
    main()
