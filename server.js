'use strict';

require('dotenv').config();

// SchoolDocs API server: Express + PostgreSQL + PostgreSQL-backed sessions.
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!DATABASE_URL) throw new Error('DATABASE_URL is required. Add your PostgreSQL connection string.');
if (IS_PRODUCTION && (!SESSION_SECRET || SESSION_SECRET.length < 32)) {
  throw new Error('Set SESSION_SECRET to a random value of at least 32 characters in production.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  // Render PostgreSQL connections use TLS. Local PostgreSQL can set PGSSL=false.
  ssl: IS_PRODUCTION && process.env.PGSSL !== 'false' ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const STATUSES = ['Pending', 'Processing', 'Rejected', 'Ready for Pickup', 'Completed'];
const DOCUMENTS = [
  'Certificate of Enrollment', 'Certificate of Grades', 'Good Moral Certificate',
  'Form 137 / Permanent Record', 'Certificate of Graduation', 'Other'
];
const PURPOSES = ['School requirement', 'Job application', 'Scholarship application', 'Personal use', 'Other'];

function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function validLRN(value) { return /^\d{12}$/.test(String(value || '').trim()); }
function publicUser(user) {
  if (!user) return null;
  // Keep the same camelCase profile shape expected by the existing browser UI.
  return {
    id: user.id, name: user.name, email: user.email, role: user.role,
    lrn: user.lrn, grade: user.grade, section: user.section,
    createdAt: asIso(user.created_at || user.createdAt)
  };
}
function asIso(value) { return value instanceof Date ? value.toISOString() : value; }

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(160) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role VARCHAR(20) NOT NULL CHECK (role IN ('student', 'registrar')),
      lrn VARCHAR(12) UNIQUE,
      grade VARCHAR(40),
      section VARCHAR(60),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT users_lrn_format CHECK (lrn IS NULL OR lrn ~ '^[0-9]{12}$')
    );
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      student_name VARCHAR(100) NOT NULL,
      lrn VARCHAR(12) NOT NULL,
      grade VARCHAR(40),
      section VARCHAR(60),
      document_type VARCHAR(100) NOT NULL,
      purpose VARCHAR(100) NOT NULL,
      copies SMALLINT NOT NULL CHECK (copies BETWEEN 1 AND 3),
      notes VARCHAR(500) NOT NULL DEFAULT '',
      status VARCHAR(30) NOT NULL DEFAULT 'Pending',
      registrar_note VARCHAR(500) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      picked_up_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS request_history (
      id BIGSERIAL PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      status VARCHAR(30) NOT NULL,
      note VARCHAR(500) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS requests_student_created_idx ON requests(student_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS requests_status_created_idx ON requests(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS request_history_request_idx ON request_history(request_id, created_at ASC);
  `);
}

async function ensureRegistrar() {
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!email && !password) return;
  if (!email || password.length < 12) {
    throw new Error('Set both ADMIN_EMAIL and ADMIN_PASSWORD (at least 12 characters) to create the registrar account.');
  }
  const existing = await pool.query("SELECT id FROM users WHERE role = 'registrar' LIMIT 1");
  if (existing.rowCount) return;
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role)
     VALUES ($1, $2, $3, $4, 'registrar')
     ON CONFLICT (email) DO NOTHING`,
    ['reg-' + crypto.randomUUID(), 'School Registrar', email, bcrypt.hashSync(password, 12)]
  );
  console.log('Initial registrar account is configured.');
}

// Optional one-time import of an earlier prototype's data/db.json file.
// This only imports when the PostgreSQL users table is empty.
async function importLegacyJsonIfEmpty() {
  const legacyPath = path.join(__dirname, 'data', 'db.json');
  if (!fs.existsSync(legacyPath)) return;
  const count = await pool.query('SELECT COUNT(*)::int AS count FROM users');
  if (count.rows[0].count > 0) return;
  let legacy;
  try { legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8')); }
  catch (error) { console.warn('Legacy JSON import skipped: file could not be parsed.'); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of (legacy.users || [])) {
      const legacyLrn = String(u.lrn || u.studentNo || '');
      const lrn = /^\d{12}$/.test(legacyLrn) ? legacyLrn : null;
      await client.query(
        `INSERT INTO users (id, name, email, password_hash, role, lrn, grade, section, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz,NOW())) ON CONFLICT DO NOTHING`,
        [u.id, u.name, normalizeEmail(u.email), u.passwordHash || u.password_hash, u.role || 'student', lrn, u.grade || null, u.section || null, u.createdAt || null]
      );
    }
    for (const r of (legacy.requests || [])) {
      const legacyRequestLrn = String(r.lrn || r.studentNo || '');
      const lrn = /^\d{12}$/.test(legacyRequestLrn) ? legacyRequestLrn : null;
      await client.query(
        `INSERT INTO requests (id,student_id,student_name,lrn,grade,section,document_type,purpose,copies,notes,status,registrar_note,created_at,updated_at,picked_up_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13::timestamptz,NOW()),COALESCE($14::timestamptz,NOW()),$15)
         ON CONFLICT DO NOTHING`,
        [r.id,r.studentId,r.studentName,lrn,r.grade || null,r.section || null,r.documentType,r.purpose,Number(r.copies) || 1,r.notes || '',r.status || 'Pending',r.registrarNote || '',r.createdAt || null,r.updatedAt || null,r.pickedUpAt || null]
      );
      const history = Array.isArray(r.history) && r.history.length ? r.history : [{ status: r.status || 'Pending', note: 'Imported from previous SchoolDocs version.', at: r.createdAt }];
      for (const h of history) {
        await client.query(
          `INSERT INTO request_history (request_id,status,note,created_at) VALUES ($1,$2,$3,COALESCE($4::timestamptz,NOW()))`,
          [r.id,h.status || r.status || 'Pending',h.note || '',h.at || null]
        );
      }
    }
    await client.query('COMMIT');
    console.log('Imported legacy SchoolDocs JSON data into PostgreSQL.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function getRequestWithHistory(requestId, client = pool) {
  const result = await client.query('SELECT * FROM requests WHERE id = $1', [requestId]);
  if (!result.rowCount) return null;
  const row = result.rows[0];
  const history = await client.query(
    'SELECT status,note,created_at FROM request_history WHERE request_id = $1 ORDER BY created_at ASC, id ASC',
    [requestId]
  );
  return {
    id: row.id, studentId: row.student_id, studentName: row.student_name, lrn: row.lrn,
    grade: row.grade, section: row.section, documentType: row.document_type,
    purpose: row.purpose, copies: row.copies, notes: row.notes, status: row.status,
    registrarNote: row.registrar_note, createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at), pickedUpAt: asIso(row.picked_up_at),
    history: history.rows.map(h => ({ status: h.status, note: h.note, at: asIso(h.created_at) }))
  };
}

app.disable('x-powered-by');
// Trust Render's reverse proxy for HTTPS secure session cookies.
if (IS_PRODUCTION) {
  app.set('trust proxy', 1);
}
app.use(express.json({ limit: '20kb' }));
app.use(session({
  name: 'schooldocs.sid',
  store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: SESSION_SECRET || 'local-development-only-change-this-secret-please',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: IS_PRODUCTION, maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

async function requireAuth(req, res, next) {
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId || '']);
    if (!result.rowCount) return res.status(401).json({ error: 'Please log in to continue.' });
    req.user = result.rows[0];
    next();
  } catch (error) { next(error); }
}
function requireRegistrar(req, res, next) {
  if (req.user.role !== 'registrar') return res.status(403).json({ error: 'Registrar access only.' });
  next();
}

app.get('/api/health', async (_req, res, next) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, app: 'SchoolDocs', database: 'connected' }); }
  catch (error) { next(error); }
});

