"""
Smart Odour Monitoring Platform — API
Deployed twice on Render (primary + standby), fronted by the Cloudflare router.

Run locally:  uvicorn main:app --reload --port 8000
"""

from __future__ import annotations

import io
import os
import time
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, HTTPException, Header, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

import db
import predict as pred
from config import settings
from esg_report import build_pdf, upload_to_r2

BOOT_TIME = time.time()
MYT = timezone(timedelta(hours=8))

app = FastAPI(
    title="Smart Odour Monitoring Platform API",
    version="1.0.0",
    description="High-availability environmental odour monitoring for UTeM campus.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def require_admin(token: str | None):
    if token != settings.ADMIN_TOKEN:
        raise HTTPException(status_code=401, detail="invalid admin token")


@app.on_event("startup")
async def _startup():
    # Opening the pool eagerly means the first request after a cold start pays
    # the connection cost once, not on every route.
    try:
        await db.init_pool()
    except Exception as exc:
        # Never block boot on the database: /health has to stay answerable so
        # the router can see this instance is up but degraded.
        print(f"[warn] database pool not ready at startup: {exc}")


@app.on_event("shutdown")
async def _shutdown():
    await db.close_pool()


# ===========================================================================
#  HEALTH  — probed every 60s by the Cloudflare cron
# ===========================================================================
@app.get("/health")
async def health():
    """Must stay cheap. The router's failover decision depends on this
    answering fast, so it does exactly one tiny database round-trip."""
    started = time.perf_counter()
    db_ok = await db.healthcheck()
    latency_ms = round((time.perf_counter() - started) * 1000, 1)

    return {
        "status": "healthy" if db_ok else "degraded",
        "instance": settings.INSTANCE_ROLE,
        "region": settings.INSTANCE_REGION,
        "database": "up" if db_ok else "down",
        "db_latency_ms": latency_ms,
        "uptime_s": round(time.time() - BOOT_TIME),
        "ts": datetime.now(timezone.utc).isoformat(),
    }


# ===========================================================================
#  ZONES + LATEST
# ===========================================================================
@app.get("/zones")
async def list_zones():
    return await db.select("zones", {"select": "*", "order": "id.asc"})


@app.get("/latest")
async def latest_readings():
    """Powers the dashboard tiles and the GIS heatmap."""
    rows = await db.select("v_latest_readings", {"select": "*"})
    for r in rows:
        score = r.get("aqi_score") or 0
        r["status"] = ("hazardous" if score >= 65 else
                       "warning" if score >= 40 else "normal")
    return rows


# ===========================================================================
#  HISTORY
# ===========================================================================
@app.get("/readings")
async def readings(
    zone_id: int = Query(1),
    hours: int = Query(24, ge=1, le=720),
    limit: int = Query(1000, ge=1, le=5000),
):
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    return await db.select("readings", {
        "select": "ts,temperature,humidity,mq5,mq6,mq7_1,mq7_2,aqi_score,source",
        "zone_id": f"eq.{zone_id}",
        "ts": f"gte.{since}",
        "order": "ts.asc",
        "limit": str(limit),
    })


@app.get("/timeline")
async def timeline(hours: int = Query(720, ge=1, le=720)):
    """All zones at once, for the map timeline scrubber."""
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    return await db.select("readings", {
        "select": "zone_id,ts,aqi_score,mq6,mq7_1",
        "ts": f"gte.{since}",
        "order": "ts.asc",
        "limit": "5000",
    })


# ===========================================================================
#  INCIDENTS
# ===========================================================================
@app.get("/incidents")
async def list_incidents(open_only: bool = False, limit: int = 50):
    params = {
        "select": "*,zones(name,code)",
        "order": "opened_at.desc",
        "limit": str(limit),
    }
    if open_only:
        params["resolved_at"] = "is.null"
    return await db.select("incidents", params)


@app.patch("/incidents/{incident_id}/acknowledge")
async def acknowledge(incident_id: str, by: str = "facility@utem.edu.my"):
    rows = await db.patch(
        "incidents",
        {"id": f"eq.{incident_id}"},
        {"acknowledged_at": datetime.now(timezone.utc).isoformat(),
         "acknowledged_by": by},
    )
    if not rows:
        raise HTTPException(404, "incident not found")
    return rows[0]


@app.patch("/incidents/{incident_id}/resolve")
async def resolve(incident_id: str):
    rows = await db.patch(
        "incidents",
        {"id": f"eq.{incident_id}"},
        {"resolved_at": datetime.now(timezone.utc).isoformat()},
    )
    if not rows:
        raise HTTPException(404, "incident not found")
    return rows[0]


# ===========================================================================
#  RELIABILITY MATRIX
# ===========================================================================
@app.get("/uptime")
async def uptime():
    summary = await db.select("v_uptime_24h", {"select": "*"})
    since = (datetime.now(timezone.utc) - timedelta(hours=6)).isoformat()
    samples = await db.select("uptime_samples", {
        "select": "ts,origin,healthy,latency_ms",
        "ts": f"gte.{since}",
        "order": "ts.asc",
        "limit": "1000",
    })
    failovers = await db.select("incidents", {
        "select": "opened_at,message",
        "kind": "eq.failover",
        "order": "opened_at.desc",
        "limit": "10",
    })
    return {
        "target_pct": 99.5,
        "summary": summary,
        "samples": samples,
        "recent_failovers": failovers,
        "responding_instance": settings.INSTANCE_ROLE,
    }


# ===========================================================================
#  PREDICTION
# ===========================================================================
@app.get("/predict")
async def prediction(zone_id: int = Query(1)):
    zones = await db.select("zones", {"select": "*", "id": f"eq.{zone_id}"})
    if not zones:
        raise HTTPException(404, "zone not found")
    zone = zones[0]

    weather = await pred.fetch_weather(zone["latitude"], zone["longitude"])

    recent = await db.select("readings", {
        "select": "ts,aqi_score",
        "zone_id": f"eq.{zone_id}",
        "order": "ts.desc",
        "limit": "48",
    })
    recent.reverse()
    series = [r.get("aqi_score") for r in recent if r.get("aqi_score") is not None]
    current_index = series[-1] if series else 0.0

    return {
        "zone": {"id": zone["id"], "name": zone["name"],
                 "is_physical": zone["is_physical"]},
        "current_index": current_index,
        "weather": weather,
        "plume": pred.predict_plume(zone["latitude"], zone["longitude"],
                                    current_index, weather),
        "trend": pred.forecast_trend(series),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


# ===========================================================================
#  ESG REPORT
# ===========================================================================
@app.post("/reports/esg")
async def generate_esg_report(
    days: int = Query(30, ge=1, le=90),
    archive: bool = Query(True, description="Also upload to R2"),
    x_admin_token: str | None = Header(default=None),
):
    require_admin(x_admin_token)

    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days)

    zones = await db.select("zones", {"select": "*", "order": "id.asc"})

    zone_summaries = []
    for z in zones:
        rows = await db.select("readings", {
            "select": "aqi_score,mq6,mq7_1",
            "zone_id": f"eq.{z['id']}",
            "ts": f"gte.{start.isoformat()}",
            "limit": "5000",
        })
        aqi = [r["aqi_score"] for r in rows if r.get("aqi_score") is not None]
        mq6 = [r["mq6"] for r in rows if r.get("mq6") is not None]
        mq7 = [r["mq7_1"] for r in rows if r.get("mq7_1") is not None]
        zone_summaries.append({
            "code": z["code"],
            "name": z["name"],
            "is_physical": z["is_physical"],
            "readings": len(rows),
            "avg_aqi": sum(aqi) / len(aqi) if aqi else 0,
            "max_aqi": max(aqi) if aqi else 0,
            "avg_mq6": sum(mq6) / len(mq6) if mq6 else 0,
            "max_mq7": max(mq7) if mq7 else 0,
        })

    inc_rows = await db.select("incidents", {
        "select": "opened_at,severity,metric,value,message,resolved_at,zone_id",
        "opened_at": f"gte.{start.isoformat()}",
        "order": "opened_at.desc",
        "limit": "200",
    })
    zone_names = {z["id"]: z["name"] for z in zones}
    for i in inc_rows:
        i["zone"] = zone_names.get(i.get("zone_id"), "Infrastructure")

    uptime_rows = await db.select("v_uptime_24h", {"select": "*"})

    pdf = build_pdf(start.astimezone(MYT), end.astimezone(MYT),
                    zone_summaries, inc_rows, uptime_rows)

    filename = f"ESG_Odour_Report_{end:%Y%m%d_%H%M}.pdf"

    if archive and settings.R2_ACCOUNT_ID:
        key = f"reports/{end:%Y/%m}/{filename}"
        try:
            upload_to_r2(key, pdf, settings)
            await db.insert("reports", [{
                "title": f"ESG Odour Report — {days} days",
                "period_start": start.isoformat(),
                "period_end": end.isoformat(),
                "r2_key": key,
                "generated_by": "api",
            }])
        except Exception as exc:  # archiving must never block the download
            print(f"[warn] R2 archive failed: {exc}")

    return StreamingResponse(
        io.BytesIO(pdf),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/reports")
async def list_reports(limit: int = 25):
    return await db.select("reports", {
        "select": "*", "order": "generated_at.desc", "limit": str(limit),
    })


# ===========================================================================
@app.get("/")
async def root():
    return {
        "service": "Smart Odour Monitoring Platform API",
        "instance": settings.INSTANCE_ROLE,
        "docs": "/docs",
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0",
                port=int(os.getenv("PORT", 8000)), reload=True)
