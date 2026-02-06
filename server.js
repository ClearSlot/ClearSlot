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
  if (!pepper) {
    console.warn("ADVARSEL: HASH_PEPPER mangler! Data gemmes uden ekstra sikkerhed.");
    return input; 
  }
  return crypto.createHash('sha256').update(input + pepper).digest('hex');
}

/* ============================
   DATABASE SETUP
============================ */
const connectionString = process.env.DATABASE_URL || process.env.MANUAL_DB_URL;
const pool = new Pool({
  connectionString: connectionString,
  ssl: { rejectUnauthorized: false }
});

/* ============================
   LOVABLE WEBHOOK
============================ */
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
   CORE LOGIC: THE CONFLICT GUARD 🛡️
============================ */
async function checkTimeConflict(client, secure_cust, startTime, durationMinutes) {
  const endTime = new Date(startTime.getTime() + durationMinutes * 60000);

  // Tjekker kun 'confirmed' bookinger.
  // SQL Logik: (StartA < SlutB) OG (SlutA > StartB) = Overlap
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
// Kør hver time
setInterval(cleanupOldBookings, 3600000);

/* ============================
   ENDPOINTS
============================ */

// --- OPRET BOOKING (TJEK OVERLAP) ---
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

    // 1. TJEK FOR KONFLIKT
    const conflict = await checkTimeConflict(client, secure_cust, startObj, duration_minutes);

    if (conflict) {
      // OVERLAP DETECTED -> STRAF (-10)
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
      
      // Vi sender også det 'oprindelige' navn til Lovable så vi kan se hvem det var i UI
      sendToLovable('event', { platform_id, event_type: 'OVERLAP_DETECTED', customer_hash });

      return res.status(409).json({ 
        ok: false, 
        signal: 'OVERLAP_DETECTED', 
        message: 'Customer has a conflicting booking.' 
      });
    }

    // 2. OPRET BOOKING (Ingen konflikt)
    await client.query(
      `INSERT INTO active_bookings (customer_hash, restaurant_hash, platform_id, identity_scope, reservation_time, duration_minutes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [secure_cust, secure_rest, platform_id, identity_scope, startObj, duration_minutes]
    );

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

// --- AFLYS BOOKING (TJEK LATE CANCEL) ---
app.post('/booking/cancel', async (req, res) => {
  const { 
    platform_id, customer_hash, restaurant_hash, reservation_time, identity_scope = 'local' 
  } = req.body;

  const secure_cust = secureHash(customer_hash);
  const secure_rest = secureHash(restaurant_hash);
  
  // Beregn tid
  const resTime = new Date(reservation_time);
  const now = new Date();
  const hoursUntilBooking = (resTime - now) / 36e5; // Timer

  const client = await pool.connect();
  try {
     await client.query('BEGIN');

     // Marker som cancelled
     const updateRes = await client.query(
       `UPDATE active_bookings SET status = 'cancelled' 
        WHERE customer_hash = $1 AND status = 'confirmed' 
        AND reservation_time = $2`, 
       [secure_cust, reservation_time]
     );

     if (updateRes.rowCount === 0) {
       await client.query('ROLLBACK');
       return res.status(404).json({ error: 'Booking not found or already cancelled' });
     }

     // TJEK LATE CANCEL (< 2 timer)
     let signal = 'BOOKING_CANCELLED'; // Neutral
     
     if (hoursUntilBooking < 2 && hoursUntilBooking > -1) {
        signal = 'LATE_CANCEL_PENALTY'; // Straf
        
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

// --- RAPPORTÉR NO-SHOW (Manuel) ---
app.post('/event/no-show', async (req, res) => {
  const { customer_hash, platform_id, restaurant_hash, identity_scope = 'local' } = req.body;
  const secure_cust = secureHash(customer_hash);
  const secure_rest = secureHash(restaurant_hash);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Opret Event (-30 point)
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

// --- GET SCORE ---
app.get('/score/:customer_hash', async (req, res) => {
  const { customer_hash } = req.params;
  const { platform_id, identity_scope = 'local' } = req.query;
  const secure_cust = secureHash(customer_hash);

  try {
    const result = await pool.query(
      `SELECT score FROM customer_scores WHERE customer_hash = $1 AND identity_scope = $2 AND (identity_scope = 'global' OR platform_id = $3)`,
      [secure_cust, identity_scope, platform_id]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ score: result.rows[0].score, scope: identity_scope });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Healthcheck
app.get('/healthcheck', async (req, res) => { res.status(200).json({ status: 'ready' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Global Conflict Guard running on ${PORT}`);
  cleanupOldBookings(); // Kør oprydning ved start
});
