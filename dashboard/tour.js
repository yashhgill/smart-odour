// A short guided walkthrough of the public page. Opens once on a first visit, and any time from the Guide button.
(() => {
  const STEPS = [
    { el: '.display', title: 'Is the air okay right now?', text: 'This screen gives the answer in plain words for the whole campus. If it says "Close your windows", there is a strong smell somewhere.' },
    { el: '#map', title: 'Where is it happening?', text: 'Each circle is a location with its current Odour Index. Green is normal, yellow is noticeable, red is strong and grey means no data. The chicken farm is labelled too.' },
    { el: '#scale', title: 'What does the number mean?', text: 'The Odour Index runs from 0 to 100. It compares the air with clean air at that same spot. Use this bar any time you are unsure what a number means.' },
    { el: '#locs', title: 'Check your own area', text: 'Every location has its own card with a 24-hour strip. Tap a card, like your kolej or the cafeteria, and the charts below show only that place.' },
    { el: '#whenscope', box: '.grid3', title: 'When does it usually happen?', text: 'These charts show the hours with the most odour, which places are worst and how often it happens. Change the period with the menu.' },
    { el: '.say', box: '.side .card', title: 'Tell us what you smell', text: 'Choose your location and tap one answer, even when the air is fine. No login is needed. These answers help set the levels correctly.' },
    { el: '#tgband', title: 'Get warned on Telegram', text: 'Tap this button, then press Start in Telegram. You get a message when a smell lasts, and again when it clears. Send /stop any time.' },
  ];
  const KEY = 'odour_tour_seen';
  let i = 0, ring, card, back;
  const steps = () => STEPS.filter(s => { const n = document.querySelector(s.box || s.el); return n && !n.closest('[hidden]') && !n.hidden && n.offsetParent !== null; });

  function place() {
    const list = steps(), s = list[i];
    if (!s) return close();
    const t = document.querySelector(s.box || s.el), r = t.getBoundingClientRect(), pad = 8;
    Object.assign(ring.style, { top: r.top - pad + 'px', left: r.left - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
    const h = card.offsetHeight, w = card.offsetWidth, vh = innerHeight, vw = innerWidth;
    const below = r.bottom + 18, above = r.top - h - 18;
    const top = below + h < vh - 8 ? below : above > 8 ? above : Math.max(8, vh - h - 8);
    card.style.top = top + 'px';
    card.style.left = Math.min(Math.max(8, r.left), vw - w - 8) + 'px';
  }
  function show() {
    const list = steps(), s = list[i];
    if (!s) return close();
    card.querySelector('.tstep').textContent = `Step ${i + 1} of ${list.length}`;
    card.querySelector('h2').textContent = s.title;
    card.querySelector('p').textContent = s.text;
    back.hidden = i === 0;
    card.querySelector('.tnext').textContent = i === list.length - 1 ? 'Done' : 'Next';
    const t = document.querySelector(s.box || s.el), r = t.getBoundingClientRect();
    // Scroll so the highlighted part clears the fixed header and leaves room for the card.
    const room = innerHeight - 90;
    const y = scrollY + r.top - (r.height + card.offsetHeight + 40 < room ? 90 : Math.max(70, (innerHeight - r.height) / 2));
    scrollTo({ top: Math.max(0, y), behavior: 'auto' });
    place();
    card.querySelector('.tnext').focus();
  }
  function close() {
    ring?.remove(); card?.remove(); ring = card = null;
    removeEventListener('resize', place); removeEventListener('scroll', place); removeEventListener('keydown', onKey);
    try { localStorage.setItem(KEY, '1'); } catch {}
    document.querySelector('#guide')?.focus();
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight') next();
    if (e.key === 'ArrowLeft' && i > 0) { i--; show(); }
  }
  function next() { if (i >= steps().length - 1) close(); else { i++; show(); } }
  function start() {
    if (card) return;
    i = 0;
    ring = document.createElement('div'); ring.className = 'tring';
    card = document.createElement('div'); card.className = 'tcard'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-label', 'Guide to this page');
    card.innerHTML = '<div class="tstep" aria-live="polite"></div><h2></h2><p></p><div class="tbtns"><button class="btn tskip">Skip</button><span><button class="btn tback">Back</button> <button class="btn primary tnext">Next</button></span></div>';
    document.body.append(ring, card);
    back = card.querySelector('.tback');
    card.querySelector('.tskip').onclick = close;
    back.onclick = () => { i--; show(); };
    card.querySelector('.tnext').onclick = next;
    addEventListener('resize', place); addEventListener('scroll', place, { passive: true }); addEventListener('keydown', onKey);
    show();
  }
  document.querySelector('#guide').onclick = start;
  let seen = false;
  try { seen = !!localStorage.getItem(KEY); } catch {}
  // Wait for the live data to fill the page, so the highlights land in the right places.
  if (!seen) { const wait = setInterval(() => { if (document.querySelector('#locs .loc')) { clearInterval(wait); setTimeout(start, 500); } }, 300); setTimeout(() => clearInterval(wait), 15000); }
})();
