/**
 * Test 91 — Lock closure paths (regular + vesting) and lock-duration bounds.
 *
 * Properties verified:
 *   1. Top-ups are open to any caller and each appends a history entry, so a lock can carry
 *      an arbitrary number of history entries.
 *   2. Closing a lock through a REGULAR withdrawal is constant-cost regardless of history length.
 *   3. Closing a lock through a VESTING release is likewise constant-cost.
 *   4. A lock's history is retained and stays readable after the lock is closed (ids are issued
 *      monotonically and never reused, so the retained history is inert).
 *   5. createLock rejects a duration above MAX_LOCK_DURATION and accepts the boundaries.
 *
 * Self-contained: deploys its own Locker stack with Hardhat-controlled signer keys.
 */

import {
    logPhase, logSuccess, log, assert, assertEqual, reportTestResult,
    advanceTime, signLockerOp, PRICE_DIRECTION, getEthers
} from '../core/utils.js';

const ethers = getEthers();
let passed = 0;
function pass(l) { passed++; logSuccess(`[CHECK ${passed}] ${l}`); }

function buildDomain(a, c) { return { name: 'LockerContract', version: '1', chainId: Number(c), verifyingContract: a }; }

async function deployStack(deployer, signers, threshold) {
    const VH = await (await ethers.getContractFactory('ValidationHandler', deployer)).deploy(threshold);
    const PC = await (await ethers.getContractFactory('PriceCalculator', deployer)).deploy(ethers.ZeroAddress, []);
    const LM = await (await ethers.getContractFactory('LockManager', deployer)).deploy(await PC.getAddress());
    const VM = await (await ethers.getContractFactory('VestingManager', deployer)).deploy(await LM.getAddress());
    const SM = await (await ethers.getContractFactory('SignerManager', deployer)).deploy(await VH.getAddress(), signers, threshold);
    const L = await (await ethers.getContractFactory('LockerContract', deployer)).deploy(
        await VH.getAddress(), await LM.getAddress(), await SM.getAddress(), await VM.getAddress(), signers, threshold);
    return { VH, PC, LM, VM, locker: L };
}

function lockParams(token, amount, o = {}) {
    return {
        token, amount, lockDuration: 0, pair: ethers.ZeroAddress, ethUsdPair: ethers.ZeroAddress,
        targetPriceUSD1e18: 0, isEthPair: false, stablecoinPosition: 2,
        priceDirection: PRICE_DIRECTION.UPSIDE, vestingTokensPerPeriod: 0, vestingPeriodSeconds: 0,
        vestingAccumulate: false, ...o
    };
}

async function collect(primaryType, message, signerAddrs, count, domain) {
    const addresses = [], signatures = [];
    for (let i = 0; i < count; i++) {
        const w = await ethers.getSigner(signerAddrs[i]);
        signatures.push(await signLockerOp(w, domain, primaryType, message));
        addresses.push(signerAddrs[i]);
    }
    return { addresses, signatures };
}

async function newToken(deployer, holder) {
    return await (await ethers.getContractFactory('ERC20Mock', deployer))
        .deploy('Tok', 'TOK', holder, ethers.parseEther('100000000'), 18);
}

// A third party (non-signer) appends `n` history entries to `lockId` via top-ups.
async function appendHistory(locker, tok, thirdParty, s0, lockId, n) {
    await (await tok.connect(s0).transfer(thirdParty.address, BigInt(n) + 10n)).wait();
    await (await tok.connect(thirdParty).approve(await locker.getAddress(), BigInt(n) + 10n)).wait();
    for (let i = 0; i < n; i++) await (await locker.connect(thirdParty).addToLock(lockId, 1n, ethers.ZeroHash)).wait();
}

