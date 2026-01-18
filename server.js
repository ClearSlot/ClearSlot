import express from "express";
import pkg from "pg";

const { Pool } = pkg;
const app = express();
app.use(express.json());

// ==========================
// Database
// ==========================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false,
});

// ==========================
// Health check
// ==========================
app.get("/", (_, res) => {
  res.json({ status: "ClearSlot alive" });
});

// ==========================
// CHECK ENDPOINT (FAIL-OPEN)
// ==========================
app.post("/check", async (req, res) => {
  const { platform_id, global_key, guest_key, start_time, end_time } = req.body;

  const identifier = global_key || guest_key;

  // Minimal validering
  if (!platform_id || !identifier || !start_time) {
    return res.status(400).json({ error: "Missing fields" });
  }

  // Fallback: hvis ingen end_time → +2 timer
  const start = new Date(start_time);
  const end = end_time
    ? new Date(end_time)
    : new Date(start.getTime() + 2 * 60 * 60 * 1000);

  try {
    // ==========================
    // OVERLAP CHECK
    // ==========================
    const overlapQuery = `
      SELECT 1
      FROM "Reservations"
      WHERE reservationidentifier = $1
        AND reservationstatus = 'ACTIVE'
        AND tstzrange(reservationstarttime, reservationendtime)
            && tstzrange($2, $3)
      LIMIT 1
    `;

    const overlapResult = await pool.query(overlapQuery, [
      identifier,
      start,
      end,
    ]);

    const overlapDetected = overlapResult.rowCount > 0;

    // ==========================
    // INSERT RESERVATION
    // ==========================
    const insertQuery = `
      INSERT INTO "Reservations" (
        reservationidentifier,
        reservationplatformid,
        reservationstarttime,
        reservationendtime,
        reservationstatus
      )
      VALUES ($1, $2, $3, $4, 'ACTIVE')
    `;

    await pool.query(insertQuery, [
      identifier,
      platform_id,
      start,
      end,
    ]);

    // ==========================
    // RESPONSE
    // ==========================
    return res.json({
      status: "OK",
      basis: overlapDetected ? "OVERLAP_DETECTED" : "NO_OVERLAP",
    });
  } catch (err) {
    // ==========================
    // FAIL-OPEN
    // ==========================
    console.error("ClearSlot fail-open:", err.message);

    return res.json({
      status: "OK",
      basis: "FAIL_OPEN",
    });
  }
});

// ==========================
// Start server
// ==========================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("ClearSlot running on port", port);
});
