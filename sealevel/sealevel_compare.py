#!/usr/bin/env python3
"""
NOAA CO-OPS monthly mean sea level puller + plotter — multi-station.

Pulls the full monthly-mean-sea-level history for one or more NOAA
CO-OPS stations, computes each station's linear trend (mm/yr), and
produces both per-station CSVs and a single overlay comparison chart
with all trend lines together.

Default stations compare Bay-side vs. ocean-side around the lower
Chesapeake / Delmarva:
    8577330  Solomons Island, MD   (Chesapeake Bay, Patuxent mouth)
    8557380  Lewes, DE             (Atlantic / Delaware Bay mouth)

Usage:
    python3 sea_level_compare.py                 # default two stations
    python3 sea_level_compare.py 8577330 8557380 8638610   # custom list

Each station's series is aligned to its own MSL datum, then re-centered
to a common baseline (its 1983-2001 mean, NOAA's standard tidal epoch)
so the trends are visually comparable on one axis.

No API key required — public NOAA endpoint.
"""

import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

BASE_URL = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
OUT_DIR = Path(__file__).parent

# Friendly names for known stations (extend freely)
STATION_NAMES = {
    "8577330": "Solomons Island, MD (Bay)",
    "8557380": "Lewes, DE (Ocean)",
    "8638610": "Sewells Point, VA (Bay)",
    "8570283": "Ocean City Inlet, MD (Ocean)",
    "8575512": "Annapolis, MD (Bay)",
    "8594900": "Washington, DC",
}

DEFAULT_STATIONS = ["8577330", "8557380"]

START_YEAR = 1900
END_YEAR = pd.Timestamp.today().year

# NOAA standard tidal epoch — used to re-center each series to a common
# baseline so different stations' datums don't offset the comparison.
EPOCH_START = "1983-01-01"
EPOCH_END = "2001-12-31"


def station_label(sid: str) -> str:
    return STATION_NAMES.get(sid, f"Station {sid}")


def fetch_chunk(station: str, begin_year: int, end_year: int) -> pd.DataFrame:
    params = {
        "begin_date": f"{begin_year}0101",
        "end_date": f"{end_year}1231",
        "station": station,
        "product": "monthly_mean",
        "datum": "MSL",
        "units": "metric",
        "time_zone": "gmt",
        "application": "nathancordrey-sealevel",
        "format": "json",
    }
    r = requests.get(BASE_URL, params=params, timeout=30)
    r.raise_for_status()
    payload = r.json()

    if "error" in payload:
        msg = payload["error"].get("message", "unknown error")
        if "No data" in msg:
            return pd.DataFrame()
        raise RuntimeError(f"NOAA API error ({station}, {begin_year}-{end_year}): {msg}")

    rows = payload.get("data", [])
    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows)
    df["date"] = pd.to_datetime(df["year"] + "-" + df["month"].str.zfill(2) + "-15")
    df["msl_m"] = pd.to_numeric(df["MSL"], errors="coerce")
    return df[["date", "msl_m"]]


def fetch_full_history(station: str) -> pd.DataFrame:
    chunks = []
    for decade_start in range(START_YEAR, END_YEAR + 1, 10):
        decade_end = min(decade_start + 9, END_YEAR)
        try:
            chunk = fetch_chunk(station, decade_start, decade_end)
        except requests.HTTPError as e:
            print(f"  [{station}] skipping {decade_start}-{decade_end}: {e}",
                  file=sys.stderr)
            chunk = pd.DataFrame()
        if not chunk.empty:
            chunks.append(chunk)
        time.sleep(0.3)

    if not chunks:
        raise RuntimeError(f"No data for station {station}.")

    full = pd.concat(chunks, ignore_index=True)
    full = (full.dropna(subset=["msl_m"])
                .drop_duplicates(subset="date")
                .sort_values("date")
                .reset_index(drop=True))
    return full


def recenter_to_epoch(df: pd.DataFrame) -> pd.DataFrame:
    """Subtract the 1983-2001 mean so all stations share a baseline."""
    mask = (df["date"] >= EPOCH_START) & (df["date"] <= EPOCH_END)
    if mask.sum() >= 12:
        baseline = df.loc[mask, "msl_m"].mean()
    else:
        # station too new/old to cover the epoch — fall back to full-record mean
        baseline = df["msl_m"].mean()
    df = df.copy()
    df["msl_centered_mm"] = (df["msl_m"] - baseline) * 1000.0
    return df


def compute_trend(df: pd.DataFrame) -> tuple[float, float]:
    years = (df["date"] - df["date"].iloc[0]).dt.days / 365.25
    y_mm = df["msl_centered_mm"].values
    coeffs, cov = np.polyfit(years, y_mm, 1, cov=True)
    return coeffs[0], np.sqrt(cov[0, 0])


def plot_overlay(series: dict, out_path: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    colors = ["#2b6cb0", "#c53030", "#2f855a", "#6b46c1", "#b7791f"]
    fig, ax = plt.subplots(figsize=(12, 6.5))

    for i, (sid, df) in enumerate(series.items()):
        c = colors[i % len(colors)]
        slope, se = compute_trend(df)
        years = (df["date"] - df["date"].iloc[0]).dt.days / 365.25
        fit = np.poly1d(np.polyfit(years, df["msl_centered_mm"].values, 1))
        # thin raw line + bold trend
        ax.plot(df["date"], df["msl_centered_mm"], color=c, linewidth=0.5, alpha=0.30)
        ax.plot(df["date"], fit(years), color=c, linewidth=2.4,
                label=f"{station_label(sid)}: {slope:.2f} ± {se:.2f} mm/yr")

    ax.axhline(0, color="0.6", linewidth=0.8, linestyle="--")
    ax.set_title("Chesapeake Bay vs. Atlantic Ocean-Side Sea Level Rise\n"
                 "NOAA monthly mean sea level, re-centered to 1983–2001 baseline")
    ax.set_xlabel("Year")
    ax.set_ylabel("Sea level relative to 1983–2001 mean (mm)")
    ax.legend(loc="upper left", framealpha=0.9)
    ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    print(f"Saved comparison chart to {out_path}")


def main():
    stations = sys.argv[1:] if len(sys.argv) > 1 else DEFAULT_STATIONS
    series = {}

    for sid in stations:
        print(f"Fetching {station_label(sid)} ({sid})...")
        df = fetch_full_history(sid)
        df = recenter_to_epoch(df)
        series[sid] = df

        csv_path = OUT_DIR / f"sea_level_{sid}.csv"
        df.to_csv(csv_path, index=False)
        slope, se = compute_trend(df)
        span = f"{df['date'].dt.year.min()}-{df['date'].dt.year.max()}"
        print(f"  {len(df)} readings, {span}, trend {slope:.2f} ± {se:.2f} mm/yr "
              f"({slope / 25.4 * 100:.1f} in/century)")

    png_path = OUT_DIR / "sea_level_comparison.png"
    plot_overlay(series, png_path)


if __name__ == "__main__":
    main()
