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
   SIKKERHED & CONFIG
============================ */
function secureHash(input) {
  if (!input) return null;
  const pepper = process.env.HASH_PEPPER;
  if (!pepper) {
    console.warn("ADVARSEL: HASH_PEPPER mangler!");
    return input; 
  }
  return crypto.createHash('sha256').update(input + pepper).digest('hex');
}

const connectionString = process.env.DATABASE_URL || process.env.MANUAL_DB_URL;
const pool = new Pool({
  connectionString: connectionString,
  ssl: { rejectUnauthorized: false }
});

async function sendToLovable(type, payload) {
  if (!process.env.LOVABLE_WEBHOOK_URL) return;
  try {
    await fetch(process.env.LOVABLE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, data: payload })
    });
  } catch (err) { console.error('Lovable Error:', err.message); }
}

/* ============================
   BILLING LOGIC (€0.05 TOTAL)
============================ */
async function recordBillableEvent(client, platform_id, restaurant_hash, type) {
  const PRICES = {
    'coordination_booking': 0.03,
    'signal_check': 0.02,
    'data_report': 0.00
  };

  const amount = PRICES[type] || 0;

  if (amount > 0) {
    await client.query(
      `INSERT INTO billing_ledger (platform_id, restaurant_hash, event_type, amount_euro)
       VALUES ($1, $2, $3, $4)`,
      [platform_id, restaurant_hash, type, amount]
    );
  }
}

/* ============================
   CORE LOGIC: CONFLICT GUARD
============================ */
async function checkTimeConflict(client, secure_cust, startTime, durationMinutes) {
  const endTime = new Date(startTime.getTime() + durationMinutes * 60000);
  
  const query = `
    SELECT * FROM active_bookings 
    WHERE customer_hash = $1 
    AND status = 'confirmed'
    AND (reservation_time < $2 AND (reservation_time + (duration_minutes || ' minutes')::interval) > $3)
    LIMIT 1
  `;
  const res = await client.query(query, [secure_cust, endTime, startTime]);
  return res.rows[0];
}

/* ============================
   HOUSEKEEPING
============================ */
async function cleanupOldBookings() {
  try {
    const res = await pool.query(
      `DELETE FROM active_bookings WHERE reservation_time < NOW() - INTERVAL '24 hours'`
    );
    if (res.rowCount > 0) console.log(`Housekeeping: Removed ${res.rowCount} expired bookings.`);
  } catch (err) { console.error('Housekeeping Error:', err.message); }
}
setInterval(cleanupOldBookings, 3600000);

/* ============================
   ENDPOINTS
============================ */

