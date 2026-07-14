/**
 * Test 15: Update Threshold with Signatures
 * 
 * Tests updateThresholdWithSignatures - change the approval threshold
 * using EIP-712 signatures
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
    signLockerOp,
    lockerOpKey,
    getEthers
} from '../core/utils.js';

const ethers = getEthers();

async function main() {
    log('\n🧪 TEST 15: UPDATE THRESHOLD\n', '\x1b[1m\x1b[36m');

    try {
        const locker = await getContract('LockerContract', 0);
        const signerManagerAddress = await locker.signerManager();
        const signerManager = await ethers.getContractAt('SignerManager', signerManagerAddress);
        const signers = await signerManager.getSigners();

        // Phase 1: Get current threshold
        const currentThreshold = await testGetCurrentThreshold(locker, signers.length);

        // Phase 2: Calculate new threshold (increase by 1, but max = signers.length - 2)
        const newThreshold = Math.min(Number(currentThreshold) + 1, signers.length - 2);

        if (newThreshold === Number(currentThreshold)) {
            log('\n⚠️  Threshold already at maximum, cannot increase further');
            log(`   Skipping test (threshold: ${currentThreshold}, signers: ${signers.length})\n`);
            reportTestResult('15-threshold-update', true);
            logSuccess('\n✅ TEST 15 SKIPPED (threshold at max)\n');
            return;
        }

        // Phase 3: Generate signatures
        const { signatures, signerAddresses } =
            await testGenerateSignatures(locker, newThreshold, signers, currentThreshold);

        // Phase 4: Execute threshold update
        await testExecuteThresholdUpdate(locker, newThreshold, signatures, signerAddresses, currentThreshold);

        reportTestResult('15-threshold-update', true);
        logSuccess('\n✅ TEST 15 PASSED!\n');

    } catch (error) {
        reportTestResult('15-threshold-update', false, error.message);
        throw error;
    }
}

async function testGetCurrentThreshold(locker, signerCount) {
    logPhase(1, 'Get Current Threshold');

    const threshold = await locker.approvalsThreshold();
    log(`  Current threshold: ${threshold}`);
    log(`  Total signers: ${signerCount}`);
    log(`  Max threshold: ${signerCount - 2}`);

    logSuccess('Current threshold retrieved');
    return threshold;
}

async function testGenerateSignatures(locker, newThreshold, signers, currentThreshold) {
    logPhase(2, 'Generate EIP-712 Signatures for Threshold Update');
    logSection(`Changing threshold from ${currentThreshold} to ${newThreshold}`);

    // Request nonce from contract
    const nonce = await locker.thresholdNonce();
    log(`  Nonce: ${nonce}`);

    // Generate opKey WITH nonce (replay protection) as the EIP-712 hashStruct
    const message = { newThreshold, nonce };
    const opKey = lockerOpKey('UpdateThreshold', message);

    log(`  OpKey: ${opKey.substring(0, 20)}...`);
    log(`  New threshold: ${newThreshold}`);

    const signatures = [];
    const signerAddresses = [];

    // Get domain for EIP-712
    const lockerAddress = await locker.getAddress();
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const domain = {
        name: "LockerContract",
        version: "1",
        chainId: Number(chainId),
        verifyingContract: lockerAddress
    };

    // Generate signatures from current threshold number of signers
    for (let i = 0; i < Number(currentThreshold) && i < signers.length; i++) {
        const signerWallet = await ethers.getSigner(signers[i]);

        const signature = await signLockerOp(signerWallet, domain, 'UpdateThreshold', message);

        signatures.push(signature);
        signerAddresses.push(signers[i]);

        log(`  ✅ Signature ${i + 1}/${currentThreshold} from ${signers[i].substring(0, 10)}...`);
    }

    logSuccess(`Generated ${signatures.length} EIP-712 signatures`);

    return { signatures, signerAddresses };
}

async function testExecuteThresholdUpdate(locker, newThreshold, signatures, signerAddresses, oldThreshold) {

    logPhase(3, 'Execute Threshold Update');
    logSection('Updating threshold with signatures');

    const signer0 = await ethers.getSigner(signerAddresses[0]);

    const tx = await locker.connect(signer0).updateThresholdWithSignatures(
        newThreshold,
        signerAddresses,
        signatures
    );
    await tx.wait();

    // Verify update
    const updatedThreshold = await locker.approvalsThreshold();

    log(`  Threshold before: ${oldThreshold}`);
    log(`  Threshold after: ${updatedThreshold}`);

    assertEqual(updatedThreshold, BigInt(newThreshold), 'Threshold should be updated');

    logSuccess('✅ Threshold updated successfully');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
