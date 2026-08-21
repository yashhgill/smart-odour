"""
Smart Odour — compute sidecar.

This exists because two things genuinely cannot run on Cloudflare Workers:
scikit-learn and ReportLab both need CPython with native extensions. Everything
else — ingest, auth, storage, alerting — stays on the Worker, which keeps the
data path at the edge and this service off the critical path entirely.

If this service is down, the platform keeps working. Forecasts go stale and PDF
export returns an error; readings, alerts and the dashboards are unaffected.
That is deliberate: the sidecar is an enhancement, never a dependency.
"""

import os
import time
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI, Header, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware

from predictor import fit_zone, InsufficientData
from esg import build_report

WORKER_BASE = os.getenv("WORKER_BASE", "https://odour-router.yashchaal99.workers.dev/api")
SERVICE_TOKEN = os.getenv("SERVICE_TOKEN", "")
FORECAST_HOURS = int(os.getenv("FORECAST_HOURS", "336"))

app = FastAPI(title="Smart Odour compute sidecar", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _require_token(token: str | None):
    """
    Both endpoints mutate or cost real work, so neither is open. The Worker
    holds the same token and is the only expected caller.
    """
    if not SERVICE_TOKEN:
        raise HTTPException(503, "SERVICE_TOKEN is not configured on this service")
    if token != SERVICE_TOKEN:
        raise HTTPException(401, "invalid service token")


@app.get("/health")
def health():
    return {"ok": True, "ts": _now(), "worker": WORKER_BASE}


@app.post("/run-forecast")
async def run_forecast(x_service_token: str | None = Header(default=None)):
    """
    Pull recent readings for every zone, fit a model per zone, and post the
    results back to the Worker. Called by the Worker's cron every 15 minutes.
    """
    _require_token(x_service_token)

    run_id = str(uuid.uuid4())
    started = time.time()
    fitted, errors, model_used = 0, [], None

    async with httpx.AsyncClient(timeout=30) as client:
        try:
            zones = (await client.get(f"{WORKER_BASE}/zones")).json()
        except Exception as exc:
            raise HTTPException(502, f"could not reach the Worker: {exc}")

        for zone in zones:
            zid = zone["id"]
            try:
                resp = await client.get(
                    f"{WORKER_BASE}/readings",
                    params={"zone_id": zid, "hours": FORECAST_HOURS, "limit": 5000},
                )
                readings = resp.json()
                points, meta = fit_zone(readings)
                model_used = meta["model"]

                await client.post(
                    f"{WORKER_BASE}/predictions",
                    headers={"X-Service-Token": SERVICE_TOKEN},
                    json={"zone_id": zid, "points": points, "meta": meta},
                )
                fitted += 1

            except InsufficientData as exc:
                # Not an error. A zone with no hardware yet simply has nothing
                # to fit, and saying so is more useful than inventing a curve.
                errors.append(f"zone {zid}: {exc}")
            except Exception as exc:
                errors.append(f"zone {zid}: {type(exc).__name__}: {exc}")

        duration = int((time.time() - started) * 1000)
        try:
            await client.post(
                f"{WORKER_BASE}/model-runs",
                headers={"X-Service-Token": SERVICE_TOKEN},
                json={
                    "id": run_id,
                    "ok": 1 if fitted else 0,
                    "model": model_used,
                    "zones_fitted": fitted,
                    "duration_ms": duration,
                    "detail": "; ".join(errors)[:500] or None,
                },
            )
        except Exception:
            pass   # losing the run log must not fail the run

    return {"run_id": run_id, "zones_fitted": fitted, "duration_ms": duration, "notes": errors}


@app.post("/esg-report")
async def esg_report(
    days: int = 30,
    x_service_token: str | None = Header(default=None),
):
    """
    Build the compliance PDF. Returns the bytes; the Worker archives a copy in
    R2 and records the metadata.
    """
    _require_token(x_service_token)
    days = max(1, min(days, 365))

    async with httpx.AsyncClient(timeout=60) as client:
        zones = (await client.get(f"{WORKER_BASE}/zones")).json()
        series = {}
        for zone in zones:
            resp = await client.get(
                f"{WORKER_BASE}/readings",
                params={"zone_id": zone["id"], "hours": days * 24, "limit": 5000},
            )
            series[zone["id"]] = resp.json()
        incidents = (await client.get(
            f"{WORKER_BASE}/incidents", params={"open_only": "false", "limit": 100}
        )).json()

    pdf = build_report(zones, series, incidents, days)
    filename = f"ESG_Odour_Report_{datetime.now(timezone.utc):%Y%m%d}_{days}d.pdf"

    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
