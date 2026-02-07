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
   BILLING LOGIC (NY PRISMODEL: €0.05 TOTAL) 💰
============================ */
async function recordBillableEvent(client, platform_id, restaurant_hash, type) {
  // PRISLISTE (I EURO)
  const PRICES = {
    'coordination_booking': 0.03,  // €0.03 (Selve bookingen / Garantien)
    'signal_check':         0.02,  // €0.02 (Data opslag / Score check)
    'data_report':          0.00   // Gratis (Vi vil have No-Show data ind!)
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
   CORE LOGIC: CONFLICT GUARD 🛡️
============================ */
async function checkTimeConflict(client, secure_cust, startTime, durationMinutes) {
  const endTime = new Date(startTime.getTime() + durationMinutes * 60000);
  
  // Tjekker kun 'confirmed' bookinger.
  // SQL Logik: (StartA < SlutB) OG (SlutA > StartB)
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
   HOUSEKEEPING (OPRYDNING) 🧹
============================ */
async function cleanupOldBookings() {
  try {
    // Slet bookinger ældre end 24 timer
    const res = await pool.query(
      `DELETE FROM active_bookings WHERE reservation_time < NOW() - INTERVAL '24 hours'`
    );
    if (res.rowCount > 0) console.log(`🧹 Housekeeping: Slettede ${res.rowCount} gamle bookinger.`);
  } catch (err) { console.error('Housekeeping Error:', err.message); }
}
setInterval(cleanupOldBookings, 3600000); // Kør hver time

/* ============================
   ENDPOINTS
============================ */

// --- COORDINATION LAYER: CREATE BOOKING (€0.03) ---
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

    // 1. Tjek Konflikt
    const conflict = await checkTimeConflict(client, secure_cust, startObj, duration_minutes);

    if (conflict) {
      // OVERLAP DETECTED -> Straf (-10) -> Ingen Fakturering (Booking fejlede)
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
      
      // Vi sender også data til Lovable for UI feedback
      sendToLovable('event', { platform_id, event_type: 'OVERLAP_DETECTED', customer_hash });
      
      return res.status(409).json({ ok: false, signal: 'OVERLAP_DETECTED', message: 'Conflict blocked.' });
    }

    // 2. Opret Booking (Ingen konflikt)
    await client.query(
      `INSERT INTO active_bookings (customer_hash, restaurant_hash, platform_id, identity_scope, reservation_time, duration_minutes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [secure_cust, secure_rest, platform_id, identity_scope, startObj, duration_minutes]
    );

    // 3. FAKTURERING (€0.03) 💰
    await recordBillableEvent(client, platform_id, secure_rest, 'coordination_booking');

    await client.query('COMMIT');
    sendToLovable('booking', { status: 'created', time: startObj });
    res.json({ ok: true, signal: 'BOOKING_CONFIRMED' });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- CANCEL BOOKING (Gratis & Late Cancel Logic) ---
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
     // Late Cancel (< 2 timer) -> Straf (-15)
     if (hoursUntilBooking < 2 && hoursUntilBooking > -1) {
        signal = 'LATE_CANCEL_PENALTY';
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
     res.json({ ok: true, signal: signal });

  } catch (e) { 
    await client.query('ROLLBACK');
    res.status(500).json({error: e.message}); 
  } finally {
    client.release();
  }
});

// --- REPORT NO-SHOW (Gratis - Data Incentive) ---
app.post('/event/no-show', async (req, res) => {
  const { customer_hash, platform_id, restaurant_hash, identity_scope = 'local' } = req.body;
  const secure_cust = secureHash(customer_hash);
  const secure_rest = secureHash(restaurant_hash);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Opret Event (-30)
    await client.query(
      `INSERT INTO behavior_events (id, customer_hash, platform_id, identity_scope, event_type, severity, score_delta, occurred_at, expires_at, restaurant_hash) 
       VALUES (gen_random_uuid(), $1, $2, $3, 'no_show', 'high', -30, NOW(), NOW() + interval '365 days', $4)`,
      [secure_cust, platform_id, identity_scope, secure_rest]
    );

    // Opdater Score
    await client.query(
      `UPDATE customer_scores SET score = GREATEST(0, LEAST(100, score - 30)), last_updated_at = NOW() 
       WHERE customer_hash = $1`, [secure_cust]
    );

    // Logget til fakturering (men gratis)
    await recordBillableEvent(client, platform_id, secure_rest, 'data_report');

    await client.query('COMMIT');
    sendToLovable('event', { platform_id, event_type: 'no_show', customer_hash });
    res.json({ ok: true, signal: 'NO_SHOW_RECORDED' });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// --- SIGNAL LAYER: GET SCORE (€0.02) ---
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
    
    // FAKTURERING: Signal Layer (€0.02) 💰
    await recordBillableEvent(client, platform_id || 'anonymous', secure_rest, 'signal_check');
    
    if (!result.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ score: result.rows[0].score, scope: identity_scope });
  } catch (err) { res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

app.get('/healthcheck', async (req, res) => { res.status(200).json({ status: 'ready' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Global Conflict Guard (Euro Pricing) running on ${PORT}`);
  cleanupOldBookings(); // Kør oprydning ved start
});
