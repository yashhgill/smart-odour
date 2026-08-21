"""
Odour forecasting.

Design principle: the model must degrade honestly. A Random Forest fitted to
forty readings is not a forecast, it is a memorised curve that will look
confident and be wrong. So there are three tiers, and the tier used is reported
back and shown in the UI:

    >= 500 readings   random_forest       lagged features, held-out scoring
    >=  60 readings   linear_trend        least squares on recent slope
    <   60 readings   insufficient_data   raises, nothing is stored

An examiner asking "how do you know this prediction is any good" should get the
R^2 on held-out data and the sample count, not a hand wave.
"""

from datetime import datetime, timedelta, timezone

import numpy as np

HORIZONS = [30, 60, 120, 180]      # minutes ahead
MIN_FOREST = 500
MIN_TREND = 60


class InsufficientData(Exception):
    pass


def _parse(readings):
    """Return (timestamps, values) sorted ascending, dropping unusable rows."""
    rows = []
    for r in readings:
        v = r.get("aqi_score")
        ts = r.get("ts")
        if v is None or ts is None:
            continue
        try:
            t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            continue
        rows.append((t, float(v)))
    rows.sort(key=lambda x: x[0])
    return rows


def fit_zone(readings):
    """
    Fit whichever model the data supports and project the horizons.
    Returns (points, meta).
    """
    rows = _parse(readings)
    if len(rows) < MIN_TREND:
        raise InsufficientData(
            f"{len(rows)} usable readings, need at least {MIN_TREND}"
        )

    times = np.array([r[0].timestamp() for r in rows])
    values = np.array([r[1] for r in rows])

    if len(rows) >= MIN_FOREST:
        return _forest(times, values, rows)
    return _trend(times, values, rows)


# ---------------------------------------------------------------------------
#  Tier 1: Random Forest on lagged features
# ---------------------------------------------------------------------------

def _forest(times, values, rows):
    from sklearn.ensemble import RandomForestRegressor
    from sklearn.metrics import r2_score

    lags = [1, 2, 3, 6, 12]        # readings back, not minutes
    max_lag = max(lags)

    X, y = [], []
    for i in range(max_lag, len(values)):
        t = rows[i][0]
        feats = [values[i - lag] for lag in lags]
        feats.append(t.hour + t.minute / 60.0)       # time of day drives odour
        feats.append(float(np.mean(values[i - 12:i])))
        feats.append(float(np.std(values[i - 12:i])))
        X.append(feats)
        y.append(values[i])

    X, y = np.array(X), np.array(y)

    # Chronological split, never random: shuffling time series leaks the future
    # into training and produces an R^2 that means nothing.
    split = int(len(X) * 0.8)
    model = RandomForestRegressor(
        n_estimators=120, max_depth=12, min_samples_leaf=3,
        random_state=42, n_jobs=1,
    )
    model.fit(X[:split], y[:split])

    r2 = float(r2_score(y[split:], model.predict(X[split:]))) if len(X) - split > 5 else None

    names = [f"lag_{l}" for l in lags] + ["hour_of_day", "mean_12", "std_12"]
    importance = {
        n: round(float(v), 4) for n, v in zip(names, model.feature_importances_)
    }

    # Recursive projection: feed each prediction back in as the newest lag.
    interval_min = _interval_minutes(rows)
    window = list(values[-max_lag:])
    last_t = rows[-1][0]
    residual = float(np.std(y[split:] - model.predict(X[split:]))) if len(X) - split > 5 else 6.0

    points = []
    for horizon in HORIZONS:
        steps = max(1, round(horizon / interval_min))
        sim = list(window)
        t = last_t
        for _ in range(steps):
            t = t + timedelta(minutes=interval_min)
            feats = [sim[-lag] for lag in lags]
            feats.append(t.hour + t.minute / 60.0)
            feats.append(float(np.mean(sim[-12:])))
            feats.append(float(np.std(sim[-12:])))
            nxt = float(model.predict(np.array([feats]))[0])
            sim.append(nxt)

        # Uncertainty widens with distance, because recursive projection
        # compounds its own error at every step.
        spread = residual * (1 + steps ** 0.5 * 0.35)
        points.append({
            "horizon_min": horizon,
            "predicted": round(_clamp(sim[-1]), 1),
            "lower": round(_clamp(sim[-1] - spread), 1),
            "upper": round(_clamp(sim[-1] + spread), 1),
        })

    return points, {
        "model": "random_forest",
        "r2": round(r2, 4) if r2 is not None else None,
        "n_samples": len(X),
        "features": importance,
    }


# ---------------------------------------------------------------------------
#  Tier 2: linear trend
# ---------------------------------------------------------------------------

def _trend(times, values, rows):
    recent = min(len(values), 240)
    t = times[-recent:]
    v = values[-recent:]
    t0 = t - t[0]

    slope, intercept = np.polyfit(t0, v, 1)
    fitted = slope * t0 + intercept
    ss_res = float(np.sum((v - fitted) ** 2))
    ss_tot = float(np.sum((v - np.mean(v)) ** 2))
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else None
    residual = float(np.std(v - fitted)) or 5.0

    last_offset = t0[-1]
    points = []
    for horizon in HORIZONS:
        future = last_offset + horizon * 60
        pred = slope * future + intercept
        spread = residual * (1 + horizon / 180 * 0.5)
        points.append({
            "horizon_min": horizon,
            "predicted": round(_clamp(pred), 1),
            "lower": round(_clamp(pred - spread), 1),
            "upper": round(_clamp(pred + spread), 1),
        })

    return points, {
        "model": "linear_trend",
        "r2": round(float(r2), 4) if r2 is not None else None,
        "n_samples": int(recent),
        "features": {"slope_per_hour": round(float(slope) * 3600, 4)},
    }


# ---------------------------------------------------------------------------

def _clamp(v):
    return max(0.0, min(100.0, float(v)))


def _interval_minutes(rows):
    """Median gap between readings, so projection steps match the real cadence."""
    if len(rows) < 3:
        return 15.0
    gaps = [
        (rows[i][0] - rows[i - 1][0]).total_seconds() / 60.0
        for i in range(1, min(len(rows), 60))
    ]
    gaps = [g for g in gaps if 0 < g < 240]
    return float(np.median(gaps)) if gaps else 15.0
