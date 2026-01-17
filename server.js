import express from "express";
import pkg from "pg";

const { Pool } = pkg;
const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.post("/check", async (req, res) => {
  const start = Date.now();

  try {
    const { platform_id, global_key, guest_key, start_time } = req.body;
    const identifier = global_key || guest_key;

    // Fail-open hvis input mangler
    if (!identifier || !start_time || !platform_id) {
      return res.status(200).json({
        status: "OK",
        basis: "FAIL_OPEN",
        warning: "MISSING_FIELDS"
      });
    }

    const durationHours = 2;

    // Overlap-check
    const overlap = await pool.query(
      `
      SELECT 1
      FROM "Reservations"
      WHERE reservationidentifier = $1
        AND reservationstatus = 'ACTIVE'
        AND reservationstarttime < ($2::timestamptz + interval '${durationHours} hours')
        AND reservationendtime   > $2::timestamptz
      LIMIT 1
      `,
      [identifier, start_time]
    );

    if (overlap.rowCount > 0) {
      return res.status(200).json({
        status: "BLOCKED",
        reason: "OVERLAPPING_RESERVATION"
      });
    }

    // Ingen overlap → indsæt reservation
    await pool.query(
      `
      INSERT INTO "Reservations" (
        reservationidentifier,
        reservationplatformid,
        reservationstarttime,
        reservationendtime,
        reservationstatus
      )
      VALUES (
        $1,
        $2,
        $3::timestamptz,
        ($3::timestamptz + interval '${durationHours} hours'),
        'ACTIVE'
      )
      `,
      [identifier, platform_id, start_time]
    );

    return res.status(200).json({
      status: "OK",
      basis: global_key ? "GLOBAL_KEY" : "LOCAL_KEY"
    });

  } catch (err) {
    // 🚨 FAIL-OPEN: ALDRIG BLOKER
    console.error("FAIL-OPEN:", err.message);

    return res.status(200).json({
      status: "OK",
      basis: "FAIL_OPEN",
      warning: "CLEAR_SLOT_UNAVAILABLE"
    });
  } finally {
    const ms = Date.now() - start;
    if (ms > 300) {
      console.warn("Slow ClearSlot response:", ms, "ms");
    }
  }
});

  } catch (err) {
    console.error("CHECK ERROR:", err);
    return res.status(500).json({
      error: err.message,
      detail: err.detail
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("ClearSlot running on port", port);
});
