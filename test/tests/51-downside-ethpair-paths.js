/**
 * Test 51: DOWNSIDE Price Direction + isEthPair=true Paths
 *
 * Covers two entire code paths never exercised before:
 *
 * 1. priceDirection == DOWNSIDE:
 *    - createLock with DOWNSIDE + price pair + low target
 *    - price above target => still locked (unlock reverts 'COND')
 *    - price dropped below target => unlock succeeds BEFORE unlockTime
 *    - getLockStatus DOWNSIDE branches: targetReached true/false
 *      + exact priceProgressPercent = (target * 100) / currentUSD
 *    - UPSIDE control lock to assert the comparison difference
 *
 * 2. isEthPair == true:
 *    - token/WETH pair + WETH/stablecoin ethUsdPair (custom WETH registered
 *      in the PriceCalculator constructor so validateEthUsdPair accepts it)
 *    - exact USD price through the ETH intermediate (priceInETH * ethUsd / 1e18)
 *    - getLockStatus + unlock by price condition on the ETH-routed lock
 *    - negative createLock cases: ethUsdPair == 0 ('Z') and non-WETH
 *      ethUsdPair ('Invalid pair')
 *
 * Plus:
 *    - _initializePurchasePrice success=false (zero-reserve pair): lock is
 *      still created, avg purchase price = 0, history written with price 0
 *    - addToLock weighted-average branch (exact weighted average) and the
 *      else branch (first successful price after a broken-oracle creation)
 *    - calculateGainLoss real GAIN (current > avg) and real LOSS (current < avg)
 *    - getLockHistory non-empty (CREATED + TOKENS_ADDED entries)
 *
 * Uses a fresh contract stack (same pattern as test 38) so the custom WETH
 * can be registered at PriceCalculator construction time.
 */

import {
    getWallet,
    logPhase,
    logSection,
    logSuccess,
    log,
    assert,
    assertEqual,
    reportTestResult,
    getCurrentTimestamp,
    ONE_MONTH,
    PRICE_DIRECTION,
    signLockerOp,
    getEthers
} from '../core/utils.js';

const ethers = getEthers();

const THRESHOLD = 3;

// ============================================================================
// HELPERS
// ============================================================================

function baseLockParams(overrides = {}) {
    return {
        token: ethers.ZeroAddress,
        amount: 0n,
        lockDuration: ONE_MONTH,
        pair: ethers.ZeroAddress,
        ethUsdPair: ethers.ZeroAddress,
        targetPriceUSD1e18: 0n,
        isEthPair: false,
        stablecoinPosition: 2,
        priceDirection: PRICE_DIRECTION.UPSIDE,
        vestingTokensPerPeriod: 0,
        vestingPeriodSeconds: 0,
        vestingAccumulate: false,
        ...overrides
    };
}

async function createLockAndGetId(locker, lockManager, signer, params) {
    const nextId = await lockManager.nextLockId();
    const tx = await locker.connect(signer).createLock(params);
    await tx.wait();
    return nextId;
}

async function signUnlock(locker, lockId, to, amount, signerAddresses) {
    const nonce = await locker.unlockNonce(lockId);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const domain = {
        name: 'LockerContract',
        version: '1',
        chainId: Number(chainId),
        verifyingContract: await locker.getAddress()
    };
    // Sign the decoded Unlock struct (M-1): its hashStruct equals the on-chain opKey.
    const message = { lockId, to, amount, nonce };

    const signatures = [];
    const usedSigners = [];
    for (let i = 0; i < THRESHOLD; i++) {
        const wallet = await ethers.getSigner(signerAddresses[i]);
        signatures.push(await signLockerOp(wallet, domain, 'Unlock', message));
        usedSigners.push(signerAddresses[i]);
    }
    return { usedSigners, signatures };
}

