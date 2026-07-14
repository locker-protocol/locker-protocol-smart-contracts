/**
 * Test 16: Create Lock with Signatures (EIP-712)
 * 
 * Tests createLockWithSignatures - create lock using offline EIP-712 signature
 * Allows non-signer to create lock with signer's offline signature
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
    lockerOpKey,
    getEthers
} from '../core/utils.js';

const ethers = getEthers();

async function main() {
    log('\n🧪 TEST 16: CREATE LOCK WITH SIGNATURES\n', '\x1b[1m\x1b[36m');

    try {
        const state = loadSharedState();
        const tokenProvider = await getWallet(0); // Has tokens
        const offlineSigner = await getWallet(1); // Signs offline

        const locker = await getContract('LockerContract', 0);
        const lockManagerAddress = await locker.lockManager();
        const lockManager = await ethers.getContractAt('LockManager', lockManagerAddress);
        const testToken = new ethers.Contract(
            state.contracts.TestToken,
            ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'],
            tokenProvider
        );

        // Phase 1: Prepare lock params
        const lockParams = await testPrepareLockParams(state.contracts.TestToken);

        // Phase 2: Generate EIP-712 signature
        const { signature } =
            await testGenerateCreateLockSignature(locker, lockParams, offlineSigner);

        // Phase 3: Create lock with signature
        const lockId = await testCreateLockWithSignature(locker, lockManager, testToken,
            tokenProvider, lockParams, offlineSigner.address, signature);

        // Phase 4: Verify lock created
        await testVerifyLock(lockManager, lockId, lockParams);

        // Phase 5: Verify the vesting config was plumbed through the signature path
        await testVerifyVestingConfig(locker, lockId, lockParams);

        reportTestResult('16-create-lock-sig', true);
        logSuccess('\n✅ TEST 16 PASSED!\n');

    } catch (error) {
        reportTestResult('16-create-lock-sig', false, error.message);
        throw error;
    }
}

async function testPrepareLockParams(tokenAddress) {
    logPhase(1, 'Prepare Lock Parameters');
    logSection('Setting up lock creation params');

    const lockParams = {
        token: tokenAddress,
        amount: ethers.parseEther('5000'),
        lockDuration: 5, // 5 seconds
        pair: ethers.ZeroAddress,
        ethUsdPair: ethers.ZeroAddress,
        targetPriceUSD1e18: 0,
        isEthPair: false,
        stablecoinPosition: 2,
        priceDirection: PRICE_DIRECTION.UPSIDE,
        vestingTokensPerPeriod: ethers.parseEther('50'), // 50 tokens/period
        vestingPeriodSeconds: 2, // 2 second periods
        vestingAccumulate: true // Accumulating vesting
    };

    log(`  Token: ${lockParams.token.substring(0, 20)}...`);
    log(`  Amount: ${ethers.formatEther(lockParams.amount)}`);
    log(`  Duration: ${lockParams.lockDuration}s`);
    log(`  Vesting: ${ethers.formatEther(lockParams.vestingTokensPerPeriod)} tokens/${lockParams.vestingPeriodSeconds}s`);

    logSuccess('Lock params prepared');
    return lockParams;
}

async function testGenerateCreateLockSignature(locker, lockParams, signerWallet) {
    logPhase(2, 'Generate EIP-712 Signature');
    logSection('Signer creates offline signature for lock creation');

    // Get current nonce
    const nonce = await locker.createLockNonce();
    log(`  Current nonce: ${nonce}`);

    // Build the decoded CreateLock struct; its hashStruct equals the on-chain opKey.
    const message = {
        token: lockParams.token,
        amount: lockParams.amount,
        lockDuration: lockParams.lockDuration,
        pair: lockParams.pair,
        ethUsdPair: lockParams.ethUsdPair,
        targetPriceUSD1e18: lockParams.targetPriceUSD1e18,
        isEthPair: lockParams.isEthPair,
        stablecoinPosition: lockParams.stablecoinPosition,
        priceDirection: lockParams.priceDirection,
        vestingTokensPerPeriod: lockParams.vestingTokensPerPeriod,
        vestingPeriodSeconds: lockParams.vestingPeriodSeconds,
        vestingAccumulate: lockParams.vestingAccumulate,
        nonce,
        signer: signerWallet.address
    };
    const opKey = lockerOpKey('CreateLock', message);

    log(`  OpKey: ${opKey.substring(0, 20)}...`);
    log(`  Signer: ${signerWallet.address.substring(0, 20)}...`);

    // Get domain for EIP-712
    const lockerAddress = await locker.getAddress();
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const domain = {
        name: "LockerContract",
        version: "1",
        chainId: Number(chainId),
        verifyingContract: lockerAddress
    };

    const signature = await signLockerOp(signerWallet, domain, 'CreateLock', message);

    log(`  ✅ Signature generated`);
    logSuccess('EIP-712 signature created');

    return { signature };
}

async function testCreateLockWithSignature(locker, lockManager, testToken, tokenProvider,
    lockParams, signerAddress, signature) {

    logPhase(3, 'Create Lock with Signature');
    logSection('Token provider creates lock using offline signature');

    // Approve tokens
    await testToken.approve(await locker.getAddress(), lockParams.amount);
    log(`  ✅ Approved ${ethers.formatEther(lockParams.amount)} tokens`);

    // Get next lock ID
    const nextLockId = await lockManager.nextLockId();
    log(`  Next lock ID: ${nextLockId}`);

    // Create lock with signature
    log(`  Calling createLockWithSignatures...`);
    const tx = await locker.connect(tokenProvider).createLockWithSignatures(
        lockParams,
        {
            signer: signerAddress,
            signature: signature
        }
    );
    await tx.wait();

    log(`  ✅ Lock created with ID: ${nextLockId}`);
    logSuccess('Lock created with EIP-712 signature');

    return nextLockId;
}

async function testVerifyLock(lockManager, lockId, lockParams) {
    logPhase(4, 'Verify Lock Created');
    logSection('Checking lock details match params');

    const lock = await lockManager.getLock(lockId);

    log(`  Lock ${lockId}:`);
    log(`    Token: ${lock.basic.token}`);
    log(`    Amount: ${ethers.formatEther(lock.basic.availableAmount)}`);
    log(`    Total: ${ethers.formatEther(lock.basic.totalAmount)}`);

    assertEqual(lock.basic.token.toLowerCase(), lockParams.token.toLowerCase(), 'Token should match');
    assertEqual(lock.basic.totalAmount, lockParams.amount, 'Amount should match');
    assertEqual(lock.basic.availableAmount, lockParams.amount, 'Available amount should match total');

    logSuccess('✅ Lock verified successfully');
}

async function testVerifyVestingConfig(locker, lockId, lockParams) {
    logPhase(5, 'Verify Vesting Config Initialized');
    logSection('Checking initializeVesting received the signed params');

    const config = await locker.getVestingConfig(lockId);

    assertEqual(config.enabled, true, 'Vesting should be enabled');
    assertEqual(config.tokensPerPeriod, lockParams.vestingTokensPerPeriod, 'tokensPerPeriod should match signed params');
    assertEqual(config.periodDuration, BigInt(lockParams.vestingPeriodSeconds), 'periodDuration should match signed params');
    assertEqual(config.accumulate, lockParams.vestingAccumulate, 'accumulate flag should match signed params');

    logSuccess('✅ Vesting config verified (accumulate/tokensPerPeriod plumbed through signature path)');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
