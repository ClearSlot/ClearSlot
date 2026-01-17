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
  try {
    const { platform_id, global_key, guest_key, start_time } = req.body;
    const identifier = global_key || guest_key;

    if (!identifier || !start_time || !platform_id) {
      return res.status(400).json({ error: "Missing fields" });
    }

    await pool.query(
      `INSERT INTO Reservations (
        reservationidentifier,
        reservationplatformid,
        reservationstarttime,
        reservationendtime,
        reservationstatus
      )
      VALUES (
        $1,
        $2,
        $3::timestamp,
        ($3::timestamp + interval '2 hours'),
        'ACTIVE'
      )`,
      [identifier, platform_id, start_time]
    );

    return res.json({
      status: "OK",
      basis: global_key ? "GLOBAL_KEY" : "LOCAL_KEY"
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
