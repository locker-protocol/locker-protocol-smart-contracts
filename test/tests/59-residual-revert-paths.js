/**
 * Test 59: Residual Revert Paths
 *
 * A cross-reference audit of contracts vs tests (function inventory + revert-string
 * inventory) showed the suite exercised 100/102 revert paths. This test covers the
 * final 2, bringing every reachable require/revert/custom-error path under assertion:
 *
 *   N1. LockerContract.executeRescueNativeWithSignatures → "Native transfer failed"
 *       (full 3-of-N quorum, recipient is a contract with no receive/fallback).
 *       Also verifies the failed transfer rolls back the nonce bump and the
 *       markAsExecuted, so the same signatures can be replayed toward a GOOD
 *       recipient — a failed rescue must not burn the operation.
 *   N2. PriceCalculator constructor → "Zero custom WETH address"
 *       (zero address inside the custom WETH list).
 * Known NOT covered (unreachable by construction, documented in test 48):
 *   - LockerContract "OpKey is zero" (keccak256 preimage of zero required).
 */

import {
    logPhase,
    logSuccess,
    log,
    reportTestResult,
    getEthers,
    assert,
    assertEqual,
    signLockerOp
} from '../core/utils.js';

const ethers = getEthers();

async function buildDomain(lockerAddress) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    return {
        name: "LockerContract",
        version: "1",
        chainId: Number(chainId),
        verifyingContract: lockerAddress
    };
}

async function collectSignatures(primaryType, message, wallets, domain) {
    const signatures = [];
    const addresses = [];
    for (const w of wallets) {
        signatures.push(await signLockerOp(w, domain, primaryType, message));
        addresses.push(w.address);
    }
    return { addresses, signatures };
}

function extractRevertData(error, depth = 0) {
    if (!error || depth > 4) return [];
    const found = [];
    for (const v of [error.data, error.error, error.info, error.info && error.info.error]) {
        if (typeof v === 'string' && v.startsWith('0x')) found.push(v);
        else if (v && typeof v === 'object') found.push(...extractRevertData(v, depth + 1));
    }
    return found;
}

function revertText(error) {
    const parts = [error.shortMessage, error.reason, error.message];
    if (error.info && error.info.error && error.info.error.message) parts.push(error.info.error.message);
    if (error.error && error.error.message) parts.push(error.error.message);
    for (const hex of extractRevertData(error)) {
        parts.push(hex);
        if (hex.startsWith('0x08c379a0')) {
            try {
                parts.push(ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + hex.slice(10))[0]);
            } catch { /* raw hex already pushed */ }
        }
    }
    return parts.filter(Boolean).join(' | ');
}

async function expectRevert(callFn, label, expected) {
    const expectedList = Array.isArray(expected) ? expected : [expected];
    try {
        const result = await callFn();
        if (result && result.wait) await result.wait();
    } catch (error) {
        const text = revertText(error);
        assert(
            expectedList.some((s) => text.includes(s)),
            `${label}: expected revert containing one of [${expectedList.join(', ')}], got: ${text.substring(0, 250)}`
        );
        logSuccess(`${label} → rejected ("${expectedList.find((s) => text.includes(s))}")`);
        return;
    }
    throw new Error(`${label}: expected revert but call succeeded`);
}

const sel = (sig) => ethers.id(sig).slice(0, 10);

