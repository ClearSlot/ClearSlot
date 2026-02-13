import express from 'express';
import pkg from 'pg';
import dotenv from 'dotenv';
import cors from 'cors';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';

dotenv.config();

const { Pool } = pkg;
const app = express();

app.use(cors());
app.use(express.json());

/* ============================
   RATE LIMITING
============================ */

const scoreLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100
});

app.use('/score', scoreLimiter);

/* ============================
   DATABASE
============================ */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ============================
   SECURITY
============================ */

function secureHash(input) {
  const pepper = process.env.HASH_PEPPER;
  if (!pepper) throw new Error("HASH_PEPPER not configured");
  return crypto.createHash('sha256')
    .update(input + pepper)
    .digest('hex');
}

/* ============================
   VALIDATION
============================ */

function validateScope(scope) {
  return ['local', 'global'].includes(scope);
}

function validateISO(date) {
  return !isNaN(Date.parse(date));
}

function error(res, code, message, status = 400) {
  return res.status(status).json({
    error: { code, message }
  });
}

/* ============================
   BILLING
============================ */

async function recordBillableEvent(client, platform_id, restaurant_hash, type) {

  const PRICES = {
    signal_check: 0.02,
    coordination_booking: 0.03,
    data_report: 0.00
  };

  const amount = PRICES[type] || 0;

  if (amount > 0) {
    await client.query(
      `INSERT INTO billing_ledger
       (platform_id, restaurant_hash, event_type, amount_euro)
       VALUES ($1,$2,$3,$4)`,
      [platform_id, restaurant_hash, type, amount]
    );
  }
}

/* ============================
   IDEMPOTENCY
============================ */

async function checkIdempotency(client, key) {
  const result = await client.query(
    `SELECT response_body, status_code
     FROM idempotency_keys
     WHERE idempotency_key = $1`,
    [key]
  );
  return result.rows[0];
}

async function storeIdempotency(client, key, body, status) {
  await client.query(
    `INSERT INTO idempotency_keys
     (idempotency_key, response_body, status_code, created_at)
     VALUES ($1,$2,$3,NOW())`,
    [key, body, status]
  );
}

/* ============================
   CONFLICT CHECK
============================ */

async function checkTimeConflict(client, secure_cust, startTime, durationMinutes) {

  const endTime = new Date(startTime.getTime() + durationMinutes * 60000);

  const result = await client.query(
    `SELECT 1 FROM active_bookings
     WHERE customer_hash=$1
     AND status='confirmed'
     AND (reservation_time < $2 AND
          (reservation_time + (duration_minutes || ' minutes')::interval) > $3)
     LIMIT 1`,
    [secure_cust, endTime, startTime]
  );

  return result.rows.length > 0;
}

/* ============================
   CREATE BOOKING
============================ */

