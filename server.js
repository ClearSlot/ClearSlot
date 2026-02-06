import express from 'express';
import pkg from 'pg';
import dotenv from 'dotenv';
import cors from 'cors';
import crypto from 'crypto';

dotenv.config();

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

/* ============================
   SIKKERHED (PEPPERING) 🌶️
============================ */
function secureHash(input) {
  if (!input) return null;
  
  const pepper = process.env.HASH_PEPPER;
  // Fallback hvis pepper mangler (så crasher vi ikke, men logger en advarsel)
  if (!pepper) {
    console.warn("ADVARSEL: HASH_PEPPER mangler! Data gemmes uden ekstra sikkerhed.");
    return input; 
  }
  
  return crypto.createHash('sha256').update(input + pepper).digest('hex');
}

/* ============================
   DATABASE
============================ */
const connectionString = process.env.DATABASE_URL || process.env.MANUAL_DB_URL;

if (!connectionString) {
  console.error("KRITISK FEJL: Ingen database-forbindelse fundet! Tjek variablerne.");
}

const pool = new Pool({
  connectionString: connectionString,
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
      body: JSON.stringify({ type, data: payload })
    });
  } catch (err) {
    console.error('Kunne ikke sende til Lovable:', err.message);
  }
}

/* ============================
   MIDDLEWARE: LOGGING
============================ */
app.use(async (req, res, next) => {
  const start = Date.now();
  res.on('finish', async () => {
    const duration = Date.now() - start;
    if (req.path === '/healthcheck') return;

    const platformId = req.body?.platform_id || req.query?.platform_id || 'anonymous';

    try {
      pool.query(
        `INSERT INTO api_logs 
        (platform_id, method, endpoint, status_code, duration_ms, request_body) 
        VALUES ($1, $2, $3, $4, $5, $6)`,
        [platformId, req.method, req.originalUrl, res.statusCode, duration, JSON.stringify(req.body)]
      ).catch(e => console.error('LOG ERROR:', e.message));
    } catch (e) { console.error(e); }

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
   SCORE LOGIK
============================ */
const SCORE_RULES = {
  overlap:        { delta: -10, severity: 'mild',   ttlDays: 14 },
  repeat_overlap: { delta: -20, severity: 'medium', ttlDays: 90 },
  no_show:        { delta: -30, severity: 'high',   ttlDays: 365 }
};

// Modtager nu identity_scope (finalScope)
async function getOrCreateScore(client, secure_customer_hash, platform_id, identity_scope) {
  const res = await client.query(
    `SELECT * FROM customer_scores WHERE customer_hash = $1 AND identity_scope = $2 AND (identity_scope = 'global' OR platform_id = $3)`,
    [secure_customer_hash, identity_scope, platform_id]
  );
  if (res.rows.length) return res.rows[0];
  
  const insert = await client.query(
    `INSERT INTO customer_scores (customer_hash, platform_id, identity_scope) VALUES ($1, $2, $3) RETURNING *`,
    [secure_customer_hash, platform_id, identity_scope]
  );
  return insert.rows[0];
}

async function hasRecentOverlap(client, secure_customer_hash, platform_id, identity_scope) {
  const res = await client.query(
    `SELECT 1 FROM behavior_events WHERE customer_hash = $1 AND event_type IN ('overlap','repeat_overlap') AND expires_at > NOW() AND identity_scope = $2 AND (identity_scope = 'global' OR platform_id = $3) LIMIT 1`,
    [secure_customer_hash, identity_scope, platform_id]
  );
  return res.rowCount > 0;
}

async function applyBehaviorEvent(client, secure_customer_hash, platform_id, identity_scope, type, secure_restaurant_hash) {
  const rule = SCORE_RULES[type];
  const now = new Date();
  const expires = new Date(now);
  expires.setDate(expires.getDate() + rule.ttlDays);

  // Indsætter med det korrekte scope og restaurant hash
  await client.query(
    `INSERT INTO behavior_events (id, customer_hash, platform_id, identity_scope, event_type, severity, score_delta, occurred_at, expires_at, restaurant_hash) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [secure_customer_hash, platform_id, identity_scope, type, rule.severity, rule.delta, now, expires, secure_restaurant_hash]
  );
  
  await client.query(
    `UPDATE customer_scores SET score = GREATEST(0, LEAST(100, score + $1)), last_updated_at = NOW() WHERE customer_hash = $2 AND identity_scope = $3 AND (identity_scope = 'global' OR platform_id = $4)`,
    [rule.delta, secure_customer_hash, identity_scope, platform_id]
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
  // 1. Hent identity_scope fra request
  const { customer_hash, platform_id, restaurant_hash, identity_scope } = req.body;
  
  // 2. Bestem scope (default: local)
  const finalScope = identity_scope || 'local';

  // 3. Sikkerhed (Hashing)
  const secure_cust = secureHash(customer_hash);
  const secure_rest = secureHash(restaurant_hash);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Brug finalScope i alle kald
    await getOrCreateScore(client, secure_cust, platform_id, finalScope);
    const repeat = await hasRecentOverlap(client, secure_cust, platform_id, finalScope);
    
    const type = repeat ? 'repeat_overlap' : 'overlap';
    
    await applyBehaviorEvent(client, secure_cust, platform_id, finalScope, type, secure_rest);
    
    await client.query('COMMIT');
    
    sendToLovable('event', {
      platform_id, 
      event_type: type,
      customer_hash, // Sender original ID til Dashboard (UI)
      restaurant_hash,
      scope: finalScope // Sender scope info til dashboard
    });

    res.json({ ok: true, event: type, scope: finalScope });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- NO-SHOW EVENT ---
app.post('/event/no-show', async (req, res) => {
  const { customer_hash, platform_id, restaurant_hash, identity_scope } = req.body;

  // Bestem scope
  const finalScope = identity_scope || 'local';

  // Sikkerhed
  const secure_cust = secureHash(customer_hash);
  const secure_rest = secureHash(restaurant_hash);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await getOrCreateScore(client, secure_cust, platform_id, finalScope);
    
    await applyBehaviorEvent(client, secure_cust, platform_id, finalScope, 'no_show', secure_rest);
    
    await client.query('COMMIT');

    sendToLovable('event', {
      platform_id,
      event_type: 'no_show',
      customer_hash,
      restaurant_hash,
      scope: finalScope
    });

    res.json({ ok: true, scope: finalScope });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- GET SCORE ---
app.get('/score/:customer_hash', async (req, res) => {
  const { customer_hash } = req.params;
  // Hent scope fra URL parametre (req.query)
  const { platform_id, identity_scope } = req.query;

  const finalScope = identity_scope || 'local';

  // Husk at hashe inputtet for at finde det i DB
  const secure_cust = secureHash(customer_hash);

  try {
    const result = await pool.query(
      `SELECT score FROM customer_scores WHERE customer_hash = $1 AND identity_scope = $2 AND (identity_scope = 'global' OR platform_id = $3)`,
      [secure_cust, finalScope, platform_id]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'not found' });
    
    const score = result.rows[0].score;
    res.json({ score, scope: finalScope });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================
   START SERVER
============================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ClearSlot API running on port ${PORT}`);
});
