// Telegram sends bot messages here. The database checks the secret and writes the answer, and this
// passes it straight back as the webhook's reply, so the website never holds the bot token.
const SUPABASE = 'https://nikdxqsardermmjkfudv.supabase.co';
const KEY = 'sb_publishable_fQfM3HatwxiSpZZZLUifQg_dXoJMSnF'; // public by design, like dashboard/config.js

export async function onRequestPost({ request }) {
  let update;
  try { update = await request.json(); } catch { return new Response('Bad request', { status: 400 }); }
  const res = await fetch(`${SUPABASE}/rest/v1/rpc/telegram_update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ p_secret: request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '', p_update: update }),
  });
  if (res.status === 401) return new Response('Forbidden', { status: 403 });
  // Anything else unexpected still answers 200, or Telegram would keep resending the same message.
  const body = res.ok ? await res.text() : '';
  if (!body || body === 'null') return new Response(null, { status: 204 });
  return new Response(body, { headers: { 'Content-Type': 'application/json' } });
}
