/**
 * Test 54: VestingManager — Negative paths & branch coverage
 *
 * Direct-module coverage of VestingManager guards that the signature-flow test
 * (18-vesting-unlock-sig.js) cannot reach, plus the calculateVestedAmount
 * branches asserted at view level.
 *
 * Vesting is token-denominated (tokens-per-period, no USD conversion, no
 * stablecoin logic) — every expected revert string below was read from the
 * CURRENT contracts/VestingManager.sol.
 *
 * SCENARIO 1 — onlyLocker on the deployed (shared) VestingManager
 *   1.1 initializeVesting from a non-locker EOA reverts 'Not authorized'
 *   1.2 unlockVested from a non-locker EOA (even the deployer) reverts 'Not authorized'
 *
 * SCENARIO 2 — constructor & setLocker (fresh instances)
 *   2.1 constructor(address(0)) reverts 'Zero address' (single-param constructor)
 *   2.2 setLocker by a non-deployer (tx.origin != deployer) reverts 'Only deployer'
 *   2.3 setLocker(address(0)) by the deployer reverts 'Already set or zero'
 *   2.4 setLocker succeeds once; a second call reverts 'Already set or zero'
 *
 * SCENARIO 3 — initializeVesting guards (fresh module wired to an EOA locker)
 *   3.1 periodDuration=0 with tokensPerPeriod>0 reverts 'Invalid period duration'
 *   3.2 nonexistent lockId reverts 'No lock found'
 *   3.3 tokensPerPeriod=0 is a silent no-op (config stays disabled)
 *   3.4 config asserted via getVestingConfig; re-init reverts 'Vesting already initialized'
 *
 * SCENARIO 4 — unlockVested guards (fresh module wired to an EOA locker)
 *   4.1 no vesting config reverts 'Vesting not enabled' (real & nonexistent lock)
 *   4.2 period not elapsed (amountTokens==0) reverts 'VESTING_NOT_AVAILABLE'
 *   4.3 lock conditions met (timeOk) reverts 'USE_REGULAR_UNLOCK' even though
 *       a vested amount is claimable (require(!timeOk && !priceOk))
 *
 * SCENARIO 5 — calculateVestedAmount branches + getVestingConfig (real path)
 *   5.1 vesting disabled (non-vesting lock / nonexistent lock) returns 0
 *   5.2 getVestingConfig fields after a real createLock init; elapsedPeriods==0 returns 0
 *   5.3 accumulate=true: amount proportional to elapsed periods (3 × tokensPerPeriod)
 *   5.4 accumulate=false: single period's worth despite several elapsed periods
 *   5.5 amount capped at the lock's availableAmount
 *   5.6 overflow-safe branch: elapsedPeriods > available/tokensPerPeriod → available
 *
 * NOT DUPLICATED HERE — already covered by test 18:
 *   - on-chain vestingNonce replay via unlockVestedWithSignatures (18 / E2)
 *   - signed-cap ('Amount exceeds signed cap') and 'Invalid max amount' (18 / E4, F2)
 *   - createLock-level 'Invalid period duration' (18 / F2)
 * OBSOLETE (pre-refactor audit items that no longer exist in the code):
 *   - USD-per-period / stablecoin conversion paths — vesting is now 1:1 tokens-per-period
 *   - two-param constructor — current constructor takes only _lockManager
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
    assert,
    reportTestResult,
    PRICE_DIRECTION,
    advanceTime,
    getEthers
} from '../core/utils.js';

const ethers = getEthers();

// ─── Helpers ────────────────────────────────────────────────────────────────

// Decodes ABI-encoded Error(string) revert data (0x08c379a0…). With viaIR the
// hardhat node sometimes reports "couldn't infer the reason" even though the
// reason string is present in the returned revert data.
function decodeErrorString(data) {
    if (typeof data !== 'string' || !data.startsWith('0x08c379a0')) return null;
    try {
        return ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10))[0];
    } catch {
        return null;
    }
}

// Flattens every message/reason/revert-data field of an ethers v6 / hardhat
// error chain so revert strings can be matched regardless of which layer
// surfaced them. The revert payload can be nested at different depths
// depending on the RPC transport, so the whole error is also serialized and
// swept for Error(string) hex blobs.
function revertTextOf(error) {
    const parts = [];
    let current = error;
    for (let depth = 0; current && depth < 6; depth++) {
        if (typeof current.message === 'string') parts.push(current.message);
        if (typeof current.reason === 'string') parts.push(current.reason);
        if (typeof current.shortMessage === 'string') parts.push(current.shortMessage);
        current = current.error || current.cause;
    }

    let json = '';
    try {
        const seen = new WeakSet();
        json = JSON.stringify(error, (key, value) => {
            if (typeof value === 'bigint') return value.toString();
            if (typeof value === 'object' && value !== null) {
                if (seen.has(value)) return undefined;
                seen.add(value);
            }
            return value;
        });
    } catch { /* unserializable error — the message chain above still applies */ }
    parts.push(json);
    for (const blob of json.match(/0x08c379a0[0-9a-fA-F]+/g) || []) {
        const decoded = decodeErrorString(blob);
        if (decoded) parts.push(decoded);
    }
    return parts.join(' | ');
}

