"""
Prediction engine.

Two independent models, deliberately kept explainable. In a viva you will be
asked "what is the model actually doing", and "a neural network figured it out"
is a bad answer for a system with one physical sensor and thirty days of data.
Both models below can be defended line by line.

  1. PLUME DISPERSION  — physical. Takes live wind speed/bearing from Open-Meteo,
     projects the odour downwind from the source zone, and reports which campus
     buildings fall inside the dispersion cone and when the plume reaches them.

  2. TREND FORECAST    — statistical. Holt's linear exponential smoothing over
     the recent odour index, giving a 3-hour-ahead projection with a widening
     confidence band. Chosen over ARIMA/LSTM because it needs no training run,
     degrades gracefully on sparse data, and its two parameters have physical
     meaning you can explain.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import httpx

from config import settings

# ---------------------------------------------------------------------------
# Campus receptors — buildings that matter for the odour-complaint narrative.
# Adjust the coordinates to your actual campus survey.
# ---------------------------------------------------------------------------
RECEPTORS = [
    {"name": "FTMK Faculty Building",     "lat": 2.3105, "lon": 102.3184},
    {"name": "Kolej Kediaman Lekiu",      "lat": 2.3129, "lon": 102.3197},
    {"name": "Main Cafeteria",            "lat": 2.3141, "lon": 102.3172},
    {"name": "Chancellery",               "lat": 2.3118, "lon": 102.3159},
    {"name": "Sports Complex",            "lat": 2.3152, "lon": 102.3205},
    {"name": "Library",                   "lat": 2.3112, "lon": 102.3176},
]

# Half-angle of the dispersion cone. 30 degrees is a common Gaussian-plume
# rule of thumb for near-field, ground-level, low-wind conditions.
CONE_HALF_ANGLE_DEG = 30.0
MAX_RANGE_M = 2000.0


# ---------------------------------------------------------------------------
# Geodesy
# ---------------------------------------------------------------------------
def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def angular_diff(a: float, b: float) -> float:
    d = abs(a - b) % 360.0
    return 360.0 - d if d > 180.0 else d


def compass(deg: float) -> str:
    points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
              "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    return points[int((deg + 11.25) % 360 / 22.5)]


# ---------------------------------------------------------------------------
# Weather
# ---------------------------------------------------------------------------
async def fetch_weather(lat: float, lon: float) -> dict:
    """Open-Meteo. No API key, no rate limit worth worrying about, and it stays
    up — which is exactly what you want in a dependency for a live demo."""
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": lat,
        "longitude": lon,
        "current": "temperature_2m,relative_humidity_2m,wind_speed_10m,"
                   "wind_direction_10m,precipitation",
        "wind_speed_unit": "ms",
        "timezone": "Asia/Kuala_Lumpur",
    }
    async with httpx.AsyncClient(timeout=8.0) as client:
        r = await client.get(url, params=params)
        r.raise_for_status()
        cur = r.json().get("current", {})

    return {
        "temperature_c": cur.get("temperature_2m"),
        "humidity_pct": cur.get("relative_humidity_2m"),
        "wind_speed_ms": cur.get("wind_speed_10m"),
        # Meteorological convention: wind_direction is where the wind comes FROM.
        "wind_from_deg": cur.get("wind_direction_10m"),
        "wind_from_compass": compass(cur.get("wind_direction_10m") or 0),
        "precipitation_mm": cur.get("precipitation"),
        "observed_at": datetime.now(timezone.utc).isoformat(),
    }


# ---------------------------------------------------------------------------
# Model 1 — plume dispersion
# ---------------------------------------------------------------------------
def predict_plume(source_lat: float, source_lon: float,
                  odour_index: float, weather: dict) -> dict:
    wind_from = weather.get("wind_from_deg")
    wind_speed = weather.get("wind_speed_ms") or 0.0

    if wind_from is None:
        return {"available": False, "reason": "no wind data"}

    # Where the plume travels TO is the reciprocal of where wind comes FROM.
    travel_bearing = (wind_from + 180.0) % 360.0

    # Calm air disperses by diffusion, not advection — the plume lingers at the
    # source instead of travelling. Below ~0.5 m/s a directional forecast is
    # not meaningful and claiming one would be dishonest.
    if wind_speed < 0.5:
        return {
            "available": True,
            "regime": "stagnant",
            "travel_bearing_deg": travel_bearing,
            "travel_compass": compass(travel_bearing),
            "wind_speed_ms": wind_speed,
            "note": "Wind below 0.5 m/s — odour will pool near the source rather "
                    "than disperse. Highest complaint risk at the source zone itself.",
            "affected": [],
        }

    affected = []
    for rx in RECEPTORS:
        dist = haversine_m(source_lat, source_lon, rx["lat"], rx["lon"])
        if dist < 25 or dist > MAX_RANGE_M:
            continue
        brg = bearing_deg(source_lat, source_lon, rx["lat"], rx["lon"])
        off_axis = angular_diff(travel_bearing, brg)
        if off_axis > CONE_HALF_ANGLE_DEG:
            continue

        # Concentration falls off with distance and with off-axis angle.
        # Inverse-distance decay with a 400 m scale length; cosine taper across
        # the cone. Crude versus a full Gaussian plume model, but the inputs
        # (one sensor, no stability class) do not justify anything heavier.
        decay = 400.0 / (400.0 + dist)
        taper = math.cos(math.radians(off_axis / CONE_HALF_ANGLE_DEG * 90.0))
        intensity = odour_index * decay * max(taper, 0.0)

        eta_s = dist / wind_speed
        affected.append({
            "name": rx["name"],
            "distance_m": round(dist),
            "bearing_deg": round(brg),
            "off_axis_deg": round(off_axis, 1),
            "eta_minutes": round(eta_s / 60.0, 1),
            "eta_clock": (datetime.now(timezone.utc) + timedelta(seconds=eta_s))
                         .astimezone(timezone(timedelta(hours=8)))
                         .strftime("%H:%M"),
            "projected_index": round(intensity, 1),
            "risk": ("high" if intensity >= 55 else
                     "moderate" if intensity >= 30 else "low"),
        })

    affected.sort(key=lambda a: a["eta_minutes"])

    return {
        "available": True,
        "regime": "advective",
        "travel_bearing_deg": round(travel_bearing),
        "travel_compass": compass(travel_bearing),
        "wind_speed_ms": wind_speed,
        "cone_half_angle_deg": CONE_HALF_ANGLE_DEG,
        "source_index": odour_index,
        "affected": affected,
    }


# ---------------------------------------------------------------------------
# Model 2 — Holt's linear trend forecast
# ---------------------------------------------------------------------------
def forecast_trend(series: list[float], steps: int = 12,
                   alpha: float = 0.4, beta: float = 0.2) -> dict:
    """
    series: odour index samples, oldest first, evenly spaced.
    steps:  how many intervals ahead to project (12 x 15min = 3 hours).

    alpha weights how fast the level adapts to new readings; beta how fast the
    slope does. Higher alpha = twitchier, follows spikes. These values track a
    real odour event within about 20 minutes without chasing sensor noise.
    """
    clean = [v for v in series if v is not None]
    if len(clean) < 4:
        return {"available": False, "reason": "need at least 4 samples"}

    level = clean[0]
    trend = clean[1] - clean[0]
    residuals = []

    for value in clean[1:]:
        prediction = level + trend
        residuals.append(value - prediction)
        prev_level = level
        level = alpha * value + (1 - alpha) * (level + trend)
        trend = beta * (level - prev_level) + (1 - beta) * trend

    sigma = (sum(r * r for r in residuals) / len(residuals)) ** 0.5 if residuals else 0.0

    points = []
    for h in range(1, steps + 1):
        point = level + h * trend
        # Uncertainty grows with the square root of the horizon — the standard
        # random-walk widening, not a straight line.
        band = 1.96 * sigma * math.sqrt(h)
        points.append({
            "step": h,
            "minutes_ahead": h * 15,
            "value": round(max(0.0, min(100.0, point)), 1),
            "lower": round(max(0.0, point - band), 1),
            "upper": round(min(100.0, point + band), 1),
        })

    peak = max(points, key=lambda p: p["value"])
    direction = "rising" if trend > 0.15 else "falling" if trend < -0.15 else "stable"

    return {
        "available": True,
        "current_level": round(level, 1),
        "slope_per_interval": round(trend, 3),
        "direction": direction,
        "residual_sigma": round(sigma, 2),
        "points": points,
        "peak": {"minutes_ahead": peak["minutes_ahead"], "value": peak["value"]},
    }
