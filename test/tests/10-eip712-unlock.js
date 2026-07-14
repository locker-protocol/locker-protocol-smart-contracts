/**
 * Test 10: EIP-712 Signature Unlock
 * 
 * Tests executeUnlockWithSignatures - unlock using offline EIP-712 signatures
 * instead of individual on-chain approvals
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
    PRICE_DIRECTION,
    signLockerOp,
    getEthers
} from '../core/utils.js';

const ethers = getEthers();

async function main() {
    log('\n🧪 TEST 10: EIP-712 SIGNATURE UNLOCK\n', '\x1b[1m\x1b[36m');

    try {
        const state = loadSharedState();
        const deployer = await getWallet(0);
        const recipient = await getWallet(5);

        const locker = await getContract('LockerContract', 0);
        const lockManagerAddress = await locker.lockManager();
        const lockManager = await ethers.getContractAt('LockManager', lockManagerAddress);
        const testToken = new ethers.Contract(
            state.contracts.TestToken,
            ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'],
            deployer
        );

        // Get signers for EIP-712 signatures
        const signerManagerAddress = await locker.signerManager();
        const signerManager = await ethers.getContractAt('SignerManager', signerManagerAddress);
        const signers = await signerManager.getSigners();
        const threshold = await locker.approvalsThreshold();

        // Phase 1: Create time-based lock
        const lockId = await testCreateLock(locker, lockManager, testToken, deployer, state.contracts.TestToken);

        // Phase 2: Generate EIP-712 signatures offline
        const unlockAmount = ethers.parseEther('5000');
        const { opKey, signatures, signerAddresses } =
            await testGenerateSignatures(locker, lockId, recipient.address, unlockAmount, signers, threshold);

        // Phase 3: Execute unlock with signatures
        await testExecuteWithSignatures(locker, testToken, lockId, recipient, unlockAmount,
            opKey, signatures, signerAddresses);

        reportTestResult('10-eip712-unlock', true);
        logSuccess('\n✅ TEST 10 PASSED!\n');

    } catch (error) {
        reportTestResult('10-eip712-unlock', false, error.message);
        throw error;
    }
}

async function testCreateLock(locker, lockManager, testToken, deployer, tokenAddress) {
    logPhase(1, 'Create Time-Based Lock');
    logSection('Creating lock for EIP-712 unlock test');

    const lockAmount = ethers.parseEther('10000');
    const minTime = 2;

    await testToken.connect(deployer).approve(await locker.getAddress(), lockAmount);

    const createLockParams = {
        token: tokenAddress,
        amount: lockAmount,
        lockDuration: minTime,
        pair: ethers.ZeroAddress,
        ethUsdPair: ethers.ZeroAddress,
        targetPriceUSD1e18: 0,
        isEthPair: false,
        stablecoinPosition: 2,
        priceDirection: PRICE_DIRECTION.UPSIDE,
        vestingTokensPerPeriod: 0,
        vestingPeriodSeconds: 0,
        vestingAccumulate: false
    };

    const nextId = await lockManager.nextLockId();
    await locker.connect(deployer).createLock(createLockParams);
    const lockId = nextId;

    log(`  Lock ID: ${lockId}`);
    log(`  Amount: ${ethers.formatEther(lockAmount)}`);
    log(`  Waiting 3s for time condition...`);

    await new Promise(resolve => setTimeout(resolve, 3000));

    logSuccess(`Lock ${lockId} created and unlockable`);
    return lockId;
}

async function testGenerateSignatures(locker, lockId, recipientAddress, amount, signers, threshold) {
    logPhase(2, 'Generate EIP-712 Signatures');
    logSection('Creating offline signatures for unlock');

    const opKey = await locker.getUnlockOpKey(lockId, recipientAddress, amount);
    const nonce = await locker.unlockNonce(lockId);
    log(`  OpKey: ${opKey.substring(0, 20)}...`);
    log(`  Threshold: ${threshold}`);

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

    // Sign the decoded Unlock struct (M-1): the wallet displays lockId/to/amount/nonce
    // and recomputes the hashStruct — which equals the on-chain opKey.
    const message = { lockId, to: recipientAddress, amount, nonce };

    // Generate signatures from first N signers
    for (let i = 0; i < Number(threshold) && i < signers.length; i++) {
        const signerWallet = await ethers.getSigner(signers[i]);

        const signature = await signLockerOp(signerWallet, domain, 'Unlock', message);

        signatures.push(signature);
        signerAddresses.push(signers[i]);

        log(`  ✅ Signature ${i + 1}/${threshold} from ${signers[i].substring(0, 10)}...`);
    }

    logSuccess(`Generated ${signatures.length} EIP-712 signatures`);

    return { opKey, signatures, signerAddresses };
}

async function testExecuteWithSignatures(locker, testToken, lockId, recipient, amount,
    opKey, signatures, signerAddresses) {

    logPhase(3, 'Execute Unlock with Signatures');
    logSection('Using executeUnlockWithSignatures');

    const balanceBefore = await testToken.balanceOf(recipient.address);
    log(`  Recipient balance before: ${ethers.formatEther(balanceBefore)}`);

    // Execute unlock with signatures
    log(`  Executing with ${signatures.length} signatures...`);

    const signer0 = await ethers.getSigner(signerAddresses[0]);
    const tx = await locker.connect(signer0).executeUnlockWithSignatures(
        lockId,
        recipient.address,
        amount,
        signerAddresses,
        signatures
    );
    await tx.wait();

    const balanceAfter = await testToken.balanceOf(recipient.address);
    const received = balanceAfter - balanceBefore;

    log(`  Recipient balance after: ${ethers.formatEther(balanceAfter)}`);
    log(`  Received: ${ethers.formatEther(received)}`);

    assertEqual(received, amount, 'Recipient should receive exact amount');

    logSuccess('✅ Unlock executed successfully with EIP-712 signatures');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
