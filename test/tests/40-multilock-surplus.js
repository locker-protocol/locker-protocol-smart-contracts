/**
 * TEST 40: addToLock(0) Multi-Lock Surplus Handling
 *
 * Verifies that addToLock(lockId, 0) auto-detect requires an explicit amount
 * when a token has more than one lock.
 */

import { loadSharedState, log, logSuccess, logError, logPhase, logSection, assertEqual, assert, reportTestResult, getEthers } from '../core/utils.js';

const ethers = getEthers();

async function main() {
    console.log('\n🧪 TEST 40: MULTI-LOCK SURPLUS HANDLING VIA addToLock(0)\n');

    const state = loadSharedState();
    const [deployer, signer1, signer2, signer3, signer4] = await ethers.getSigners();

    // Deploy fresh contracts for isolation
    logSection('Deploying contracts');

    const VH = await ethers.getContractFactory('ValidationHandler');
    const vh = await VH.deploy(3);
    await vh.waitForDeployment();

    const PC = await ethers.getContractFactory('PriceCalculator');
    const pc = await PC.deploy(ethers.ZeroAddress, []);
    await pc.waitForDeployment();

    const LM = await ethers.getContractFactory('LockManager');
    const lm = await LM.deploy(await pc.getAddress());
    await lm.waitForDeployment();

    const VM = await ethers.getContractFactory('VestingManager');
    const vm = await VM.deploy(await lm.getAddress());
    await vm.waitForDeployment();

    const signerAddresses = [signer1.address, signer2.address, signer3.address];

    const SM = await ethers.getContractFactory('SignerManager');
    const sm = await SM.deploy(await vh.getAddress(), signerAddresses, 3);
    await sm.waitForDeployment();

    const LC = await ethers.getContractFactory('LockerContract');
    const locker = await LC.deploy(
        await vh.getAddress(),
        await lm.getAddress(),
        await sm.getAddress(),
        await vm.getAddress(),
        signerAddresses,
        3
    );
    await locker.waitForDeployment();
    const lockerAddr = await locker.getAddress();

    // Deploy mock token
    const ERC20Mock = await ethers.getContractFactory('ERC20Mock');
    const token = await ERC20Mock.deploy('TestToken', 'TST', deployer.address, ethers.parseEther('10000'), 18);
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    logSuccess('All contracts deployed');

    // ========================================
    // PHASE 1: Create 2 locks of the same token
    // ========================================
    logPhase(1, 'Create two locks of the same token');

    await (await token.transfer(signer1.address, ethers.parseEther('500'))).wait();
    await (await token.connect(signer1).approve(lockerAddr, ethers.parseEther('500'))).wait();

    // Lock 1: 200 tokens
    await (await locker.connect(signer1).createLock({
        token: tokenAddr,
        amount: ethers.parseEther('200'),
        lockDuration: 3600,
        pair: ethers.ZeroAddress,
        ethUsdPair: ethers.ZeroAddress,
        targetPriceUSD1e18: 0,
        isEthPair: false,
        stablecoinPosition: 0,
        priceDirection: 0,
        vestingTokensPerPeriod: 0,
        vestingPeriodSeconds: 0,
        vestingAccumulate: false,
    })).wait();
    logSuccess('Lock 1 created with 200 TST');

    // Lock 2: 300 tokens
    await (await locker.connect(signer1).createLock({
        token: tokenAddr,
        amount: ethers.parseEther('300'),
        lockDuration: 3600,
        pair: ethers.ZeroAddress,
        ethUsdPair: ethers.ZeroAddress,
        targetPriceUSD1e18: 0,
        isEthPair: false,
        stablecoinPosition: 0,
        priceDirection: 0,
        vestingTokensPerPeriod: 0,
        vestingPeriodSeconds: 0,
        vestingAccumulate: false,
    })).wait();
    logSuccess('Lock 2 created with 300 TST');

    const lock1 = await locker.locks(1);
    const lock2 = await locker.locks(2);
    assertEqual(lock1.basic.availableAmount, ethers.parseEther('200'), 'Lock 1 should have 200 TST');
    assertEqual(lock2.basic.availableAmount, ethers.parseEther('300'), 'Lock 2 should have 300 TST');
    logSuccess('Both locks verified');

    // ========================================
    // PHASE 2: Send surplus and test addToLock(0)
    // ========================================
    logPhase(2, 'Send surplus tokens and test addToLock(0)');

    // Send 50 extra tokens directly to the contract
    await (await token.transfer(lockerAddr, ethers.parseEther('50'))).wait();
    logSuccess('Sent 50 TST surplus to contract');

    const balanceAfterSurplus = await token.balanceOf(lockerAddr);
    assertEqual(balanceAfterSurplus, ethers.parseEther('550'), 'Contract should have 550 TST');

    // With MULTIPLE locks of the same token, the amount=0 auto-detect path is ambiguous
    // (the surplus could belong to any lock), so it must revert and require the caller to
    // pass an explicit amount.
    const lock1Before = await locker.locks(1);
    log(`  Lock 1 available: ${ethers.formatEther(lock1Before.basic.availableAmount)} TST`);
    log(`  Contract balance: ${ethers.formatEther(balanceAfterSurplus)} TST`);
    log(`  Naive per-lock surplus would be: ${ethers.formatEther(balanceAfterSurplus - lock1Before.basic.availableAmount)} TST`);
    log(`  Actual surplus: 50 TST`);

    try {
        // F4: the amount==0 auto-detect path is signer-gated, so call it from a signer to
        // reach the multi-lock ERR_008 guard (not the NotSigner gate).
        await (await locker.connect(signer1).addToLock(1, 0, ethers.ZeroHash)).wait();
        throw new Error('Should revert');
    } catch (e) {
        if (e.message.includes('Should revert')) {
            logError('⚠️  addToLock(0) did NOT revert with multiple locks');
            throw e;
        }
        assert(
            e.message.includes('ERR_008'),
            `Expected 'ERR_008' but got: ${e.message}`
        );
        logSuccess('addToLock(0) reverts with multiple locks — explicit amount required');
    }

    // Lock accounting must be untouched by the reverted call.
    const lock1After = await locker.locks(1);
    const lock2After = await locker.locks(2);
    assertEqual(lock1After.basic.availableAmount, ethers.parseEther('200'), 'Lock 1 still 200 TST');
    assertEqual(lock2After.basic.availableAmount, ethers.parseEther('300'), 'Lock 2 still 300 TST');
    logSuccess('Lock accounting unchanged after revert');

    // ========================================
    // PHASE 3: single-lock surplus still works via amount=0
    // ========================================
    logPhase(3, 'Single-lock surplus auto-detect still works');

    // Deploy a fresh token with exactly ONE lock, then verify amount=0 credits the surplus.
    const ERC20Mock2 = await ethers.getContractFactory('ERC20Mock');
    const token2 = await ERC20Mock2.deploy('Solo', 'SOLO', deployer.address, ethers.parseEther('1000'), 18);
    await token2.waitForDeployment();
    const token2Addr = await token2.getAddress();

    await (await token2.transfer(signer1.address, ethers.parseEther('100'))).wait();
    await (await token2.connect(signer1).approve(lockerAddr, ethers.parseEther('100'))).wait();
    await (await locker.connect(signer1).createLock({
        token: token2Addr,
        amount: ethers.parseEther('100'),
        lockDuration: 3600,
        pair: ethers.ZeroAddress,
        ethUsdPair: ethers.ZeroAddress,
        targetPriceUSD1e18: 0,
        isEthPair: false,
        stablecoinPosition: 0,
        priceDirection: 0,
        vestingTokensPerPeriod: 0,
        vestingPeriodSeconds: 0,
        vestingAccumulate: false,
    })).wait();
    const soloLockId = 3; // locks 1 & 2 are the TST locks above

    // Send 25 SOLO surplus directly, then auto-detect it.
    await (await token2.transfer(lockerAddr, ethers.parseEther('25'))).wait();
    const soloBefore = await locker.locks(soloLockId);
    // F4: amount==0 auto-detect is signer-gated — call it from a signer.
    await (await locker.connect(signer1).addToLock(soloLockId, 0, ethers.ZeroHash)).wait();
    const soloAfter = await locker.locks(soloLockId);
    assertEqual(
        soloAfter.basic.availableAmount - soloBefore.basic.availableAmount,
        ethers.parseEther('25'),
        'Single-lock surplus credits exactly 25 SOLO'
    );
    logSuccess('Single-lock amount=0 surplus auto-detect credits exactly the real surplus');

    // ========================================
    // PHASE 4: addToLock on non-existent lock reverts
    // ========================================
    logPhase(4, 'addToLock on non-existent lock');

    try {
        await locker.connect(deployer).addToLock(999, ethers.parseEther('10'), ethers.ZeroHash);
        throw new Error('Should revert');
    } catch (e) {
        if (e.message.includes('Should revert')) throw e;
        logSuccess('addToLock on non-existent lock correctly reverts');
    }

    logSuccess('\n🎉 TEST 40 PASSED: Multi-lock surplus handling verified!\n');
    reportTestResult('40-multilock-surplus', true);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        logError(`\n❌ TEST FAILED: 40-multilock-surplus - ${error.message}\n`);
        reportTestResult('40-multilock-surplus', false);
        console.error(error);
        process.exit(1);
    });
