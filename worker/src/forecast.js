/**
 * Native forecasting — runs entirely inside the Cloudflare Worker.
 *
 * No Python, no numpy, no sidecar. Two model tiers:
 *
 *   < 60  readings  → refuse
 *  60–499 readings  → weighted linear regression on time + hour-of-day
 *    500+ readings  → same + lag features (reported as "enhanced_linear")
 *
 * Output schema is identical to the Python sidecar so the admin portal
 * AI Prediction tab works without any frontend changes.
 */

const HORIZONS    = [30, 60, 120, 180]; // minutes ahead
const MIN_SAMPLES = 60;
const ENHANCED_AT = 500;

/** OLS via normal equations: β = (XᵀX)⁻¹ Xᵀy */
function ols(X, y) {
  const n = X.length, k = X[0].length;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < n; i++)
    for (let a = 0; a < k; a++)
      for (let b = 0; b < k; b++)
        XtX[a][b] += X[i][a] * X[i][b];
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++)
    for (let a = 0; a < k; a++)
      Xty[a] += X[i][a] * y[i];

  // Gauss-Jordan inversion
  const aug = XtX.map((r, i) =>
    [...r, ...Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))]
  );
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++)
      if (Math.abs(aug[r][col]) > Math.abs(aug[pivot][col])) pivot = r;
    [aug[col], aug[pivot]] = [aug[pivot], aug[col]];
    const d = aug[col][col];
    if (Math.abs(d) < 1e-12) continue;
    for (let j = 0; j < 2 * k; j++) aug[col][j] /= d;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = aug[r][col];
      for (let j = 0; j < 2 * k; j++) aug[r][j] -= f * aug[col][j];
    }
  }
  const inv = aug.map(r => r.slice(k));
  return inv.map(r => r.reduce((s, v, i) => s + v * Xty[i], 0));
}

/**
 * Build feature row.
 *
 * x-axis: reading index normalised to [0, 1]. Using index rather than wall
 * time avoids blow-up when the training window (say 10 min of 8-sec samples)
 * is much shorter than the forecast horizon (60–180 min). Extrapolating 60
 * minutes from a 10-minute window using wall time gives x ≈ 7× the training
 * max, which sends linear regression to extreme values even with reasonable σ.
 * With index normalisation a +60-min horizon maps to roughly index 1.05,
 * which is a mild extrapolation the model handles correctly.
 *
 * Extra features: hour-of-day sin/cos capture diurnal patterns (morning
 * agriculture, midday heat) without needing many samples.
 */
function makeRow(idx, n, hourOfDay, lag1, lag2, useLags) {
  const x = idx / Math.max(n - 1, 1);
  const h = (hourOfDay / 24) * 2 * Math.PI;
  const row = [1, x, Math.sin(h), Math.cos(h)];
  if (useLags) { row.push(lag1 ?? 0); row.push(lag2 ?? 0); }
  return row;
}

/**
 * Fit and forecast for a set of readings.
 * readings: [{ts, aqi_score}] newest-first (as returned by D1 ORDER BY ts DESC).
 */
export function fitAndForecast(readings) {
  const n = readings.length;
  if (n < MIN_SAMPLES) {
    return {
      available: false,
      reason: `Need at least ${MIN_SAMPLES} readings; zone has ${n}.`,
    };
  }

  // Reverse to chronological order
  const chron = [...readings].reverse();
  const vals  = chron.map(r => Number(r.aqi_score));
  const times = chron.map(r => new Date(r.ts).getTime()); // ms

  // Estimate sampling rate from the last 20 readings
  const recentMs = times[n - 1] - times[Math.max(0, n - 20)];
  const msPerSample = recentMs / Math.min(19, n - 1) || 8000;

  const useLags = n >= ENHANCED_AT;
  const start   = useLags ? 2 : 0;

  const X = [], y = [];
  for (let i = start; i < n; i++) {
    const hour = new Date(times[i]).getUTCHours() + new Date(times[i]).getUTCMinutes() / 60;
    X.push(makeRow(i, n, hour, useLags ? vals[i - 1] : undefined, useLags ? vals[i - 2] : undefined, useLags));
    y.push(vals[i]);
  }

  const beta = ols(X, y);

  const resid = y.map((yi, i) => yi - X[i].reduce((s, v, j) => s + v * beta[j], 0));
  const sigma = Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / Math.max(resid.length - beta.length, 1));

  const mean  = y.reduce((s, v) => s + v, 0) / y.length;
  const ssTot = y.reduce((s, v) => s + (v - mean) ** 2, 0);
  const ssRes = resid.reduce((s, r) => s + r * r, 0);
  const r2    = ssTot < 1e-9 ? 1 : Math.max(0, 1 - ssRes / ssTot);

  // For each horizon, map minutes-ahead to a fractional index position
  const lastTime = times[n - 1];
  const lastVal  = vals[n - 1];
  const prevVal  = vals[n - 2] ?? lastVal;

  const forecasts = HORIZONS.map(horizonMin => {
    const futureMs    = lastTime + horizonMin * 60000;
    // how many samples ahead is this horizon?
    const samplesAhead = (horizonMin * 60000) / msPerSample;
    const futureIdx    = n - 1 + samplesAhead;
    const hour = new Date(futureMs).getUTCHours() + new Date(futureMs).getUTCMinutes() / 60;
    const row  = makeRow(futureIdx, n, hour, useLags ? lastVal : undefined, useLags ? prevVal : undefined, useLags);
    const pt   = row.reduce((s, v, j) => s + v * beta[j], 0);
    const cl   = Math.max(0, Math.min(100, pt));
    return {
      horizon_minutes: horizonMin,
      predicted_index: Math.round(cl * 10) / 10,
      lower: Math.max(0,   Math.round((cl - sigma) * 10) / 10),
      upper: Math.min(100, Math.round((cl + sigma) * 10) / 10),
      ts: new Date(futureMs).toISOString(),
    };
  });

  return {
    available: true,
    model: useLags ? 'enhanced_linear' : 'linear_trend',
    readings_used: n,
    r2: Math.round(r2 * 1000) / 1000,
    sigma: Math.round(sigma * 10) / 10,
    forecasts,
    fitted_at: new Date().toISOString(),
  };
}

/** Fetch readings from D1 and run the model. Called from /predict. */
export async function predictZone(env, zoneId) {
  const { results } = await env.DB.prepare(
    `select ts, aqi_score from readings
      where zone_id = ?1 and aqi_score is not null
      order by ts desc limit 1000`
  ).bind(zoneId).all();

  if (!results || results.length === 0) {
    return { available: false, reason: 'No readings for this zone yet.' };
  }
  return fitAndForecast(results);
}
