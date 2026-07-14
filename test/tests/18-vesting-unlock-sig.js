/**
 * Test 18: Vesting Unlock with Signatures — Comprehensive Coverage
 *
 * Vesting is token-denominated (1:1, no USD conversion): the config releases a
 * fixed number of locked tokens per elapsed period. With accumulate=true the
 * claimable amount is tokensPerPeriod × fully elapsed periods; otherwise a
 * single period's worth per claim. Claims are all-or-nothing (no partial) and
 * always capped by the lock's remaining available balance.
 *
 * SCENARIO A — Non-accumulating vesting (accumulate=false)
 *   A1. Signature unlock — standard period releases exactly tokensPerPeriod
 *   A2. Multi-period (advance 3× period): still only 1 period released
 *   A3. Period not yet elapsed → calculateVestedAmount returns 0
 *   A4. Multiple successive unlocks on the same lock
 *   A5. Claim resets the clock: banked periods + in-progress time forfeited
 *
 * SCENARIO B — Accumulating vesting (accumulate=true)
 *   B1. 3 periods elapsed → 3 × tokensPerPeriod claimable in ONE call
 *   B2. Clock advances by whole periods only (in-progress period preserved)
 *
 * SCENARIO C — Cap at available balance
 *   C1. tokensPerPeriod > availableAmount → only available released,
 *       then the drained lock is closed and vesting yields 0
 *   C2. Accumulated amount > availableAmount → capped to available
 *
 * SCENARIO D — 6-decimal token (USDT-like): 1:1 native-unit release
 *   D1. tokensPerPeriod expressed in native 6-dec units releases exactly that
 *
 * EXTRA
 *   E2. Replay attack: reusing same signature must revert (nonce check)
 *   E3. Wrong signer (not in signers list) must revert
 *   E4. Signed cap below vested amount must revert (all-or-nothing, no partial)
 *
 * SCENARIO F — Guards
 *   F1. Lock conditions met (time elapsed) → vesting path reverts USE_REGULAR_UNLOCK
 *   F2. Param validation: vesting with periodDuration=0 reverts; maxAmountTokens=0 reverts
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
    signLockerOp,
    getEthers
} from '../core/utils.js';

const ethers = getEthers();

// ─── EIP-712 helpers ────────────────────────────────────────────────────────

// Picks a signed token ceiling for a release. The signer commits to this cap; we default
// to twice the currently-vested amount so the cap does not spuriously bind in scenarios
// that exercise the vesting math itself. Dedicated cap tests pass an explicit value.
async function capFor(locker, lockId) {
    const amt = await locker.calculateVestedAmount(lockId);
    return amt > 0n ? amt * 2n : ethers.parseEther('1');
}

// Returns exactly `threshold` wallets that are CURRENTLY authorized signers. Earlier tests in
// the shared-state run (13/14/15/23) mutate the signer set and threshold, so we must resolve
// them live rather than assuming the initial 3-of-5.
async function getThresholdSigners(locker) {
    const threshold = Number(await locker.approvalsThreshold());
    const signerAddrs = (await locker.getSigners()).map((a) => a.toLowerCase());
    const byAddr = new Map();
    for (let i = 0; i < 12; i++) {
        const w = await getWallet(i);
        byAddr.set(w.address.toLowerCase(), w);
    }
    const chosen = [];
    for (const a of signerAddrs) {
        if (byAddr.has(a)) {
            chosen.push(byAddr.get(a));
            if (chosen.length === threshold) break;
        }
    }
    if (chosen.length < threshold) {
        throw new Error(`Only resolved ${chosen.length}/${threshold} signer wallets`);
    }
    return chosen;
}

// Vesting release requires the full M-of-N signer threshold. The opKey binds only
// the operation parameters, never an individual signer.
async function signVestingUnlock(locker, lockId, recipient, maxAmountTokens, signerWallets) {
    // Nonce comes from the dedicated vestingNonce mapping (separate from unlockNonce).
    const nonce = await locker.vestingNonce(lockId);
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const lockerAddress = await locker.getAddress();

    // Signed as the decoded VestingUnlock struct; its hashStruct equals the on-chain opKey.
    const message = { lockId, recipient, maxAmountTokens, chainId, nonce };

    const domain = { name: 'LockerContract', version: '1', chainId, verifyingContract: lockerAddress };

    const wallets = signerWallets ?? (await getThresholdSigners(locker));
    const signers = [];
    const signatures = [];
    for (const w of wallets) {
        signers.push(w.address);
        signatures.push(await signLockerOp(w, domain, 'VestingUnlock', message));
    }
    return { signers, signatures, nonce };
}

async function unlockVestedSig(locker, lockId, recipient, maxAmountTokens, signerWallets) {
    const cap = maxAmountTokens ?? (await capFor(locker, lockId));
    const { signers, signatures } = await signVestingUnlock(locker, lockId, recipient.address, cap, signerWallets);
    const deployer = await getWallet(0);
    const tx = await locker.connect(deployer).unlockVestedWithSignatures(
        lockId, recipient.address, cap, signers, signatures
    );
    return tx.wait();
}

// Deploy a 6-decimal ERC20 token (USDT-like)
async function deploy6DecToken(deployer, name, symbol, amount) {
    const ERC20Mock = await ethers.getContractFactory('ERC20Mock', deployer);
    const token = await ERC20Mock.deploy(name, symbol, deployer.address, amount, 6);
    await token.waitForDeployment();
    return token;
}

// Generic vesting lock creator
async function createVestingLock(locker, lockManager, tokenContract, creator, params) {
    const { token, amount, lockDuration, pair, ethUsdPair, targetPrice, isEthPair,
        stablecoinPos, vestingTokens, vestingPeriod, accumulate } = params;

    await tokenContract.connect(creator).approve(await locker.getAddress(), amount);
    const nextId = await lockManager.nextLockId();

    await locker.connect(creator).createLock({
        token: token,
        amount: amount,
        lockDuration: lockDuration || 300,       // 5 minutes default
        pair: pair || ethers.ZeroAddress,
        ethUsdPair: ethUsdPair || ethers.ZeroAddress,
        targetPriceUSD1e18: targetPrice || 0n,
        isEthPair: isEthPair || false,
        stablecoinPosition: stablecoinPos || 2,
        priceDirection: PRICE_DIRECTION.UPSIDE,
        vestingTokensPerPeriod: vestingTokens,
        vestingPeriodSeconds: vestingPeriod,
        vestingAccumulate: accumulate || false
    });

    log(`  Created lock #${nextId} — ${ethers.formatUnits(vestingTokens, 18)} tokens / ${vestingPeriod}s (accumulate=${!!accumulate})`);
    return nextId;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
    log('\n🧪 TEST 18: VESTING UNLOCK WITH SIGNATURES — COMPREHENSIVE\n', '\x1b[1m\x1b[36m');

    const state = loadSharedState();
    const deployer = await getWallet(0);
    const signer1 = await getWallet(1);  // authorized signer
    const signer2 = await getWallet(2);  // authorized signer
    const stranger = await getWallet(9);  // NOT a signer
    const recipient = await getWallet(7);

    const locker = await getContract('LockerContract', 0);
    const lockManagerAddress = await locker.lockManager();
    const lockManager = await ethers.getContractAt('LockManager', lockManagerAddress);

    const ERC20_ABI = [
        'function balanceOf(address) view returns (uint256)',
        'function approve(address,uint256) returns (bool)',
        'function decimals() view returns (uint8)',
        'function transfer(address,uint256) returns (bool)'
    ];

    // Base 18-decimal test token (TestToken)
    const testToken = new ethers.Contract(state.contracts.TestToken, ERC20_ABI, deployer);

    let passed = 0, failed = 0;

    // ───────────────────────────────────────────────────────────────────────────
    // SCENARIO A — Non-accumulating vesting (accumulate=false)
    // ───────────────────────────────────────────────────────────────────────────
    logPhase(1, 'SCENARIO A — Non-accumulating vesting');

    // A1. Standard period + signature — releases exactly tokensPerPeriod
    try {
        logSection('A1 — Standard sig unlock (100 tokens/period, 18 dec)');
        const vTokens = ethers.parseEther('100');  // 100 tokens / period
        const vPeriod = 2;
        const lockId = await createVestingLock(locker, lockManager, testToken, deployer, {
            token: state.contracts.TestToken, amount: ethers.parseEther('10000'),
            vestingTokens: vTokens, vestingPeriod: vPeriod, accumulate: false
        });

        await advanceTime(vPeriod + 1);

        const amt = await locker.calculateVestedAmount(lockId);
        log(`  Vested: ${ethers.formatEther(amt)} TEST`);
        assertEqual(amt, vTokens, 'Vested amount should be exactly tokensPerPeriod');

        const balBefore = await testToken.balanceOf(recipient.address);
        await unlockVestedSig(locker, lockId, recipient);
        const received = (await testToken.balanceOf(recipient.address)) - balBefore;
        assertEqual(received, vTokens, 'Recipient should receive exactly tokensPerPeriod');
        log(`  ✅ A1 received: ${ethers.formatEther(received)} TEST`);
        passed++;
    } catch (e) { log(`  ❌ A1 FAILED: ${e.message}`); failed++; }

    // A2. Advance 3× period — still only 1 period is released (non-accumulating)
    try {
        logSection('A2 — Multi-period advance: only 1 period released per call');
        const vTokens = ethers.parseEther('50');
        const vPeriod = 2;
        const lockId = await createVestingLock(locker, lockManager, testToken, deployer, {
            token: state.contracts.TestToken, amount: ethers.parseEther('5000'),
            vestingTokens: vTokens, vestingPeriod: vPeriod, accumulate: false
        });

        await advanceTime(vPeriod * 3 + 1);  // 3 periods elapsed

        const amt = await locker.calculateVestedAmount(lockId);
        log(`  Vested after 3 periods: ${ethers.formatEther(amt)} TEST`);
        // accumulate=false → 1 period per call, elapsed periods do NOT stack
        assertEqual(amt, vTokens, 'Should be exactly 1 period worth');

        const balBefore = await testToken.balanceOf(recipient.address);
        await unlockVestedSig(locker, lockId, recipient);
        const received = (await testToken.balanceOf(recipient.address)) - balBefore;
        assertEqual(received, vTokens, 'Should receive exactly 1 period worth');
        log(`  ✅ A2 received: ${ethers.formatEther(received)} TEST (1 period only)`);
        passed++;
    } catch (e) { log(`  ❌ A2 FAILED: ${e.message}`); failed++; }

    // A3. Period NOT yet elapsed → calculateVestedAmount returns 0
    try {
        logSection('A3 — Period not elapsed → vested amount = 0');
        const vPeriod = 10;  // 10s period
        const lockId = await createVestingLock(locker, lockManager, testToken, deployer, {
            token: state.contracts.TestToken, amount: ethers.parseEther('1000'),
            vestingTokens: ethers.parseEther('100'), vestingPeriod: vPeriod, accumulate: false
        });

        // Only advance 3 seconds, not enough for a 10s period
        await advanceTime(3);

        const amt = await locker.calculateVestedAmount(lockId);
        assertEqual(amt, 0n, 'Vested amount should be 0 before period');
        log(`  ✅ A3 correctly returns 0 when period not elapsed`);
        passed++;
    } catch (e) { log(`  ❌ A3 FAILED: ${e.message}`); failed++; }

    // A4. Multiple successive unlocks on the same lock (3 periods unlocked one by one)
    try {
        logSection('A4 — 3 successive unlocks on same lock (2s period)');
        const vTokens = ethers.parseEther('30');  // 30 tokens/period
        const vPeriod = 2;
        const lockId = await createVestingLock(locker, lockManager, testToken, deployer, {
            token: state.contracts.TestToken, amount: ethers.parseEther('500'),
            vestingTokens: vTokens, vestingPeriod: vPeriod, accumulate: false
        });

        let totalReceived = 0n;
        for (let i = 1; i <= 3; i++) {
            await advanceTime(vPeriod + 1);
            const amt = await locker.calculateVestedAmount(lockId);
            assertEqual(amt, vTokens, `Period ${i}: should vest exactly tokensPerPeriod`);

            const balBefore = await testToken.balanceOf(recipient.address);
            await unlockVestedSig(locker, lockId, recipient);
            const gained = (await testToken.balanceOf(recipient.address)) - balBefore;
            totalReceived += gained;
            log(`  Period ${i}: received ${ethers.formatEther(gained)} TEST`);
        }
        log(`  Total over 3 periods: ${ethers.formatEther(totalReceived)} TEST`);
        assertEqual(totalReceived, vTokens * 3n, 'Should receive exactly 3×30 TEST over 3 claims');
        log(`  ✅ A4 multi-unlock ok, total: ${ethers.formatEther(totalReceived)} TEST`);
        passed++;
    } catch (e) { log(`  ❌ A4 FAILED: ${e.message}`); failed++; }

    // A5. accumulate=false claim RESETS the clock to the claim block: the 2 banked
    //     periods and the in-progress fraction are forfeited — nothing is claimable
    //     until a full fresh period elapses from the claim.
    try {
        logSection('A5 — Claim resets clock: banked periods forfeited (accumulate=false)');
        const vTokens = ethers.parseEther('20');
        const vPeriod = 60;
        const lockId = await createVestingLock(locker, lockManager, testToken, deployer, {
            token: state.contracts.TestToken, amount: ethers.parseEther('1000'),
            vestingTokens: vTokens, vestingPeriod: vPeriod, accumulate: false
        });

        await advanceTime(vPeriod * 3 + 1);  // 3 banked periods
        await unlockVestedSig(locker, lockId, recipient);  // pays exactly 1 period

        // Immediately after the claim nothing is claimable (banked periods gone)
        const amtAfterClaim = await locker.calculateVestedAmount(lockId);
        assertEqual(amtAfterClaim, 0n, 'Banked periods must be forfeited by the claim');

        // Half a period later: still nothing (any carry-over would show tokensPerPeriod)
        await advanceTime(30);
        const amtMidPeriod = await locker.calculateVestedAmount(lockId);
        assertEqual(amtMidPeriod, 0n, 'Old schedule forfeited: mid-period still 0');

        // A full fresh period from the claim: exactly one period claimable again
        await advanceTime(35);
        const amtNextPeriod = await locker.calculateVestedAmount(lockId);
        assertEqual(amtNextPeriod, vTokens, 'Fresh period completes from the claim block');
        log(`  ✅ A5 clock reset verified (no carry-over of unclaimed periods)`);
        passed++;
    } catch (e) { log(`  ❌ A5 FAILED: ${e.message}`); failed++; }

    // ───────────────────────────────────────────────────────────────────────────
    // SCENARIO B — Accumulating vesting (accumulate=true)
    // ───────────────────────────────────────────────────────────────────────────
    logPhase(2, 'SCENARIO B — Accumulating vesting');

    // B1. 3 periods elapsed → 3 × tokensPerPeriod claimable in one call
    try {
        logSection('B1 — accumulate=true: 3 elapsed periods claimed at once');
        const vTokens = ethers.parseEther('40');
        // Period must be long enough that the claim tx's own +1..2s block-timestamp
        // drift cannot cross into a 4th period between the view read and the claim.
        const vPeriod = 10;
        const lockId = await createVestingLock(locker, lockManager, testToken, deployer, {
            token: state.contracts.TestToken, amount: ethers.parseEther('10000'),
            vestingTokens: vTokens, vestingPeriod: vPeriod, accumulate: true
        });

        await advanceTime(vPeriod * 3 + 1);  // 3 full periods elapsed

        const amt = await locker.calculateVestedAmount(lockId);
        log(`  Vested after 3 periods: ${ethers.formatEther(amt)} TEST`);
        assertEqual(amt, vTokens * 3n, 'Accumulated amount should be 3 × tokensPerPeriod');

        const balBefore = await testToken.balanceOf(recipient.address);
        await unlockVestedSig(locker, lockId, recipient);
        const received = (await testToken.balanceOf(recipient.address)) - balBefore;
        assertEqual(received, vTokens * 3n, 'Should receive all 3 accumulated periods in one claim');
        log(`  ✅ B1 received: ${ethers.formatEther(received)} TEST (3 periods at once)`);
        passed++;
    } catch (e) { log(`  ❌ B1 FAILED: ${e.message}`); failed++; }

    // B2. Clock advances by whole claimed periods only — the in-progress period is
    //     preserved, so the next period completes on schedule (no time forfeited).
    try {
        logSection('B2 — accumulate=true: in-progress period preserved after claim');
        const vTokens = ethers.parseEther('25');
        // 30s period gives ~15s of wall-clock headroom: the claim tx's real-time
        // drift (RPC latency leaks into block timestamps) cannot cross a boundary.
        const vPeriod = 30;
        const lockId = await createVestingLock(locker, lockManager, testToken, deployer, {
            token: state.contracts.TestToken, amount: ethers.parseEther('10000'),
            vestingTokens: vTokens, vestingPeriod: vPeriod, accumulate: true
        });

        // Advance 2.5 periods → claim pays 2 periods, 0.5 period remainder is kept
        await advanceTime(vPeriod * 2 + 15);

        const amt = await locker.calculateVestedAmount(lockId);
        assertEqual(amt, vTokens * 2n, 'Should vest exactly 2 whole periods');
        await unlockVestedSig(locker, lockId, recipient);

        // ~15s remain to complete the in-progress period; +16s must finish it
        await advanceTime(16);
        const amtAfter = await locker.calculateVestedAmount(lockId);
        assertEqual(amtAfter, vTokens, 'Remainder preserved: next period completes on schedule');
        log(`  ✅ B2 clock advanced by whole periods only (remainder preserved)`);
        passed++;
    } catch (e) { log(`  ❌ B2 FAILED: ${e.message}`); failed++; }

    // ───────────────────────────────────────────────────────────────────────────
    // SCENARIO C — Cap at available balance
    // ───────────────────────────────────────────────────────────────────────────
    logPhase(3, 'SCENARIO C — Cap at available balance');

    // C1. tokensPerPeriod > availableAmount → only available released
    //     Uses a dedicated token: the lock is fully drained (and deleted), which must
    //     not disturb shared-state TestToken locks used by later tests.
    try {
        logSection('C1 — tokensPerPeriod (500) > lock amount (200) → capped');
        const ERC20Mock = await ethers.getContractFactory('ERC20Mock', deployer);
        const capToken = await ERC20Mock.deploy('CapToken', 'CAP1', deployer.address, ethers.parseEther('200'), 18);
        await capToken.waitForDeployment();

        const lockAmount = ethers.parseEther('200');
        const vPeriod = 5;
        const lockId = await createVestingLock(locker, lockManager, capToken, deployer, {
            token: await capToken.getAddress(), amount: lockAmount,
            vestingTokens: ethers.parseEther('500'), vestingPeriod: vPeriod, accumulate: false
        });

        await advanceTime(vPeriod + 2);

        const amt = await locker.calculateVestedAmount(lockId);
        log(`  Vested (capped): ${ethers.formatEther(amt)} CAP1`);
        assertEqual(amt, lockAmount, 'Should be capped to the lock available amount');

        const balBefore = await capToken.balanceOf(recipient.address);
        await unlockVestedSig(locker, lockId, recipient);
        const received = (await capToken.balanceOf(recipient.address)) - balBefore;
        assertEqual(received, lockAmount, 'Cap respected — releases exactly the available amount');

        // Post-drain lifecycle: the emptied lock is closed and vesting yields 0 forever
        const drained = await locker.locks(lockId);
        assertEqual(drained.basic.token, ethers.ZeroAddress, 'Fully drained lock must be deleted');
        await advanceTime(vPeriod + 2);
        const amtAfterDrain = await locker.calculateVestedAmount(lockId);
        assertEqual(amtAfterDrain, 0n, 'Drained lock must vest 0 (orphaned config is inert)');

        // Rescue eligibility: executeRescue requires getTokenLocks(token).length == 0 —
        // a vesting-drained token must become rescuable (its lock index is emptied).
        const remainingLocks = await lockManager.getTokenLocks(await capToken.getAddress());
        assertEqual(BigInt(remainingLocks.length), 0n, 'Token index emptied — rescue is possible again');
        log(`  ✅ C1 cap correct: ${ethers.formatEther(received)} CAP1 released, lock closed, token rescuable`);
        passed++;
    } catch (e) { log(`  ❌ C1 FAILED: ${e.message}`); failed++; }

    // C2. Accumulated amount exceeds available → capped to available
    try {
        logSection('C2 — accumulate: 5 × 100 > 300 available → capped to 300');
        const ERC20Mock = await ethers.getContractFactory('ERC20Mock', deployer);
        const capToken2 = await ERC20Mock.deploy('CapToken2', 'CAP2', deployer.address, ethers.parseEther('300'), 18);
        await capToken2.waitForDeployment();

        const lockAmount = ethers.parseEther('300');
        const vTokens = ethers.parseEther('100');
        const vPeriod = 2;
        const lockId = await createVestingLock(locker, lockManager, capToken2, deployer, {
            token: await capToken2.getAddress(), amount: lockAmount,
            vestingTokens: vTokens, vestingPeriod: vPeriod, accumulate: true
        });

        await advanceTime(vPeriod * 5 + 1);  // 5 periods → 500 accumulated but only 300 available

        const amt = await locker.calculateVestedAmount(lockId);
        assertEqual(amt, lockAmount, 'Accumulated amount must be capped to available');

        const balBefore = await capToken2.balanceOf(recipient.address);
        await unlockVestedSig(locker, lockId, recipient);
        const received = (await capToken2.balanceOf(recipient.address)) - balBefore;
        assertEqual(received, lockAmount, 'Releases exactly the available amount');
        log(`  ✅ C2 accumulation capped: ${ethers.formatEther(received)} CAP2 released`);
        passed++;
    } catch (e) { log(`  ❌ C2 FAILED: ${e.message}`); failed++; }

    // ───────────────────────────────────────────────────────────────────────────
    // SCENARIO D — 6-decimal token (USDT-like): native-unit 1:1 release
    // ───────────────────────────────────────────────────────────────────────────
    logPhase(4, 'SCENARIO D — 6-decimal token (native units, no conversion)');

    // D1. tokensPerPeriod expressed in native 6-dec units releases exactly that amount
    try {
        logSection('D1 — 6-dec token: 100e6/period must release exactly 100 USDT');
        const usdt = await deploy6DecToken(deployer, 'Test USDT', 'USDT', ethers.parseUnits('2500', 6));
        const usdtAddress = await usdt.getAddress();
        await usdt.connect(deployer).approve(await locker.getAddress(), ethers.parseUnits('2500', 6));

        const lockAmount = ethers.parseUnits('2500', 6);   // 2500 USDT
        const vTokens = ethers.parseUnits('100', 6);       // 100 USDT/period (native units)
        const vPeriod = 5;
        const nextId = await lockManager.nextLockId();

        await locker.connect(deployer).createLock({
            token: usdtAddress, amount: lockAmount, lockDuration: 300,
            pair: ethers.ZeroAddress, ethUsdPair: ethers.ZeroAddress,
            targetPriceUSD1e18: 0n, isEthPair: false, stablecoinPosition: 2,
            priceDirection: PRICE_DIRECTION.UPSIDE,
            vestingTokensPerPeriod: vTokens, vestingPeriodSeconds: vPeriod, vestingAccumulate: false
        });

        await advanceTime(vPeriod + 2);

        const amtTokens = await locker.calculateVestedAmount(nextId);
        log(`  Vested tokens: ${ethers.formatUnits(amtTokens, 6)} USDT`);

        // 1:1 native units: exactly 100 USDT (100e6), NOT 2500 USDT
        assertEqual(amtTokens, vTokens, 'Should vest exactly 100 USDT (native units)');

        const balBefore = await usdt.balanceOf(recipient.address);
        const cap = await capFor(locker, nextId);
        const { signers, signatures } = await signVestingUnlock(locker, nextId, recipient.address, cap);
        const tx = await locker.connect(deployer).unlockVestedWithSignatures(
            nextId, recipient.address, cap, signers, signatures
        );
        await tx.wait();

        const received = (await usdt.balanceOf(recipient.address)) - balBefore;
        log(`  USDT received: ${ethers.formatUnits(received, 6)}`);
        assertEqual(received, vTokens, 'Must release exactly 100 USDT, not the entire lock');
        log(`  ✅ D1 native-unit release verified: ${ethers.formatUnits(received, 6)} USDT`);
        passed++;
    } catch (e) { log(`  ❌ D1 FAILED: ${e.message}`); failed++; }

    // ───────────────────────────────────────────────────────────────────────────
    // SCENARIO E — Extra edge cases
    // ───────────────────────────────────────────────────────────────────────────
    logPhase(5, 'SCENARIO E — Edge cases');


    // E2. Replay attack: reusing the same signature must revert (nonce incremented)
    try {
        logSection('E2 — Replay attack: reused signature must revert');
        const vPeriod = 4;
        const lockId = await createVestingLock(locker, lockManager, testToken, deployer, {
            token: state.contracts.TestToken, amount: ethers.parseEther('1000'),
            vestingTokens: ethers.parseEther('50'), vestingPeriod: vPeriod, accumulate: false
        });

        await advanceTime(vPeriod + 2);

        // First unlock — succeeds
        const cap = await capFor(locker, lockId);
        const { signers, signatures } = await signVestingUnlock(locker, lockId, recipient.address, cap);
        await locker.connect(deployer).unlockVestedWithSignatures(lockId, recipient.address, cap, signers, signatures);

        // Advance time for next period
        await advanceTime(vPeriod + 2);

        // Replay with same (now stale) signatures — must revert (nonce bumped + markAsExecuted)
        let reverted = false;
        try {
            await locker.connect(deployer).unlockVestedWithSignatures(lockId, recipient.address, cap, signers, signatures);
        } catch (e) {
            reverted = true;
            log(`  Reverted as expected: ${e.message.split('\n')[0]}`);
        }
        assert(reverted, 'Replay attack must be reverted by nonce check');
        log(`  ✅ E2 replay attack correctly rejected`);
        passed++;
    } catch (e) { log(`  ❌ E2 FAILED: ${e.message}`); failed++; }

    // E3. Wrong signer (not in signers list) must revert
    try {
        logSection('E3 — Wrong signer (not authorized) must revert');
        const vPeriod = 4;
        const lockId = await createVestingLock(locker, lockManager, testToken, deployer, {
            token: state.contracts.TestToken, amount: ethers.parseEther('1000'),
            vestingTokens: ethers.parseEther('50'), vestingPeriod: vPeriod, accumulate: false
        });

        await advanceTime(vPeriod + 2);

        // Include an unauthorized signer (wallet 9) in the M-of-N set — must revert.
        // Build a threshold-sized set so the ONLY defect is the stranger (a too-short
        // list would revert on count alone and make this test pass vacuously).
        const cap = await capFor(locker, lockId);
        const wrongSet = await getThresholdSigners(locker);
        wrongSet[wrongSet.length - 1] = stranger;
        const { signers, signatures } = await signVestingUnlock(
            locker, lockId, recipient.address, cap, wrongSet
        );

        let reverted = false;
        try {
            await locker.connect(deployer).unlockVestedWithSignatures(lockId, recipient.address, cap, signers, signatures);
        } catch (e) {
            reverted = true;
            log(`  Reverted as expected: ${e.message.split('\n')[0]}`);
        }
        assert(reverted, 'Unauthorized signer must be rejected');
        log(`  ✅ E3 unauthorized signer correctly rejected`);
        passed++;
    } catch (e) { log(`  ❌ E3 FAILED: ${e.message}`); failed++; }

    // E4. Signed cap enforcement: a signature that authorizes fewer tokens
    //     than the vested amount must revert. Claims are all-or-nothing — the release
    //     is never split down to fit the cap.
    try {
        logSection('E4 — Signed cap: maxAmountTokens below vested amount must revert');
        const vPeriod = 4;
        const lockId = await createVestingLock(locker, lockManager, testToken, deployer, {
            token: state.contracts.TestToken, amount: ethers.parseEther('1000'),
            vestingTokens: ethers.parseEther('100'), vestingPeriod: vPeriod, accumulate: false
        });

        await advanceTime(vPeriod + 2);

        const vested = await locker.calculateVestedAmount(lockId);
        assert(vested > 0n, 'Precondition: should have a vested amount');

        // Sign for only 1 token while 100 are vested → contract must reject (no partial claim).
        const tooLowCap = ethers.parseEther('1');
        const { signers, signatures } = await signVestingUnlock(locker, lockId, recipient.address, tooLowCap);

        let reverted = false;
        let reason = '';
        try {
            await locker.connect(deployer).unlockVestedWithSignatures(
                lockId, recipient.address, tooLowCap, signers, signatures
            );
        } catch (e) {
            reverted = true;
            reason = e.message.split('\n')[0];
            log(`  Reverted as expected: ${reason}`);
        }
        assert(reverted, 'Release above the signed cap must revert');
        assert(reason.includes('Amount exceeds signed cap'), 'Must revert with the signed-cap guard');

        // Sanity: signing for the full vested amount then succeeds (cap not binding).
        const balBefore = await testToken.balanceOf(recipient.address);
        await unlockVestedSig(locker, lockId, recipient, vested);
        const received = (await testToken.balanceOf(recipient.address)) - balBefore;
        assert(received > 0n, 'A correctly-sized signed cap should release tokens');
        log(`  ✅ E4 signed-cap enforced; correct cap released ${ethers.formatEther(received)} TEST`);
        passed++;
    } catch (e) { log(`  ❌ E4 FAILED: ${e.message}`); failed++; }

    // ───────────────────────────────────────────────────────────────────────────
    // SCENARIO F — Guards
    // ───────────────────────────────────────────────────────────────────────────
    logPhase(6, 'SCENARIO F — Guards');

    // F1. Once the lock's own conditions are met (time elapsed), the vesting path
    //     must refuse and defer to executeUnlockWithSignatures (USE_REGULAR_UNLOCK).
    try {
        logSection('F1 — Lock unlockable by time → vesting claim reverts USE_REGULAR_UNLOCK');
        const vPeriod = 2;
        const lockId = await createVestingLock(locker, lockManager, testToken, deployer, {
            token: state.contracts.TestToken, amount: ethers.parseEther('1000'),
            lockDuration: 5,  // expires almost immediately
            vestingTokens: ethers.parseEther('50'), vestingPeriod: vPeriod, accumulate: false
        });

        // Both a vesting period AND the lock duration have elapsed
        await advanceTime(10);

        // The view has no status guard — it still reports a vested amount
        const amt = await locker.calculateVestedAmount(lockId);
        assert(amt > 0n, 'Precondition: view reports a vested amount');

        let reverted = false;
        let reason = '';
        try {
            await unlockVestedSig(locker, lockId, recipient);
        } catch (e) {
            reverted = true;
            reason = e.message.split('\n')[0];
            log(`  Reverted as expected: ${reason}`);
        }
        assert(reverted, 'Vesting claim on a matured lock must revert');
        assert(reason.includes('USE_REGULAR_UNLOCK'), 'Must revert with USE_REGULAR_UNLOCK');
        log(`  ✅ F1 matured lock correctly deferred to the regular unlock path`);
        passed++;
    } catch (e) { log(`  ❌ F1 FAILED: ${e.message}`); failed++; }

    // F2. Parameter validation reverts
    try {
        logSection('F2 — Validation: periodDuration=0 and maxAmountTokens=0 revert');

        // Vesting enabled (tokensPerPeriod > 0) but periodDuration = 0 → revert at creation
        await testToken.connect(deployer).approve(await locker.getAddress(), ethers.parseEther('100'));
        let creationReverted = false;
        let creationReason = '';
        try {
            await locker.connect(deployer).createLock({
                token: state.contracts.TestToken, amount: ethers.parseEther('100'),
                lockDuration: 300, pair: ethers.ZeroAddress, ethUsdPair: ethers.ZeroAddress,
                targetPriceUSD1e18: 0n, isEthPair: false, stablecoinPosition: 2,
                priceDirection: PRICE_DIRECTION.UPSIDE,
                vestingTokensPerPeriod: ethers.parseEther('10'),
                vestingPeriodSeconds: 0,  // invalid
                vestingAccumulate: false
            });
        } catch (e) {
            creationReverted = true;
            creationReason = e.message.split('\n')[0];
            log(`  Creation reverted as expected: ${creationReason}`);
        }
        assert(creationReverted, 'Vesting with periodDuration=0 must revert');
        assert(creationReason.includes('Invalid period duration'), 'Must revert with Invalid period duration');

        // maxAmountTokens = 0 → unlockVestedWithSignatures rejects before any signature work
        const vPeriod = 2;
        const lockId = await createVestingLock(locker, lockManager, testToken, deployer, {
            token: state.contracts.TestToken, amount: ethers.parseEther('100'),
            vestingTokens: ethers.parseEther('10'), vestingPeriod: vPeriod, accumulate: false
        });
        await advanceTime(vPeriod + 1);

        const { signers, signatures } = await signVestingUnlock(locker, lockId, recipient.address, 0n);
        let capReverted = false;
        let capReason = '';
        try {
            await locker.connect(deployer).unlockVestedWithSignatures(
                lockId, recipient.address, 0n, signers, signatures
            );
        } catch (e) {
            capReverted = true;
            capReason = e.message.split('\n')[0];
            log(`  Zero cap reverted as expected: ${capReason}`);
        }
        assert(capReverted, 'maxAmountTokens=0 must revert');
        assert(capReason.includes('Invalid max amount'), 'Must revert with Invalid max amount');
        log(`  ✅ F2 parameter validation guards verified`);
        passed++;
    } catch (e) { log(`  ❌ F2 FAILED: ${e.message}`); failed++; }

    // ─── RESULTS ────────────────────────────────────────────────────────────
    log('\n' + '═'.repeat(70), '\x1b[1m\x1b[36m');
    log(`RESULTS: ${passed}/${passed + failed} scenarios PASSED`, '\x1b[1m\x1b[36m');
    log('═'.repeat(70), '\x1b[1m\x1b[36m');

    if (failed > 0) {
        reportTestResult('18-vesting-unlock-sig', false, `${failed} scenario(s) failed`);
        throw new Error(`${failed} scenario(s) failed`);
    }

    reportTestResult('18-vesting-unlock-sig', true);
    logSuccess('\n✅ TEST 18 PASSED — All vesting unlock scenarios verified!\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