// --- COORDINATION LAYER: CREATE BOOKING ---
app.post('/booking/create', async (req, res) => {
  const { 
    platform_id, customer_hash, restaurant_hash, reservation_time, 
    duration_minutes = 120, identity_scope = 'local'
  } = req.body;

  const secure_cust = secureHash(customer_hash);
  const secure_rest = secureHash(restaurant_hash);
  const startObj = reservation_time ? new Date(reservation_time) : new Date();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const conflict = await checkTimeConflict(client, secure_cust, startObj, duration_minutes);

    if (conflict) {
      // Standard scoring delta (-10)
      await client.query(
        `INSERT INTO behavior_events (id, customer_hash, platform_id, identity_scope, event_type, severity, score_delta, occurred_at, expires_at, restaurant_hash) 
         VALUES (gen_random_uuid(), $1, $2, $3, 'overlap', 'mild', -10, NOW(), NOW() + interval '14 days', $4)`,
        [secure_cust, platform_id, identity_scope, secure_rest]
      );
      await client.query(
        `UPDATE customer_scores SET score = GREATEST(0, LEAST(100, score - 10)), last_updated_at = NOW() 
         WHERE customer_hash = $1`, [secure_cust]
      );
      await client.query('COMMIT');
      
      sendToLovable('coordination_signal', { 
        platform_id, 
        signal: 'OVERLAP_DETECTED', 
        customer_hash 
      });
      
      return res.status(409).json({ 
        ok: false, 
        signal: 'OVERLAP_DETECTED', 
        message: 'Coordination signal returned. Additional confirmation recommended.' 
      });
    }

    await client.query(
      `INSERT INTO active_bookings (customer_hash, restaurant_hash, platform_id, identity_scope, reservation_time, duration_minutes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [secure_cust, secure_rest, platform_id, identity_scope, startObj, duration_minutes]
    );

    await recordBillableEvent(client, platform_id, secure_rest, 'coordination_booking');

    await client.query('COMMIT');
    sendToLovable('booking_event', { status: 'created', time: startObj });

    res.json({ 
      ok: true, 
      signal: 'BOOKING_CONFIRMED',
      message: 'Coordination signal returned.'
    });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- CANCEL BOOKING ---
app.post('/booking/cancel', async (req, res) => {
  const { platform_id, customer_hash, restaurant_hash, reservation_time, identity_scope = 'local' } = req.body;
  const secure_cust = secureHash(customer_hash);
  const secure_rest = secureHash(restaurant_hash);
  
  const resTime = new Date(reservation_time);
  const now = new Date();
  const hoursUntilBooking = (resTime - now) / 36e5;

  const client = await pool.connect();
  try {
     await client.query('BEGIN');
     const updateRes = await client.query(
       `UPDATE active_bookings SET status = 'cancelled' 
        WHERE customer_hash = $1 AND status = 'confirmed' AND reservation_time = $2`, 
       [secure_cust, reservation_time]
     );

     if (updateRes.rowCount === 0) {
       await client.query('ROLLBACK');
       return res.status(404).json({ error: 'Booking not found or already cancelled' });
     }

     let signal = 'BOOKING_CANCELLED';

     if (hoursUntilBooking < 2 && hoursUntilBooking > -1) {
        signal = 'LATE_CANCEL_PENALTY';
        // Standard scoring delta (-15)
        await client.query(
          `INSERT INTO behavior_events (id, customer_hash, platform_id, identity_scope, event_type, severity, score_delta, occurred_at, expires_at, restaurant_hash) 
           VALUES (gen_random_uuid(), $1, $2, $3, 'late_cancel', 'medium', -15, NOW(), NOW() + interval '30 days', $4)`,
          [secure_cust, platform_id, identity_scope, secure_rest]
        );
        await client.query(
          `UPDATE customer_scores SET score = GREATEST(0, LEAST(100, score - 15)), last_updated_at = NOW() 
           WHERE customer_hash = $1`, [secure_cust]
        );
     }

     await client.query('COMMIT');
     res.json({ 
       ok: true, 
       signal: signal,
       message: 'Coordination signal returned.'
     });

  } catch (e) { 
    await client.query('ROLLBACK');
    res.status(500).json({error: e.message}); 
  } finally {
    client.release();
  }
});

// --- REPORT NO-SHOW ---
app.post('/event/no-show', async (req, res) => {
  const { customer_hash, platform_id, restaurant_hash, identity_scope = 'local' } = req.body;
  const secure_cust = secureHash(customer_hash);
  const secure_rest = secureHash(restaurant_hash);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Standard scoring delta (-30)
    await client.query(
      `INSERT INTO behavior_events (id, customer_hash, platform_id, identity_scope, event_type, severity, score_delta, occurred_at, expires_at, restaurant_hash) 
       VALUES (gen_random_uuid(), $1, $2, $3, 'no_show', 'high', -30, NOW(), NOW() + interval '365 days', $4)`,
      [secure_cust, platform_id, identity_scope, secure_rest]
    );

    await client.query(
      `UPDATE customer_scores SET score = GREATEST(0, LEAST(100, score - 30)), last_updated_at = NOW() 
       WHERE customer_hash = $1`, [secure_cust]
    );

    await recordBillableEvent(client, platform_id, secure_rest, 'data_report');

    await client.query('COMMIT');
    sendToLovable('score_adjustment_event', { 
      platform_id, 
      signal: 'NO_SHOW_RECORDED', 
      customer_hash 
    });

    res.json({ 
      ok: true, 
      signal: 'NO_SHOW_RECORDED',
      message: 'Score adjustment event recorded.'
    });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- SIGNAL LAYER: GET SCORE ---
app.get('/score/:customer_hash', async (req, res) => {
  const { customer_hash } = req.params;
  const { platform_id, identity_scope = 'local', restaurant_hash } = req.query;
  const secure_cust = secureHash(customer_hash);
  const secure_rest = restaurant_hash ? secureHash(restaurant_hash) : 'unknown_restaurant';

  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT score FROM customer_scores WHERE customer_hash = $1 AND identity_scope = $2 AND (identity_scope = 'global' OR platform_id = $3)`,
      [secure_cust, identity_scope, platform_id]
    );
    
    await recordBillableEvent(client, platform_id || 'anonymous', secure_rest, 'signal_check');
    
    if (!result.rows.length) return res.status(404).json({ error: 'not found' });

    res.json({ 
      score: result.rows[0].score, 
      scope: identity_scope 
    });

  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
  finally { 
    client.release(); 
  }
});

app.get('/healthcheck', async (req, res) => { 
  res.status(200).json({ status: 'ready' }); 
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ClearSlot Scoring Standard running on ${PORT}`);
  cleanupOldBookings();
});