app.post('/booking/create', async (req, res) => {

  const key = req.headers['idempotency-key'];
  if (!key)
    return error(res, "IDEMPOTENCY_REQUIRED", "Idempotency-Key header required");

  const {
    platform_id,
    customer_hash,
    restaurant_hash,
    reservation_time,
    duration_minutes = 120,
    identity_scope = 'local'
  } = req.body;

  if (!platform_id)
    return error(res, "INVALID_PLATFORM_ID", "platform_id required");

  if (!customer_hash)
    return error(res, "INVALID_CUSTOMER_HASH", "customer_hash required");

  if (!restaurant_hash)
    return error(res, "INVALID_RESTAURANT_HASH", "restaurant_hash required");

  if (!validateISO(reservation_time))
    return error(res, "INVALID_DATETIME", "reservation_time must be ISO format");

  if (!validateScope(identity_scope))
    return error(res, "INVALID_SCOPE", "identity_scope must be local or global");

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existing = await checkIdempotency(client, key);
    if (existing) {
      await client.query('COMMIT');
      return res.status(existing.status_code).json(existing.response_body);
    }

    const secure_cust = secureHash(customer_hash);
    const secure_rest = secureHash(restaurant_hash);
    const startObj = new Date(reservation_time);

    // Always bill signal layer
    await recordBillableEvent(client, platform_id, secure_rest, 'signal_check');

    const conflict = await checkTimeConflict(client, secure_cust, startObj, duration_minutes);

    if (conflict) {

      await client.query(
        `INSERT INTO behavior_events
         (id, customer_hash, platform_id, identity_scope,
          event_type, severity, score_delta,
          occurred_at, expires_at, restaurant_hash)
         VALUES (gen_random_uuid(), $1,$2,$3,
                 'overlap','mild',
                 -10, NOW(),
                 NOW() + interval '14 days',
                 $4)`,
        [secure_cust, platform_id, identity_scope, secure_rest]
      );

      const response = {
        ok: false,
        signal: "OVERLAP_DETECTED",
        message: "Coordination signal returned. Additional confirmation recommended."
      };

      await storeIdempotency(client, key, response, 409);
      await client.query('COMMIT');
      return res.status(409).json(response);
    }

    await client.query(
      `INSERT INTO active_bookings
       (customer_hash, restaurant_hash, platform_id,
        identity_scope, reservation_time,
        duration_minutes, status)
       VALUES ($1,$2,$3,$4,$5,$6,'confirmed')`,
      [secure_cust, secure_rest, platform_id,
       identity_scope, startObj, duration_minutes]
    );

    await recordBillableEvent(client, platform_id, secure_rest, 'coordination_booking');

    const response = {
      ok: true,
      signal: "BOOKING_CONFIRMED",
      message: "Coordination signal returned."
    };

    await storeIdempotency(client, key, response, 200);

    await client.query('COMMIT');
    res.json(response);

  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({
      error: { code: "SERVER_ERROR", message: e.message }
    });
  } finally {
    client.release();
  }
});

/* ============================
   CANCEL BOOKING
============================ */

app.post('/booking/cancel', async (req, res) => {

  const {
    platform_id,
    customer_hash,
    restaurant_hash,
    reservation_time,
    identity_scope = 'local'
  } = req.body;

  if (!platform_id || !customer_hash || !restaurant_hash || !reservation_time)
    return error(res, "INVALID_REQUEST", "Missing required fields");

  const secure_cust = secureHash(customer_hash);
  const secure_rest = secureHash(restaurant_hash);

  const resTime = new Date(reservation_time);
  const now = new Date();
  const hoursUntil = (resTime - now) / 36e5;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const updateRes = await client.query(
      `UPDATE active_bookings
       SET status='cancelled'
       WHERE customer_hash=$1
       AND reservation_time=$2
       AND status='confirmed'`,
      [secure_cust, reservation_time]
    );

    if (updateRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return error(res, "NOT_FOUND", "Booking not found", 404);
    }

    if (hoursUntil < 2 && hoursUntil > -1) {

      await client.query(
        `INSERT INTO behavior_events
         (id, customer_hash, platform_id, identity_scope,
          event_type, severity, score_delta,
          occurred_at, expires_at, restaurant_hash)
         VALUES (gen_random_uuid(), $1,$2,$3,
                 'late_cancel','medium',
                 -15, NOW(),
                 NOW() + interval '30 days',
                 $4)`,
        [secure_cust, platform_id, identity_scope, secure_rest]
      );
    }

    await client.query('COMMIT');

    res.json({
      ok: true,
      signal: "BOOKING_CANCELLED",
      message: "Coordination signal returned."
    });

  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({
      error: { code: "SERVER_ERROR", message: e.message }
    });
  } finally {
    client.release();
  }
});

/* ============================
   REPORT NO-SHOW
============================ */

