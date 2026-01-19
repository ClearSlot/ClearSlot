import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function runCleanup() {
  console.log("🧹 ClearSlot cron started");

  try {
    const now = new Date();

    // 1. Find udløbne aktive reservationer
    const expired = await pool.query(
      `
      SELECT reservationidentifier
      FROM reservations
      WHERE reservationstatus = 'ACTIVE'
        AND reservationendtime < $1
      `,
      [now]
    );

    console.log(`Found ${expired.rowCount} expired reservations`);

    // 2. Opdater adfærd (hvis tabel findes)
    for (const row of expired.rows) {
      try {
        await pool.query(
          `
          INSERT INTO behavior_scores (identifier, score, last_event_at)
          VALUES ($1, 1, NOW())
          ON CONFLICT (identifier)
          DO UPDATE SET
            score = behavior_scores.score + 1,
            last_event_at = NOW()
          `,
          [row.reservationidentifier]
        );
      } catch (e) {
        // Hvis behavior_scores ikke findes → ignorer
        console.log("ℹ️ behavior_scores not available, skipping");
        break;
      }
    }

    // 3. Slet udløbne reservationer
    await pool.query(
      `
      DELETE FROM reservations
      WHERE reservationstatus = 'ACTIVE'
        AND reservationendtime < $1
      `,
      [now]
    );

    console.log("✅ Cleanup completed safely");
  } catch (err) {
    // FAIL-OPEN: vi logger, men gør intet farligt
    console.error("❌ Cron error (fail-open):", err.message);
  } finally {
    await pool.end();
  }
}

runCleanup();
