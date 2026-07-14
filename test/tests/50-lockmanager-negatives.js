/**
 * Test 50: LockManager Negative Paths & Edge Coverage
 *
 * Covers (validated against the CURRENT LockManager.sol):
 * - constructor: 'Z' (_priceCalculator == 0)
 * - setLocker: 'Z' (_locker == 0 / already initialized), 'Only deployer' (tx.origin guard)
 * - onlyLocker: exact 'NA' on direct calls by a non-locker account
 * - createLock: 'Z' (token==0 / amount==0), 'TF' (locker balance < amount),
 *   'INV_STABLECOIN_POS' (stablecoinPosition > 2 — position 1 is VALID per current code),
 *   'STABLECOIN_REQ' (position 0 with a non-eth pair)
 * - addToLock: 'Z' (amount==0 with no... amount==0), 'LOCK_NOT_EXISTS'
 * - validateAndUnlock: 'TREG' (missing lock), 'NA' (amount > availableAmount),
 *   'COND' (price lock: neither time nor price satisfied), 'COND' via broken oracle
 *   (zeroed reserves). NOTE: the `catch` branch of LockManager's try/catch around
 *   getPriceUSDWithFallback is defensive-only — PriceCalculator.getPriceUSDWithFallback
 *   itself try/catches getPriceUSD and returns (false, 0) instead of reverting, so a
 *   broken pair flows through `success == false` → priceOk=false → 'COND' (same
 *   observable behavior).
 * - unlockVestedAmount: 'NL' (missing lock), 'NA' (amount==0 and amount > available).
 *   'WD' is UNREACHABLE dead code: both places that set `withdrawn = true` do so when
 *   availableAmount hits 0 and immediately call _deleteLockIfEmpty, which deletes the
 *   whole lock — any later call sees basic.token == 0 and reverts 'NL', never 'WD'.
 *   We assert the 'NL' outcome on a fully-drained lock to document this.
 * - _deleteLockIfEmpty partial branch: token with several locks, one emptied → the
 *   token stays in getLockedTokens / keeps its remaining lock id
 * - getLockHistoryPaginated: non-empty copy loop + end>total clamp + offset>=total
 * - calculateGainLoss overflow requires — all four are reachable with mock pairs
 *   because reserves are uint112-capped but the decimals adjustment 10**(d0-d1)
 *   multiplies the price arbitrarily (uint256 max ≈ 1.157e77 > int256 max ≈ 5.789e76):
 *   'Price diff overflow' (price 1e77), 'Percentage overflow' (avg=1, diff ~1e57),
 *   'Gain overflow' / 'Loss overflow' (0-decimals token, huge totalPurchaseAmount)
 *
 * Obsolete (removed from the contract, asserted absent):
 * - updateTargetPrice / _updateLockPricing / TARGET_PRICE_UPDATE_COOLDOWN
 *
 * Technique: no impersonation needed — a fresh LockManager is deployed and wired to
 * the deployer EOA via setLocker (tx.origin == deployer passes the guard), so the EOA
 * can exercise every onlyLocker code path directly.
 */

import {
    logPhase,
    logSection,
    logSuccess,
    log,
    reportTestResult,
    getEthers,
    assert,
    assertEqual,
    ONE_YEAR
} from '../core/utils.js';

const ethers = getEthers();

/**
 * Asserts that an async call reverts with the EXACT reason string.
 * Matches e.reason equality or the quoted reason inside the node/ethers message.
 */
async function expectRevert(fn, expectedReason, label) {
    try {
        await fn();
    } catch (e) {
        const msg = [e.reason, e.shortMessage, e.message, e.error && e.error.message]
            .filter(Boolean)
            .join(' | ');
        const ok =
            e.reason === expectedReason ||
            msg.includes(`'${expectedReason}'`) ||
            msg.includes(`"${expectedReason}"`);
        assert(ok, `${label}: expected revert '${expectedReason}' but got: ${msg}`);
        logSuccess(`${label} → reverted with '${expectedReason}'`);
        return;
    }
    throw new Error(`${label}: expected revert '${expectedReason}' but the call succeeded`);
}