app.post('/api/register', async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const lrn = String(body.lrn || '').trim();
    const grade = String(body.grade || '').trim();
    const section = String(body.section || '').trim();
    if (![name,email,password,lrn,grade,section].every(Boolean)) return res.status(400).json({ error: 'Please complete all required fields.' });
    if (name.length > 100 || email.length > 160 || grade.length > 40 || section.length > 60) return res.status(400).json({ error: 'One or more fields are too long.' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!validLRN(lrn)) return res.status(400).json({ error: 'Enter a valid 12-digit Learner Reference Number (LRN).' });
    const user = {
      id: 'stu-' + crypto.randomUUID(), name, email,
      passwordHash: bcrypt.hashSync(password, 12), role: 'student', lrn, grade, section
    };
    try {
      await pool.query(
        `INSERT INTO users (id,name,email,password_hash,role,lrn,grade,section) VALUES ($1,$2,$3,$4,'student',$5,$6,$7)`,
        [user.id,user.name,user.email,user.passwordHash,user.lrn,user.grade,user.section]
      );
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'That email address or LRN is already registered.' });
      throw error;
    }
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.userId = user.id;
      res.status(201).json({ user: publicUser(user) });
    });
  } catch (error) { next(error); }
});

app.post('/api/login', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '');
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Incorrect email or password.' });
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.userId = user.id;
      res.json({ user: publicUser(user) });
    });
  } catch (error) { next(error); }
});

