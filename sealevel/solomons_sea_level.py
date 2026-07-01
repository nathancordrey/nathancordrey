#!/usr/bin/env python3
"""
Solomons Island, MD (NOAA station 8577330) — full-history monthly mean
sea level puller + plotter.

Pulls every available monthly mean water level reading from NOAA's
CO-OPS Data API, computes a linear trend (mm/yr), and saves both a
CSV of the raw series and a PNG chart.

Usage:
    python3 solomons_sea_level.py

Output (written next to this script):
    solomons_monthly_mean_sea_level.csv
    solomons_sea_level_trend.png

No API key required — this is a public NOAA endpoint.
"""

import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

STATION_ID = "8577330"          # Solomons Island, MD
STATION_NAME = "Solomons Island, MD"
BASE_URL = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
OUT_DIR = Path(__file__).parent

# NOAA's monthly_mean product will happily return a multi-decade range
# in one call, but we chunk by decade anyway so a hiccup mid-pull only
# costs us one chunk instead of the whole run.
START_YEAR = 1930   # safely before the station's actual start; NOAA just
                     # returns whatever it has within the window
END_YEAR = pd.Timestamp.today().year


def fetch_chunk(begin_year: int, end_year: int) -> pd.DataFrame:
    params = {
        "begin_date": f"{begin_year}0101",
        "end_date": f"{end_year}1231",
        "station": STATION_ID,
        "product": "monthly_mean",
        "datum": "MSL",          # Mean Sea Level datum -> trend-friendly
        "units": "metric",
        "time_zone": "gmt",
        "application": "nathancordrey-sealevel",
        "format": "json",
    }
    r = requests.get(BASE_URL, params=params, timeout=30)
    r.raise_for_status()
    payload = r.json()

    if "error" in payload:
        # NOAA returns 200 with an "error" key for empty/invalid ranges
        msg = payload["error"].get("message", "unknown error")
        if "No data" in msg:
            return pd.DataFrame()
        raise RuntimeError(f"NOAA API error for {begin_year}-{end_year}: {msg}")

    rows = payload.get("data", [])
    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows)
    # monthly_mean rows look like: {"year":"1937","month":"01","MSL":"0.123", ...}
    df["date"] = pd.to_datetime(df["year"] + "-" + df["month"].str.zfill(2) + "-15")
    df["msl_m"] = pd.to_numeric(df["MSL"], errors="coerce")
    return df[["date", "msl_m"]]


def fetch_full_history() -> pd.DataFrame:
    chunks = []
    for decade_start in range(START_YEAR, END_YEAR + 1, 10):
        decade_end = min(decade_start + 9, END_YEAR)
        print(f"Fetching {decade_start}-{decade_end}...")
        try:
            chunk = fetch_chunk(decade_start, decade_end)
        except requests.HTTPError as e:
            print(f"  Skipping {decade_start}-{decade_end}: {e}", file=sys.stderr)
            chunk = pd.DataFrame()
        if not chunk.empty:
            chunks.append(chunk)
        time.sleep(0.3)  # be polite to NOAA's servers

    if not chunks:
        raise RuntimeError("No data returned for any decade — check station ID/connectivity.")

    full = pd.concat(chunks, ignore_index=True)
    full = full.dropna(subset=["msl_m"]).drop_duplicates(subset="date").sort_values("date")
    return full.reset_index(drop=True)


def compute_trend(df: pd.DataFrame) -> tuple[float, float]:
    """Returns (mm/year trend, mm/year standard error) via simple OLS."""
    years = (df["date"] - df["date"].iloc[0]).dt.days / 365.25
    y_mm = df["msl_m"].values * 1000.0
    coeffs, cov = np.polyfit(years, y_mm, 1, cov=True)
    slope_mm_per_yr = coeffs[0]
    slope_se = np.sqrt(cov[0, 0])
    return slope_mm_per_yr, slope_se


def plot(df: pd.DataFrame, slope: float, se: float, out_path: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    years = (df["date"] - df["date"].iloc[0]).dt.days / 365.25
    y_mm = df["msl_m"].values * 1000.0
    fit = np.poly1d(np.polyfit(years, y_mm, 1))

    fig, ax = plt.subplots(figsize=(11, 6))
    ax.plot(df["date"], y_mm, color="#2b6cb0", linewidth=0.9, alpha=0.85,
            label="Monthly mean sea level")
    ax.plot(df["date"], fit(years), color="#c53030", linewidth=2,
            label=f"Linear trend: {slope:.2f} ± {se:.2f} mm/yr")

    ax.set_title(f"{STATION_NAME} — Monthly Mean Sea Level\n"
                  f"NOAA Station {STATION_ID} ({df['date'].dt.year.min()}–{df['date'].dt.year.max()})")
    ax.set_xlabel("Year")
    ax.set_ylabel("Sea level relative to station MSL datum (mm)")
    ax.legend(loc="upper left")
    ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    print(f"Saved chart to {out_path}")


def main():
    df = fetch_full_history()
    csv_path = OUT_DIR / "solomons_monthly_mean_sea_level.csv"
    df.to_csv(csv_path, index=False)
    print(f"Saved {len(df)} monthly readings to {csv_path}")

    slope, se = compute_trend(df)
    print(f"\nLinear trend: {slope:.2f} ± {se:.2f} mm/yr "
          f"({slope / 25.4:.3f} in/yr)")
    print(f"Record span: {df['date'].min().date()} to {df['date'].max().date()}")

    png_path = OUT_DIR / "solomons_sea_level_trend.png"
    plot(df, slope, se, png_path)


if __name__ == "__main__":
    main()
