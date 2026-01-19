import express from "express";
import pkg from "pg";

const { Pool } = pkg;
const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ===== CONFIG =====
const DECAY_DAYS = 30;
const DECAY_AMOUNT = 1;

const THRESHOLDS = {
  GREEN: 0,
  YELLOW: 3,
  RED: 6
};

// ===== HELPERS =====

function getRiskLevel(score) {
  if (score >= THRESHOLDS.RED) return "RED";
  if (score >= THRESHOLDS.YELLOW) return "YELLOW";
  return "GREEN";
}

async function ensureBehaviorKey(key) {
  await pool.query(
    `INSERT INTO behavior_scores (behavior_key, score)
     VALUES ($1, 0)
     ON CONFLICT (behavior_key) DO NOTHING`,
    [key]
  );
}

async function applyDecay(key) {
  const res = await pool.query(
    `SELECT score, last_updated FROM behavior_scores WHERE behavior_key = $1`,
    [key]
  );

  if (res.rowCount === 0) return;

  const { score, last_updated } = res.rows[0];
  const daysPassed =
    (Date.now() - new Date(last_updated).getTime()) / (1000 * 60 * 60 * 24);

  const decaySteps = Math.floor(daysPassed / DECAY_DAYS);
  if (decaySteps <= 0) return;

  const newScore = Math.max(0, score - decaySteps * DECAY_AMOUNT);

  await pool.query(
    `UPDATE behavior_scores
     SET score = $2,
         last_updated = NOW()
     WHERE behavior_key = $1`,
    [key, newScore]
  );
}

async function addScore(key, amount) {
  await pool.query(
    `UPDATE behavior_scores
     SET score = score + $2,
         last_updated = NOW()
     WHERE behavior_key = $1`,
    [key, amount]
  );
}

async function getScore(key) {
  const res = await pool.query(
    `SELECT score FROM behavior_scores WHERE behavior_key = $1`,
    [key]
  );
  return res.rowCount ? res.rows[0].score : 0;
}

// ===== ENDPOINT =====

app.post("/check", async (req, res) => {
  const { platform_id, global_key, guest_key, start_time, end_time } = req.body;
  const identifier = global_key || guest_key;

  if (!identifier || !platform_id || !start_time || !end_time) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    // 1. Prepare behavior tracking
    await ensureBehaviorKey(identifier);
    await applyDecay(identifier);

    // 2. Check overlap
    const overlap = await pool.query(
      `SELECT 1 FROM "Reservations"
       WHERE reservationidentifier = $1
         AND reservationstatus = 'ACTIVE'
         AND tstzrange(reservationstarttime, reservationendtime)
             && tstzrange($2::timestamptz, $3::timestamptz)
       LIMIT 1`,
      [identifier, start_time, end_time]
    );

    let signal = "OK";

    if (overlap.rowCount > 0) {
      await addScore(identifier, 3);
      signal = "OVERLAP";
    } else {
      await pool.query(
        `INSERT INTO "Reservations" (
          reservationidentifier,
          reservationplatformid,
          reservationstarttime,
          reservationendtime,
          reservationstatus
        )
        VALUES ($1, $2, $3, $4, 'ACTIVE')`,
        [identifier, platform_id, start_time, end_time]
      );
    }

    const score = await getScore(identifier);
    const risk_level = getRiskLevel(score);

    res.json({
      status: "OK",
      signal,
      risk_level,
      shadow_mode: true
    });

  } catch (err) {
    console.error("FAIL-OPEN ERROR:", err.message);
    res.json({
      status: "OK",
      signal: "UNKNOWN",
      risk_level: "GREEN",
      fail_open: true
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("ClearSlot running on port", port);
});
