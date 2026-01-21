import pkg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: './.env' });

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ============================
   REGEN CONFIG
============================ */

const REGEN_RATES = {
  mild: 2,
  medium: 1,
  high: 0.25
};

/* ============================
   CRON JOB
============================ */

async function runCron() {
  const client = await pool.connect();

  try {
    console.log('CRON START');

    /* 1. Delete expired events */
    const expired = await client.query(`
      DELETE FROM behavior_events
      WHERE expires_at < NOW()
      RETURNING customer_hash, platform_id, identity_scope, severity
    `);

    console.log(`Expired events removed: ${expired.rowCount}`);

    /* 2. Regenerate scores */
    const regen = await client.query(`
      SELECT
        cs.customer_hash,
        cs.platform_id,
        cs.identity_scope,
        cs.score,
        MAX(be.severity) AS worst_severity
      FROM customer_scores cs
      LEFT JOIN behavior_events be
        ON cs.customer_hash = be.customer_hash
       AND cs.identity_scope = be.identity_scope
       AND (cs.identity_scope = 'global' OR cs.platform_id = be.platform_id)
      GROUP BY cs.customer_hash, cs.platform_id, cs.identity_scope, cs.score
    `);

    for (const row of regen.rows) {
      const severity = row.worst_severity || 'mild';
      const regenAmount = REGEN_RATES[severity] || 1;

      const newScore = Math.min(100, row.score + regenAmount);

      if (newScore !== row.score) {
        await client.query(
          `
          UPDATE customer_scores
          SET score = $1,
              last_updated_at = NOW()
          WHERE customer_hash = $2
            AND platform_id = $3
            AND identity_scope = $4
          `,
          [
            newScore,
            row.customer_hash,
            row.platform_id,
            row.identity_scope
          ]
        );
      }
    }

    console.log(`Scores regenerated: ${regen.rows.length}`);

    console.log('CRON END');
  } catch (err) {
    console.error('CRON ERROR:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

runCron();
