// The Canvas Commons API — Cloudflare Worker + D1 (database) + KV (artwork photos).
// docs/index.html is bundled in and served for every non-API path; /api/* is the JSON API.
import INDEX_HTML from '../docs/index.html';

const PRINT_SIZES = { '12x16': 2499, '18x24': 3999, '24x36': 5999 };
const ITEM_STATUSES = ['Paid', 'Packed', 'Shipped', 'Delivered', 'Return window', 'Payout released', 'Cancelled'];
const LEAD_STAGES = ['New', 'Site visit', 'Proposal', 'Won', 'Lost'];
const LEAD_KINDS = ['commission', 'business', 'newsletter', 'rsvp'];
const WORK_STATUSES = ['draft', 'pending', 'live', 'rejected', 'hidden'];
const TIERS = ['Founding', 'Roster', 'Signature'];
const SESSION_DAYS = 30;
const PBKDF2_ITER = 60000;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v, min = 0, max = 1e9) => { const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, 'A number is out of range.'); return n; };
const num = (v, min, max) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, 'A size is out of range.'); return Math.round(n * 10) / 10; };
const oneOf = (v, list, label) => { if (!list.includes(v)) throw new HttpError(400, `Choose a valid ${label}.`); return v; };
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

// ---------- crypto ----------
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function sha256(text) { return b64(await crypto.subtle.digest('SHA-256', enc.encode(text))); }
async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
}
async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${b64(await pbkdf2(pw, salt, PBKDF2_ITER))}`;
}
function safeEqual(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
async function checkPassword(pw, stored) {
  const [, iter, salt, hash] = String(stored).split('$');
  if (!hash) return false;
  return safeEqual(b64(await pbkdf2(pw, unb64(salt), Number(iter))), hash);
}

// ---------- sessions ----------
function getCookie(req, name) {
  const m = (req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
const cookie = (token, maxAge) => `cc_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
async function startSession(env, userId) {
  const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c]));
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await env.DB.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').bind(await sha256(token), userId, expires).run();
  return cookie(token, SESSION_DAYS * 86400);
}
async function currentUser(req, env) {
  const token = getCookie(req, 'cc_session');
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id,u.email,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`
  ).bind(await sha256(token), now()).first();
  return row || null;
}
async function requireRole(req, env, roles) {
  const user = await currentUser(req, env);
  if (!user) throw new HttpError(401, 'Please log in.');
  if (!roles.includes(user.role)) throw new HttpError(403, 'Your account cannot do this.');
  return user;
}
async function requireArtist(req, env) {
  const user = await requireRole(req, env, ['artist']);
  const artist = await env.DB.prepare('SELECT * FROM artists WHERE user_id=?').bind(user.id).first();
  if (!artist) throw new HttpError(403, 'No artist profile is linked to this account yet.');
  return { user, artist };
}

// ---------- shaping ----------
function workOut(w) {
  return {
    id: w.id, code: w.code, artist_id: w.artist_id, artist_slug: w.artist_slug, artist_name: w.artist_name,
    title: w.title, width_in: w.width_in, height_in: w.height_in, medium: w.medium, ships_as: w.ships_as,
    price: w.price, year: w.year, story: w.story, style_name: w.style_name, subject: w.subject,
    rooms: JSON.parse(w.rooms || '[]'), prints: !!w.prints, gen_style: w.gen_style, gen_palette: w.gen_palette,
    image_url: w.image_key ? `/api/img/${w.image_key}` : null, image_key: w.image_key,
    status: w.status, sold: !!w.sold, featured: !!w.featured, review_note: w.review_note,
    created_at: w.created_at, updated_at: w.updated_at,
  };
}
const WORK_SELECT = `SELECT w.*, a.slug AS artist_slug, a.name AS artist_name FROM works w JOIN artists a ON a.id=w.artist_id`;

function readWorkInput(b, { admin }) {
  const rooms = Array.isArray(b.rooms) ? b.rooms.filter((r) => ['living', 'bedroom', 'office', 'cafe', 'hotel'].includes(r)) : [];
  const out = {
    title: str(b.title, 120), width_in: num(b.width_in, 4, 240), height_in: num(b.height_in, 4, 240),
    medium: str(b.medium, 80) || 'Acrylic on canvas', ships_as: str(b.ships_as, 60) || 'Stretched, unframed',
    price: int(b.price, 500, 5000000), year: int(b.year ?? 2026, 1900, 2100), story: str(b.story, 1200),
    style_name: str(b.style_name, 40) || 'Abstract', subject: str(b.subject, 40) || 'Colour',
    rooms: JSON.stringify(rooms), prints: b.prints ? 1 : 0, image_key: b.image_key ? str(b.image_key, 80) : null,
  };
  if (!out.title) throw new HttpError(400, 'Give the work a title.');
  if (admin) {
    if (b.status !== undefined) out.status = oneOf(b.status, WORK_STATUSES, 'status');
    if (b.featured !== undefined) out.featured = b.featured ? 1 : 0;
    if (b.sold !== undefined) out.sold = b.sold ? 1 : 0;
  }
  return out;
}

async function uniqueSlug(env, name) {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'artist';
  let slug = base, n = 1;
  while (await env.DB.prepare('SELECT 1 FROM artists WHERE slug=?').bind(slug).first()) slug = `${base}-${++n}`;
  return slug;
}

// ---------- routes ----------
async function route(req, env, url) {
  const p = url.pathname.replace(/\/+$/, '');
  const m = req.method;
  const seg = p.split('/').slice(2); // after /api
  const body = async () => {
    if (!(req.headers.get('content-type') || '').includes('application/json')) throw new HttpError(415, 'Send JSON.');
    try { return await req.json(); } catch { throw new HttpError(400, 'The request body is not valid JSON.'); }
  };

  // ----- public -----
  if (p === '/api/health') return json({ ok: true });

  if (p === '/api/catalog' && m === 'GET') {
    const [artists, works, content] = await env.DB.batch([
      env.DB.prepare(`SELECT id,slug,name,city,bio,tier,color,instagram FROM artists WHERE status='active' ORDER BY created_at`),
      env.DB.prepare(`${WORK_SELECT} WHERE w.status='live' AND a.status='active' ORDER BY w.featured DESC, w.created_at DESC`),
      env.DB.prepare(`SELECT value FROM content WHERE key='site'`),
    ]);
    return json({
      artists: artists.results, works: works.results.map(workOut),
      content: content.results[0] ? JSON.parse(content.results[0].value) : {},
    }, 200, { 'cache-control': 'public, max-age=30' });
  }

  if (seg[0] === 'img' && seg[1] && m === 'GET') {
    const { value, metadata } = await env.IMAGES.getWithMetadata(seg[1], { type: 'arrayBuffer' });
    if (!value) return new Response('Not found', { status: 404 });
    return new Response(value, { headers: { 'content-type': metadata?.type || 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' } });
  }

  if (p === '/api/auth/me' && m === 'GET') {
    const user = await currentUser(req, env);
    if (!user) return json({ user: null });
    const artist = await env.DB.prepare('SELECT * FROM artists WHERE user_id=?').bind(user.id).first();
    const application = await env.DB.prepare('SELECT status,created_at FROM applications WHERE user_id=? ORDER BY created_at DESC').bind(user.id).first();
    return json({ user, artist, application });
  }

  if (p === '/api/auth/signup' && m === 'POST') {
    const b = await body();
    const name = str(b.name, 80), email = str(b.email, 120).toLowerCase(), pw = String(b.password || '');
    if (!name) throw new HttpError(400, 'Enter your name.');
    if (!emailOk(email)) throw new HttpError(400, 'Enter a valid email address.');
    if (pw.length < 8) throw new HttpError(400, 'Use a password of at least 8 characters.');
    const works = int(b.works_count ?? 0, 0, 10000);
    if (works < 10) throw new HttpError(400, `We need a portfolio of at least 10 canvases to review. You entered ${works}.`);
    if (await env.DB.prepare('SELECT 1 FROM users WHERE email=?').bind(email).first()) throw new HttpError(409, 'An account with this email already exists. Log in instead.');
    const userId = uid();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (id,email,name,pass_hash,role) VALUES (?,?,?,?,?)').bind(userId, email, name, await hashPassword(pw), 'applicant'),
      env.DB.prepare('INSERT INTO applications (id,user_id,name,email,city,instagram,works_count,price_range,style,note) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .bind(uid(), userId, name, email, str(b.city, 80), str(b.instagram, 80), works, str(b.price_range, 60), str(b.style, 120), str(b.note, 1000)),
    ]);
    return json({ ok: true }, 201, { 'set-cookie': await startSession(env, userId) });
  }

  if (p === '/api/auth/login' && m === 'POST') {
    const b = await body();
    const email = str(b.email, 120).toLowerCase();
    const user = await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first();
    if (!user || !(await checkPassword(String(b.password || ''), user.pass_hash))) throw new HttpError(401, 'That email and password do not match.');
    await env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND expires_at<?').bind(user.id, now()).run();
    return json({ ok: true, role: user.role }, 200, { 'set-cookie': await startSession(env, user.id) });
  }

  if (p === '/api/auth/logout' && m === 'POST') {
    const token = getCookie(req, 'cc_session');
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) });
  }

  // One-time admin creation, guarded by the ADMIN_SETUP_CODE secret.
  if (p === '/api/auth/setup' && m === 'POST') {
    const b = await body();
    if (!env.ADMIN_SETUP_CODE || !safeEqual(String(b.code || ''), env.ADMIN_SETUP_CODE)) throw new HttpError(403, 'That setup code is not right.');
    const name = str(b.name, 80), email = str(b.email, 120).toLowerCase(), pw = String(b.password || '');
    if (!name || !emailOk(email)) throw new HttpError(400, 'Enter your name and a valid email.');
    if (pw.length < 10) throw new HttpError(400, 'Admin passwords need at least 10 characters.');
    const existing = await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
    const id = existing?.id || uid();
    if (existing) await env.DB.prepare(`UPDATE users SET name=?,pass_hash=?,role='admin' WHERE id=?`).bind(name, await hashPassword(pw), id).run();
    else await env.DB.prepare(`INSERT INTO users (id,email,name,pass_hash,role) VALUES (?,?,?,?,'admin')`).bind(id, email, name, await hashPassword(pw)).run();
    return json({ ok: true }, 200, { 'set-cookie': await startSession(env, id) });
  }

  if (p === '/api/leads' && m === 'POST') {
    const b = await body();
    const kind = oneOf(b.kind, LEAD_KINDS, 'enquiry type');
    const email = str(b.email, 120).toLowerCase();
    if (email && !emailOk(email)) throw new HttpError(400, 'Enter a valid email address.');
    if (kind === 'newsletter' && !email) throw new HttpError(400, 'Enter your email address.');
    const details = b.details && typeof b.details === 'object' ? JSON.stringify(b.details).slice(0, 4000) : '{}';
    await env.DB.prepare('INSERT INTO leads (id,kind,name,email,phone,company,city,details,value) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(uid(), kind, str(b.name, 80), email, str(b.phone, 30), str(b.company, 120), str(b.city, 80), details, int(b.value ?? 0, 0, 1e9)).run();
    return json({ ok: true }, 201);
  }

  if (p === '/api/orders' && m === 'POST') {
    const b = await body();
    const buyer = b.buyer || {};
    const name = str(buyer.name, 80);
    if (!name || !str(buyer.address, 300)) throw new HttpError(400, 'Enter your name and delivery address.');
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 20) throw new HttpError(400, 'Your cart is empty.');
    const orderId = uid();
    const lines = [];
    const seenOriginals = new Set();
    for (const it of b.items) {
      const w = await env.DB.prepare(`SELECT w.*, a.commission FROM works w JOIN artists a ON a.id=w.artist_id WHERE w.id=? AND w.status='live' AND a.status='active'`).bind(String(it.work_id || '')).first();
      if (!w) throw new HttpError(409, 'One of the works in your cart is no longer available.');
      const kind = oneOf(it.kind, ['orig', 'rent', 'print'], 'purchase type');
      let price, label, share;
      if (kind === 'orig') {
        if (w.sold || seenOriginals.has(w.id)) throw new HttpError(409, `“${w.title}” has already been sold.`);
        seenOriginals.add(w.id);
        price = w.price; label = 'Original'; share = Math.round(price * (100 - w.commission) / 100);
      } else if (kind === 'rent') {
        price = Math.round(w.price * 0.025); label = 'Rental · first month'; share = Math.round(price * 0.5);
      } else {
        if (!w.prints) throw new HttpError(409, `Prints are not offered for “${w.title}”.`);
        const size = oneOf(it.size, Object.keys(PRINT_SIZES), 'print size');
        price = PRINT_SIZES[size]; label = `Print · ${size.replace('x', '×')} in`; share = Math.round(price * 0.2);
      }
      lines.push({ w, kind, price, label, share });
    }
    const total = lines.reduce((s, l) => s + l.price, 0);
    const count = (await env.DB.prepare('SELECT COUNT(*) AS n FROM orders').first()).n;
    const number = `TCC-${48000 + count + 1}`;
    const stmts = [env.DB.prepare('INSERT INTO orders (id,number,buyer_name,buyer_phone,buyer_email,address,payment_method,total) VALUES (?,?,?,?,?,?,?,?)')
      .bind(orderId, number, name, str(buyer.phone, 30), str(buyer.email, 120), str(buyer.address, 300), str(buyer.payment, 60), total)];
    for (const l of lines) {
      stmts.push(env.DB.prepare('INSERT INTO order_items (id,order_id,work_id,artist_id,kind,label,price,artist_share) VALUES (?,?,?,?,?,?,?,?)')
        .bind(uid(), orderId, l.w.id, l.w.artist_id, l.kind, l.label, l.price, l.share));
      if (l.kind === 'orig') stmts.push(env.DB.prepare('UPDATE works SET sold=1, updated_at=? WHERE id=? AND sold=0').bind(now(), l.w.id));
    }
    await env.DB.batch(stmts);
    return json({ ok: true, number, total }, 201);
  }

  // ----- uploads (artist or admin) -----
  if (p === '/api/upload' && m === 'POST') {
    await requireRole(req, env, ['artist', 'admin']);
    const b = await body();
    const mt = String(b.dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!mt) throw new HttpError(400, 'Upload a JPEG, PNG or WebP image.');
    const bytes = unb64(mt[2]);
    if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'That image is over 3 MB. Use a smaller photo.');
    const key = `${uid()}.${mt[1].split('/')[1].replace('jpeg', 'jpg')}`;
    await env.IMAGES.put(key, bytes, { metadata: { type: mt[1] } });
    return json({ key, url: `/api/img/${key}` }, 201);
  }

  // ----- artist desk -----
  if (seg[0] === 'artist') {
    const { user, artist } = await requireArtist(req, env);
    if (p === '/api/artist/works' && m === 'GET') {
      const r = await env.DB.prepare(`${WORK_SELECT} WHERE w.artist_id=? ORDER BY w.created_at DESC`).bind(artist.id).all();
      return json({ artist, works: r.results.map(workOut) });
    }
    if (p === '/api/artist/works' && m === 'POST') {
      const b = await body();
      const w = readWorkInput(b, { admin: false });
      const submit = b.submit !== false;
      if (b.id) {
        const cur = await env.DB.prepare('SELECT * FROM works WHERE id=? AND artist_id=?').bind(String(b.id), artist.id).first();
        if (!cur) throw new HttpError(404, 'That work was not found.');
        if (cur.sold) throw new HttpError(409, 'Sold works cannot be edited.');
        await env.DB.prepare(`UPDATE works SET title=?,width_in=?,height_in=?,medium=?,ships_as=?,price=?,year=?,story=?,style_name=?,subject=?,rooms=?,prints=?,image_key=COALESCE(?,image_key),status=?,review_note='',updated_at=? WHERE id=?`)
          .bind(w.title, w.width_in, w.height_in, w.medium, w.ships_as, w.price, w.year, w.story, w.style_name, w.subject, w.rooms, w.prints, w.image_key, submit ? 'pending' : 'draft', now(), cur.id).run();
        return json({ ok: true, id: cur.id });
      }
      const id = uid();
      await env.DB.prepare(`INSERT INTO works (id,artist_id,title,width_in,height_in,medium,ships_as,price,year,story,style_name,subject,rooms,prints,image_key,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, artist.id, w.title, w.width_in, w.height_in, w.medium, w.ships_as, w.price, w.year, w.story, w.style_name, w.subject, w.rooms, w.prints, w.image_key, submit ? 'pending' : 'draft').run();
      return json({ ok: true, id }, 201);
    }
    if (seg[1] === 'works' && seg[2] && m === 'DELETE') {
      const r = await env.DB.prepare(`DELETE FROM works WHERE id=? AND artist_id=? AND status IN ('draft','pending','rejected') AND sold=0 AND NOT EXISTS (SELECT 1 FROM order_items WHERE work_id=works.id)`).bind(seg[2], artist.id).run();
      if (!r.meta.changes) throw new HttpError(409, 'Only drafts, pending or rejected works can be deleted.');
      return json({ ok: true });
    }
    if (p === '/api/artist/orders' && m === 'GET') {
      const r = await env.DB.prepare(`SELECT i.*, o.number, o.created_at AS ordered_at, o.address, o.buyer_name, w.title, w.image_key, w.gen_style, w.code FROM order_items i JOIN orders o ON o.id=i.order_id JOIN works w ON w.id=i.work_id WHERE i.artist_id=? ORDER BY o.created_at DESC`).bind(artist.id).all();
      return json({ items: r.results });
    }
    if (seg[1] === 'items' && seg[2] && seg[3] === 'status' && m === 'POST') {
      const b = await body();
      const next = oneOf(b.status, ['Packed', 'Shipped'], 'status');
      const allowedFrom = next === 'Packed' ? 'Paid' : 'Packed';
      const r = await env.DB.prepare('UPDATE order_items SET status=?, updated_at=? WHERE id=? AND artist_id=? AND status=?').bind(next, now(), seg[2], artist.id, allowedFrom).run();
      if (!r.meta.changes) throw new HttpError(409, `This item must be “${allowedFrom}” before it can be marked “${next}”.`);
      return json({ ok: true });
    }
    if (p === '/api/artist/profile' && m === 'POST') {
      const b = await body();
      await env.DB.prepare('UPDATE artists SET bio=?, city=?, instagram=? WHERE id=?').bind(str(b.bio, 600), str(b.city, 80) || artist.city, str(b.instagram, 80), artist.id).run();
      return json({ ok: true });
    }
    throw new HttpError(404, 'Not found.');
  }

  // ----- admin CMS -----
  if (seg[0] === 'admin') {
    await requireRole(req, env, ['admin']);

    if (p === '/api/admin/overview' && m === 'GET') {
      const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
      const since = new Date(Date.now() - 90 * 864e5).toISOString().replace('T', ' ').slice(0, 19);
      const r = await env.DB.batch([
        q(`SELECT tier, COUNT(*) AS n FROM artists WHERE status='active' GROUP BY tier`),
        q(`SELECT status, COUNT(*) AS n FROM works GROUP BY status`),
        q(`SELECT COUNT(*) AS n FROM applications WHERE status='pending'`),
        q(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS gmv FROM orders WHERE created_at>=?`, since),
        q(`SELECT COUNT(*) AS n FROM leads WHERE kind='business' AND stage='Won'`),
        q(`SELECT COUNT(*) AS n FROM leads WHERE stage='New' AND kind IN ('business','commission')`),
        q(`SELECT COUNT(*) AS n FROM order_items WHERE status='Paid'`),
        q(`SELECT COALESCE(SUM(price-artist_share),0) AS rev FROM order_items WHERE status!='Cancelled'`),
      ]);
      const tiers = Object.fromEntries(r[0].results.map((x) => [x.tier, x.n]));
      const works = Object.fromEntries(r[1].results.map((x) => [x.status, x.n]));
      return json({ tiers, works, pendingApps: r[2].results[0].n, orders90: r[3].results[0].n, gmv90: r[3].results[0].gmv, b2bWon: r[4].results[0].n, newLeads: r[5].results[0].n, toPack: r[6].results[0].n, revenue: r[7].results[0].rev });
    }

    if (p === '/api/admin/works' && m === 'GET') {
      const st = url.searchParams.get('status') || 'all';
      const r = st === 'all'
        ? await env.DB.prepare(`${WORK_SELECT} ORDER BY w.updated_at DESC`).all()
        : await env.DB.prepare(`${WORK_SELECT} WHERE w.status=? ORDER BY w.updated_at DESC`).bind(oneOf(st, WORK_STATUSES, 'status')).all();
      return json({ works: r.results.map(workOut) });
    }
    if (p === '/api/admin/works' && m === 'POST') {
      const b = await body();
      const w = readWorkInput(b, { admin: true });
      const artistId = str(b.artist_id, 80);
      if (!(await env.DB.prepare('SELECT 1 FROM artists WHERE id=?').bind(artistId).first())) throw new HttpError(400, 'Choose an artist.');
      if (b.id) {
        const r = await env.DB.prepare(`UPDATE works SET artist_id=?,title=?,width_in=?,height_in=?,medium=?,ships_as=?,price=?,year=?,story=?,style_name=?,subject=?,rooms=?,prints=?,image_key=COALESCE(?,image_key),status=COALESCE(?,status),featured=COALESCE(?,featured),sold=COALESCE(?,sold),updated_at=? WHERE id=?`)
          .bind(artistId, w.title, w.width_in, w.height_in, w.medium, w.ships_as, w.price, w.year, w.story, w.style_name, w.subject, w.rooms, w.prints, w.image_key, w.status ?? null, w.featured ?? null, w.sold ?? null, now(), String(b.id)).run();
        if (!r.meta.changes) throw new HttpError(404, 'That work was not found.');
        return json({ ok: true, id: b.id });
      }
      const id = uid();
      await env.DB.prepare(`INSERT INTO works (id,artist_id,title,width_in,height_in,medium,ships_as,price,year,story,style_name,subject,rooms,prints,image_key,status,featured) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, artistId, w.title, w.width_in, w.height_in, w.medium, w.ships_as, w.price, w.year, w.story, w.style_name, w.subject, w.rooms, w.prints, w.image_key, w.status || 'live', w.featured || 0).run();
      return json({ ok: true, id }, 201);
    }
    if (seg[1] === 'works' && seg[2] && seg[3] === 'review' && m === 'POST') {
      const b = await body();
      const action = oneOf(b.action, ['approve', 'reject', 'hide', 'feature', 'unfeature'], 'action');
      const sql = {
        approve: [`UPDATE works SET status='live', review_note='', updated_at=? WHERE id=?`, [now(), seg[2]]],
        reject: [`UPDATE works SET status='rejected', review_note=?, updated_at=? WHERE id=?`, [str(b.note, 500) || 'Not approved this time.', now(), seg[2]]],
        hide: [`UPDATE works SET status='hidden', updated_at=? WHERE id=?`, [now(), seg[2]]],
        feature: [`UPDATE works SET featured=1 WHERE id=?`, [seg[2]]],
        unfeature: [`UPDATE works SET featured=0 WHERE id=?`, [seg[2]]],
      }[action];
      const r = await env.DB.prepare(sql[0]).bind(...sql[1]).run();
      if (!r.meta.changes) throw new HttpError(404, 'That work was not found.');
      return json({ ok: true });
    }

    if (p === '/api/admin/artists' && m === 'GET') {
      const r = await env.DB.prepare(`SELECT a.*, u.email, (SELECT COUNT(*) FROM works w WHERE w.artist_id=a.id AND w.status='live') AS live_works, (SELECT COUNT(*) FROM works w WHERE w.artist_id=a.id) AS all_works, (SELECT COALESCE(SUM(price),0) FROM order_items i WHERE i.artist_id=a.id AND i.status!='Cancelled') AS sales FROM artists a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at`).all();
      return json({ artists: r.results });
    }
    if (p === '/api/admin/artists' && m === 'POST') {
      const b = await body();
      const tier = oneOf(b.tier, TIERS, 'tier'), commission = int(b.commission, 0, 60), status = oneOf(b.status || 'active', ['active', 'paused'], 'status');
      if (b.id) {
        const r = await env.DB.prepare('UPDATE artists SET name=COALESCE(NULLIF(?,\'\'),name), city=?, bio=?, tier=?, commission=?, status=? WHERE id=?')
          .bind(str(b.name, 80), str(b.city, 80), str(b.bio, 600), tier, commission, status, String(b.id)).run();
        if (!r.meta.changes) throw new HttpError(404, 'That artist was not found.');
        return json({ ok: true });
      }
      const name = str(b.name, 80);
      if (!name) throw new HttpError(400, 'Enter the artist’s name.');
      const id = uid();
      await env.DB.prepare('INSERT INTO artists (id,slug,name,city,bio,tier,commission,status) VALUES (?,?,?,?,?,?,?,?)')
        .bind(id, await uniqueSlug(env, name), name, str(b.city, 80), str(b.bio, 600), tier, commission, status).run();
      return json({ ok: true, id }, 201);
    }

    if (p === '/api/admin/applications' && m === 'GET') {
      const r = await env.DB.prepare('SELECT * FROM applications ORDER BY (status=\'pending\') DESC, created_at DESC').all();
      return json({ applications: r.results });
    }
    if (seg[1] === 'applications' && seg[2] && m === 'POST') {
      const b = await body();
      const app = await env.DB.prepare('SELECT * FROM applications WHERE id=?').bind(seg[2]).first();
      if (!app) throw new HttpError(404, 'That application was not found.');
      if (app.status !== 'pending') throw new HttpError(409, 'This application has already been decided.');
      if (b.action === 'decline') {
        await env.DB.prepare(`UPDATE applications SET status='declined', reviewed_at=? WHERE id=?`).bind(now(), app.id).run();
        return json({ ok: true });
      }
      if (b.action !== 'approve') throw new HttpError(400, 'Choose approve or decline.');
      const tier = oneOf(b.tier || 'Roster', TIERS, 'tier');
      const commission = tier === 'Founding' ? 25 : 30;
      await env.DB.batch([
        env.DB.prepare(`UPDATE applications SET status='approved', reviewed_at=? WHERE id=?`).bind(now(), app.id),
        env.DB.prepare(`UPDATE users SET role='artist' WHERE id=? AND role='applicant'`).bind(app.user_id),
        env.DB.prepare('INSERT INTO artists (id,slug,user_id,name,city,instagram,tier,commission) VALUES (?,?,?,?,?,?,?,?)')
          .bind(uid(), await uniqueSlug(env, app.name), app.user_id, app.name, app.city, app.instagram, tier, commission),
      ]);
      return json({ ok: true });
    }

    if (p === '/api/admin/orders' && m === 'GET') {
      const [o, i] = await env.DB.batch([
        env.DB.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 300'),
        env.DB.prepare(`SELECT i.*, w.title, w.code, w.image_key, a.name AS artist_name FROM order_items i JOIN works w ON w.id=i.work_id JOIN artists a ON a.id=i.artist_id`),
      ]);
      const by = {};
      for (const it of i.results) (by[it.order_id] ||= []).push(it);
      return json({ orders: o.results.map((x) => ({ ...x, items: by[x.id] || [] })) });
    }
    if (seg[1] === 'items' && seg[2] && m === 'POST') {
      const b = await body();
      const st = oneOf(b.status, ITEM_STATUSES, 'status');
      const r = await env.DB.prepare('UPDATE order_items SET status=?, updated_at=? WHERE id=?').bind(st, now(), seg[2]).run();
      if (!r.meta.changes) throw new HttpError(404, 'That order item was not found.');
      return json({ ok: true });
    }

    if (p === '/api/admin/leads' && m === 'GET') {
      const r = await env.DB.prepare('SELECT * FROM leads ORDER BY created_at DESC LIMIT 500').all();
      return json({ leads: r.results.map((l) => ({ ...l, details: JSON.parse(l.details || '{}') })) });
    }
    if (seg[1] === 'leads' && seg[2] && m === 'POST') {
      const b = await body();
      const r = await env.DB.prepare('UPDATE leads SET stage=?, value=? WHERE id=?').bind(oneOf(b.stage, LEAD_STAGES, 'stage'), int(b.value ?? 0, 0, 1e10), seg[2]).run();
      if (!r.meta.changes) throw new HttpError(404, 'That lead was not found.');
      return json({ ok: true });
    }

    if (p === '/api/admin/content' && m === 'GET') {
      const r = await env.DB.prepare(`SELECT value, updated_at FROM content WHERE key='site'`).first();
      return json({ content: r ? JSON.parse(r.value) : {}, updated_at: r?.updated_at });
    }
    if (p === '/api/admin/content' && m === 'PUT') {
      const b = await body();
      const c = b.content || {};
      const clean = {
        announcements: (Array.isArray(c.announcements) ? c.announcements : []).map((x) => str(x, 140)).filter(Boolean).slice(0, 8),
        hero: (Array.isArray(c.hero) ? c.hero : []).slice(0, 3).map((h) => ({ kicker: str(h.kicker, 40), title: str(h.title, 80), text: str(h.text, 300), button: str(h.button, 40) })),
        one_to_watch: str(c.one_to_watch, 60),
      };
      await env.DB.prepare(`INSERT INTO content (key,value,updated_at) VALUES ('site',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).bind(JSON.stringify(clean), now()).run();
      return json({ ok: true, content: clean });
    }
    throw new HttpError(404, 'Not found.');
  }

  throw new HttpError(404, 'Not found.');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
      return new Response(INDEX_HTML, { headers: {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60',
        'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'SAMEORIGIN',
      } });
    }
    // Same-origin guard for state-changing requests.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.get('origin');
      if (origin && origin !== url.origin) return json({ error: 'Cross-site requests are not allowed.' }, 403);
    }
    try {
      return await route(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Something went wrong on our side. Please try again.' }, 500);
    }
  },
};