app.post('/api/logout', (req, res, next) => {
  req.session.destroy(err => {
    if (err) return next(err);
    res.clearCookie('schooldocs.sid', { httpOnly: true, sameSite: 'lax', secure: IS_PRODUCTION });
    res.json({ ok: true });
  });
});
app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

app.get('/api/requests', requireAuth, async (req, res, next) => {
  try {
    const result = req.user.role === 'registrar'
      ? await pool.query('SELECT id FROM requests ORDER BY created_at DESC')
      : await pool.query('SELECT id FROM requests WHERE student_id = $1 ORDER BY created_at DESC', [req.user.id]);
    const requests = await Promise.all(result.rows.map(row => getRequestWithHistory(row.id)));
    res.json({ requests });
  } catch (error) { next(error); }
});

app.post('/api/requests', requireAuth, async (req, res, next) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Only student accounts can submit requests.' });
  const body = req.body || {};
  const copies = Number(body.copies);
  if (!DOCUMENTS.includes(body.documentType) || !PURPOSES.includes(body.purpose) || ![1,2,3].includes(copies)) {
    return res.status(400).json({ error: 'Please check the document type, purpose, and number of copies.' });
  }
  const client = await pool.connect();
  try {
    const now = new Date();
    const id = 'SD-' + crypto.randomUUID().slice(0, 8).toUpperCase();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO requests (id,student_id,student_name,lrn,grade,section,document_type,purpose,copies,notes,status,registrar_note,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Pending','',$11,$11)`,
      [id,req.user.id,req.user.name,req.user.lrn,req.user.grade,req.user.section,body.documentType,body.purpose,copies,String(body.notes || '').trim().slice(0,500),now]
    );
    await client.query(
      `INSERT INTO request_history (request_id,status,note,created_at) VALUES ($1,'Pending','Request submitted by student.',$2)`,
      [id,now]
    );
    await client.query('COMMIT');
    res.status(201).json({ request: await getRequestWithHistory(id) });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

app.patch('/api/requests/:id', requireAuth, requireRegistrar, async (req, res, next) => {
  const status = String((req.body && req.body.status) || '');
  const note = String((req.body && req.body.registrarNote) || '').trim().slice(0,500);
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Choose a valid request status.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM requests WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!found.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Request not found.' });
    }
    const old = found.rows[0];
    const changed = old.status !== status || old.registrar_note !== note;
    const now = new Date();
    await client.query(
      `UPDATE requests SET status=$1::varchar,registrar_note=$2,updated_at=$3,
 picked_up_at=CASE WHEN $1::varchar='Completed' THEN COALESCE(picked_up_at,$3) ELSE picked_up_at END WHERE id=$4`,
      [status,note,now,req.params.id]
    );
    if (changed) {
      const historyNote = note || (status === 'Ready for Pickup' ? 'Document is ready for physical pickup.' : 'Request status updated by registrar.');
      await client.query('INSERT INTO request_history (request_id,status,note,created_at) VALUES ($1,$2,$3,$4)', [req.params.id,status,historyNote,now]);
    }
    await client.query('COMMIT');
    res.json({ request: await getRequestWithHistory(req.params.id) });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally { client.release(); }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

async function start() {
  await pool.query('SELECT 1');
  await initializeDatabase();
  await importLegacyJsonIfEmpty();
  await ensureRegistrar();
  app.listen(PORT, () => console.log(`SchoolDocs is running on port ${PORT}`));
}
start().catch(error => {
  console.error('SchoolDocs startup failed:', error);
  process.exit(1);
});

process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