/** Creates a lock directly on the LockManager (EOA is the locker) and returns its id. */
async function createDirectLock(lm, params) {
    const id = await lm.nextLockId();
    await (await lm.createLock(
        params.token,
        params.amount,
        params.lockDuration,
        params.pair ?? ethers.ZeroAddress,
        params.ethUsdPair ?? ethers.ZeroAddress,
        params.targetPriceUSD1e18 ?? 0n,
        params.isEthPair ?? false,
        params.stablecoinPosition ?? 0,
        params.priceDirection ?? 0
    )).wait();
    return id;
}

async function main() {
    log('\n🧪 TEST 50: LOCKMANAGER NEGATIVE PATHS & EDGE COVERAGE\n', '\x1b[1m\x1b[36m');

    try {
        const [deployer, outsider] = await ethers.getSigners();

        // ========================================
        // PHASE 1: Deploy fresh modules — EOA acts as the locker
        // ========================================
        logPhase(1, 'Deploy fresh LockManager wired to an EOA locker');

        const PC = await ethers.getContractFactory('PriceCalculator');
        const pc = await PC.deploy(ethers.ZeroAddress, []);
        await pc.waitForDeployment();
        const pcAddr = await pc.getAddress();

        const LM = await ethers.getContractFactory('LockManager');
        const lm = await LM.deploy(pcAddr);
        await lm.waitForDeployment();

        // Wire the EOA as the locker: tx.origin == deployer satisfies the guard
        await (await lm.setLocker(deployer.address)).wait();
        assertEqual(await lm.locker(), deployer.address, 'LockManager.locker is the deployer EOA');
        logSuccess('Fresh LockManager deployed, deployer EOA registered as locker');

        // Removed API must stay removed (updateTargetPrice & friends were deleted)
        assert(lm.updateTargetPrice === undefined, 'updateTargetPrice must not exist');
        assert(lm.TARGET_PRICE_UPDATE_COOLDOWN === undefined, 'TARGET_PRICE_UPDATE_COOLDOWN must not exist');
        logSuccess('Removed API (updateTargetPrice / TARGET_PRICE_UPDATE_COOLDOWN) is absent');

        // Test tokens + mock pair (TST 18 dec / USDC 6 dec, price = $2)
        const ERC20Mock = await ethers.getContractFactory('ERC20Mock');
        const token = await ERC20Mock.deploy('Test Token', 'TST', deployer.address, ethers.parseEther('1000000'), 18);
        await token.waitForDeployment();
        const tokenAddr = await token.getAddress();

        const usdc = await ERC20Mock.deploy('USD Coin', 'USDC', deployer.address, ethers.parseUnits('1000000', 6), 6);
        await usdc.waitForDeployment();
        const usdcAddr = await usdc.getAddress();

        const MockV2 = await ethers.getContractFactory('MockUniswapV2Pair');
        const v2pair = await MockV2.deploy(tokenAddr, usdcAddr);
        await v2pair.waitForDeployment();
        const v2pairAddr = await v2pair.getAddress();
        await (await v2pair.setReserves(ethers.parseEther('500000'), ethers.parseUnits('1000000', 6))).wait();
        logSuccess('Mock tokens and TST/USDC pair deployed (spot price $2)');

        // ========================================
        // PHASE 2: constructor 'Z' + setLocker guards
        // ========================================
        logPhase(2, "constructor 'Z' + setLocker guards");

        await expectRevert(
            () => LM.deploy(ethers.ZeroAddress),
            'Z',
            'constructor(_priceCalculator = 0)'
        );

        // Fresh, uninitialized LockManager for the setLocker guards
        const lm2 = await LM.deploy(pcAddr);
        await lm2.waitForDeployment();

        await expectRevert(
            () => lm2.setLocker(ethers.ZeroAddress),
            'Z',
            'setLocker(_locker = 0)'
        );

        await expectRevert(
            () => lm2.connect(outsider).setLocker(outsider.address),
            'Only deployer',
            'setLocker by non-deployer (tx.origin guard)'
        );

        await (await lm2.setLocker(deployer.address)).wait();
        assert(await lm2.initialized(), 'lm2 should be initialized');

        await expectRevert(
            () => lm2.setLocker(deployer.address),
            'Z',
            'setLocker when already initialized'
        );

        // ========================================
        // PHASE 3: onlyLocker — exact 'NA' for a random caller
        // ========================================
        logPhase(3, "onlyLocker modifier — exact 'NA'");

        await expectRevert(
            () => lm.connect(outsider).createLock(tokenAddr, 1n, 3600, ethers.ZeroAddress, ethers.ZeroAddress, 0, false, 0, 0),
            'NA',
            'createLock by non-locker'
        );
        await expectRevert(
            () => lm.connect(outsider).addToLock(1, 1n, outsider.address, ethers.ZeroHash),
            'NA',
            'addToLock by non-locker'
        );
        await expectRevert(
            () => lm.connect(outsider).validateAndUnlock(1, 1n),
            'NA',
            'validateAndUnlock by non-locker'
        );
        await expectRevert(
            () => lm.connect(outsider).unlockVestedAmount(1, 1n),
            'NA',
            'unlockVestedAmount by non-locker'
        );

        // ========================================
        // PHASE 4: createLock internal requires (EOA is the locker)
        // ========================================
        logPhase(4, 'createLock internal requires');

        await expectRevert(
            () => lm.createLock(ethers.ZeroAddress, 1n, 3600, ethers.ZeroAddress, ethers.ZeroAddress, 0, false, 0, 0),
            'Z',
            'createLock(token = 0)'
        );

        await expectRevert(
            () => lm.createLock(tokenAddr, 0n, 3600, ethers.ZeroAddress, ethers.ZeroAddress, 0, false, 0, 0),
            'Z',
            'createLock(amount = 0)'
        );

        const overSupply = (await token.totalSupply()) + 1n;
        await expectRevert(
            () => lm.createLock(tokenAddr, overSupply, 3600, ethers.ZeroAddress, ethers.ZeroAddress, 0, false, 0, 0),
            'TF',
            'createLock(amount > locker balance)'
        );

        // Current code: require(stablecoinPosition <= 2) — only >2 reverts, position 1
        // (stablecoin = token0) is VALID.
        await expectRevert(
            () => lm.createLock(tokenAddr, 1n, 3600, v2pairAddr, ethers.ZeroAddress, 0, false, 3, 0),
            'INV_STABLECOIN_POS',
            'createLock(stablecoinPosition = 3 with a pair)'
        );

        await expectRevert(
            () => lm.createLock(tokenAddr, 1n, 3600, v2pairAddr, ethers.ZeroAddress, 0, false, 0, 0),
            'STABLECOIN_REQ',
            'createLock(stablecoinPosition = 0, non-eth pair)'
        );

        // ========================================
        // PHASE 5: addToLock negatives
        // ========================================
        logPhase(5, 'addToLock negatives');

        await expectRevert(
            () => lm.addToLock(9999, 0n, deployer.address, ethers.ZeroHash),
            'Z',
            'addToLock(amount = 0)'
        );

        await expectRevert(
            () => lm.addToLock(9999, 1n, deployer.address, ethers.ZeroHash),
            'LOCK_NOT_EXISTS',
            'addToLock on missing lock'
        );

        // ========================================
        // PHASE 6: validateAndUnlock — 'TREG', 'NA', 'COND' (price + broken oracle)
        // ========================================
        logPhase(6, "validateAndUnlock — 'TREG' / 'NA' / 'COND'");

        await expectRevert(
            () => lm.validateAndUnlock(9999, 1n),
            'TREG',
            'validateAndUnlock on missing lock'
        );

        // Duration-0 lock: immediately time-unlockable → the amount bound is reachable
        const timeLockAmount = ethers.parseEther('100');
        const timeLockId = await createDirectLock(lm, {
            token: tokenAddr,
            amount: timeLockAmount,
            lockDuration: 0
        });
        logSuccess(`Time lock #${timeLockId} created (duration 0, 100 TST)`);

        await expectRevert(
            () => lm.validateAndUnlock(timeLockId, timeLockAmount + 1n),
            'NA',
            'validateAndUnlock(amount > availableAmount)'
        );

        // Price lock: 1-year duration, $1000 UPSIDE target while spot is $2
        // → timeOk = false, priceOk = false → 'COND'
        const priceLockId = await createDirectLock(lm, {
            token: tokenAddr,
            amount: ethers.parseEther('50'),
            lockDuration: ONE_YEAR,
            pair: v2pairAddr,
            targetPriceUSD1e18: ethers.parseUnits('1000', 18),
            stablecoinPosition: 2,
            priceDirection: 0 // UPSIDE
        });
        logSuccess(`Price lock #${priceLockId} created ($1000 UPSIDE target, spot $2)`);

        await expectRevert(
            () => lm.validateAndUnlock(priceLockId, 1n),
            'COND',
            'validateAndUnlock: target not reached, time not elapsed'
        );

        // Broken oracle: zero reserves make getPriceUSD revert ('No liquidity');
        // getPriceUSDWithFallback swallows it and returns success=false → priceOk stays
        // false → 'COND'. (LockManager's own catch branch is unreachable defensive code
        // because the fallback wrapper never reverts.)
        await (await v2pair.setReserves(0, 0)).wait();
        await expectRevert(
            () => lm.validateAndUnlock(priceLockId, 1n),
            'COND',
            'validateAndUnlock: oracle failure (broken pair) keeps the lock closed'
        );

        // Restore the pair for the history phase
        await (await v2pair.setReserves(ethers.parseEther('500000'), ethers.parseUnits('1000000', 6))).wait();
        logSuccess('Pair reserves restored');

        // ========================================
        // PHASE 7: unlockVestedAmount — 'NL' / 'NA' bounds ('WD' unreachable)
        // ========================================
        logPhase(7, "unlockVestedAmount — 'NL' / 'NA' bounds");

        await expectRevert(
            () => lm.unlockVestedAmount(9999, 1n),
            'NL',
            'unlockVestedAmount on missing lock'
        );

        const vestLockAmount = ethers.parseEther('50');
        const vestLockId = await createDirectLock(lm, {
            token: tokenAddr,
            amount: vestLockAmount,
            lockDuration: 0
        });

        await expectRevert(
            () => lm.unlockVestedAmount(vestLockId, 0n),
            'NA',
            'unlockVestedAmount(amount = 0)'
        );

        await expectRevert(
            () => lm.unlockVestedAmount(vestLockId, vestLockAmount + 1n),
            'NA',
            'unlockVestedAmount(amount > availableAmount)'
        );

        // Drain fully: withdrawn=true is immediately followed by lock deletion inside
        // _deleteLockIfEmpty, so the 'WD' require can never fire — a later call sees a
        // deleted lock and reverts 'NL'. Asserting that documents the dead branch.
        await (await lm.unlockVestedAmount(vestLockId, vestLockAmount)).wait();
        await expectRevert(
            () => lm.unlockVestedAmount(vestLockId, 1n),
            'NL',
            "unlockVestedAmount on drained lock ('WD' is unreachable dead code)"
        );

        // ========================================
        // PHASE 8: _deleteLockIfEmpty — partial branch (token keeps other locks)
        // ========================================
        logPhase(8, '_deleteLockIfEmpty partial branch');

        const multi = await ERC20Mock.deploy('Multi Lock', 'MLT', deployer.address, ethers.parseEther('1000'), 18);
        await multi.waitForDeployment();
        const multiAddr = await multi.getAddress();

        const lockA = await createDirectLock(lm, { token: multiAddr, amount: ethers.parseEther('60'), lockDuration: 0 });
        const lockB = await createDirectLock(lm, { token: multiAddr, amount: ethers.parseEther('40'), lockDuration: 0 });
        logSuccess(`Two MLT locks created: #${lockA} (60) and #${lockB} (40)`);

        // Empty lock A only
        await (await lm.validateAndUnlock(lockA, ethers.parseEther('60'))).wait();

        const remainingIds = await lm.getTokenLocks(multiAddr);
        assertEqual(BigInt(remainingIds.length), 1n, 'MLT should keep exactly 1 lock id');
        assertEqual(remainingIds[0], lockB, 'Remaining MLT lock id is lock B');

        const lockedAfterPartial = await lm.getLockedTokens();
        assert(lockedAfterPartial.includes(multiAddr), 'MLT must stay in getLockedTokens while lock B lives');
        logSuccess('Token stays tracked after emptying one of its locks');

        const deletedLock = await lm.getLock(lockA);
        assertEqual(deletedLock.basic.token, ethers.ZeroAddress, 'Emptied lock A is deleted from storage');

        // Empty lock B too → token fully untracked (full branch)
        await (await lm.validateAndUnlock(lockB, ethers.parseEther('40'))).wait();
        const lockedAfterFull = await lm.getLockedTokens();
        assert(!lockedAfterFull.includes(multiAddr), 'MLT must leave getLockedTokens once all locks are empty');
        assertEqual(BigInt((await lm.getTokenLocks(multiAddr)).length), 0n, 'MLT lock id list is empty');
        logSuccess('Token untracked after its last lock is emptied');

        // ========================================
        // PHASE 9: getLockHistoryPaginated — copy loop + end>total clamp
        // ========================================
        logPhase(9, 'getLockHistoryPaginated');

        // The price lock recorded a CREATED entry (it has a price pair); addToLock
        // always records a TOKENS_ADDED entry.
        const add1 = ethers.parseEther('5');
        const add2 = ethers.parseEther('7');
        await (await lm.addToLock(priceLockId, add1, deployer.address, ethers.ZeroHash)).wait();
        await (await lm.addToLock(priceLockId, add2, deployer.address, ethers.ZeroHash)).wait();
        assertEqual(await lm.getLockHistoryCount(priceLockId), 3n, 'History count is 3 (CREATED + 2 TOKENS_ADDED)');

        // offset in the middle + limit overshooting → end>total clamp + non-empty copy loop
        const [pageMid, totalMid] = await lm.getLockHistoryPaginated(priceLockId, 1, 10);
        assertEqual(totalMid, 3n, 'Paginated total is 3');
        assertEqual(BigInt(pageMid.length), 2n, 'Clamped page (offset 1, limit 10) has 2 entries');
        assertEqual(pageMid[0].historyType, 1n, 'First paged entry is TOKENS_ADDED');
        assertEqual(pageMid[0].amount, add1, 'First paged entry amount is 5');
        assertEqual(pageMid[1].amount, add2, 'Second paged entry amount is 7');

        // exact window from the start
        const [pageStart] = await lm.getLockHistoryPaginated(priceLockId, 0, 2);
        assertEqual(BigInt(pageStart.length), 2n, 'Page (offset 0, limit 2) has 2 entries');
        assertEqual(pageStart[0].historyType, 0n, 'History[0] is CREATED');

        // offset >= total → empty page, total still reported
        const [pageEmpty, totalEmpty] = await lm.getLockHistoryPaginated(priceLockId, 3, 5);
        assertEqual(BigInt(pageEmpty.length), 0n, 'Page with offset >= total is empty');
        assertEqual(totalEmpty, 3n, 'Total still reported for out-of-range offset');
        logSuccess('Pagination: copy loop, end clamp and out-of-range offset all verified');

        // ========================================
        // PHASE 10: calculateGainLoss overflow requires
        // ========================================
        logPhase(10, 'calculateGainLoss overflow requires');

        // uint256 max ≈ 1.157e77 ; int256 max ≈ 5.789e76 ; reserves are uint112 (max ≈ 5.19e33)
        // but 10**(decimals0 - decimals1) scales prices past int256.max without overflowing uint256.

        // --- 'Price diff overflow': pair 65-dec / 6-dec → adjustment 1e59 ---
        logSection("'Price diff overflow'");
        const tok65 = await ERC20Mock.deploy('Deep Decimals', 'D65', deployer.address, 10n ** 30n, 65);
        await tok65.waitForDeployment();
        const tok65Addr = await tok65.getAddress();
        const pair65 = await MockV2.deploy(tok65Addr, usdcAddr);
        await pair65.waitForDeployment();
        // Creation price = 1e59 * 1e18 / 5e33 = 2e43 → sane avg > 0
        await (await pair65.setReserves(5n * 10n ** 33n, 1n)).wait();
        const lock65 = await createDirectLock(lm, {
            token: tok65Addr,
            amount: 10n ** 6n,
            lockDuration: ONE_YEAR,
            pair: await pair65.getAddress(),
            targetPriceUSD1e18: 10n ** 18n,
            stablecoinPosition: 2,
            priceDirection: 0
        });
        // New price = 1e59 * 1e18 / 1 = 1e77 > int256.max → diff check reverts
        await (await pair65.setReserves(1n, 1n)).wait();
        await expectRevert(
            () => lm.calculateGainLoss(lock65),
            'Price diff overflow',
            'calculateGainLoss with price 1e77 (> int256.max)'
        );

        // --- 'Percentage overflow': pair 33-dec / 18-dec (adjustment 1e15), avg = 1 wei ---
        logSection("'Percentage overflow'");
        const tok33 = await ERC20Mock.deploy('Mid Decimals', 'D33', deployer.address, 10n ** 40n, 33);
        await tok33.waitForDeployment();
        const tok33Addr = await tok33.getAddress();
        const tok18 = await ERC20Mock.deploy('Quote 18', 'Q18', deployer.address, ethers.parseEther('1000'), 18);
        await tok18.waitForDeployment();
        const pair33 = await MockV2.deploy(tok33Addr, await tok18.getAddress());
        await pair33.waitForDeployment();
        // Creation price = 1 * 1e15 * 1e18 / 1e33 = 1 → avg = 1 wei
        await (await pair33.setReserves(10n ** 33n, 1n)).wait();
        const lock33 = await createDirectLock(lm, {
            token: tok33Addr,
            amount: 10n ** 6n,
            lockDuration: ONE_YEAR,
            pair: await pair33.getAddress(),
            targetPriceUSD1e18: 10n ** 18n,
            stablecoinPosition: 2,
            priceDirection: 0
        });
        // New price = 1e24 * 1e15 * 1e18 / 1 = 1e57 → diff OK (< int256.max) but
        // percentage = (1e57-1) * 100 * 1e18 / 1 ≈ 1e77 > int256.max → reverts
        await (await pair33.setReserves(1n, 10n ** 24n)).wait();
        await expectRevert(
            () => lm.calculateGainLoss(lock33),
            'Percentage overflow',
            'calculateGainLoss with avg 1 wei and diff ~1e57'
        );

        // --- 'Gain overflow' / 'Loss overflow': 0-decimals token, totalPurchase 1e60 ---
        logSection("'Gain overflow' / 'Loss overflow'");
        const tok0 = await ERC20Mock.deploy('Zero Decimals', 'D0', deployer.address, 2n * 10n ** 60n, 0);
        await tok0.waitForDeployment();
        const tok0Addr = await tok0.getAddress();
        const pair0 = await MockV2.deploy(tok0Addr, await tok18.getAddress());
        await pair0.waitForDeployment();
        // Price for a 0-dec token vs 18-dec quote = r1 / r0 → creation price 1e18, avg = 1e18
        await (await pair0.setReserves(1n, 10n ** 18n)).wait();
        const lock0 = await createDirectLock(lm, {
            token: tok0Addr,
            amount: 10n ** 60n, // totalPurchaseAmount = 1e60 (0-decimals token)
            lockDuration: ONE_YEAR,
            pair: await pair0.getAddress(),
            targetPriceUSD1e18: 10n ** 18n,
            stablecoinPosition: 2,
            priceDirection: 0
        });
        // Gain: price 1.1e18 → diff 1e17 ; gain = 1e17 * 1e60 / 10**0 = 1e77 > int256.max
        await (await pair0.setReserves(1n, 11n * 10n ** 17n)).wait();
        await expectRevert(
            () => lm.calculateGainLoss(lock0),
            'Gain overflow',
            'calculateGainLoss gain = 1e77 (> int256.max)'
        );
        // Loss: price 0.9e18 → diff 1e17 ; loss = 1e77 > int256.max
        await (await pair0.setReserves(1n, 9n * 10n ** 17n)).wait();
        await expectRevert(
            () => lm.calculateGainLoss(lock0),
            'Loss overflow',
            'calculateGainLoss loss = 1e77 (> int256.max)'
        );

        logSuccess('\n🎉 TEST 50 PASSED: LockManager negative paths fully covered!\n');
        reportTestResult('50-lockmanager-negatives', true);

    } catch (error) {
        reportTestResult('50-lockmanager-negatives', false, error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
