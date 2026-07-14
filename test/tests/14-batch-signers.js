/**
 * Test 14: Batch Update Signers with Signatures
 * 
 * Tests batchUpdateSignersWithSignatures - add and remove multiple signers
 * in a single operation using EIP-712 signatures
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
    log('\n🧪 TEST 14: BATCH UPDATE SIGNERS\n', '\x1b[1m\x1b[36m');

    try {
        const state = loadSharedState();

        const locker = await getContract('LockerContract', 0);
        const signerManagerAddress = await locker.signerManager();
        const signerManager = await ethers.getContractAt('SignerManager', signerManagerAddress);

        // Phase 1: Get current signers
        const signersBefore = await testGetCurrentSigners(signerManager);

        // Phase 2: Prepare signer changes
        const wallet15 = await getWallet(15);
        const wallet16 = await getWallet(16);
        const signerToRemove = signersBefore[signersBefore.length - 1]; // Last signer
        const signersToAdd = [wallet15.address, wallet16.address];

        // Phase 3: Generate signatures
        const { signatures, signerAddresses } =
            await testGenerateSignatures(locker, [signerToRemove], signersToAdd, signersBefore);

        // Phase 4: Execute batch update
        await testExecuteBatchUpdate(locker, signerManager, [signerToRemove], signersToAdd,
            signatures, signerAddresses, signersBefore.length);

        reportTestResult('14-batch-signers', true);
        logSuccess('\n✅ TEST 14 PASSED!\n');

    } catch (error) {
        reportTestResult('14-batch-signers', false, error.message);
        throw error;
    }
}

async function testGetCurrentSigners(signerManager) {
    logPhase(1, 'Get Current Signers');

    const signers = await signerManager.getSigners();
    log(`  Current signers: ${signers.length}`);
    signers.forEach((signer, i) => {
        log(`    ${i + 1}. ${signer.substring(0, 20)}...`);
    });

    logSuccess(`Found ${signers.length} signers`);
    return signers;
}

async function testGenerateSignatures(locker, signersToRemove, signersToAdd, currentSigners) {
    logPhase(2, 'Generate EIP-712 Signatures for Batch Update');
    logSection(`Remove: ${signersToRemove.length}, Add: ${signersToAdd.length}`);

    // Get nonce
    const nonce = await locker.batchUpdateSignersNonce();

    // Generate opKey (EIP-712 hashStruct of the BatchUpdateSigners op)
    const message = { signersToRemove, signersToAdd, nonce };
    const opKey = lockerOpKey('BatchUpdateSigners', message);

    log(`  OpKey: ${opKey.substring(0, 20)}...`);
    log(`  Nonce: ${nonce}`);
    log(`  Removing: ${signersToRemove[0].substring(0, 20)}...`);
    signersToAdd.forEach(addr => log(`  Adding: ${addr.substring(0, 20)}...`));

    const threshold = 3;
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

    // Generate signatures from first 3 signers (not the one being removed)
    for (let i = 0; i < threshold && i < currentSigners.length - 1; i++) {
        const signerWallet = await ethers.getSigner(currentSigners[i]);

        const signature = await signLockerOp(signerWallet, domain, 'BatchUpdateSigners', message);

        signatures.push(signature);
        signerAddresses.push(currentSigners[i]);

        log(`  ✅ Signature ${i + 1}/${threshold} from ${currentSigners[i].substring(0, 10)}...`);
    }

    logSuccess(`Generated ${signatures.length} EIP-712 signatures`);

    return { signatures, signerAddresses };
}

async function testExecuteBatchUpdate(locker, signerManager, signersToRemove, signersToAdd,
    signatures, signerAddresses, previousCount) {

    logPhase(3, 'Execute Batch Signer Update');
    logSection('Updating signers with signatures');

    const signer0 = await ethers.getSigner(signerAddresses[0]);

    const tx = await locker.connect(signer0).batchUpdateSignersWithSignatures(
        signersToRemove,
        signersToAdd,
        signerAddresses,
        signatures
    );
    await tx.wait();

    // Verify update
    const signersAfter = await signerManager.getSigners();
    const expectedCount = previousCount - signersToRemove.length + signersToAdd.length;

    log(`  Signers before: ${previousCount}`);
    log(`  Signers after: ${signersAfter.length}`);
    log(`  Expected: ${expectedCount}`);

    assertEqual(signersAfter.length, expectedCount, 'Signer count should match');

    // Verify removed signer is gone
    const removedStillPresent = signersAfter.some(s =>
        s.toLowerCase() === signersToRemove[0].toLowerCase()
    );
    assertEqual(removedStillPresent, false, 'Removed signer should not be present');

    // Verify added signers are present
    for (const newSigner of signersToAdd) {
        const isPresent = signersAfter.some(s => s.toLowerCase() === newSigner.toLowerCase());
        assertEqual(isPresent, true, `New signer ${newSigner.substring(0, 10)}... should be present`);
    }

    logSuccess('✅ Batch signer update successful');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