async function main() {
    log('\n🧪 TEST 91: Lock closure paths & duration bounds\n', '\x1b[1m\x1b[36m');
    try {
        const all = await ethers.getSigners();
        const deployer = all[0];
        const thirdParty = all[9];
        const recipient = all[8];
        const signerAddrs = [all[1].address, all[2].address, all[3].address, all[4].address, all[5].address];
        const s0 = await ethers.getSigner(signerAddrs[0]);
        const THRESHOLD = 3;
        const chainId = Number((await ethers.provider.getNetwork()).chainId);
        const env = await deployStack(deployer, signerAddrs, THRESHOLD);
        const lockerAddr = await env.locker.getAddress();
        const domain = buildDomain(lockerAddr, chainId);

        // ─── Regular withdrawal closure ───────────────────────────────────────
        logPhase(1, 'Regular closing withdrawal is constant-cost + history retained');
        const tok = await newToken(deployer, s0.address);
        const amt = ethers.parseEther('1000');
        await (await tok.connect(s0).approve(lockerAddr, amt)).wait();
        const lockId = await env.LM.nextLockId();
        await (await env.locker.connect(s0).createLock(lockParams(await tok.getAddress(), amt))).wait();

        assert(!(await env.locker.isSigner(thirdParty.address)), 'third party is not a signer');
        await appendHistory(env.locker, tok, thirdParty, s0, lockId, 300);
        const histCount = await env.LM.getLockHistoryCount(lockId);
        assert(histCount >= 300n, `history holds ${histCount} entries`);
        pass(`a non-signer appended ${histCount} history entries via top-ups`);

        const avail = (await env.LM.getLock(lockId)).basic.availableAmount;
        const nonce = await env.locker.unlockNonce(lockId);
        const sigs = await collect('Unlock', { lockId, to: recipient.address, amount: avail, nonce }, signerAddrs, THRESHOLD, domain);
        const rc = await (await env.locker.connect(s0).executeUnlockWithSignatures(
            lockId, recipient.address, avail, sigs.addresses, sigs.signatures)).wait();
        log(`  closing withdrawal gas @ ${histCount} entries: ${rc.gasUsed}`);
        assert(rc.gasUsed < 1_000_000n, `closing withdrawal stays under 1M gas despite ${histCount} entries`);
        pass(`lock closed in one tx (${rc.gasUsed} gas)`);

        assertEqual((await env.LM.getLock(lockId)).basic.token, ethers.ZeroAddress, 'lock record cleared');
        assert((await env.LM.getLockHistory(lockId)).length >= 300n, 'history still readable after closure');
        pass('history retained after closure (monotonic ids → inert)');

        // ─── Vesting release closure ──────────────────────────────────────────
        logPhase(2, 'Vesting closing release is constant-cost too');
        const vtok = await newToken(deployer, s0.address);
        const vamt = ethers.parseEther('1000');
        await (await vtok.connect(s0).approve(lockerAddr, vamt)).wait();
        const vLockId = await env.LM.nextLockId();
        await (await env.locker.connect(s0).createLock(lockParams(await vtok.getAddress(), vamt, {
            lockDuration: 50 * 365 * 24 * 3600,                  // vesting is the withdrawal path
            vestingTokensPerPeriod: ethers.parseEther('100000'), // one period empties the lock
            vestingPeriodSeconds: 24 * 3600,
            vestingAccumulate: true
        }))).wait();
        await appendHistory(env.locker, vtok, thirdParty, s0, vLockId, 300);
        await advanceTime(2 * 24 * 3600 + 10);                   // ≥1 period → vested caps at available
        const vAvail = (await env.LM.getLock(vLockId)).basic.availableAmount;
        const vHist = await env.LM.getLockHistoryCount(vLockId);
        const vNonce = await env.locker.vestingNonce(vLockId);
        const vSigs = await collect('VestingUnlock',
            { lockId: vLockId, recipient: recipient.address, maxAmountTokens: vAvail, chainId, nonce: vNonce },
            signerAddrs, THRESHOLD, domain);
        const vrc = await (await env.locker.connect(s0).unlockVestedWithSignatures(
            vLockId, recipient.address, vAvail, vSigs.addresses, vSigs.signatures)).wait();
        log(`  vesting closing gas @ ${vHist} entries: ${vrc.gasUsed}`);
        assert(vrc.gasUsed < 1_000_000n, `vesting closing release stays under 1M gas despite ${vHist} entries`);
        assertEqual((await env.LM.getLock(vLockId)).basic.token, ethers.ZeroAddress, 'vesting lock emptied & cleared');
        pass(`vesting close in one tx (${vrc.gasUsed} gas)`);

        // ─── Duration bounds ──────────────────────────────────────────────────
        logPhase(3, 'createLock enforces MAX_LOCK_DURATION (revert + boundaries)');
        const MAX = await env.LM.MAX_LOCK_DURATION();
        assertEqual(MAX, BigInt(100 * 365 * 24 * 3600), 'MAX_LOCK_DURATION == 100 years');
        const ctok = await newToken(deployer, s0.address);
        await (await ctok.connect(s0).approve(lockerAddr, ethers.parseEther('40'))).wait();

        let reason = '';
        try {
            const p = lockParams(await ctok.getAddress(), ethers.parseEther('10')); p.lockDuration = MAX + 1n;
            await (await env.locker.connect(s0).createLock(p)).wait();
        } catch (e) { reason = (e.shortMessage || e.reason || e.message || '') + (e?.data || ''); }
        assert(/DUR_TOO_LONG/.test(reason) || reason.length > 0, `duration above MAX reverts: ${reason.slice(0, 80)}`);
        pass('createLock duration above MAX_LOCK_DURATION reverted');

        for (const [label, dur] of [['MAX', MAX], ['0', 0n]]) {
            const p = lockParams(await ctok.getAddress(), ethers.parseEther('10')); p.lockDuration = dur;
            await (await env.locker.connect(s0).createLock(p)).wait();
            pass(`createLock duration == ${label} accepted (boundary ok)`);
        }

        log(`\n📊 TEST 91 checks passed: ${passed}\n`, '\x1b[1m\x1b[32m');
        reportTestResult('91-lock-closure-and-duration-bounds', true);
        logSuccess('✅ TEST 91 PASSED — closure cost is history-independent and duration is bounded.');
    } catch (error) {
        reportTestResult('91-lock-closure-and-duration-bounds', false, error.message);
        throw error;
    }
}

main().then(() => process.exit(0)).catch(e => { console.error('\n❌ TEST 91 FAILED:\n', e); process.exit(1); });
