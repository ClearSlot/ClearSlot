import express from 'express';
import pkg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pkg;

const app = express();
app.use(express.json());

/* ============================
   DATABASE
============================ */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ============================
   LOVABLE WEBHOOK INTEGRATION
============================ */

async function sendToLovable(type, payload) {
  if (!process.env.LOVABLE_WEBHOOK_URL) return;

  try {
    await fetch(process.env.LOVABLE_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.LOVABLE_API_KEY || 'system-update'
      },
      body: JSON.stringify({
        type: type,
        data: payload
      })
    });
  } catch (err) {
    console.error('Kunne ikke sende til Lovable:', err.message);
  }
}

/* ============================
   MIDDLEWARE: LOGGING & DASHBOARD
============================ */

app.use(async (req, res, next) => {
  const start = Date.now();

  res.on('finish', async () => {
    const duration = Date.now() - start;
    if (req.path === '/healthcheck') return;

    // Her definerer vi platformId (camelCase) til middlewaren
    const platformId = req.body?.platform_id || req.query?.platform_id || 'anonymous';

    // 1. Gem i lokal Database
    try {
      pool.query(
        `INSERT INTO api_logs 
        (platform_id, method, endpoint, status_code, duration_ms, request_body) 
        VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          platformId, 
          req.method, 
          req.originalUrl, 
          res.statusCode, 
          duration,
          JSON.stringify(req.body) 
        ]
      ).catch(err => console.error('LOGGING ERROR:', err));
    } catch (e) { console.error(e); }

    // 2. Send til Lovable
    sendToLovable('api_usage', {
      platform_id: platformId,
      endpoint: req.path,
      request_count: 1,
      status: res.statusCode
    });

  });

  next();
});

/* ============================
   STANDARD FEJL-HÅNDTERING
============================ */
process.on('uncaughtException', (err) => console.error('UNCAUGHT:', err));
process.on('unhandledRejection', (reason) => console.error('UNHANDLED:', reason));

/* ============================
   SCORE LOGIK
============================ */
const SCORE_RULES = {
  overlap:        { delta: -10, severity: 'mild',   ttlDays: 14 },
  repeat_overlap: { delta: -20, severity: 'medium', ttlDays: 90 },
  no_show:        { delta: -30, severity: 'high',   ttlDays: 365 }
};

async function getOrCreateScore(client, customer_hash, platform_id, identity_scope) {
  const res = await client.query(
    `SELECT * FROM customer_scores WHERE customer_hash = $1 AND identity_scope = $2 AND (identity_scope = 'global' OR platform_id = $3)`,
    [customer_hash, identity_scope, platform_id]
  );
  if (res.rows.length) return res.rows[0];
  const insert = await client.query(
    `INSERT INTO customer_scores (customer_hash, platform_id, identity_scope) VALUES ($1, $2, $3) RETURNING *`,
    [customer_hash, platform_id, identity_scope]
  );
  return insert.rows[0];
}

async function hasRecentOverlap(client, customer_hash, platform_id, identity_scope) {
  const res = await client.query(
    `SELECT 1 FROM behavior_events WHERE customer_hash = $1 AND event_type IN ('overlap','repeat_overlap') AND expires_at > NOW() AND identity_scope = $2 AND (identity_scope = 'global' OR platform_id = $3) LIMIT 1`,
    [customer_hash, identity_scope, platform_id]
  );
  return res.rowCount > 0;
}

async function applyBehaviorEvent(client, customer_hash, platform_id, identity_scope, type) {
  const rule = SCORE_RULES[type];
  const now = new Date();
  const expires = new Date(now);
  expires.setDate(expires.getDate() + rule.ttlDays);

  await client.query(
    `INSERT INTO behavior_events (id, customer_hash, platform_id, identity_scope, event_type, severity, score_delta, occurred_at, expires_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)`,
    [customer_hash, platform_id, identity_scope, type, rule.severity, rule.delta, now, expires]
  );
  await client.query(
    `UPDATE customer_scores SET score = GREATEST(0, LEAST(100, score + $1)), last_updated_at = NOW() WHERE customer_hash = $2 AND identity_scope = $3 AND (identity_scope = 'global' OR platform_id = $4)`,
    [rule.delta, customer_hash, identity_scope, platform_id]
  );
}

/* ============================
   ENDPOINTS
============================ */

app.get('/healthcheck', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'healthy', database: 'connected' });
  } catch (error) {
    res.status(503).json({ status: 'unhealthy', error: error.message });
  }
});

app.get('/api/logs/:platform_id', async (req, res) => {
    const { platform_id } = req.params;
    try {
        const result = await pool.query(`SELECT * FROM api_logs WHERE platform_id = $1 ORDER BY created_at DESC LIMIT 50`, [platform_id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/ping', (req, res) => res.json({ pong: true }));

// --- OVERLAP EVENT ---
app.post('/event/overlap', async (req, res) => {
  const { customer_hash, platform_id, identity_scope = 'local' } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    await getOrCreateScore(client, customer_hash, platform_id, identity_scope);
    const repeat = await hasRecentOverlap(client, customer_hash, platform_id, identity_scope);
    const type = repeat ? 'repeat_overlap' : 'overlap';
    await applyBehaviorEvent(client, customer_hash, platform_id, identity_scope, type);
    await client.query('COMMIT');
    
    // RETTELSE HER: Vi bruger 'platform_id' (underscore) fordi den kommer fra req.body linjen ovenover
    sendToLovable('event', {
      platform_id: platform_id, 
      event_type: type,
      customer_hash: customer_hash
    });

    res.json({ ok: true, event: type });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- NO-SHOW EVENT ---
app.post('/event/no-show', async (req, res) => {
  const { customer_hash, platform_id, identity_scope = 'local' } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await getOrCreateScore(client, customer_hash, platform_id, identity_scope);
    await applyBehaviorEvent(client, customer_hash, platform_id, identity_scope, 'no_show');
    await client.query('COMMIT');

    // RETTELSE HER: Samme her, vi bruger 'platform_id'
    sendToLovable('event', {
      platform_id: platform_id,
      event_type: 'no_show',
      customer_hash: customer_hash
    });

    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/score/:customer_hash', async (req, res) => {
  const { customer_hash } = req.params;
  const { platform_id, identity_scope = 'local' } = req.query;
  const result = await pool.query(
    `SELECT score FROM customer_scores WHERE customer_hash = $1 AND identity_scope = $2 AND (identity_scope = 'global' OR platform_id = $3)`,
    [customer_hash, identity_scope, platform_id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'not found' });
  
  const score = result.rows[0].score;
  res.json({ score });
});

/* ============================
   START SERVER
============================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ClearSlot API running on port ${PORT}`);
});