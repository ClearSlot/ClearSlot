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
     (idempotency_key, response_body, status_code)
     VALUES ($1,$2,$3)`,
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

    // Signal layer billing (always happens)
    await recordBillableEvent(client, platform_id, secure_rest, 'signal_check');

    c
