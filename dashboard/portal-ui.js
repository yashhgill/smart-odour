/* ==========================================================================
   Shared UI for both portals: nav icons, theme, and the map.

   Loaded before admin.js / user.js. Everything here is presentation only —
   no API calls, no auth. Keeping it separate means a visual change never
   risks the data path.
   ========================================================================== */

/* Inline SVG rather than an icon font or a CDN package: no extra request, no
   flash of unstyled icons, and it still renders if the network is down —
   which on campus WiFi is a real consideration. */
const ICONS = {
  home:    '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/>',
  data:    '<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h10"/><circle cx="18.5" cy="19" r="2"/>',
  ai:      '<rect x="6" y="6" width="12" height="12" rx="2.5"/><path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3"/>',
  alerts:  '<path d="M12 3 3 20h18L12 3Z"/><path d="M12 10v4"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>',
  system:  '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  map:     '<path d="M9 4 3 6.5v14L9 18l6 2.5 6-2.5v-14L15 6.5 9 4Z"/><path d="M9 4v14M15 6.5v14"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.5l3.5 2"/>',
  profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/>',
  sun:     '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8"/>',
  moon:    '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>',
  logout:  '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  wind:    '<path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 13h15a3 3 0 1 1-3 3"/><path d="M3 18h8"/>',
};

const svgIcon = (name, cls = '') =>
  `<span class="${cls}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg></span>`;

/* ------------------------------------------------------------------ theme -- */

/** Sidebar / masthead mark. Two files because the artwork differs per theme. */
function markHTML() {
  return '<div class="side__mark">'
       + '<img src="assets/logo-light-mark.png" alt="Smart Odour" class="mark--light">'
       + '<img src="assets/logo-dark-mark.png"  alt="" class="mark--dark" aria-hidden="true">'
       + '</div>';
}

/** Called after sign-in, when the role is finally known. */
function setRole(role, current) {
  window.__odourRole = role;
  addPortalSwitcher(current, role);
}

function swapLogoArt(theme) {
  const full = document.querySelector('.gate__logo');
  if (full) full.src = `assets/logo-${theme === 'dark' ? 'dark' : 'light'}-full.png`;
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  swapLogoArt(theme);
  try { localStorage.setItem('odour_theme', theme); } catch { /* private mode */ }
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.innerHTML = `<svg viewBox="0 0 24 24">${theme === 'dark' ? ICONS.sun : ICONS.moon}</svg>`;
    btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    btn.setAttribute('title', theme === 'dark' ? 'Light mode' : 'Dark mode');
  }
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('odour_theme'); } catch { /* ignore */ }
  // Respect the OS preference on first visit rather than forcing light.
  const prefersDark = window.matchMedia
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
}

function toggleTheme() {
  const now = document.documentElement.getAttribute('data-theme');
  applyTheme(now === 'dark' ? 'light' : 'dark');
  // Leaflet needs a nudge after a theme change or tiles keep the old filter.
  if (window.__odourMap) setTimeout(() => window.__odourMap.invalidateSize(), 60);
}

/* ------------------------------------------------------------- decoration -- */

/** Adds icons to nav buttons and the brand mark, using each button's data-sec. */
function decorateChrome(subtitle) {
  document.querySelectorAll('.nav button').forEach((b) => {
    if (b.querySelector('.nav__ico')) return;
    const key = b.dataset.sec;
    b.insertAdjacentHTML('afterbegin', svgIcon(key, 'nav__ico'));
  });

  const brand = document.querySelector('.side__brand');
  if (brand && !brand.querySelector('.side__mark')) {
    brand.insertAdjacentHTML('afterbegin', markHTML());
  }

  // The login card has room for the full lockup, so it gets the wordmark
  // rather than the icon, and the heading below it is dropped to avoid
  // saying "Smart Odour" twice.
  const gateBrand = document.querySelector('.gate__brand');
  if (gateBrand && !gateBrand.querySelector('.gate__logo')) {
    gateBrand.insertAdjacentHTML('afterbegin',
      `<img class="gate__logo" src="assets/logo-light-full.png" alt="Smart Odour Monitoring Platform">`);
    const h1 = gateBrand.querySelector('h1');
    if (h1) h1.remove();
  }

  const who = document.querySelector('.who');
  if (who && !document.getElementById('theme-toggle')) {
    const btn = document.createElement('button');
    btn.id = 'theme-toggle';
    btn.className = 'icon-btn';
    btn.type = 'button';
    btn.addEventListener('click', toggleTheme);
    who.insertBefore(btn, who.firstChild);
    applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
  }

  const logout = document.getElementById('logout');
  if (logout && !logout.querySelector('svg')) {
    logout.innerHTML = `<svg viewBox="0 0 24 24">${ICONS.logout}</svg><span>Sign out</span>`;
  }

  if (subtitle) {
    const p = document.querySelector('.side__brand p');
    if (p) p.textContent = subtitle;
  }

  addPortalSwitcher(subtitle, window.__odourRole || null);
}

/**
 * Links between the views. The admin link is shown only to roles that can
 * actually use it — advertising a console a viewer will be refused from is
 * confusing, and it invites the question of whether the refusal is real.
 *
 * This is presentation, not security. The server checks the role on every
 * privileged route regardless of what the sidebar chooses to render.
 */
const ADMIN_ROLES = ['admin', 'facility'];

