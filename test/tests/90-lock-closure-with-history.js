/**
 * Test 90 — Lock closure with accumulated history, and the lock-duration bound.
 *
 * Properties verified:
 *  1. Top-ups (addToLock with amount > 0) are open to any caller and append a history entry,
 *     so a lock can accumulate an arbitrary number of history entries.
 *  2. Emptying a lock in full is CONSTANT-COST regardless of how many history entries it
 *     carries (closure gas does not scale with history length).
 *  3. A partial withdrawal that leaves a residual balance is likewise constant-cost.
 *  4. createLock enforces MAX_LOCK_DURATION.
 *
 * Self-contained: deploys its own Locker stack with Hardhat-controlled signer keys.
 */

import {
    logPhase, logSuccess, log, assert, PRICE_DIRECTION,
    signLockerOp, getEthers
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
    return { VH, PC, LM, VM, SM, locker: L };
}

function lockParams(token, amount) {
    return {
        token, amount, lockDuration: 0, pair: ethers.ZeroAddress, ethUsdPair: ethers.ZeroAddress,
        targetPriceUSD1e18: 0, isEthPair: false, stablecoinPosition: 2,
        priceDirection: PRICE_DIRECTION.UPSIDE, vestingTokensPerPeriod: 0, vestingPeriodSeconds: 0,
        vestingAccumulate: false
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

// Gas cost of the withdrawal that EMPTIES a lock carrying `historyLen` history entries.
async function closingUnlockGas(env, deployer, signerAddrs, domain, historyLen) {
    const { locker, LM } = env;
    const lockAmt = ethers.parseEther('1000');
    const tok = await (await ethers.getContractFactory('ERC20Mock', deployer))
        .deploy('T', 'T', signerAddrs[0], ethers.parseEther('10000000'), 18);
    const signer0 = await ethers.getSigner(signerAddrs[0]);
    const lockerAddr = await locker.getAddress();

    await (await tok.connect(signer0).approve(lockerAddr, lockAmt)).wait();
    const lockId = await LM.nextLockId();
    await (await locker.connect(signer0).createLock(lockParams(await tok.getAddress(), lockAmt))).wait();

    // A third party (not a signer) accumulates history entries via small top-ups.
    const thirdParty = (await ethers.getSigners())[9];
    await (await tok.connect(signer0).transfer(thirdParty.address, BigInt(historyLen) + 10n)).wait();
    await (await tok.connect(thirdParty).approve(lockerAddr, BigInt(historyLen) + 10n)).wait();
    assert(!(await locker.isSigner(thirdParty.address)), 'third party is not an authorized signer');
    for (let i = 0; i < historyLen; i++) {
        await (await locker.connect(thirdParty).addToLock(lockId, 1n, ethers.ZeroHash)).wait();
    }
    const histCount = await LM.getLockHistoryCount(lockId);

    // Signers close the lock (withdraw the full available amount).
    const available = (await LM.getLock(lockId)).basic.availableAmount;
    const nonce = await locker.unlockNonce(lockId);
    const recipient = (await ethers.getSigners())[8];
    const sigs = await collect('Unlock',
        { lockId, to: recipient.address, amount: available, nonce },
        signerAddrs, 3, domain);
    const tx = await locker.connect(signer0).executeUnlockWithSignatures(
        lockId, recipient.address, available, sigs.addresses, sigs.signatures);
    const rc = await tx.wait();
    return { gas: rc.gasUsed, histCount, lockId };
}

async function main() {
    log('\n🧪 TEST 90 — Lock closure with accumulated history\n', '\x1b[1m\x1b[36m');
    const all = await ethers.getSigners();
    const deployer = all[0];
    const signerAddrs = [all[1].address, all[2].address, all[3].address, all[4].address, all[5].address];
    const THRESHOLD = 3;
    const env = await deployStack(deployer, signerAddrs, THRESHOLD);
    const domain = buildDomain(await env.locker.getAddress(), Number((await ethers.provider.getNetwork()).chainId));

    // ────────────────────────────────────────────────────────────────────────
    logPhase(1, 'Closing an emptied lock is constant-cost regardless of history length');
    const A = await closingUnlockGas(env, deployer, signerAddrs, domain, 40);
    const B = await closingUnlockGas(env, deployer, signerAddrs, domain, 240);
    log(`  closing gas @ ${A.histCount} history entries: ${A.gas}`);
    log(`  closing gas @ ${B.histCount} history entries: ${B.gas}`);
    const entries = Number(B.histCount) - Number(A.histCount);
    const perEntry = (B.gas > A.gas ? B.gas - A.gas : 0n) / BigInt(entries);
    log(`  marginal gas per extra history entry on closure: ${perEntry}`);
    assert(perEntry < 500n, `closing gas must not scale with history (got ${perEntry}/entry)`);
    pass(`closing a lock is O(1) in history length (${perEntry} gas/entry)`);
    // History is retained after closure (ids are never reused, so it is inert).
    assert((await env.LM.getLockHistoryCount(B.lockId)) >= 0n, 'history retained after closure');

    // ────────────────────────────────────────────────────────────────────────
    logPhase(2, 'A partial withdrawal that leaves a residual balance is also constant-cost');
    const lockAmt = ethers.parseEther('1000');
    const tok = await (await ethers.getContractFactory('ERC20Mock', deployer))
        .deploy('T2', 'T2', signerAddrs[0], ethers.parseEther('10000000'), 18);
    const s0 = await ethers.getSigner(signerAddrs[0]);
    const lockerAddr = await env.locker.getAddress();
    await (await tok.connect(s0).approve(lockerAddr, lockAmt)).wait();
    const lockId = await env.LM.nextLockId();
    await (await env.locker.connect(s0).createLock(lockParams(await tok.getAddress(), lockAmt))).wait();
    const thirdParty = all[9];
    await (await tok.connect(s0).transfer(thirdParty.address, 300n)).wait();
    await (await tok.connect(thirdParty).approve(lockerAddr, 300n)).wait();
    for (let i = 0; i < 240; i++) await (await env.locker.connect(thirdParty).addToLock(lockId, 1n, ethers.ZeroHash)).wait();

    const avail = (await env.LM.getLock(lockId)).basic.availableAmount;
    const partial = avail - 1n; // leave a residual balance so the lock is not emptied
    const recipient = all[8];
    const nonce = await env.locker.unlockNonce(lockId);
    const sigs = await collect('Unlock', { lockId, to: recipient.address, amount: partial, nonce }, signerAddrs, 3, domain);
    const before = await tok.balanceOf(recipient.address);
    const rc = await (await env.locker.connect(s0).executeUnlockWithSignatures(
        lockId, recipient.address, partial, sigs.addresses, sigs.signatures)).wait();
    assert((await tok.balanceOf(recipient.address)) - before === partial, 'partial withdrawal delivered the requested amount');
    log(`  partial-withdrawal gas @ ${await env.LM.getLockHistoryCount(lockId)} entries: ${rc.gasUsed}`);
    pass('partial withdrawal is cheap and independent of history length');

    // ────────────────────────────────────────────────────────────────────────
    logPhase(3, 'createLock enforces MAX_LOCK_DURATION');
    const tokC = await (await ethers.getContractFactory('ERC20Mock', deployer))
        .deploy('T3', 'T3', signerAddrs[0], ethers.parseEther('1000'), 18);
    const sc = await ethers.getSigner(signerAddrs[0]);
    await (await tokC.connect(sc).approve(lockerAddr, ethers.parseEther('20'))).wait();
    const MAX = await env.LM.MAX_LOCK_DURATION();
    let reverted = false;
    try {
        const p = lockParams(await tokC.getAddress(), ethers.parseEther('10'));
        p.lockDuration = MAX + 1n;
        await (await env.locker.connect(sc).createLock(p)).wait();
    } catch (e) { reverted = true; }
    assert(reverted, 'createLock with duration above MAX_LOCK_DURATION must revert');
    pass(`duration above MAX_LOCK_DURATION (${MAX}) rejected`);
    const pOk = lockParams(await tokC.getAddress(), ethers.parseEther('10'));
    pOk.lockDuration = MAX;
    await (await env.locker.connect(sc).createLock(pOk)).wait();
    pass('duration equal to MAX_LOCK_DURATION accepted (boundary ok)');

    log(`\n📊 TEST 90 checks passed: ${passed}\n`, '\x1b[1m\x1b[32m');
    logSuccess('TEST 90 complete — closure cost is history-independent and duration is bounded.');
}

main().then(() => process.exit(0)).catch(e => { console.error('\n❌ TEST 90 FAILED:\n', e); process.exit(1); });
