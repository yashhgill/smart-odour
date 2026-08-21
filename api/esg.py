"""
ESG compliance report.

Deliberately conservative about what it claims. The MQ sensors are not
calibrated to any absolute scale, so this reports a relative odour index and
says so on the page — a compliance document that implies calibrated PPM would
be worse than no document.
"""

import io
from datetime import datetime, timezone

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle, PageBreak,
)

INK = colors.HexColor("#111927")
MUTED = colors.HexColor("#667085")
LINE = colors.HexColor("#e4e8ef")
BLUE = colors.HexColor("#1a73e8")
GREEN = colors.HexColor("#0f9d58")
AMBER = colors.HexColor("#f0a202")
RED = colors.HexColor("#d93025")

WARNING, HAZARDOUS = 40, 65


def _styles():
    s = getSampleStyleSheet()
    return {
        "title": ParagraphStyle("t", parent=s["Title"], fontSize=19, textColor=INK,
                                spaceAfter=4, alignment=0),
        "sub": ParagraphStyle("s", parent=s["Normal"], fontSize=9.5, textColor=MUTED,
                              spaceAfter=14),
        "h2": ParagraphStyle("h", parent=s["Heading2"], fontSize=12, textColor=INK,
                             spaceBefore=15, spaceAfter=7),
        "body": ParagraphStyle("b", parent=s["Normal"], fontSize=9.5, textColor=INK,
                               leading=14, spaceAfter=7),
        "note": ParagraphStyle("n", parent=s["Normal"], fontSize=8.5, textColor=MUTED,
                               leading=12, spaceAfter=6),
    }


def _band(v):
    if v is None:
        return "no data", MUTED
    if v >= HAZARDOUS:
        return "hazardous", RED
    if v >= WARNING:
        return "warning", AMBER
    return "normal", GREEN


def _stats(rows):
    vals = [r["aqi_score"] for r in rows if r.get("aqi_score") is not None]
    if not vals:
        return None
    vals_sorted = sorted(vals)
    n = len(vals_sorted)
    return {
        "n": n,
        "mean": sum(vals) / n,
        "max": max(vals),
        "min": min(vals),
        "p95": vals_sorted[int(n * 0.95)] if n > 20 else max(vals),
        "over_warning": sum(1 for v in vals if v >= WARNING),
        "over_hazard": sum(1 for v in vals if v >= HAZARDOUS),
    }


def build_report(zones, series, incidents, days):
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm,
        topMargin=18 * mm, bottomMargin=18 * mm,
        title="Environmental Odour Compliance Report",
    )
    st = _styles()
    now = datetime.now(timezone.utc)
    flow = []

    flow.append(Paragraph("Environmental Odour Compliance Report", st["title"]))
    flow.append(Paragraph(
        f"Universiti Teknikal Malaysia Melaka &middot; Campus Air Quality Station Network<br/>"
        f"Reporting period: {days} days ending {now:%d %B %Y} &middot; "
        f"Generated {now:%Y-%m-%d %H:%M} UTC", st["sub"]))

    # --- summary table -----------------------------------------------------
    flow.append(Paragraph("Station summary", st["h2"]))
    data = [["Station", "Type", "Readings", "Mean", "Peak", "95th pct",
             "Over warn", "Over hazard", "Status"]]
    styles = [
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f8fafc")),
        ("TEXTCOLOR", (0, 0), (-1, 0), MUTED),
        ("FONTSIZE", (0, 0), (-1, -1), 7.6),
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (2, 0), (-2, -1), "RIGHT"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
    ]

    for i, z in enumerate(zones, start=1):
        s = _stats(series.get(z["id"], []))
        if not s:
            data.append([z.get("code", z["id"]),
                         "hardware" if z.get("is_physical") else "replay",
                         "0", "—", "—", "—", "—", "—", "no data"])
            styles.append(("TEXTCOLOR", (8, i), (8, i), MUTED))
            continue
        label, colour = _band(s["max"])
        data.append([
            z.get("code", z["id"]),
            "hardware" if z.get("is_physical") else "replay",
            f"{s['n']:,}", f"{s['mean']:.1f}", f"{s['max']:.1f}", f"{s['p95']:.1f}",
            f"{s['over_warning']:,}", f"{s['over_hazard']:,}", label,
        ])
        styles.append(("TEXTCOLOR", (8, i), (8, i), colour))

    t = Table(data, colWidths=[22 * mm, 19 * mm, 19 * mm, 15 * mm, 15 * mm,
                               17 * mm, 19 * mm, 21 * mm, 20 * mm])
    t.setStyle(TableStyle(styles))
    flow.append(t)

    # --- incidents ---------------------------------------------------------
    flow.append(Paragraph("Recorded incidents", st["h2"]))
    if incidents:
        idata = [["Opened", "Station", "Severity", "Description", "Resolved"]]
        for inc in incidents[:28]:
            idata.append([
                (inc.get("opened_at") or "")[:16].replace("T", " "),
                str(inc.get("zone_id") or "—"),
                inc.get("severity", ""),
                Paragraph(str(inc.get("message", ""))[:150],
                          ParagraphStyle("c", fontSize=7.2, leading=9.4)),
                "yes" if inc.get("resolved_at") else "open",
            ])
        it = Table(idata, colWidths=[26 * mm, 16 * mm, 18 * mm, 75 * mm, 18 * mm])
        it.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f8fafc")),
            ("TEXTCOLOR", (0, 0), (-1, 0), MUTED),
            ("FONTSIZE", (0, 0), (-1, -1), 7.4),
            ("GRID", (0, 0), (-1, -1), 0.4, LINE),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        flow.append(it)
    else:
        flow.append(Paragraph("No incidents were recorded in this period.", st["body"]))

    # --- methodology -------------------------------------------------------
    flow.append(PageBreak())
    flow.append(Paragraph("Methodology and limitations", st["h2"]))
    flow.append(Paragraph(
        "Readings are collected by ESP32 edge nodes carrying MQ-5, MQ-6 and two "
        "MQ-7 gas sensors with a DHT11 for temperature and humidity. Each node "
        "samples every eight seconds and transmits over HTTPS, signing every "
        "payload with HMAC-SHA256 so a reading cannot be forged by a third party.",
        st["body"]))
    flow.append(Paragraph(
        "<b>The odour index is a relative severity score from 0 to 100, not a "
        "calibrated concentration.</b> MQ-series sensors output a raw 12-bit "
        "analogue value that varies with temperature, humidity and sensor age, "
        "and they are not factory calibrated against a reference gas. This "
        "report therefore makes no claim in parts per million. Converting these "
        "readings to absolute concentrations would require per-sensor "
        "calibration against a known reference, which has not been performed.",
        st["body"]))
    flow.append(Paragraph(
        "The index weights MQ-6 most heavily at 0.45, MQ-5 at 0.20, and the two "
        "MQ-7 carbon monoxide channels at 0.175 each, normalised against their "
        "practical ceilings. Thresholds are 40 for warning and 65 for hazardous.",
        st["body"]))
    flow.append(Paragraph(
        "Stations marked <i>replay</i> reproduce recorded campus data rather "
        "than live hardware, and are labelled as such throughout the platform. "
        "Only stations marked <i>hardware</i> represent live physical "
        "measurement.", st["body"]))
    flow.append(Spacer(1, 8))
    flow.append(Paragraph(
        f"Report generated automatically {now:%Y-%m-%d %H:%M} UTC. Raw payloads "
        "are archived in object storage and are available for independent "
        "verification.", st["note"]))

    doc.build(flow)
    return buf.getvalue()
