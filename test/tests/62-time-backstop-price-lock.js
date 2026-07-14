/**
 * Test 62: Time backstop on a PRICE-locked lock (audit A1 / C3 / F7-bounded)
 *
 * The audit's freeze analysis rests on ONE guarantee: a lock can never be stranded by a
 * broken/uncooperative price oracle, because `block.timestamp >= unlockTime` is ALWAYS a
 * valid unlock trigger, consulted BEFORE (and independently of) any oracle read
 * (LockManager.validateAndUnlock). This test makes that guarantee executable:
 *
 *   1. Create a price-locked lock (target never reached) with a finite duration.
 *   2. Before unlockTime, an M-of-N-approved unlock reverts "COND" (neither time nor price).
 *   3. Break the oracle entirely (drain the pool → getReserves returns 0 → price read fails).
 *   4. Advance past unlockTime → getLockStatus shows timeOk=true, priceOk=false (dead oracle).
 *   5. The M-of-N unlock now SUCCEEDS via the time backstop, delivering the funds.
 *
 * Proves the freeze surface is bounded by the (capped) lock duration, not by oracle health.
 */

import {
    loadSharedState,
    getContract,
    getWallet,
    logPhase,
    logSection,
    logSuccess,
    log,
    assert,
    assertEqual,
    reportTestResult,
    advanceTime,
    lockerDomain,
    PRICE_DIRECTION,
    getEthers
} from '../core/utils.js';
import { expectRevert, collectSignatures } from '../core/regression-helpers.js';

const ethers = getEthers();

async function main() {
    log('\n🧪 TEST 62: TIME BACKSTOP ON A PRICE-LOCKED LOCK\n', '\x1b[1m\x1b[36m');

    try {
        loadSharedState();
        const locker = await getContract('LockerContract', 0);
        const lockManager = await getContract('LockManager', 0);
        const lockerAddress = await locker.getAddress();

        const executor = await getWallet(0);      // a signer (needed for onlySigner createLock)
        const recipient = await getWallet(8);      // a non-signer destination
        const signers = await locker.getSigners();
        const threshold = Number(await locker.approvalsThreshold());
        const chainId = Number((await ethers.provider.getNetwork()).chainId);
        const domain = lockerDomain(lockerAddress, chainId);

        // ── Deploy an isolated price token + stablecoin + V2 pool ──────────────
        logSection('Deploy price token, stablecoin and a V2 pool');
        const ERC20Mock = await ethers.getContractFactory('ERC20Mock', executor);
        const supply = ethers.parseEther('1000000');
        const priceToken = await ERC20Mock.deploy('Backstop Token', 'BKS', executor.address, supply, 18);
        await priceToken.waitForDeployment();
        const stable = await ERC20Mock.deploy('Mock USD', 'mUSD', executor.address, supply, 18);
        await stable.waitForDeployment();

        const Pair = await ethers.getContractFactory('MockUniswapV2Pair', executor);
        // token0 = priceToken, token1 = stable → stablecoinPosition = 2
        const pair = await Pair.deploy(await priceToken.getAddress(), await stable.getAddress());
        await pair.waitForDeployment();
        // Spot = $1, but the target is $2 UPSIDE → price condition is NEVER satisfied.
        await (await pair.setPriceForToken(await priceToken.getAddress(), ethers.parseEther('1'))).wait();

        // ── Create the price-locked lock (finite duration, unreachable target) ──
        logPhase(1, 'Create a price-locked lock with a finite duration');
        const lockAmt = ethers.parseEther('10000');
        const lockDuration = 7 * 24 * 3600; // 7 days
        const params = {
            token: await priceToken.getAddress(),
            amount: lockAmt,
            lockDuration,
            pair: await pair.getAddress(),
            ethUsdPair: ethers.ZeroAddress,
            targetPriceUSD1e18: ethers.parseEther('2'), // never reached (spot is $1)
            isEthPair: false,
            stablecoinPosition: 2,
            priceDirection: PRICE_DIRECTION.UPSIDE,
            vestingTokensPerPeriod: 0,
            vestingPeriodSeconds: 0,
            vestingAccumulate: false
        };
        await (await priceToken.connect(executor).approve(lockerAddress, lockAmt)).wait();
        const lockId = await lockManager.nextLockId();
        await (await locker.connect(executor).createLock(params)).wait();
        assertEqual((await lockManager.getLock(lockId)).basic.availableAmount, lockAmt, 'lock funded with 10000');

        const preStatus = await lockManager.getLockStatus(lockId);
        assert(preStatus.timeOk === false, 'time condition closed at creation');
        assert(preStatus.priceOk === false, 'price condition closed (target $2 > spot $1)');

        // ── Before unlockTime: even a full M-of-N unlock is refused (COND) ──────
        logPhase(2, 'M-of-N unlock before the condition is met reverts COND');
        const nonce0 = await locker.unlockNonce(lockId);
        const earlySigs = await collectSignatures(
            'Unlock', { lockId, to: recipient.address, amount: lockAmt, nonce: nonce0 },
            signers, threshold, domain
        );
        await expectRevert(
            () => locker.connect(executor).executeUnlockWithSignatures(
                lockId, recipient.address, lockAmt, earlySigs.addresses, earlySigs.signatures
            ),
            'Full-multisig unlock before time or price is met',
            'COND'
        );

        // ── Break the oracle entirely (drain the pool) ─────────────────────────
        logPhase(3, 'Break the price oracle (drain the pool reserves)');
        await (await pair.setReserves(0, 0)).wait();
        const deadStatus = await lockManager.getLockStatus(lockId);
        assert(deadStatus.priceOk === false, 'price read fails on a dead pool → priceOk stays false');

        // ── Advance past unlockTime: time backstop opens the lock ──────────────
        logPhase(4, 'Advance past unlockTime; time backstop applies despite the dead oracle');
        await advanceTime(lockDuration + 60);
        const openStatus = await lockManager.getLockStatus(lockId);
        assert(openStatus.timeOk === true, 'time condition open after unlockTime');
        assert(openStatus.priceOk === false, 'price still closed (dead oracle) → unlock can only be via TIME');

        // ── The M-of-N unlock now succeeds via the time backstop ───────────────
        logPhase(5, 'M-of-N unlock succeeds via the time backstop');
        const nonce1 = await locker.unlockNonce(lockId);
        const sigs = await collectSignatures(
            'Unlock', { lockId, to: recipient.address, amount: lockAmt, nonce: nonce1 },
            signers, threshold, domain
        );
        const before = await priceToken.balanceOf(recipient.address);
        await (await locker.connect(executor).executeUnlockWithSignatures(
            lockId, recipient.address, lockAmt, sigs.addresses, sigs.signatures
        )).wait();
        assertEqual((await priceToken.balanceOf(recipient.address)) - before, lockAmt,
            'funds released via time backstop even with a dead price oracle');

        log('\n📊 Time-backstop regression passed\n', '\x1b[1m\x1b[32m');
        reportTestResult('62-time-backstop-price-lock', true);
        logSuccess('\n✅ TEST 62 PASSED — a broken oracle cannot strand a lock past unlockTime\n');
    } catch (error) {
        reportTestResult('62-time-backstop-price-lock', false, error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST 62 FAILED:\n', error);
        process.exit(1);
    });