// Runs fn() and requires it to revert with the EXACT reason string from the
// current contract code (substring match over the flattened error chain).
async function expectRevert(fn, reason, label) {
    let failure = null;
    try {
        const res = await fn();
        if (res && typeof res.wait === 'function') await res.wait();
        failure = `expected revert '${reason}' but the call succeeded`;
    } catch (e) {
        const text = revertTextOf(e);
        if (text.includes(reason)) {
            logSuccess(`${label}: reverted with '${reason}'`);
            return;
        }
        failure = `wrong revert reason — expected '${reason}', got: ${text.split('\n')[0]}`;
    }
    throw new Error(`${label}: ${failure}`);
}

// Creates a real lock through the LockerContract (vestingTokens=0n → no vesting).
// Returns the lockId and the creation receipt (for lastWithdrawalTime asserts).
async function createRealLock(locker, lockManager, tokenContract, creator, params) {
    const { token, amount, lockDuration, vestingTokens, vestingPeriod, accumulate } = params;

    await (await tokenContract.connect(creator).approve(await locker.getAddress(), amount)).wait();
    const lockId = await lockManager.nextLockId();

    const tx = await locker.connect(creator).createLock({
        token: token,
        amount: amount,
        lockDuration: lockDuration ?? 100000,
        pair: ethers.ZeroAddress,
        ethUsdPair: ethers.ZeroAddress,
        targetPriceUSD1e18: 0n,
        isEthPair: false,
        stablecoinPosition: 2,
        priceDirection: PRICE_DIRECTION.UPSIDE,
        vestingTokensPerPeriod: vestingTokens ?? 0n,
        vestingPeriodSeconds: vestingPeriod ?? 0,
        vestingAccumulate: accumulate ?? false
    });
    const receipt = await tx.wait();

    log(`  Created lock #${lockId} (duration=${lockDuration ?? 100000}s, vestingTokens=${ethers.formatEther(vestingTokens ?? 0n)}/period)`);
    return { lockId, receipt };
}

