import express from "express";
import pkg from "pg";

const { Pool } = pkg;
const app = express();
app.use(express.json());

// ---------- DATABASE ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ---------- HEALTH ----------
app.get("/", (req, res) => {
  res.json({ status: "ClearSlot alive" });
});

// ---------- CHECK ENDPOINT ----------
app.post("/check", async (req, res) => {
  const { platform_id, global_key, guest_key, start_time } = req.body;

  const identifier = global_key || guest_key;

  if (!identifier || !platform_id || !start_time) {
    return res.status(400).json({
      error: "Missing fields"
    });
  }

  try {
    // 1️⃣ Beregn tidsvindue (2 timer)
    const startTime = new Date(start_time);
    const endTime = new Date(startTime.getTime() + 2 * 60 * 60 * 1000);

    // 2️⃣ Overlap check
    const overlapResult = await pool.query(
      `
      SELECT reservationid
      FROM "Reservations"
      WHERE reservationidentifier = $1
        AND reservationstatus = 'ACTIVE'
        AND reservationstarttime < $3
        AND reservationendtime > $2
      LIMIT 1
      `,
      [identifier, startTime, endTime]
    );

    const hasOverlap = overlapResult.rows.length > 0;

    // 3️⃣ Log booking (uanset overlap)
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

    // 4️⃣ Return signal
    return res.json({
      status: "OK",
      signal: hasOverlap ? "POTENTIAL_OVERLAP" : "NO_CONFLICT",
      basis: global_key ? "GLOBAL_KEY" : "LOCAL_KEY"
    });

  } catch (err) {
    console.error("ClearSlot error:", err);

    // 🔓 FAIL-OPEN
    return res.json({
      status: "OK",
      signal: "NO_CONFLICT",
      failopen: true
    });
  }
});

// ---------- SERVER ----------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("ClearSlot running on port", port);
});
