import express from "express";
import pkg from "pg";

const { Pool } = pkg;
const app = express();
app.use(express.json());

// --------------------
// Database connection
// --------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

// --------------------
// Health check
// --------------------
app.get("/", (req, res) => {
  res.json({ status: "OK", service: "ClearSlot" });
});

// --------------------
// CHECK endpoint
// --------------------
app.post("/check", async (req, res) => {
  const { platform_id, global_key, guest_key, start_time } = req.body;

  // Fail-open ved manglende data
  if (!platform_id || !start_time || (!global_key && !guest_key)) {
    return res.json({
      status: "OK",
      basis: "FAIL_OPEN_MISSING_FIELDS"
    });
  }

  const identifier = global_key || guest_key;

  try {
    // --------------------
    // Overlap check
    // --------------------
    const overlapQuery = `
      SELECT reservationid
      FROM "Reservations"
      WHERE reservationidentifier = $1
        AND reservationstatus = 'ACTIVE'
        AND tstzrange(
              reservationstarttime,
              reservationendtime,
              '[)'
            ) && tstzrange(
              $2::timestamptz,
              $2::timestamptz + interval '2 hours',
              '[)'
            )
      LIMIT 1
    `;

    const overlapResult = await pool.query(overlapQuery, [
      identifier,
      start_time
    ]);

    if (overlapResult.rowCount > 0) {
      // Overlap fundet → stadig fail-open (platform beslutter selv)
      return res.json({
        status: "OK",
        basis: "OVERLAP_DETECTED"
      });
    }

    // --------------------
    // Insert reservation
    // --------------------
    const insertQuery = `
      INSERT INTO "Reservations" (
        reservationidentifier,
        reservationplatformid,
        reservationstarttime,
        reservationendtime,
        reservationstatus,
        reservationcreatedat
      )
      VALUES (
        $1,
        $2,
        $3::timestamptz,
        $3::timestamptz + interval '2 hours',
        'ACTIVE',
        NOW()
      )
    `;

    await pool.query(insertQuery, [
      identifier,
      platform_id,
      start_time
    ]);

    return res.json({
      status: "OK",
      basis: global_key ? "GLOBAL_KEY" : "LOCAL_KEY"
    });

  } catch (err) {
    // --------------------
    // FAIL-OPEN catch-all
    // --------------------
    console.error("ClearSlot error:", err);

    return res.json({
      status: "OK",
      basis: "FAIL_OPEN_EXCEPTION"
    });
  }
});

// --------------------
// Start server
// --------------------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("ClearSlot running on port", port);
});
