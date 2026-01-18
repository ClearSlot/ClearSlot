import express from "express";
import pkg from "pg";

const { Pool } = pkg;
const app = express();
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Helper: calculate end time (default 2 hours)
function calculateEndTime(startTime) {
  const start = new Date(startTime);
  return new Date(start.getTime() + 2 * 60 * 60 * 1000);
}

app.post("/check", async (req, res) => {
  const { platform_id, global_key, guest_key, start_time, end_time } = req.body;

  const identifier = global_key || guest_key;

  if (!platform_id || !identifier || !start_time) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const startTime = new Date(start_time);
  const endTime = end_time ? new Date(end_time) : calculateEndTime(start_time);

  let overlap = false;

  try {
    // 1️⃣ Overlap check (ACTIVE reservations only)
    const overlapResult = await pool.query(
      `
      SELECT 1
      FROM "Reservations"
      WHERE reservationidentifier = $1
        AND reservationstatus = 'ACTIVE'
        AND reservationstarttime < $2
        AND reservationendtime > $3
      LIMIT 1
      `,
      [identifier, endTime, startTime]
    );

    overlap = overlapResult.rowCount > 0;

    // 2️⃣ Log reservation attempt (ALWAYS)
    await pool.query(
      `
      INSERT INTO "Reservations" (
        reservationidentifier,
        reservationplatformid,
        reservationstarttime,
        reservationendtime,
        reservationstatus
      )
      VALUES ($1, $2, $3, $4, 'ACTIVE')
      `,
      [identifier, platform_id, startTime, endTime]
    );

    // 3️⃣ Return signal (never block)
    return res.json({
      status: "OK",
      basis: global_key ? "GLOBAL_KEY" : "LOCAL_KEY",
      overlap,
      risk: overlap ? "MEDIUM" : "LOW"
    });

  } catch (err) {
    console.error("FAIL-OPEN ERROR:", err.message);

    // 🔓 FAIL-OPEN: booking must never be blocked
    return res.json({
      status: "OK",
      basis: "FAIL_OPEN",
      risk: "UNKNOWN"
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("ClearSlot running on port", port);
});