async function expectRevert(promise, expectedFragment, label) {
    try {
        await promise;
    } catch (e) {
        assert(
            e.message.includes(expectedFragment),
            `${label}: expected revert '${expectedFragment}' but got: ${e.message}`
        );
        logSuccess(`${label}: reverted with '${expectedFragment}' as expected`);
        return;
    }
    throw new Error(`${label}: should have reverted with '${expectedFragment}'`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    log('\n🧪 TEST 51: DOWNSIDE + isEthPair=true PATHS\n', '\x1b[1m\x1b[36m');

    try {
        const deployer = await getWallet(0);
        const recipient = await getWallet(7);

        // ------------------------------------------------------------------
        // PHASE 0: Fresh stack (custom WETH registered in PriceCalculator)
        // ------------------------------------------------------------------
        logPhase(0, 'Deploy fresh stack with custom WETH');

        const signerAddresses = [];
        for (let i = 0; i < 5; i++) {
            signerAddresses.push((await getWallet(i)).address);
        }

        const ERC20Mock = await ethers.getContractFactory('ERC20Mock', deployer);
        const weth = await ERC20Mock.deploy('Wrapped ETH', 'WETH', deployer.address, ethers.parseEther('1000000'), 18);
        await weth.waitForDeployment();
        const wethAddr = await weth.getAddress();

        // Custom WETH list is immutable, set at construction only
        const PC = await ethers.getContractFactory('PriceCalculator', deployer);
        const priceCalc = await PC.deploy(ethers.ZeroAddress, [wethAddr]);
        await priceCalc.waitForDeployment();

        const VH = await ethers.getContractFactory('ValidationHandler', deployer);
        const vh = await VH.deploy(THRESHOLD);
        await vh.waitForDeployment();

        const LM = await ethers.getContractFactory('LockManager', deployer);
        const lockManager = await LM.deploy(await priceCalc.getAddress());
        await lockManager.waitForDeployment();

        const VMgr = await ethers.getContractFactory('VestingManager', deployer);
        const vmgr = await VMgr.deploy(await lockManager.getAddress());
        await vmgr.waitForDeployment();

        const SM = await ethers.getContractFactory('SignerManager', deployer);
        const sm = await SM.deploy(await vh.getAddress(), signerAddresses, THRESHOLD);
        await sm.waitForDeployment();

        const LC = await ethers.getContractFactory('LockerContract', deployer);
        const locker = await LC.deploy(
            await vh.getAddress(),
            await lockManager.getAddress(),
            await sm.getAddress(),
            await vmgr.getAddress(),
            signerAddresses,
            THRESHOLD
        );
        await locker.waitForDeployment();
        const lockerAddress = await locker.getAddress();

        // Test tokens (18 decimals everywhere so MockUniswapV2Pair.setPriceForToken
        // — which assumes equal decimals — yields EXACT 1e18 prices)
        const tst = await ERC20Mock.deploy('Test Token', 'TST', deployer.address, ethers.parseEther('1000000'), 18);
        await tst.waitForDeployment();
        const tstAddr = await tst.getAddress();

        const stab = await ERC20Mock.deploy('Mock USD 18', 'MUSD', deployer.address, ethers.parseEther('1000000'), 18);
        await stab.waitForDeployment();
        const stabAddr = await stab.getAddress();

        const tkn2 = await ERC20Mock.deploy('Eth Routed Token', 'ERT', deployer.address, ethers.parseEther('1000000'), 18);
        await tkn2.waitForDeployment();
        const tkn2Addr = await tkn2.getAddress();

        // Main price pair: TST/MUSD (token0 = TST, token1 = stable => stablecoinPosition 2)
        const MockV2 = await ethers.getContractFactory('MockUniswapV2Pair', deployer);
        const pairA = await MockV2.deploy(tstAddr, stabAddr);
        await pairA.waitForDeployment();
        const pairAAddr = await pairA.getAddress();

        // One big approval for all createLock/addToLock calls in this test
        await (await tst.connect(deployer).approve(lockerAddress, ethers.parseEther('1000000'))).wait();
        await (await tkn2.connect(deployer).approve(lockerAddress, ethers.parseEther('1000000'))).wait();

        logSuccess('Fresh stack + mocks deployed');

        // ------------------------------------------------------------------
        // PHASE 1: DOWNSIDE lock full lifecycle
        // ------------------------------------------------------------------
        logPhase(1, 'DOWNSIDE lock: locked above target, unlocks below target before unlockTime');

        // Current price $8, DOWNSIDE target $2
        await (await pairA.setPriceForToken(tstAddr, ethers.parseUnits('8', 18))).wait();

        const downAmount = ethers.parseEther('1000');
        const downTarget = ethers.parseUnits('2', 18);
        const downLockId = await createLockAndGetId(locker, lockManager, deployer, baseLockParams({
            token: tstAddr,
            amount: downAmount,
            lockDuration: ONE_MONTH,
            pair: pairAAddr,
            targetPriceUSD1e18: downTarget,
            stablecoinPosition: 2,
            priceDirection: PRICE_DIRECTION.DOWNSIDE
        }));
        log(`  DOWNSIDE lock ID: ${downLockId}`);

        const downLock = await locker.locks(downLockId);
        assertEqual(downLock.pricing.priceDirection, 1n, 'priceDirection stored as DOWNSIDE (1)');
        assertEqual(downLock.pricing.targetPriceUSD1e18, downTarget, 'Target price stored');
        // _initializePurchasePrice success=true path: entry price captured at $8
        assertEqual(downLock.pricing.averagePurchasePriceUSD1e18, ethers.parseUnits('8', 18), 'Initial purchase price = $8');
        assertEqual(downLock.pricing.totalPurchaseAmount, downAmount, 'totalPurchaseAmount = lock amount');

        logSection('getLockStatus with price ($8) ABOVE DOWNSIDE target ($2) => targetReached=false');
        let status = await locker.getLockStatus(downLockId);
        assertEqual(status.timeOk, false, 'timeOk false (1 month lock)');
        assertEqual(status.priceOk, false, 'priceOk false: $8 > $2 target on DOWNSIDE');
        // DOWNSIDE not reached: progress = (target * 100) / currentUSD = (2e18*100)/8e18 = 25
        assertEqual(status.priceProgressPercent, 25n, 'DOWNSIDE progress = (2*100)/8 = 25');

        logSection('Unlock attempt while price above target => COND');
        const unlockAmount1 = ethers.parseEther('400');
        let sig = await signUnlock(locker, downLockId, recipient.address, unlockAmount1, signerAddresses);
        await expectRevert(
            locker.connect(deployer).executeUnlockWithSignatures(
                downLockId, recipient.address, unlockAmount1, sig.usedSigners, sig.signatures
            ),
            'COND',
            'DOWNSIDE unlock with price above target'
        );

        logSection('Boundary: price EXACTLY at target ($2) => targetReached=true (<=)');
        await (await pairA.setPriceForToken(tstAddr, downTarget)).wait();
        status = await locker.getLockStatus(downLockId);
        assertEqual(status.priceOk, true, 'priceOk true at exact target (currentUSD <= target)');
        assertEqual(status.priceProgressPercent, 100n, 'progress = 100 when target reached');

        logSection('Price dropped BELOW target ($1.5) => unlock succeeds BEFORE unlockTime');
        await (await pairA.setPriceForToken(tstAddr, ethers.parseUnits('1.5', 18))).wait();
        status = await locker.getLockStatus(downLockId);
        assertEqual(status.priceOk, true, 'priceOk true: $1.5 <= $2 target');
        assertEqual(status.timeOk, false, 'timeOk still false');

        const now = await getCurrentTimestamp();
        assert(BigInt(now) < downLock.basic.unlockTime, 'Unlocking strictly before unlockTime');

        const balBefore = await tst.balanceOf(recipient.address);
        sig = await signUnlock(locker, downLockId, recipient.address, unlockAmount1, signerAddresses);
        await (await locker.connect(deployer).executeUnlockWithSignatures(
            downLockId, recipient.address, unlockAmount1, sig.usedSigners, sig.signatures
        )).wait();
        const balAfter = await tst.balanceOf(recipient.address);
        assertEqual(balAfter - balBefore, unlockAmount1, 'Recipient received 400 TST via DOWNSIDE price condition');

        const downLockAfter = await locker.locks(downLockId);
        assertEqual(downLockAfter.basic.availableAmount, ethers.parseEther('600'), 'availableAmount = 600 after partial unlock');
        logSuccess('DOWNSIDE lifecycle verified (COND above target, unlock below target before unlockTime)');

        // ------------------------------------------------------------------
        // PHASE 2: UPSIDE control lock — inverse comparison at same price/target
        // ------------------------------------------------------------------
        logPhase(2, 'UPSIDE control: same target, same price, inverted result');

        // Price is currently $1.5, target $2 for both locks
        const upLockId = await createLockAndGetId(locker, lockManager, deployer, baseLockParams({
            token: tstAddr,
            amount: ethers.parseEther('100'),
            lockDuration: ONE_MONTH,
            pair: pairAAddr,
            targetPriceUSD1e18: downTarget,
            stablecoinPosition: 2,
            priceDirection: PRICE_DIRECTION.UPSIDE
        }));
        log(`  UPSIDE control lock ID: ${upLockId}`);

        logSection('At $1.5 with $2 target: UPSIDE not reached, DOWNSIDE reached');
        const upStatus1 = await locker.getLockStatus(upLockId);
        const downStatus1 = await locker.getLockStatus(downLockId);
        assertEqual(upStatus1.priceOk, false, 'UPSIDE priceOk false ($1.5 < $2)');
        // UPSIDE not reached: progress = (current * 100) / target = (1.5e18*100)/2e18 = 75
        assertEqual(upStatus1.priceProgressPercent, 75n, 'UPSIDE progress = (1.5*100)/2 = 75');
        assertEqual(downStatus1.priceOk, true, 'DOWNSIDE priceOk true ($1.5 <= $2)');

        logSection('At $3 with $2 target: UPSIDE reached, DOWNSIDE not reached');
        await (await pairA.setPriceForToken(tstAddr, ethers.parseUnits('3', 18))).wait();
        const upStatus2 = await locker.getLockStatus(upLockId);
        const downStatus2 = await locker.getLockStatus(downLockId);
        assertEqual(upStatus2.priceOk, true, 'UPSIDE priceOk true ($3 >= $2)');
        assertEqual(upStatus2.priceProgressPercent, 100n, 'UPSIDE progress = 100');
        assertEqual(downStatus2.priceOk, false, 'DOWNSIDE priceOk false ($3 > $2)');
        // DOWNSIDE not reached: (2e18*100)/3e18 = 66 (integer division)
        assertEqual(downStatus2.priceProgressPercent, 66n, 'DOWNSIDE progress = floor(200/3) = 66');
        logSuccess('UPSIDE vs DOWNSIDE comparison difference verified');

        // ------------------------------------------------------------------
        // PHASE 3: calculateGainLoss — real GAIN and real LOSS branches
        // ------------------------------------------------------------------
        logPhase(3, 'calculateGainLoss: non-zero GAIN and LOSS');

        // Entry at $2 for exact math
        await (await pairA.setPriceForToken(tstAddr, ethers.parseUnits('2', 18))).wait();
        const glAmount = ethers.parseEther('1000');
        const glLockId = await createLockAndGetId(locker, lockManager, deployer, baseLockParams({
            token: tstAddr,
            amount: glAmount,
            lockDuration: ONE_MONTH,
            pair: pairAAddr,
            targetPriceUSD1e18: ethers.parseUnits('1000', 18),
            stablecoinPosition: 2,
            priceDirection: PRICE_DIRECTION.UPSIDE
        }));
        log(`  GainLoss lock ID: ${glLockId} (entry $2, 1000 TST)`);

        const [avg0, total0] = await lockManager.getAveragePurchasePrice(glLockId);
        assertEqual(avg0, ethers.parseUnits('2', 18), 'Average purchase price = $2');
        assertEqual(total0, glAmount, 'totalPurchaseAmount = 1000');

        logSection('GAIN: price $6 vs avg $2');
        await (await pairA.setPriceForToken(tstAddr, ethers.parseUnits('6', 18))).wait();
        let [glOk, cur, avg, diff, pct, totalGain] = await lockManager.calculateGainLoss(glLockId);
        assertEqual(glOk, true, 'calculateGainLoss success');
        assertEqual(cur, ethers.parseUnits('6', 18), 'currentPriceUSD = $6');
        assertEqual(avg, ethers.parseUnits('2', 18), 'averagePurchasePrice = $2');
        assertEqual(diff, ethers.parseUnits('4', 18), 'priceDifference = +$4');
        // (4e18 * 100 * 1e18) / 2e18 = 200e18 => +200%
        assertEqual(pct, ethers.parseUnits('200', 18), 'percentageGain = +200% (1e18 scaled)');
        // (4e18 * 1000e18) / 1e18 = 4000e18
        assertEqual(totalGain, ethers.parseUnits('4000', 18), 'totalGainUSD = +$4000');

        logSection('LOSS: price $0.5 vs avg $2');
        await (await pairA.setPriceForToken(tstAddr, ethers.parseUnits('0.5', 18))).wait();
        [glOk, cur, avg, diff, pct, totalGain] = await lockManager.calculateGainLoss(glLockId);
        assertEqual(glOk, true, 'calculateGainLoss success');
        assertEqual(cur, ethers.parseUnits('0.5', 18), 'currentPriceUSD = $0.5');
        assertEqual(diff, -ethers.parseUnits('1.5', 18), 'priceDifference = -$1.5');
        // -(1.5e18 * 100 * 1e18) / 2e18 = -75e18 => -75%
        assertEqual(pct, -ethers.parseUnits('75', 18), 'percentageGain = -75% (1e18 scaled)');
        // -(1.5e18 * 1000e18) / 1e18 = -1500e18
        assertEqual(totalGain, -ethers.parseUnits('1500', 18), 'totalGainUSD = -$1500');
        logSuccess('GAIN and LOSS branches verified with exact values');

        // ------------------------------------------------------------------
        // PHASE 4: addToLock weighted average branch (uniswapPair != 0)
        // ------------------------------------------------------------------
        logPhase(4, 'addToLock: weighted average purchase price');

        // 1000 @ $2 already locked; add 3000 @ $4
        // avg = (2e18*1000e18 + 4e18*3000e18) / 4000e18 = 3.5e18
        await (await pairA.setPriceForToken(tstAddr, ethers.parseUnits('4', 18))).wait();
        const addAmount = ethers.parseEther('3000');
        await (await locker.connect(deployer).addToLock(glLockId, addAmount, ethers.ZeroHash)).wait();

        const [avgW, totalW] = await lockManager.getAveragePurchasePrice(glLockId);
        assertEqual(avgW, ethers.parseUnits('3.5', 18), 'Weighted average = (2*1000 + 4*3000)/4000 = $3.5');
        assertEqual(totalW, ethers.parseEther('4000'), 'totalPurchaseAmount = 4000');

        const glLockAfterAdd = await locker.locks(glLockId);
        assertEqual(glLockAfterAdd.basic.availableAmount, ethers.parseEther('4000'), 'availableAmount = 4000 after top-up');
        logSuccess('Weighted average purchase price verified exactly');

        // ------------------------------------------------------------------
        // PHASE 5: getLockHistory non-empty (CREATED + TOKENS_ADDED)
        // ------------------------------------------------------------------
        logPhase(5, 'getLockHistory: non-empty history for price-pair lock');

        const history = await lockManager.getLockHistory(glLockId);
        assertEqual(BigInt(history.length), 2n, 'History has 2 entries');
        assertEqual(await lockManager.getLockHistoryCount(glLockId), 2n, 'getLockHistoryCount = 2');

        assertEqual(history[0].historyType, 0n, 'Entry 0 type = CREATED');
        assertEqual(history[0].token, tstAddr, 'Entry 0 token');
        assertEqual(history[0].amount, glAmount, 'Entry 0 amount = 1000');
        assertEqual(history[0].purchasePriceUSD1e18, ethers.parseUnits('2', 18), 'Entry 0 purchase price = $2');
        assertEqual(history[0].uniswapPair, pairAAddr, 'Entry 0 pair address');
        assertEqual(history[0].isEthPair, false, 'Entry 0 isEthPair = false');

        assertEqual(history[1].historyType, 1n, 'Entry 1 type = TOKENS_ADDED');
        assertEqual(history[1].amount, addAmount, 'Entry 1 amount = 3000');
        assertEqual(history[1].purchasePriceUSD1e18, ethers.parseUnits('4', 18), 'Entry 1 purchase price = $4');
        assertEqual(history[1].payer, deployer.address, 'Entry 1 payer = deployer');
        logSuccess('Lock history entries verified');

        // ------------------------------------------------------------------
        // PHASE 6: _initializePurchasePrice success=false (broken oracle)
        // ------------------------------------------------------------------
        logPhase(6, 'Broken oracle at creation: lock created with no purchase price');

        // Fresh pair with ZERO reserves: V2 read reverts 'No liquidity',
        // V3 fallback reverts (no slot0) => getPriceUSDWithFallback = (false, 0)
        const brokenPair = await MockV2.deploy(tstAddr, stabAddr);
        await brokenPair.waitForDeployment();
        const brokenPairAddr = await brokenPair.getAddress();

        const [okBroken, priceBroken] = await priceCalc.getPriceUSDWithFallback(
            brokenPairAddr, tstAddr, ethers.ZeroAddress, false, 2
        );
        assertEqual(okBroken, false, 'Oracle read fails on zero-reserve pair');
        assertEqual(priceBroken, 0n, 'Fallback price = 0');

        const brokenAmount = ethers.parseEther('500');
        const brokenLockId = await createLockAndGetId(locker, lockManager, deployer, baseLockParams({
            token: tstAddr,
            amount: brokenAmount,
            lockDuration: ONE_MONTH,
            pair: brokenPairAddr,
            targetPriceUSD1e18: ethers.parseUnits('5', 18),
            stablecoinPosition: 2,
            priceDirection: PRICE_DIRECTION.UPSIDE
        }));
        log(`  Broken-oracle lock ID: ${brokenLockId}`);

        const brokenLock = await locker.locks(brokenLockId);
        assertEqual(brokenLock.basic.availableAmount, brokenAmount, 'Lock created anyway (amount stored)');
        assertEqual(brokenLock.pricing.averagePurchasePriceUSD1e18, 0n, 'averagePurchasePrice = 0 (success=false)');
        assertEqual(brokenLock.pricing.totalPurchaseAmount, 0n, 'totalPurchaseAmount = 0 (success=false)');

        // History IS written for price-pair locks, with purchase price 0
        const brokenHistory = await lockManager.getLockHistory(brokenLockId);
        assertEqual(BigInt(brokenHistory.length), 1n, 'Broken-oracle lock has CREATED history entry');
        assertEqual(brokenHistory[0].purchasePriceUSD1e18, 0n, 'CREATED entry price = 0');

        // calculateGainLoss short-circuits: averagePurchasePriceUSD1e18 == 0
        const glBroken = await lockManager.calculateGainLoss(brokenLockId);
        assertEqual(glBroken[0], false, 'calculateGainLoss success=false when avg purchase price = 0');

        // getLockStatus: oracle success=false => priceOk false, progress 0
        const brokenStatus = await locker.getLockStatus(brokenLockId);
        assertEqual(brokenStatus.priceOk, false, 'priceOk false with broken oracle');
        assertEqual(brokenStatus.priceProgressPercent, 0n, 'priceProgressPercent = 0 with broken oracle');

        logSection('addToLock else-branch: first successful price after broken creation');
        // Fix the pair: oracle now works at $3. totalPurchaseAmount==0 => avg takes current price
        await (await brokenPair.setPriceForToken(tstAddr, ethers.parseUnits('3', 18))).wait();
        await (await locker.connect(deployer).addToLock(brokenLockId, ethers.parseEther('500'), ethers.ZeroHash)).wait();
        const [avgFixed, totalFixed] = await lockManager.getAveragePurchasePrice(brokenLockId);
        assertEqual(avgFixed, ethers.parseUnits('3', 18), 'avg = current price ($3) when no prior purchase data');
        assertEqual(totalFixed, ethers.parseEther('500'), 'totalPurchaseAmount = top-up amount only');
        logSuccess('Broken-oracle creation + recovery verified');

        // ------------------------------------------------------------------
        // PHASE 7: isEthPair == true, full path
        // ------------------------------------------------------------------
        logPhase(7, 'isEthPair=true: ETH-routed pricing, status and price unlock');

        // token/WETH pair: 1 ERT = 0.05 WETH
        const ethPair = await MockV2.deploy(tkn2Addr, wethAddr);
        await ethPair.waitForDeployment();
        const ethPairAddr = await ethPair.getAddress();
        await (await ethPair.setPriceForToken(tkn2Addr, ethers.parseUnits('0.05', 18))).wait();

        // WETH/stable pair: 1 WETH = 2000 MUSD
        const wethUsdPair = await MockV2.deploy(wethAddr, stabAddr);
        await wethUsdPair.waitForDeployment();
        const wethUsdPairAddr = await wethUsdPair.getAddress();
        await (await wethUsdPair.setPriceForToken(wethAddr, ethers.parseUnits('2000', 18))).wait();

        logSection('Exact USD price via ETH intermediate: 0.05 * 2000 = $100');
        const [ethOk, ethUsdPrice] = await priceCalc.getPriceUSDWithFallback(
            ethPairAddr, tkn2Addr, wethUsdPairAddr, true, 0
        );
        assertEqual(ethOk, true, 'ETH-routed price calculation succeeds');
        assertEqual(ethUsdPrice, ethers.parseUnits('100', 18), 'USD price = (0.05e18 * 2000e18) / 1e18 = $100');

        const [lmOk, lmPrice] = await lockManager.calculatePriceUSD(tkn2Addr, ethPairAddr, wethUsdPairAddr, true, 0);
        assertEqual(lmOk, true, 'LockManager.calculatePriceUSD succeeds');
        assertEqual(lmPrice, ethers.parseUnits('100', 18), 'LockManager reports the same $100');

        logSection('Negative createLock cases for isEthPair=true');
        await expectRevert(
            locker.connect(deployer).createLock(baseLockParams({
                token: tkn2Addr,
                amount: ethers.parseEther('10'),
                pair: ethPairAddr,
                ethUsdPair: ethers.ZeroAddress,
                targetPriceUSD1e18: ethers.parseUnits('200', 18),
                isEthPair: true,
                stablecoinPosition: 0
            })),
            'Z',
            'isEthPair=true with ethUsdPair=0'
        );
        await expectRevert(
            locker.connect(deployer).createLock(baseLockParams({
                token: tkn2Addr,
                amount: ethers.parseEther('10'),
                pair: ethPairAddr,
                ethUsdPair: pairAAddr, // TST/MUSD pair: contains no WETH
                targetPriceUSD1e18: ethers.parseUnits('200', 18),
                isEthPair: true,
                stablecoinPosition: 0
            })),
            'Invalid pair',
            'isEthPair=true with non-WETH ethUsdPair (validateEthUsdPair)'
        );

        logSection('Create ETH-routed lock (target $200, UPSIDE, stablecoinPosition=0 allowed)');
        const ethAmount = ethers.parseEther('2000');
        const ethLockId = await createLockAndGetId(locker, lockManager, deployer, baseLockParams({
            token: tkn2Addr,
            amount: ethAmount,
            lockDuration: ONE_MONTH,
            pair: ethPairAddr,
            ethUsdPair: wethUsdPairAddr,
            targetPriceUSD1e18: ethers.parseUnits('200', 18),
            isEthPair: true,
            stablecoinPosition: 0, // STABLECOIN_REQ is skipped when isEthPair=true
            priceDirection: PRICE_DIRECTION.UPSIDE
        }));
        log(`  ETH-routed lock ID: ${ethLockId}`);

        const ethLock = await locker.locks(ethLockId);
        assertEqual(ethLock.pricing.isEthPair, true, 'isEthPair stored true');
        assertEqual(ethLock.pricing.ethUsdPair, wethUsdPairAddr, 'ethUsdPair stored');
        assertEqual(ethLock.pricing.uniswapPair, ethPairAddr, 'uniswapPair stored');
        assertEqual(ethLock.pricing.averagePurchasePriceUSD1e18, ethers.parseUnits('100', 18), 'Entry price captured through ETH route = $100');
        assertEqual(ethLock.pricing.totalPurchaseAmount, ethAmount, 'totalPurchaseAmount = 2000');

        logSection('getLockStatus at $100 vs $200 target');
        let ethStatus = await locker.getLockStatus(ethLockId);
        assertEqual(ethStatus.timeOk, false, 'timeOk false');
        assertEqual(ethStatus.priceOk, false, 'priceOk false ($100 < $200)');
        assertEqual(ethStatus.priceProgressPercent, 50n, 'UPSIDE progress = (100*100)/200 = 50');

        logSection('Unlock attempt below target => COND (ETH-routed oracle consulted)');
        const ethUnlockAmount = ethers.parseEther('500');
        sig = await signUnlock(locker, ethLockId, recipient.address, ethUnlockAmount, signerAddresses);
        await expectRevert(
            locker.connect(deployer).executeUnlockWithSignatures(
                ethLockId, recipient.address, ethUnlockAmount, sig.usedSigners, sig.signatures
            ),
            'COND',
            'ETH-routed unlock below target'
        );

        logSection('Raise ERT/WETH to 0.15 => $300 >= $200: unlock by price before unlockTime');
        await (await ethPair.setPriceForToken(tkn2Addr, ethers.parseUnits('0.15', 18))).wait();

        const [, newEthUsd] = await priceCalc.getPriceUSDWithFallback(ethPairAddr, tkn2Addr, wethUsdPairAddr, true, 0);
        assertEqual(newEthUsd, ethers.parseUnits('300', 18), 'New ETH-routed price = $300');

        ethStatus = await locker.getLockStatus(ethLockId);
        assertEqual(ethStatus.priceOk, true, 'priceOk true ($300 >= $200)');
        assertEqual(ethStatus.priceProgressPercent, 100n, 'progress = 100');
        assertEqual(ethStatus.timeOk, false, 'timeOk still false');

        const nowEth = await getCurrentTimestamp();
        assert(BigInt(nowEth) < ethLock.basic.unlockTime, 'Still before unlockTime');

        const ertBalBefore = await tkn2.balanceOf(recipient.address);
        sig = await signUnlock(locker, ethLockId, recipient.address, ethUnlockAmount, signerAddresses);
        await (await locker.connect(deployer).executeUnlockWithSignatures(
            ethLockId, recipient.address, ethUnlockAmount, sig.usedSigners, sig.signatures
        )).wait();
        const ertBalAfter = await tkn2.balanceOf(recipient.address);
        assertEqual(ertBalAfter - ertBalBefore, ethUnlockAmount, 'Recipient received 500 ERT via ETH-routed price condition');

        logSection('ETH-routed lock history is non-empty with isEthPair=true');
        const ethHistory = await lockManager.getLockHistory(ethLockId);
        assertEqual(BigInt(ethHistory.length), 1n, 'ETH-routed lock has CREATED entry');
        assertEqual(ethHistory[0].isEthPair, true, 'History entry isEthPair = true');
        assertEqual(ethHistory[0].ethUsdPair, wethUsdPairAddr, 'History entry ethUsdPair');
        assertEqual(ethHistory[0].purchasePriceUSD1e18, ethers.parseUnits('100', 18), 'History entry purchase price = $100');
        logSuccess('isEthPair=true full path verified');

        reportTestResult('51-downside-ethpair-paths', true);
        logSuccess('\n✅ TEST 51 PASSED!\n');

    } catch (error) {
        reportTestResult('51-downside-ethpair-paths', false, error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
