/**
 * Test 23: Threshold Replay Protection
 * 
 * Tests that thresholdNonce allows reverting to previous threshold values
 * This test works regardless of initial state from previous tests
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
    log('\n🧪 TEST 23: THRESHOLD REPLAY PROTECTION\n', '\x1b[1m\x1b[36m');

    try {
        const locker = await getContract('LockerContract', 0);
        const signerManagerAddress = await locker.signerManager();
        const signerManager = await ethers.getContractAt('SignerManager', signerManagerAddress);
        const signers = await signerManager.getSigners();

        // Phase 1: Get initial state
        const initialState = await testGetInitialState(locker, signers.length);

        // Calculate max threshold (signer count)
        const maxThreshold = signers.length;

        // Get current state from previous tests
        const currentThreshold = Number(initialState.threshold);
        const currentNonce = Number(initialState.nonce);

        log(`  Max threshold allowed: ${maxThreshold}`);
        log(`  Starting from threshold: ${currentThreshold}, nonce: ${currentNonce}\n`);

        // Phase 2: Change to a different valid threshold
        let targetThreshold = currentThreshold < maxThreshold ? currentThreshold + 1 : currentThreshold - 1;
        targetThreshold = Math.max(3, Math.min(targetThreshold, maxThreshold));

        await testChangeThreshold(locker, signers, currentThreshold, targetThreshold, currentNonce);

        // Phase 3: Change back to original threshold (this is the key test - can we reuse a threshold value?)
        await testChangeThreshold(locker, signers, targetThreshold, currentThreshold, currentNonce + 1);

        // Phase 4: Verify nonce incremented correctly
        await testVerifyNonceProgression(locker, currentNonce + 2);

        reportTestResult('23-threshold-replay-protection', true);
        logSuccess('\n✅ TEST 23 PASSED!\n');

    } catch (error) {
        reportTestResult('23-threshold-replay-protection', false, error.message);
        throw error;
    }
}

async function testGetInitialState(locker, signerCount) {
    logPhase(1, 'Get Initial State');

    const threshold = await locker.approvalsThreshold();
    const nonce = await locker.thresholdNonce();

    log(`  Current threshold: ${threshold}`);
    log(`  Current nonce: ${nonce}`);
    log(`  Total signers: ${signerCount}`);

    logSuccess('Initial state retrieved');
    return { threshold, nonce, signerCount };
}

async function testChangeThreshold(locker, signers, fromThreshold, toThreshold, expectedNonce) {
    const phaseNum = expectedNonce === Number(await locker.thresholdNonce()) - Number(await locker.thresholdNonce()) + 2 ? 2 : 3;
    logPhase(phaseNum, `Change Threshold ${fromThreshold} → ${toThreshold}`);
    logSection(`Testing threshold change with nonce=${expectedNonce}`);

    const nonceBefore = await locker.thresholdNonce();
    assertEqual(nonceBefore, BigInt(expectedNonce), `Nonce should be ${expectedNonce} before change`);

    // Generate signatures for new threshold
    const opKey = lockerOpKey('UpdateThreshold', { newThreshold: toThreshold, nonce: nonceBefore });

    log(`  OpKey: ${opKey.substring(0, 20)}...`);
    log(`  From threshold: ${fromThreshold}`);
    log(`  To threshold: ${toThreshold}`);
    log(`  Nonce: ${nonceBefore}`);

    const signatures = [];
    const signerAddresses = [];

    // Generate signatures from current threshold number of signers
    const lockerAddress = await locker.getAddress();
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const domain = {
        name: "LockerContract",
        version: "1",
        chainId: Number(chainId),
        verifyingContract: lockerAddress
    };

    // Sign the decoded UpdateThreshold struct (M-1): the wallet displays
    // newThreshold/nonce and recomputes the hashStruct — which equals opKey.
    const message = { newThreshold: toThreshold, nonce: nonceBefore };

    for (let i = 0; i < fromThreshold && i < signers.length; i++) {
        const signerWallet = await ethers.getSigner(signers[i]);

        const signature = await signLockerOp(signerWallet, domain, 'UpdateThreshold', message);

        signatures.push(signature);
        signerAddresses.push(signers[i]);

        log(`  ✅ Signature ${i + 1}/${fromThreshold} from ${signers[i].substring(0, 10)}...`);
    }

    // Execute threshold update
    const signer0 = await ethers.getSigner(signerAddresses[0]);
    const tx = await locker.connect(signer0).updateThresholdWithSignatures(
        toThreshold,
        signerAddresses,
        signatures
    );
    await tx.wait();

    // Verify update
    const updatedThreshold = await locker.approvalsThreshold();
    const nonceAfter = await locker.thresholdNonce();

    log(`  Threshold after: ${updatedThreshold}`);
    log(`  Nonce after: ${nonceAfter}`);

    assertEqual(updatedThreshold, BigInt(toThreshold), `Threshold should be ${toThreshold}`);
    assertEqual(nonceAfter, BigInt(expectedNonce + 1), `Nonce should be incremented to ${expectedNonce + 1}`);

    logSuccess(`✅ Threshold changed ${fromThreshold} → ${toThreshold}`);
}

async function testVerifyNonceProgression(locker, expectedFinalNonce) {
    logPhase(4, 'Verify Nonce Progression');
    logSection('Checking final nonce value');

    const finalNonce = await locker.thresholdNonce();
    log(`  Final nonce: ${finalNonce}`);
    log(`  Expected: ${expectedFinalNonce}`);

    assertEqual(finalNonce, BigInt(expectedFinalNonce), `Nonce should be ${expectedFinalNonce} after threshold changes in this test`);

    logSuccess('✅ Nonce progressed correctly');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
