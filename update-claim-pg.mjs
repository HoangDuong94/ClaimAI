import pg from 'pg';

const { Client } = pg;

const client = new Client({
  host: 'localhost',
  port: 5433,
  database: 'claimai_db',
  user: 'claimai',
  password: 'claimai'
});

(async () => {
  try {
    await client.connect();

    const updateResult = await client.query(
      `UPDATE kfz_claims_claims
       SET status = $1, modifiedat = CURRENT_TIMESTAMP
       WHERE id = $2`,
      ['Eingegangen', '0f9b12b5-6a2d-4a63-9a3e-3c8b6c3b4a01']
    );

    console.log('✓ Status updated to "Eingegangen"');
    console.log(`Rows affected: ${updateResult.rowCount}`);

    const verifyResult = await client.query(
      `SELECT claim_number, status FROM kfz_claims_claims WHERE id = $1`,
      ['0f9b12b5-6a2d-4a63-9a3e-3c8b6c3b4a01']
    );

    console.log('\nVerification:');
    console.log(verifyResult.rows[0]);

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await client.end();
  }
})();
