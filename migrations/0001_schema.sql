-- The Canvas Commons: core schema (Cloudflare D1 / SQLite)
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'applicant' CHECK (role IN ('admin','artist','applicant')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE artists (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  user_id TEXT UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  instagram TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL DEFAULT 'Roster' CHECK (tier IN ('Founding','Roster','Signature')),
  commission INTEGER NOT NULL DEFAULT 30 CHECK (commission BETWEEN 0 AND 60),
  color TEXT NOT NULL DEFAULT '#3E5C76',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  instagram TEXT NOT NULL DEFAULT '',
  works_count INTEGER NOT NULL DEFAULT 0,
  price_range TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE works (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE,
  artist_id TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  width_in REAL NOT NULL CHECK (width_in > 0),
  height_in REAL NOT NULL CHECK (height_in > 0),
  medium TEXT NOT NULL DEFAULT 'Acrylic on canvas',
  ships_as TEXT NOT NULL DEFAULT 'Stretched, unframed',
  price INTEGER NOT NULL CHECK (price >= 0),
  year INTEGER NOT NULL DEFAULT 2026,
  story TEXT NOT NULL DEFAULT '',
  style_name TEXT NOT NULL DEFAULT 'Abstract',
  subject TEXT NOT NULL DEFAULT 'Colour',
  rooms TEXT NOT NULL DEFAULT '[]',
  prints INTEGER NOT NULL DEFAULT 0,
  gen_style TEXT,
  gen_palette TEXT,
  image_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('draft','pending','live','rejected','hidden')),
  sold INTEGER NOT NULL DEFAULT 0,
  featured INTEGER NOT NULL DEFAULT 0,
  review_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX works_status_idx ON works(status);
CREATE INDEX works_artist_idx ON works(artist_id);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  buyer_name TEXT NOT NULL,
  buyer_phone TEXT NOT NULL DEFAULT '',
  buyer_email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  payment_method TEXT NOT NULL DEFAULT '',
  total INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  work_id TEXT NOT NULL REFERENCES works(id),
  artist_id TEXT NOT NULL REFERENCES artists(id),
  kind TEXT NOT NULL CHECK (kind IN ('orig','rent','print')),
  label TEXT NOT NULL,
  price INTEGER NOT NULL,
  artist_share INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'Paid' CHECK (status IN ('Paid','Packed','Shipped','Delivered','Return window','Payout released','Cancelled')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX order_items_artist_idx ON order_items(artist_id);
CREATE INDEX order_items_order_idx ON order_items(order_id);

CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('commission','business','newsletter','rsvp')),
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '{}',
  stage TEXT NOT NULL DEFAULT 'New' CHECK (stage IN ('New','Site visit','Proposal','Won','Lost')),
  value INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE content (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
