# The three front doors

| URL | Who | Login |
|---|---|---|
| `/` | anyone | no |
| `/user.html` | residents, staff | yes |
| `/admin.html` | facilities, admins | yes |

All three share one session cookie, so signing in once covers the portals you
have the role for.

**Who can open what.** `/admin.html` refuses any role below `facility` at the
door, showing which role the account actually holds and a link to the user
portal. The switcher only advertises the admin link to roles that can use it.

An admin can open `/user.html` and that is intentional — an administrator is
also a campus resident, and may want to file an odour report or see what users
see. Nothing in the user portal is privileged.

**The refusal is presentation, not security.** The server checks the role on
every privileged route regardless of what the sidebar renders. Before this gate
existed a viewer could open the admin console and see public data with every
privileged panel failing — no leak, but it looked like one.

## Roles

| | viewer | facility | admin |
|---|---|---|---|
| View readings, history, map | yes | yes | yes |
| Submit a community odour report | yes | yes | yes |
| Edit own profile and alert prefs | yes | yes | yes |
| Acknowledge / resolve incidents | no | yes | yes |
| Review community reports | no | yes | yes |
| Change calibration thresholds | no | no | yes |
| List users, issue invites | no | no | yes |

Registration is invite-only. Your bootstrap account is `admin`; everyone else
needs a code you issue from **System & Admin → Create invite**. Codes last 72
hours and work once.

## Deploying this build

There is a schema change, so run the migration before the Worker.

```bash
cd worker
```

```bash
npx wrangler d1 execute smart-odour --remote -y --file=../d1/migration_002.sql
```

```bash
npx wrangler deploy
```

```bash
cd ..
```

```bash
npx wrangler pages deploy dashboard --project-name smart-odour --commit-dirty=true
```

## Deliberate departures from the mockups

**Google Maps is replaced by a drawn SVG map.** The Maps JavaScript API needs a
billed API key, and a key shipped in a static page is a public key — anyone can
lift it and spend against your account. The SVG version needs no key, costs
nothing, and renders when campus WiFi does not, which matters on demo day.

**"Tomorrow's prediction" shows "Not available".** There is no weather binding
and no forecast route deployed. A predicted temperature rendered from nothing
is a number you cannot defend when an examiner asks where it came from.

**"AI Safe Route Guide" is empty with an explanation.** Routing around a plume
requires modelling the plume. Until the dispersion forecast exists, a route
claiming to be safe would be worse than offering none.

**NH3 / PPM became a 0-100 odour index.** The mockups label the y-axis
"NH3 Concentration (PPM)", but MQ-5, MQ-6 and MQ-7 do not measure ammonia and
are not factory calibrated to any PPM scale — they output a raw 12-bit ADC
value that varies with temperature, humidity and sensor age. Presenting ADC as
PPM would be a fabricated unit, and it is the single easiest thing for an
examiner to pull apart. The composite index is honest about being a relative
severity score. If you need real PPM you need a calibrated reference gas and a
per-sensor curve, which is a project in itself.

**Community reports are stored separately from readings.** A human saying "it
smells" is an observation, not a measurement. Merging them would corrupt every
chart and the ESG report along with it. They live in `odour_reports` and appear
to facility staff for review.
