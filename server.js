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
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/score', scoreLimiter);

/* ============================
   SECURITY
============================ */
function secureHash(input) {
  const pepper = process.env.HASH_PEPPER;
  if (!pepper) throw new Error("HASH_PEPPER not configured");
  return crypto.createHash('sha256').update(input + pepper).digest('hex');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20
});

/* ============================
   HELPERS
============================ */
function validateScope(scope) {
  return ['local','global'].includes(scope);
}

function validateISO(date) {
  return !isNaN(Date.parse(date));
}

function error(res,code,message,status=400){
  return res.status(status).json({ error:{ code,message }});
}

/* ============================
   BILLING
============================ */
async function recordBillableEvent(client,platform_id,restaurant_hash,type){
  const PRICES = {
    coordination_booking: 0.03,
    signal_check: 0.02,
    data_report: 0.00
  };

  const amount = PRICES[type] || 0;

  if(amount>0){
    await client.query(
      `INSERT INTO billing_ledger
       (platform_id,restaurant_hash,event_type,amount_euro)
       VALUES ($1,$2,$3,$4)`,
       [platform_id,restaurant_hash,type,amount]
    );
  }
}

/* ============================
   IDEMPOTENCY
============================ */
async function checkIdempotency(client,key){
  const r = await client.query(
    `SELECT response_body,status_code
     FROM idempotency_keys
     WHERE idempotency_key=$1`,
    [key]
  );
  return r.rows[0];
}

async function storeIdempotency(client,key,body,status){
  await client.query(
    `INSERT INTO idempotency_keys
     (idempotency_key,response_body,status_code)
     VALUES ($1,$2,$3)`,
    [key,body,status]
  );
}

/* ============================
   CONFLICT CHECK
============================ */
async function checkTimeConflict(client,secure_cust,start,duration){
  const end = new Date(start.getTime()+duration*60000);

  const r = await client.query(
    `SELECT 1 FROM active_bookings
     WHERE customer_hash=$1
     AND status='confirmed'
     AND (reservation_time < $2
          AND (reservation_time + (duration_minutes || ' minutes')::interval) > $3)
     LIMIT 1`,
    [secure_cust,end,start]
  );

  return r.rows.length>0;
}

/* ============================
   CREATE BOOKING
============================ */
app.post('/booking/create',async(req,res)=>{

  const key = req.headers['idempotency-key'];
  if(!key) return error(res,"IDEMPOTENCY_REQUIRED","Idempotency-Key required");

  const {
    platform_id,
    customer_hash,
    restaurant_hash,
    reservation_time,
    duration_minutes=120,
    identity_scope='local'
  } = req.body;

  if(!platform_id) return error(res,"INVALID_PLATFORM_ID","platform_id required");
  if(!customer_hash) return error(res,"INVALID_CUSTOMER_HASH","customer_hash required");
  if(!restaurant_hash) return error(res,"INVALID_RESTAURANT_HASH","restaurant_hash required");
  if(!validateISO(reservation_time)) return error(res,"INVALID_DATETIME","ISO datetime required");
  if(!validateScope(identity_scope)) return error(res,"INVALID_SCOPE","scope invalid");

  const client = await pool.connect();

  try{
    await client.query('BEGIN');

    const existing = await checkIdempotency(client,key);
    if(existing){
      await client.query('COMMIT');
      return res.status(existing.status_code).json(existing.response_body);
    }

    const secure_cust = secureHash(customer_hash);
    const secure_rest = secureHash(restaurant_hash);
    const start = new Date(reservation_time);

    const conflict = await checkTimeConflict(client,secure_cust,start,duration_minutes);

    await recordBillableEvent(client,platform_id,secure_rest,'signal_check');

    if(conflict){
      const response={
        ok:false,
        signal:"OVERLAP_DETECTED",
        message:"Coordination signal returned. Additional confirmation recommended."
      };
      await storeIdempotency(client,key,response,409);
      await client.query('COMMIT');
      return res.status(409).json(response);
    }

    await client.query(
      `INSERT INTO active_bookings
       (customer_hash,restaurant_hash,platform_id,
        identity_scope,reservation_time,duration_minutes,status)
       VALUES ($1,$2,$3,$4,$5,$6,'confirmed')`,
       [secure_cust,secure_rest,platform_id,
        identity_scope,start,duration_minutes]
    );

    await recordBillableEvent(client,platform_id,secure_rest,'coordination_booking');

    const response={
      ok:true,
      signal:"BOOKING_CONFIRMED",
      message:"Coordination signal returned."
    };

    await storeIdempotency(client,key,response,200);

    await client.query('COMMIT');
    res.json(response);

  }catch(e){
    await client.query('ROLLBACK');
    res.status(500).json({error:{code:"SERVER_ERROR",message:e.message}});
  }finally{
    client.release();
  }
});

/* ============================
   SCORE CHECK
============================ */
app.get('/score/:customer_hash',async(req,res)=>{

  const {customer_hash}=req.params;
  const {platform_id,identity_scope='local',restaurant_hash}=req.query;

  if(!platform_id) return error(res,"INVALID_PLATFORM_ID","platform_id required");
  if(!validateScope(identity_scope)) return error(res,"INVALID_SCOPE","scope invalid");

  const client=await pool.connect();

  try{
    const secure_cust=secureHash(customer_hash);
    const secure_rest=restaurant_hash?secureHash(restaurant_hash):'unknown';

    const r=await client.query(
      `SELECT score FROM customer_scores
       WHERE customer_hash=$1
       AND identity_scope=$2`,
       [secure_cust,identity_scope]
    );

    await recordBillableEvent(client,platform_id,secure_rest,'signal_check');

    if(!r.rows.length){
      return res.status(404).json({score:100,scope:identity_scope});
    }

    res.json({score:r.rows[0].score,scope:identity_scope});

  }catch(e){
    res.status(500).json({error:{code:"SERVER_ERROR",message:e.message}});
  }finally{
    client.release();
  }
});

/* ============================
   HOUSEKEEPING
============================ */
async function cleanupOldBookings(){

  await pool.query(`
    INSERT INTO booking_archive
    (customer_hash,restaurant_hash,platform_id,
     identity_scope,reservation_time,duration_minutes,status)
    SELECT customer_hash,restaurant_hash,platform_id,
           identity_scope,reservation_time,duration_minutes,status
    FROM active_bookings
    WHERE reservation_time < NOW() - INTERVAL '24 hours'
  `);

  await pool.query(`
    DELETE FROM active_bookings
    WHERE reservation_time < NOW() - INTERVAL '24 hours'
  `);
}

setInterval(cleanupOldBookings,3600000);

app.listen(process.env.PORT||3000,()=>{
  console.log("ClearSlot Scoring Standard running.");
});
