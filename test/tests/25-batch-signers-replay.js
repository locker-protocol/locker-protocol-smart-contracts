/**
 * Test 25: BATCH_UPDATE_SIGNERS Replay Protection
 * 
 * Tests that batchUpdateSignersNonce allows same signer operations multiple times
 * Scenario: Remove X add Y, then Remove Y add X (revert with different nonce)
 */

import {
    loadSharedState,
    getContract,
    getWallet,
    logPhase,
    logSection,
    logSuccess,
    log,
    assertEqual,
    reportTestResult,
    lockerOpKey,
    signLockerOp,
    getEthers
} from '../core/utils.js';

const ethers = getEthers();

async function main() {
    log('\n🧪 TEST 25: BATCH_UPDATE_SIGNERS REPLAY PROTECTION\n', '\x1b[1m\x1b[36m');

    try {
        const locker = await getContract('LockerContract', 0);
        const signerManagerAddress = await locker.signerManager();
        const signerManager = await ethers.getContractAt('SignerManager', signerManagerAddress);
        const initialSigners = await signerManager.getSigners();

        // Phase 1: Get initial state
        const initialState = await testGetInitialState(locker, initialSigners);

        // Get wallets for signer operations
        const wallet18 = await getWallet(18);
        const wallet19 = await getWallet(19);
        const signerToSwapOut = initialSigners[initialSigners.length - 1]; // Last current signer

        // Phase 2: Remove last signer, add wallet18
        await testBatchUpdateSigners(
            locker,
            initialSigners,
            [signerToSwapOut],
            [wallet18.address],
            initialState.nonce,
            'Phase 2'
        );

        // Get updated signers
        const signersAfterFirst = await signerManager.getSigners();

        // Phase 3: Remove wallet18, add back signerToSwapOut (revert - tests replay)
        await testBatchUpdateSigners(
            locker,
            signersAfterFirst,
            [wallet18.address],
            [signerToSwapOut],
            initialState.nonce + 1,
            'Phase 3'
        );

        // Phase 4: Verify final state
        await testVerifyFinalState(locker, initialSigners, initialState.nonce + 2);

        reportTestResult('25-batch-signers-replay', true);
        logSuccess('\n✅ TEST 25 PASSED!\n');

    } catch (error) {
        reportTestResult('25-batch-signers-replay', false, error.message);
        throw error;
    }
}

async function testGetInitialState(locker, signers) {
    logPhase(1, 'Get Initial State');

    const nonce = await locker.batchUpdateSignersNonce();

    log(`  Current signers count: ${signers.length}`);
    log(`  Current nonce: ${nonce}`);
    log(`  Last signer: ${signers[signers.length - 1].substring(0, 20)}...`);

    logSuccess('Initial state retrieved');
    return { nonce: Number(nonce), signers };
}

async function testBatchUpdateSigners(locker, currentSigners, toRemove, toAdd, expectedNonce, phaseName) {
    const phaseNum = phaseName === 'Phase 2' ? 2 : 3;
    logPhase(phaseNum, `Batch Update Signers (${phaseName})`);
    logSection(`Remove ${toRemove.length}, Add ${toAdd.length} with nonce=${expectedNonce}`);

    const nonceBefore = await locker.batchUpdateSignersNonce();
    assertEqual(nonceBefore, BigInt(expectedNonce), `Nonce should be ${expectedNonce} before change`);

    // Compute opKey as the EIP-712 hashStruct of the BatchUpdateSigners op
    const opKey = lockerOpKey('BatchUpdateSigners', {
        signersToRemove: toRemove,
        signersToAdd: toAdd,
        nonce: nonceBefore
    });

    log(`  OpKey: ${opKey.substring(0, 20)}...`);
    log(`  Removing: ${toRemove[0].substring(0, 20)}...`);
    log(`  Adding: ${toAdd[0].substring(0, 20)}...`);
    log(`  Nonce: ${nonceBefore}`);

    // Generate threshold signatures
    const threshold = await locker.approvalsThreshold();
    const signatures = [];
    const signerAddresses = [];

    const lockerAddress = await locker.getAddress();
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const domain = {
        name: "LockerContract",
        version: "1",
        chainId: Number(chainId),
        verifyingContract: lockerAddress
    };

    // Sign the decoded BatchUpdateSigners struct (M-1): wallet shows the
    // remove/add arrays and nonce, recomputing the same hashStruct as opKey.
    const message = { signersToRemove: toRemove, signersToAdd: toAdd, nonce: nonceBefore };

    for (let i = 0; i < threshold && i < currentSigners.length; i++) {
        const signerWallet = await ethers.getSigner(currentSigners[i]);

        const signature = await signLockerOp(signerWallet, domain, 'BatchUpdateSigners', message);

        signatures.push(signature);
        signerAddresses.push(currentSigners[i]);

        log(`  ✅ Signature ${i + 1}/${threshold} from ${currentSigners[i].substring(0, 10)}...`);
    }

    // Execute batch update
    const signer0 = await ethers.getSigner(signerAddresses[0]);
    const tx = await locker.connect(signer0).batchUpdateSignersWithSignatures(
        toRemove,
        toAdd,
        signerAddresses,
        signatures
    );
    await tx.wait();

    // Verify update
    const nonceAfter = await locker.batchUpdateSignersNonce();
    log(`  Nonce after: ${nonceAfter}`);

    assertEqual(nonceAfter, BigInt(expectedNonce + 1), `Nonce should be incremented to ${expectedNonce + 1}`);

    logSuccess(`✅ Batch update executed successfully`);
}

async function testVerifyFinalState(locker, originalSigners, expectedNonce) {
    logPhase(4, 'Verify Final State');
    logSection('Checking signer list reverted with different nonce');

    const signerManagerAddress = await locker.signerManager();
    const signerManager = await ethers.getContractAt('SignerManager', signerManagerAddress);
    const finalSigners = await signerManager.getSigners();
    const finalNonce = await locker.batchUpdateSignersNonce();

    log(`  Final signers count: ${finalSigners.length}`);
    log(`  Final nonce: ${finalNonce}`);
    log(`  Original signers count: ${originalSigners.length}`);
    log(`  Expected nonce: ${expectedNonce}`);

    // Check signer list is same as original
    assertEqual(finalSigners.length, originalSigners.length, 'Signer count should match original');
    assertEqual(finalNonce, BigInt(expectedNonce), `Nonce should be ${expectedNonce}`);

    // Verify last signer is back
    const originalLast = originalSigners[originalSigners.length - 1].toLowerCase();
    const finalLast = finalSigners[finalSigners.length - 1].toLowerCase();
    assertEqual(finalLast, originalLast, 'Last signer should be reverted to original');

    logSuccess('✅ Signers successfully reverted with different nonce');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
