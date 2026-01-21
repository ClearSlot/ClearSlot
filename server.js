import express from 'express';
import pkg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pkg;

const app = express();
app.use(express.json());

/* GLOBAL ERROR LOGGING */

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});



/* ============================
   DATABASE
============================ */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ============================
   SCORE-REGLER
============================ */

const SCORE_RULES = {
  overlap:        { delta: -10, severity: 'mild',   ttlDays: 14 },
  repeat_overlap: { delta: -20, severity: 'medium', ttlDays: 90 },
  no_show:        { delta: -30, severity: 'high',   ttlDays: 365 }
};

/* ============================
   FUNKTIONER
============================ */

async function getOrCreateScore(client, customer_hash, platform_id, identity_scope) {
  const res = await client.query(
    `
    SELECT * FROM customer_scores
    WHERE customer_hash = $1
      AND identity_scope = $2
      AND (identity_scope = 'global' OR platform_id = $3)
    `,
    [customer_hash, identity_scope, platform_id]
  );

  if (res.rows.length) return res.rows[0];

  const insert = await client.query(
    `
    INSERT INTO customer_scores (customer_hash, platform_id, identity_scope)
    VALUES ($1, $2, $3)
    RETURNING *
    `,
    [customer_hash, platform_id, identity_scope]
  );

  return insert.rows[0];
}

async function hasRecentOverlap(client, customer_hash, platform_id, identity_scope) {
  const res = await client.query(
    `
    SELECT 1 FROM behavior_events
    WHERE customer_hash = $1
      AND event_type IN ('overlap','repeat_overlap')
      AND expires_at > NOW()
      AND identity_scope = $2
      AND (identity_scope = 'global' OR platform_id = $3)
    LIMIT 1
    `,
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
    `
    INSERT INTO behavior_events
    (id, customer_hash, platform_id, identity_scope,
     event_type, severity, score_delta, occurred_at, expires_at)
    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      customer_hash,
      platform_id,
      identity_scope,
      type,
      rule.severity,
      rule.delta,
      now,
      expires
    ]
  );

  await client.query(
    `
    UPDATE customer_scores
    SET score = GREATEST(0, LEAST(100, score + $1)),
        last_updated_at = NOW()
    WHERE customer_hash = $2
      AND identity_scope = $3
      AND (identity_scope = 'global' OR platform_id = $4)
    `,
    [rule.delta, customer_hash, identity_scope, platform_id]
  );
}

/* ============================
   ENDPOINTS
============================ */

app.get('/ping', (req, res) => {
  res.json({ pong: true });
});

app.post('/event/overlap', async (req, res) => {
  console.log('OVERLAP HIT', req.body);

  const { customer_hash, platform_id, identity_scope = 'local' } = req.body;

  const client = await pool.connect();
  console.log('DB CONNECTED');

  try {
    await client.query('BEGIN');
    console.log('TX BEGIN');

    await getOrCreateScore(client, customer_hash, platform_id, identity_scope);
    console.log('SCORE OK');

    const repeat = await hasRecentOverlap(
      client,
      customer_hash,
      platform_id,
      identity_scope
    );
    console.log('REPEAT CHECK:', repeat);

    const type = repeat ? 'repeat_overlap' : 'overlap';

    await applyBehaviorEvent(
      client,
      customer_hash,
      platform_id,
      identity_scope,
      type
    );
    console.log('EVENT APPLIED');

    await client.query('COMMIT');
    console.log('TX COMMIT');

    res.json({ ok: true, event: type });
  } catch (err) {
    console.error('OVERLAP ERROR:', err);
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
    console.log('DB RELEASED');
  }
});


app.post('/event/no-show', async (req, res) => {
  const { customer_hash, platform_id, identity_scope = 'local' } = req.body;
  if (!customer_hash || !platform_id) {
    return res.status(400).json({ error: 'customer_hash and platform_id required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await getOrCreateScore(client, customer_hash, platform_id, identity_scope);
    await applyBehaviorEvent(client, customer_hash, platform_id, identity_scope, 'no_show');

    await client.query('COMMIT');
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

  if (!platform_id) {
    return res.status(400).json({ error: 'platform_id required' });
  }

  const result = await pool.query(
    `
    SELECT score FROM customer_scores
    WHERE customer_hash = $1
      AND identity_scope = $2
      AND (identity_scope = 'global' OR platform_id = $3)
    `,
    [customer_hash, identity_scope, platform_id]
  );

  if (!result.rows.length) {
    return res.status(404).json({ error: 'not found' });
  }

  const score = result.rows[0].score;

  const recommendation =
    score < 40 ? 'Deposit recommended' :
    score < 70 ? 'Confirmation recommended' :
                 'No action';

  res.json({ score, recommendation });
});

/* ============================
   START SERVER
============================ */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ClearSlot API running on port ${PORT}`);
});