function addPortalSwitcher(current, role) {
  const side = document.querySelector('.side');
  if (!side) return;
  side.querySelector('.side__foot')?.remove();

  const links = [
    ['Admin Portal',   'admin.html', ICONS.system],
    ['User Portal',    'user.html',  ICONS.profile],
    ['Public view',    'index.html', ICONS.map],
  ].filter(([label]) => label !== current)
   .filter(([label]) => label !== 'Admin Portal' || (role && ADMIN_ROLES.includes(role)));

  const foot = document.createElement('div');
  foot.className = 'side__foot';
  foot.innerHTML = `
    <div class="sub" style="margin:0 0 6px 13px">Switch to</div>
    ${links.map(([label, href, ico]) => `
      <a class="nav__link" href="${href}">
        <span class="nav__ico"><svg viewBox="0 0 24 24">${ico}</svg></span>
        <span>${label}</span>
      </a>`).join('')}`;
  side.appendChild(foot);
}

/* ------------------------------------------------------------------- map -- */

/**
 * Loads Leaflet from CDN and renders the stations on OpenStreetMap tiles.
 *
 * Leaflet with OSM needs no API key and no billing account, unlike the Google
 * Maps JavaScript API. A Maps key shipped in a static page is a public key —
 * anyone can lift it and spend against the account it belongs to.
 *
 * Returns false if the CDN is unreachable, so the caller can fall back to the
 * drawn SVG map. Campus WiFi failing should degrade the map, not the page.
 */
function loadLeaflet() {
  if (window.L) return Promise.resolve(true);
  return new Promise((resolve) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);

    const js = document.createElement('script');
    js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    js.onload = () => resolve(true);
    js.onerror = () => resolve(false);
    document.head.appendChild(js);

    setTimeout(() => resolve(Boolean(window.L)), 6000);
  });
}

const STATE_COLOUR = {
  normal:    '#0e9f6e',
  warning:   '#e8940c',
  hazardous: '#dc3545',
  offline:   '#94a3b8',
};

async function renderStationMap(containerId, stations) {
  const host = document.getElementById(containerId);
  if (!host || !stations.length) return false;

  const ok = await loadLeaflet();
  if (!ok) return false;

  if (window.__odourMap) {
    window.__odourMap.remove();
    window.__odourMap = null;
  }

  const lats = stations.map((s) => s.latitude);
  const lons = stations.map((s) => s.longitude);
  const centre = [
    (Math.min(...lats) + Math.max(...lats)) / 2,
    (Math.min(...lons) + Math.max(...lons)) / 2,
  ];

  const map = L.map(containerId, { scrollWheelZoom: false }).setView(centre, 16);
  window.__odourMap = map;

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  for (const s of stations) {
    const status = s.status || 'offline';
    const colour = STATE_COLOUR[status] || STATE_COLOUR.offline;
    const index = s.aqi_score;

    // A translucent halo scaled to the reading, so severity reads spatially
    // before anyone looks at a number.
    if (status === 'warning' || status === 'hazardous') {
      L.circle([s.latitude, s.longitude], {
        radius: 40 + (index || 0) * 1.6,
        color: colour, fillColor: colour, fillOpacity: 0.14, weight: 1,
      }).addTo(map);
    }

    L.circleMarker([s.latitude, s.longitude], {
      radius: s.is_physical ? 11 : 8,
      color: colour,
      fillColor: s.is_physical ? colour : '#ffffff',
      fillOpacity: s.is_physical ? 0.9 : 1,
      weight: 3,
      dashArray: s.is_physical ? null : '4 3',
    }).addTo(map).bindPopup(`
      <div style="font-family:Inter,sans-serif;min-width:170px">
        <div style="font-weight:650;font-size:13.5px">${s.zone_name || s.code}</div>
        <div style="font-size:11px;color:#64748b;margin-bottom:7px">
          ${s.is_physical ? 'Physical hardware' : 'Replayed data'}
        </div>
        <div style="font-family:ui-monospace,monospace;font-size:21px;color:${colour}">
          ${index == null ? '—' : Number(index).toFixed(1)}
        </div>
        <div style="font-size:11px;color:#64748b;text-transform:uppercase;
                    letter-spacing:.06em;font-weight:650">${status}</div>
        ${s.ts ? `<div style="font-size:11px;color:#94a3b8;margin-top:6px">
          ${new Date(s.ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
        </div>` : ''}
      </div>`);
  }

  map.fitBounds(stations.map((s) => [s.latitude, s.longitude]), { padding: [45, 45] });
  setTimeout(() => map.invalidateSize(), 120);
  return true;
}

/**
 * Entry choreography runs exactly once. The dashboards re-render every 30
 * seconds when polling returns; without this guard the whole interface would
 * re-animate on every refresh, which is nauseating on a screen someone is
 * monitoring for an hour.
 */
function playEntranceOnce() {
  if (sessionStorage.getItem('odour_entered')) return;
  document.body.classList.add('is-loading');
  try { sessionStorage.setItem('odour_entered', '1'); } catch { /* private mode */ }
  // Remove the class after the longest delay + duration, so later DOM writes
  // (new cards from a poll) are never caught by the animation rules.
  setTimeout(() => document.body.classList.remove('is-loading'), 3200);
}

document.addEventListener('DOMContentLoaded', playEntranceOnce);

// Apply the theme before first paint so there is no white flash in dark mode.
initTheme();