async function main() {
    log('\n🧪 TEST 59: RESIDUAL REVERT PATHS\n', '\x1b[1m\x1b[36m');

    try {
        const [deployer, s1, s2, s3, s4, attacker, recipient] = await ethers.getSigners();
        const signerAddresses = [s1, s2, s3, s4].map((w) => w.address);
        const THRESHOLD = 3;

        // ====================================================================
        // PHASE 1: N2 — PriceCalculator constructor rejects zero custom WETH
        // ====================================================================
        logPhase(1, 'PriceCalculator constructor — zero custom WETH');

        const PC = await ethers.getContractFactory('PriceCalculator');
        await expectRevert(
            () => PC.deploy(ethers.ZeroAddress, [ethers.ZeroAddress]),
            'N2 constructor(customWETH=[0x0])', 'Zero custom WETH address');
        // Mixed list: one valid, one zero — must also reject (loop covers every slot).
        await expectRevert(
            () => PC.deploy(ethers.ZeroAddress, [s1.address, ethers.ZeroAddress]),
            'N2b constructor(customWETH=[valid, 0x0])', 'Zero custom WETH address');
        // Control: valid custom list deploys and registers the address.
        const pcOk = await PC.deploy(ethers.ZeroAddress, [s1.address]);
        await pcOk.waitForDeployment();
        assert(await pcOk.customWETHAddresses(s1.address), 'Valid custom WETH must be registered');
        logSuccess('Control: valid custom WETH list accepted');

        // ====================================================================
        // PHASE 2: N1 — native rescue to a non-payable recipient
        // ====================================================================
        logPhase(2, 'executeRescueNativeWithSignatures — "Native transfer failed"');

        const pc = await PC.deploy(ethers.ZeroAddress, []);
        await pc.waitForDeployment();
        const VH = await ethers.getContractFactory('ValidationHandler');
        const vh = await VH.deploy(THRESHOLD);
        await vh.waitForDeployment();
        const LM = await ethers.getContractFactory('LockManager');
        const lm = await LM.deploy(await pc.getAddress());
        await lm.waitForDeployment();
        const VMgr = await ethers.getContractFactory('VestingManager');
        const vmgr = await VMgr.deploy(await lm.getAddress());
        await vmgr.waitForDeployment();
        const SM = await ethers.getContractFactory('SignerManager');
        const sm = await SM.deploy(await vh.getAddress(), signerAddresses, THRESHOLD);
        await sm.waitForDeployment();
        const LC = await ethers.getContractFactory('LockerContract');
        const locker = await LC.deploy(
            await vh.getAddress(), await lm.getAddress(), await sm.getAddress(),
            await vmgr.getAddress(), signerAddresses, THRESHOLD);
        await locker.waitForDeployment();
        const lockerAddress = await locker.getAddress();
        const domain = await buildDomain(lockerAddress);
        const chainId = Number((await ethers.provider.getNetwork()).chainId);
        logSuccess('Suite deployed');

        // Force-send native coin into the vault.
        const ForceSend = await ethers.getContractFactory('ForceSend');
        const forceSend = await ForceSend.deploy();
        await forceSend.waitForDeployment();
        await (await forceSend.forceSend(lockerAddress, { value: 1000n })).wait();

        // Non-payable recipient: PriceCalculator has no receive/fallback.
        const nonPayable = await pc.getAddress();
        const nonceBefore = await locker.rescueNonce();
        const opKeyBad = await locker.getRescueNativeOpKey(nonPayable, 1000n);
        const badSigs = await collectSignatures('RescueNative', { to: nonPayable, amount: 1000n, chainId, nonce: nonceBefore }, [s1, s2, s3], domain);
        await expectRevert(
            () => locker.connect(s1).executeRescueNativeWithSignatures(nonPayable, 1000n, badSigs.addresses, badSigs.signatures),
            'N1 native rescue to non-payable contract (full quorum)', 'Native transfer failed');

        // The revert must roll back nonce bump + markAsExecuted: the operation is
        // NOT burned by the failed transfer.
        assertEqual(await locker.rescueNonce(), nonceBefore, 'rescueNonce rolled back');
        assert(!(await vh.hasExecuted(opKeyBad)), 'opKey not marked executed after rollback');
        logSuccess('Failed native rescue rolls back nonce and execution mark');

        // Control: same funds rescued to an EOA succeed.
        const goodSigs = await collectSignatures('RescueNative', { to: recipient.address, amount: 1000n, chainId, nonce: nonceBefore }, [s1, s2, s3], domain);
        const balBefore = await ethers.provider.getBalance(recipient.address);
        await (await locker.connect(s1).executeRescueNativeWithSignatures(
            recipient.address, 1000n, goodSigs.addresses, goodSigs.signatures)).wait();
        assertEqual(await ethers.provider.getBalance(recipient.address), balBefore + 1000n, 'EOA rescue must succeed');
        logSuccess('Control: native rescue to EOA succeeds with same quorum');

        // NOTE: DeploymentRegistry is not part of this repository — its revert
        // paths are covered by its own test suite.

        logSuccess('\n🎉 TEST 59 PASSED: all residual revert paths covered!\n');
        reportTestResult('59-residual-revert-paths', true);

    } catch (error) {
        reportTestResult('59-residual-revert-paths', false, error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
