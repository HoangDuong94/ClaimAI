import cds from '@sap/cds';

(async () => {
  try {
    const db = await cds.connect.to('db');

    const result = await db.run(
      UPDATE('kfz.claims.Claims')
        .set({ status: 'Eingegangen' })
        .where({ ID: '0f9b12b5-6a2d-4a63-9a3e-3c8b6c3b4a01' })
    );

    console.log('✓ Status updated to "Eingegangen"');
    console.log(`Rows affected: ${result}`);

    // Verify
    const updated = await db.run(
      SELECT.one.from('kfz.claims.Claims').where({ ID: '0f9b12b5-6a2d-4a63-9a3e-3c8b6c3b4a01' })
    );
    console.log(`Current status: ${updated.status}`);

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    process.exit(0);
  }
})();
