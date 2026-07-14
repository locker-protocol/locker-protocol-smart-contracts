/**
 * Test 39: SignerManager + Access Control Coverage
 *
 * Tests untested public functions:
 * - canRemoveSigner (view — positive + negative)
 * - addToLock with amount=0 (auto-detect surplus, single-lock only)
 * - Direct access control checks on critical functions
 */

import {
    logPhase,
    logSection,
    logSuccess,
    log,
    reportTestResult,
    getEthers,
    assert,
    assertEqual
} from '../core/utils.js';

const ethers = getEthers();

async function main() {
    log('\n🧪 TEST 39: SIGNER MANAGER + ACCESS CONTROL COVERAGE\n', '\x1b[1m\x1b[36m');

    try {
        const [deployer, outsider] = await ethers.getSigners();

        // Generate 5 signer wallets
        const signersWallets = [];
        for (let i = 0; i < 5; i++) {
            signersWallets.push(ethers.Wallet.createRandom().connect(ethers.provider));
        }
        const signerAddresses = signersWallets.map(w => w.address);

        // Distribute ETH
        for (const w of signersWallets) {
            await (await deployer.sendTransaction({ to: w.address, value: ethers.parseEther('1') })).wait();
        }

        // Deploy contracts
        logSection('Deploying contracts');
        const PC = await ethers.getContractFactory('PriceCalculator');
        const pc = await PC.deploy(ethers.ZeroAddress, []);
        await pc.waitForDeployment();

        const VH = await ethers.getContractFactory('ValidationHandler');
        const vh = await VH.deploy(3);
        await vh.waitForDeployment();
        const vhAddr = await vh.getAddress();

        const LM = await ethers.getContractFactory('LockManager');
        const lm = await LM.deploy(await pc.getAddress());
        await lm.waitForDeployment();
        const lmAddr = await lm.getAddress();

        const VMgr = await ethers.getContractFactory('VestingManager');
        const vmgr = await VMgr.deploy(lmAddr);
        await vmgr.waitForDeployment();

        const SM = await ethers.getContractFactory('SignerManager');
        const sm = await SM.deploy(vhAddr, signerAddresses, 3);
        await sm.waitForDeployment();
        const smAddr = await sm.getAddress();

        const LC = await ethers.getContractFactory('LockerContract');
        const locker = await LC.deploy(
            vhAddr,
            lmAddr,
            smAddr,
            await vmgr.getAddress(),
            signerAddresses,
            3
        );
        await locker.waitForDeployment();
        const lockerAddress = await locker.getAddress();
        logSuccess(`LockerContract deployed at ${lockerAddress}`);

        // Deploy test token
        const ERC20Mock = await ethers.getContractFactory('ERC20Mock');
        const token = await ERC20Mock.deploy('Test', 'TST', deployer.address, ethers.parseEther('1000000'), 18);
        await token.waitForDeployment();
        const tokenAddr = await token.getAddress();

        // ========================================
        // PHASE 1: canRemoveSigner — positive + negative
        // ========================================
        logPhase(1, 'canRemoveSigner');

        // Positive — signer exists and count > MIN_SIGNERS (5 > 3)
        const canRemove = await sm.canRemoveSigner(signerAddresses[0]);
        assert(canRemove, 'Should be able to remove signer when count > MIN');
        logSuccess('canRemoveSigner returns true for valid signer');

        // Negative — non-signer
        const canRemoveNonSigner = await sm.canRemoveSigner(deployer.address);
        assert(!canRemoveNonSigner, 'Should not be able to remove non-signer');
        logSuccess('canRemoveSigner returns false for non-signer');

        // ========================================
        // PHASE 2: addToLock with amount=0 (auto-detect surplus)
        // ========================================
        logPhase(2, 'addToLock with amount=0 (auto-detect)');

        // First, create a lock
        const lockAmount = ethers.parseEther('100');
        await (await token.transfer(signersWallets[0].address, lockAmount)).wait();
        await (await token.connect(signersWallets[0]).approve(lockerAddress, lockAmount)).wait();

        await (await locker.connect(signersWallets[0]).createLock({
            token: tokenAddr,
            amount: lockAmount,
            lockDuration: 3600,
            pair: ethers.ZeroAddress,
            ethUsdPair: ethers.ZeroAddress,
            targetPriceUSD1e18: 0,
            isEthPair: false,
            stablecoinPosition: 0,
            priceDirection: 0,
            vestingTokensPerPeriod: 0,
            vestingPeriodSeconds: 0,
            vestingAccumulate: false
        })).wait();
        logSuccess('Lock created with 100 TST');

        // Send extra tokens directly to LockerContract (surplus)
        const surplusAmount = ethers.parseEther('50');
        await (await token.transfer(lockerAddress, surplusAmount)).wait();
        logSuccess('Sent 50 TST surplus directly to LockerContract');

        // addToLock with amount=0 should detect the surplus
        await (await locker.connect(signersWallets[0]).addToLock(1, 0, ethers.ZeroHash)).wait();
        logSuccess('addToLock(lockId=1, amount=0) succeeded — surplus auto-detected');

        // Verify lock now has 150 TST
        const lockData = await locker.locks(1);
        assertEqual(lockData.basic.availableAmount, ethers.parseEther('150'), 'Lock should have 150 TST');
        logSuccess('Lock amount correctly updated to 150 TST');

        // addToLock(0) — negative: no surplus left
        try {
            await locker.connect(signersWallets[0]).addToLock(1, 0, ethers.ZeroHash);
            throw new Error('Should revert');
        } catch (e) {
            assert(e.message.includes('No additional amount'), `Expected 'No additional amount' but got: ${e.message}`);
            logSuccess('addToLock(0) reverts when no surplus');
        }

        // ========================================
        // PHASE 3: Access control — critical functions
        // ========================================
        logPhase(3, 'Access control on critical functions');

        // LockManager.setLocker — should fail (already initialized)
        try {
            await lm.setLocker(deployer.address);
            throw new Error('Should revert');
        } catch (e) {
            assert(e.message.includes('Z'), `Expected init revert but got: ${e.message}`);
            logSuccess('LockManager.setLocker reverts when already initialized');
        }

        // ValidationHandler.setLocker — should fail (already initialized)
        try {
            await vh.setLocker(deployer.address);
            throw new Error('Should revert');
        } catch (e) {
            if (e.message.includes('Should revert')) throw e;
            // Combined require(!initialized && _locker != address(0)) — Hardhat may not infer reason
            logSuccess('ValidationHandler.setLocker reverts when already initialized');
        }

        // VestingManager.setLocker — should fail (already initialized)
        try {
            await vmgr.setLocker(deployer.address);
            throw new Error('Should revert');
        } catch (e) {
            if (e.message.includes('Should revert')) throw e;
            logSuccess('VestingManager.setLocker reverts when already initialized');
        }

        // SignerManager.setLocker — should fail (already initialized)
        try {
            await sm.setLocker(deployer.address);
            throw new Error('Should revert');
        } catch (e) {
            if (e.message.includes('Should revert')) throw e;
            logSuccess('SignerManager.setLocker reverts when already initialized');
        }

        // LockManager.createLock — only locker
        try {
            await lm.connect(deployer).createLock(tokenAddr, 1, 3600, ethers.ZeroAddress, ethers.ZeroAddress, 0, false, 0, 0);
            throw new Error('Should revert');
        } catch (e) {
            if (e.message.includes('Should revert')) throw e;
            logSuccess('LockManager.createLock reverts for non-locker');
        }

        // SignerManager.addSignerDirect — only locker
        try {
            await sm.connect(deployer).addSignerDirect(outsider.address);
            throw new Error('Should revert');
        } catch (e) {
            assert(e.message.includes('Only locker allowed'), `Expected 'Only locker allowed' but got: ${e.message}`);
            logSuccess('SignerManager.addSignerDirect reverts for non-locker');
        }

        // SignerManager.removeSignerDirect — only locker
        try {
            await sm.connect(deployer).removeSignerDirect(signerAddresses[0]);
            throw new Error('Should revert');
        } catch (e) {
            assert(e.message.includes('Only locker allowed'), `Expected 'Only locker allowed' but got: ${e.message}`);
            logSuccess('SignerManager.removeSignerDirect reverts for non-locker');
        }

        // The contracts expose no owner role — the ABI must contain no owner functions
        assert(locker.owner === undefined, 'owner() must not exist');
        assert(locker.updateThreshold === undefined, 'owner-direct updateThreshold must not exist');
        assert(locker.executeRescue === undefined, 'owner-only executeRescue must not exist');
        assert(locker.proposeNewOwnerWithSignatures === undefined, 'proposeNewOwnerWithSignatures must not exist');
        assert(sm.owner === undefined, 'SignerManager.owner must not exist');
        assert(sm.setOwner === undefined, 'SignerManager.setOwner must not exist');
        logSuccess('No owner role exposed by LockerContract/SignerManager');

        // LockerContract.executeRescueWithSignatures — requires multi-sig quorum
        try {
            await locker.connect(signersWallets[0]).executeRescueWithSignatures(
                tokenAddr, outsider.address, 1, [], []
            );
            throw new Error('Should revert');
        } catch (e) {
            if (e.message.includes('Should revert')) throw e;
            logSuccess('executeRescueWithSignatures reverts without quorum');
        }

        // LockerContract.executeRescueNativeWithSignatures — requires multi-sig quorum
        const ForceSend = await ethers.getContractFactory('ForceSend');
        const forceSend = await ForceSend.deploy();
        await forceSend.waitForDeployment();
        await (await forceSend.forceSend(lockerAddress, { value: 1000n })).wait();
        try {
            await locker.connect(signersWallets[0]).executeRescueNativeWithSignatures(
                outsider.address, 1000n, [], []
            );
            throw new Error('Should revert');
        } catch (e) {
            if (e.message.includes('Should revert')) throw e;
            logSuccess('executeRescueNativeWithSignatures reverts without quorum');
        }

        // ValidationHandler.setThreshold — only locker or signer manager
        try {
            await vh.connect(deployer).setThreshold(5);
            throw new Error('Should revert');
        } catch (e) {
            if (e.message.includes('Should revert')) throw e;
            logSuccess('ValidationHandler.setThreshold reverts for unauthorized caller');
        }

        // ValidationHandler.markAsExecuted — only locker or signer manager
        const fakeOpKey = ethers.solidityPackedKeccak256(['string'], ['FAKE']);
        try {
            await vh.connect(deployer).markAsExecuted(fakeOpKey);
            throw new Error('Should revert');
        } catch (e) {
            if (e.message.includes('Should revert')) throw e;
            logSuccess('ValidationHandler.markAsExecuted reverts for unauthorized caller');
        }

        logSuccess('\n🎉 TEST 39 PASSED: SignerManager + Access Control coverage complete!\n');
        reportTestResult('39-signer-access-coverage', true);

    } catch (error) {
        reportTestResult('39-signer-access-coverage', false, error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
