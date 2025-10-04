import cds from '@sap/cds';

async function updateClaimStatus() {
  try {
    await cds.connect.to('db');

    const { 'kfz.claims.Claims': Claims } = cds.entities;

    const claimID = '0f9b12b5-6a2d-4a63-9a3e-3c8b6c3b4a01';
    const newStatus = 'Eingegangen';

    // First, read the existing claim to verify it exists
    const existing = await SELECT.one.from(Claims).where({ ID: claimID });
    if (!existing) {
      console.log('❌ Claim not found:', claimID);
      return;
    }

    console.log('📋 Current status:', existing.status);

    // Update the status
    const updated = await UPDATE(Claims)
      .set({ status: newStatus })
      .where({ ID: claimID });

    console.log('✅ Status updated to:', newStatus);
    console.log('   Rows affected:', updated);

    // Verify the update
    const verified = await SELECT.one.from(Claims).where({ ID: claimID });
    console.log('📋 New status:', verified.status);

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await cds.shutdown();
  }
}

updateClaimStatus();