async function blockTimestampOf(receipt) {
    const block = await ethers.provider.getBlock(receipt.blockNumber);
    return BigInt(block.timestamp);
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
    log('\n🧪 TEST 54: VESTING MANAGER — NEGATIVE PATHS & BRANCH COVERAGE\n', '\x1b[1m\x1b[36m');

    const state = loadSharedState();
    const deployer = await getWallet(0);   // EOA that ran 00-setup (tx.origin of module deploys)
    const outsider = await getWallet(1);
    const stranger = await getWallet(9);   // never a module locker

    const locker = await getContract('LockerContract', 0);
    const sharedVesting = await getContract('VestingManager', 0);
    const lockManagerAddress = state.contracts.LockManager;
    const lockManager = await ethers.getContractAt('LockManager', lockManagerAddress);

    const ERC20_ABI = [
        'function balanceOf(address) view returns (uint256)',
        'function approve(address,uint256) returns (bool)'
    ];
    const testToken = new ethers.Contract(state.contracts.TestToken, ERC20_ABI, deployer);

    const VestingFactory = await ethers.getContractFactory('VestingManager', deployer);

    let passed = 0, failed = 0;

    // Fresh VestingManager wired to an EOA locker (deployer): setLocker records
    // tx.origin as deployer at construction, so the deployer EOA can both wire
    // itself as the locker and then call the onlyLocker functions directly.
    let freshVesting = null;

    // ───────────────────────────────────────────────────────────────────────────
    // SCENARIO 1 — onlyLocker on the deployed (shared) VestingManager
    // ───────────────────────────────────────────────────────────────────────────
    logPhase(1, 'SCENARIO 1 — onlyLocker guards on the shared VestingManager');

    // 1.1 initializeVesting from a random EOA
    try {
        logSection('1.1 — initializeVesting by non-locker reverts Not authorized');
        await expectRevert(
            () => sharedVesting.connect(stranger).initializeVesting(1, ethers.parseEther('1'), 3600, false),
            'Not authorized',
            'initializeVesting by stranger'
        );
        passed++;
    } catch (e) { log(`  ❌ 1.1 FAILED: ${e.message}`); failed++; }

    // 1.2 unlockVested from random EOAs — even the module deployer is refused
    try {
        logSection('1.2 — unlockVested by non-locker reverts Not authorized');
        await expectRevert(
            () => sharedVesting.connect(stranger).unlockVested(1),
            'Not authorized',
            'unlockVested by stranger'
        );
        // The deploying EOA has no special access either: only the wired locker.
        await expectRevert(
            () => sharedVesting.connect(deployer).unlockVested(1),
            'Not authorized',
            'unlockVested by module deployer EOA'
        );
        passed++;
    } catch (e) { log(`  ❌ 1.2 FAILED: ${e.message}`); failed++; }

    // ───────────────────────────────────────────────────────────────────────────
    // SCENARIO 2 — constructor & setLocker (fresh instances)
    // ───────────────────────────────────────────────────────────────────────────
    logPhase(2, 'SCENARIO 2 — constructor & setLocker guards');

    // 2.1 constructor rejects the zero LockManager address (single-param constructor)
    try {
        logSection('2.1 — constructor(address(0)) reverts Zero address');
        await expectRevert(
            () => VestingFactory.deploy(ethers.ZeroAddress),
            'Zero address',
            'constructor with zero LockManager'
        );
        passed++;
    } catch (e) { log(`  ❌ 2.1 FAILED: ${e.message}`); failed++; }

    // 2.2 setLocker restricted to tx.origin == deployer
    try {
        logSection('2.2 — setLocker by non-deployer reverts Only deployer');
        freshVesting = await VestingFactory.deploy(lockManagerAddress);
        await freshVesting.waitForDeployment();
        assertEqual(await freshVesting.deployer(), deployer.address, 'deployer() records the deploying tx.origin');
        assertEqual(await freshVesting.locker(), ethers.ZeroAddress, 'locker starts unset');

        await expectRevert(
            () => freshVesting.connect(outsider).setLocker(outsider.address),
            'Only deployer',
            'setLocker by non-deployer'
        );
        passed++;
    } catch (e) { log(`  ❌ 2.2 FAILED: ${e.message}`); failed++; }

    // 2.3 setLocker(address(0)) by the deployer
    try {
        logSection('2.3 — setLocker(address(0)) reverts Already set or zero');
        assert(freshVesting, 'Precondition: fresh VestingManager deployed in 2.2');
        await expectRevert(
            () => freshVesting.connect(deployer).setLocker(ethers.ZeroAddress),
            'Already set or zero',
            'setLocker with zero address'
        );
        passed++;
    } catch (e) { log(`  ❌ 2.3 FAILED: ${e.message}`); failed++; }

    // 2.4 setLocker is one-shot: wire deployer EOA as locker, second call reverts
    try {
        logSection('2.4 — setLocker succeeds once, re-set reverts Already set or zero');
        assert(freshVesting, 'Precondition: fresh VestingManager deployed in 2.2');
        await (await freshVesting.connect(deployer).setLocker(deployer.address)).wait();
        assertEqual(await freshVesting.locker(), deployer.address, 'locker wired to deployer EOA');

        await expectRevert(
            () => freshVesting.connect(deployer).setLocker(outsider.address),
            'Already set or zero',
            'second setLocker'
        );
        passed++;
    } catch (e) { log(`  ❌ 2.4 FAILED: ${e.message}`); failed++; }

    // ───────────────────────────────────────────────────────────────────────────
    // SCENARIO 3 — initializeVesting guards (fresh module, EOA locker)
    // ───────────────────────────────────────────────────────────────────────────
    logPhase(3, 'SCENARIO 3 — initializeVesting guards (direct module calls)');

    // Real lock WITHOUT vesting: the fresh module reads it from the real LockManager,
    // while the shared VestingManager keeps no config for it (used again in 5.1).
    let lockA = null;
    try {
        ({ lockId: lockA } = await createRealLock(locker, lockManager, testToken, deployer, {
            token: state.contracts.TestToken, amount: ethers.parseEther('100'), lockDuration: 100000
        }));
    } catch (e) { log(`  ❌ lockA creation failed: ${e.message}`); }

    // 3.1 periodDuration=0 with tokensPerPeriod>0
    try {
        logSection('3.1 — periodDuration=0 reverts Invalid period duration');
        assert(freshVesting && lockA, 'Precondition: fresh module + lockA');
        await expectRevert(
            () => freshVesting.connect(deployer).initializeVesting(lockA, ethers.parseEther('10'), 0, false),
            'Invalid period duration',
            'initializeVesting with periodDuration=0'
        );
        passed++;
    } catch (e) { log(`  ❌ 3.1 FAILED: ${e.message}`); failed++; }

    // 3.2 nonexistent lockId (valid vesting params, empty lock slot)
    try {
        logSection('3.2 — nonexistent lockId reverts No lock found');
        assert(freshVesting, 'Precondition: fresh module');
        await expectRevert(
            () => freshVesting.connect(deployer).initializeVesting(999999999, ethers.parseEther('10'), 3600, false),
            'No lock found',
            'initializeVesting on missing lock'
        );
        passed++;
    } catch (e) { log(`  ❌ 3.2 FAILED: ${e.message}`); failed++; }

    // 3.3 tokensPerPeriod=0 is a silent no-op (early return before any validation/storage)
    try {
        logSection('3.3 — tokensPerPeriod=0 is a no-op (config stays disabled)');
        assert(freshVesting && lockA, 'Precondition: fresh module + lockA');
        await (await freshVesting.connect(deployer).initializeVesting(lockA, 0, 0, true)).wait();
        const cfg = await freshVesting.getVestingConfig(lockA);
        assertEqual(cfg.enabled, false, 'No-op init leaves vesting disabled');
        assertEqual(cfg.tokensPerPeriod, 0n, 'No-op init stores nothing');
        passed++;
    } catch (e) { log(`  ❌ 3.3 FAILED: ${e.message}`); failed++; }

    // 3.4 successful init (config asserted via getVestingConfig) then re-init reverts
    try {
        logSection('3.4 — re-initialization reverts Vesting already initialized');
        assert(freshVesting && lockA, 'Precondition: fresh module + lockA');
        const vTokens = ethers.parseEther('10');
        const vPeriod = 3600;
        const initTx = await freshVesting.connect(deployer).initializeVesting(lockA, vTokens, vPeriod, true);
        const initReceipt = await initTx.wait();
        const initTs = await blockTimestampOf(initReceipt);

        const cfg = await freshVesting.getVestingConfig(lockA);
        assertEqual(cfg.tokensPerPeriod, vTokens, 'getVestingConfig.tokensPerPeriod');
        assertEqual(cfg.periodDuration, BigInt(vPeriod), 'getVestingConfig.periodDuration');
        assertEqual(cfg.lastWithdrawalTime, initTs, 'getVestingConfig.lastWithdrawalTime == init block timestamp');
        assertEqual(cfg.accumulate, true, 'getVestingConfig.accumulate');
        assertEqual(cfg.enabled, true, 'getVestingConfig.enabled');

        await expectRevert(
            () => freshVesting.connect(deployer).initializeVesting(lockA, vTokens, vPeriod, false),
            'Vesting already initialized',
            're-initializeVesting on same lockId'
        );
        passed++;
    } catch (e) { log(`  ❌ 3.4 FAILED: ${e.message}`); failed++; }

    // ───────────────────────────────────────────────────────────────────────────
    // SCENARIO 4 — unlockVested guards (fresh module, EOA locker)
    // ───────────────────────────────────────────────────────────────────────────
    logPhase(4, 'SCENARIO 4 — unlockVested guards (direct module calls)');

    // 4.1 no vesting config → Vesting not enabled (checked before lock existence)
    let lockB = null;
    try {
        logSection('4.1 — no config reverts Vesting not enabled');
        assert(freshVesting, 'Precondition: fresh module');
        ({ lockId: lockB } = await createRealLock(locker, lockManager, testToken, deployer, {
            token: state.contracts.TestToken, amount: ethers.parseEther('100'), lockDuration: 7200
        }));
        await expectRevert(
            () => freshVesting.connect(deployer).unlockVested(lockB),
            'Vesting not enabled',
            'unlockVested on real lock without config'
        );
        // The enabled check precedes the lock lookup: a nonexistent lockId hits it too.
        await expectRevert(
            () => freshVesting.connect(deployer).unlockVested(424242424),
            'Vesting not enabled',
            'unlockVested on nonexistent lock'
        );
        passed++;
    } catch (e) { log(`  ❌ 4.1 FAILED: ${e.message}`); failed++; }

    // 4.2 period not elapsed → calculateVestedAmount==0 → VESTING_NOT_AVAILABLE
    try {
        logSection('4.2 — period not elapsed reverts VESTING_NOT_AVAILABLE');
        assert(freshVesting && lockB, 'Precondition: fresh module + lockB');
        await (await freshVesting.connect(deployer).initializeVesting(lockB, ethers.parseEther('10'), 3600, false)).wait();
        // Lock still time-locked (7200s) and no full 3600s period elapsed.
        assertEqual(await freshVesting.calculateVestedAmount(lockB), 0n, 'View reports 0 before the first period');
        await expectRevert(
            () => freshVesting.connect(deployer).unlockVested(lockB),
            'VESTING_NOT_AVAILABLE',
            'unlockVested before the first period'
        );
        passed++;
    } catch (e) { log(`  ❌ 4.2 FAILED: ${e.message}`); failed++; }

    // 4.3 lock conditions met (timeOk) → USE_REGULAR_UNLOCK, even with vested amount > 0
    //     (contract requires !status.timeOk && !status.priceOk)
    try {
        logSection('4.3 — matured lock reverts USE_REGULAR_UNLOCK');
        assert(freshVesting, 'Precondition: fresh module');
        const { lockId: lockC } = await createRealLock(locker, lockManager, testToken, deployer, {
            token: state.contracts.TestToken, amount: ethers.parseEther('100'), lockDuration: 5
        });
        await (await freshVesting.connect(deployer).initializeVesting(lockC, ethers.parseEther('10'), 2, false)).wait();

        await advanceTime(10);  // lock duration AND vesting period both elapsed → timeOk

        const claimable = await freshVesting.calculateVestedAmount(lockC);
        assert(claimable > 0n, 'Precondition: a vested amount is claimable');
        await expectRevert(
            () => freshVesting.connect(deployer).unlockVested(lockC),
            'USE_REGULAR_UNLOCK',
            'unlockVested on time-unlockable lock'
        );
        passed++;
    } catch (e) { log(`  ❌ 4.3 FAILED: ${e.message}`); failed++; }

    // ───────────────────────────────────────────────────────────────────────────
    // SCENARIO 5 — calculateVestedAmount branches + getVestingConfig (real path)
    // ───────────────────────────────────────────────────────────────────────────
    logPhase(5, 'SCENARIO 5 — calculateVestedAmount branches (real LockerContract path)');

    // 5.1 vesting disabled → 0 (both a real non-vesting lock and a nonexistent lock)
    try {
        logSection('5.1 — disabled vesting returns 0');
        assert(lockA, 'Precondition: lockA (no vesting on the REAL VestingManager)');
        assertEqual(await locker.calculateVestedAmount(lockA), 0n, 'Non-vesting lock vests 0');
        assertEqual(await locker.calculateVestedAmount(888888888), 0n, 'Nonexistent lock vests 0');
        passed++;
    } catch (e) { log(`  ❌ 5.1 FAILED: ${e.message}`); failed++; }

    // 5.2 real vesting lock: getVestingConfig fields + elapsedPeriods==0 → 0
    const vTokensAcc = ethers.parseEther('7');
    const vPeriodView = 100;
    let lockV1 = null;
    try {
        logSection('5.2 — getVestingConfig after real init; 0 before the first period');
        const { lockId, receipt } = await createRealLock(locker, lockManager, testToken, deployer, {
            token: state.contracts.TestToken, amount: ethers.parseEther('1000'), lockDuration: 100000,
            vestingTokens: vTokensAcc, vestingPeriod: vPeriodView, accumulate: true
        });
        lockV1 = lockId;
        const createTs = await blockTimestampOf(receipt);

        const cfg = await locker.getVestingConfig(lockV1);
        assertEqual(cfg.tokensPerPeriod, vTokensAcc, 'getVestingConfig.tokensPerPeriod');
        assertEqual(cfg.periodDuration, BigInt(vPeriodView), 'getVestingConfig.periodDuration');
        assertEqual(cfg.lastWithdrawalTime, createTs, 'getVestingConfig.lastWithdrawalTime == createLock timestamp');
        assertEqual(cfg.accumulate, true, 'getVestingConfig.accumulate');
        assertEqual(cfg.enabled, true, 'getVestingConfig.enabled');

        assertEqual(await locker.calculateVestedAmount(lockV1), 0n, 'elapsedPeriods==0 → vests 0');
        passed++;
    } catch (e) { log(`  ❌ 5.2 FAILED: ${e.message}`); failed++; }

    // Locks for the remaining view branches, created BEFORE a single time advance.
    let lockV2 = null, lockV3 = null, lockV4 = null;
    try {
        // Same schedule as V1 but non-accumulating.
        ({ lockId: lockV2 } = await createRealLock(locker, lockManager, testToken, deployer, {
            token: state.contracts.TestToken, amount: ethers.parseEther('1000'), lockDuration: 100000,
            vestingTokens: vTokensAcc, vestingPeriod: vPeriodView, accumulate: false
        }));
        // tokensPerPeriod (500) > availableAmount (200) → cap branch.
        ({ lockId: lockV3 } = await createRealLock(locker, lockManager, testToken, deployer, {
            token: state.contracts.TestToken, amount: ethers.parseEther('200'), lockDuration: 100000,
            vestingTokens: ethers.parseEther('500'), vestingPeriod: 50, accumulate: false
        }));
        // available/tokensPerPeriod == 2 < elapsedPeriods (6) → overflow-safe branch.
        ({ lockId: lockV4 } = await createRealLock(locker, lockManager, testToken, deployer, {
            token: state.contracts.TestToken, amount: ethers.parseEther('250'), lockDuration: 100000,
            vestingTokens: ethers.parseEther('100'), vestingPeriod: 50, accumulate: true
        }));

        // One shared advance: V1/V2 land in period 3 (~322-330s / 100s, safely < 400),
        // V3/V4 in period 6 (~320-330s / 50s).
        await advanceTime(320);
    } catch (e) { log(`  ❌ view-branch lock creation failed: ${e.message}`); }

    // 5.3 accumulate=true → proportional to elapsed periods
    try {
        logSection('5.3 — accumulate=true: 3 elapsed periods → 3 × tokensPerPeriod');
        assert(lockV1, 'Precondition: lockV1');
        assertEqual(await locker.calculateVestedAmount(lockV1), vTokensAcc * 3n, 'Vests exactly 3 × 7 TEST');
        passed++;
    } catch (e) { log(`  ❌ 5.3 FAILED: ${e.message}`); failed++; }

    // 5.4 accumulate=false → a single period's worth despite 3 elapsed periods
    try {
        logSection('5.4 — accumulate=false: single period despite 3 elapsed');
        assert(lockV2, 'Precondition: lockV2');
        assertEqual(await locker.calculateVestedAmount(lockV2), vTokensAcc, 'Vests exactly 1 × 7 TEST');
        passed++;
    } catch (e) { log(`  ❌ 5.4 FAILED: ${e.message}`); failed++; }

    // 5.5 cap at availableAmount (tokensPerPeriod exceeds the lock balance)
    try {
        logSection('5.5 — tokensPerPeriod (500) capped to availableAmount (200)');
        assert(lockV3, 'Precondition: lockV3');
        assertEqual(await locker.calculateVestedAmount(lockV3), ethers.parseEther('200'), 'Capped to available');
        passed++;
    } catch (e) { log(`  ❌ 5.5 FAILED: ${e.message}`); failed++; }

    // 5.6 overflow-safe accumulate branch: elapsedPeriods > available/tokensPerPeriod
    try {
        logSection('5.6 — accumulated periods beyond payability → availableAmount');
        assert(lockV4, 'Precondition: lockV4');
        assertEqual(await locker.calculateVestedAmount(lockV4), ethers.parseEther('250'), 'Returns available (250), no overflow');
        passed++;
    } catch (e) { log(`  ❌ 5.6 FAILED: ${e.message}`); failed++; }

    // NOTE: on-chain vestingNonce replay through unlockVestedWithSignatures is
    // exercised end-to-end by test 18 (scenario E2) and is intentionally not
    // duplicated here.

    // ─── RESULTS ────────────────────────────────────────────────────────────
    log('\n' + '═'.repeat(70), '\x1b[1m\x1b[36m');
    log(`RESULTS: ${passed}/${passed + failed} scenarios PASSED`, '\x1b[1m\x1b[36m');
    log('═'.repeat(70), '\x1b[1m\x1b[36m');

    if (failed > 0) {
        reportTestResult('54-vesting-negatives', false, `${failed} scenario(s) failed`);
        throw new Error(`${failed} scenario(s) failed`);
    }

    reportTestResult('54-vesting-negatives', true);
    logSuccess('\n✅ TEST 54 PASSED — All vesting negative paths verified!\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