app.post('/event/no-show', async (req, res) => {

  const {
    platform_id,
    customer_hash,
    restaurant_hash,
    identity_scope = 'local'
  } = req.body;

  if (!platform_id || !customer_hash || !restaurant_hash)
    return error(res, "INVALID_REQUEST", "Missing required fields");

  const secure_cust = secureHash(customer_hash);
  const secure_rest = secureHash(restaurant_hash);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO behavior_events
       (id, customer_hash, platform_id, identity_scope,
        event_type, severity, score_delta,
        occurred_at, expires_at, restaurant_hash)
       VALUES (gen_random_uuid(), $1,$2,$3,
               'no_show','high',
               -30, NOW(),
               NOW() + interval '365 days',
               $4)`,
      [secure_cust, platform_id, identity_scope, secure_rest]
    );

    await recordBillableEvent(client, platform_id, secure_rest, 'data_report');

    await client.query('COMMIT');

    res.json({
      ok: true,
      signal: "NO_SHOW_RECORDED",
      message: "Score adjustment event recorded."
    });

  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({
      error: { code: "SERVER_ERROR", message: e.message }
    });
  } finally {
    client.release();
  }
});

/* ============================
   SCORE (DYNAMIC)
============================ */

app.get('/score/:customer_hash', async (req, res) => {

  const { customer_hash } = req.params;
  const { platform_id, identity_scope = 'local', restaurant_hash } = req.query;

  if (!platform_id)
    return error(res, "INVALID_PLATFORM_ID", "platform_id required");

  if (!validateScope(identity_scope))
    return error(res, "INVALID_SCOPE", "Invalid identity_scope");

  const secure_cust = secureHash(customer_hash);
  const secure_rest = restaurant_hash
    ? secureHash(restaurant_hash)
    : 'unknown';

  const client = await pool.connect();

  try {

    const result = await client.query(
      `
      SELECT
        GREATEST(
          0,
          LEAST(
            100,
            100 + COALESCE(SUM(score_delta),0)
          )
        ) AS score
      FROM behavior_events
      WHERE customer_hash=$1
      AND identity_scope=$2
      AND expires_at > NOW()
      `,
      [secure_cust, identity_scope]
    );

    await recordBillableEvent(client, platform_id, secure_rest, 'signal_check');

    res.json({
      score: result.rows[0].score || 100,
      scope: identity_scope
    });

  } catch (e) {
    res.status(500).json({
      error: { code: "SERVER_ERROR", message: e.message }
    });
  } finally {
    client.release();
  }
});

/* ============================
   USAGE SUMMARY
============================ */

app.get('/usage/summary', async (req, res) => {

  const { platform_id } = req.query;

  if (!platform_id)
    return error(res, "INVALID_PLATFORM_ID", "platform_id required");

  const client = await pool.connect();

  try {

    const result = await client.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE event_type='signal_check') AS signal_requests,
        COUNT(*) FILTER (WHERE event_type='coordination_booking') AS coordination_bookings,
        SUM(amount_euro) AS estimated_cost
      FROM billing_ledger
      WHERE platform_id=$1
      AND created_at >= date_trunc('month', NOW())
      `,
      [platform_id]
    );

    res.json(result.rows[0]);

  } catch (e) {
    res.status(500).json({
      error: { code: "SERVER_ERROR", message: e.message }
    });
  } finally {
    client.release();
  }
});

/* ============================
   HEALTH
============================ */

app.get('/healthcheck', (req, res) => {
  res.status(200).json({ status: 'ready' });
});

/* ============================
   START
============================ */

app.listen(process.env.PORT || 3000, () => {
  console.log("ClearSlot Dynamic Scoring Standard running.");
});

/* ============================
   BILLING SUMMARY
============================ */

app.get('/billing/summary', async (req, res) => {
  const { platform_id, from, to } = req.query;

  if (!platform_id) {
    return res.status(400).json({ error: { code: "INVALID_PLATFORM", message: "platform_id required" } });
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      `
      SELECT 
        COUNT(*) FILTER (WHERE event_type = 'signal_check') AS signal_checks,
        COUNT(*) FILTER (WHERE event_type = 'coordination_booking') AS coordination_bookings,
        SUM(amount_euro) AS total_revenue
      FROM billing_ledger
      WHERE platform_id = $1
      AND created_at BETWEEN COALESCE($2::timestamp, '1970-01-01')
      AND COALESCE($3::timestamp, NOW())
      `,
      [platform_id, from || null, to || null]
    );

    res.json(result.rows[0]);

  } catch (e) {
    res.status(500).json({ error: { code: "SERVER_ERROR", message: e.message } });
  } finally {
    client.release();
  }
});

