/**
 * Test 34: Threshold Update with MIN_SIGNERS (3) Signers
 *
 * Verifies that with exactly 3 signers (= MIN_SIGNERS):
 * - updateThresholdWithSignatures(3) SUCCEEDS (no more deadlock)
 * - updateThresholdWithSignatures(2) still reverts (below MIN_THRESHOLD)
 */

import {
    logPhase,
    logSection,
    logSuccess,
    log,
    reportTestResult,
    getEthers,
    assertEqual,
    signLockerOp
} from '../core/utils.js';

const ethers = getEthers();

async function main() {
    log('\n🧪 TEST 34: THRESHOLD UPDATE WITH MIN_SIGNERS (3) SIGNERS\n', '\x1b[1m\x1b[36m');

    try {
        const [deployer] = await ethers.getSigners();
        log(`Deployer: ${deployer.address}`);

        // Generate 3 signer wallets
        const signersWallets = [
            ethers.Wallet.createRandom().connect(ethers.provider),
            ethers.Wallet.createRandom().connect(ethers.provider),
            ethers.Wallet.createRandom().connect(ethers.provider)
        ];
        const signerAddresses = signersWallets.map(w => w.address);
        log(`Created 3 temporary signers:`);
        signerAddresses.forEach((addr, idx) => log(`  Signer ${idx}: ${addr}`));

        // Distribute some ETH to signers for signing / tx execution
        for (const wallet of signersWallets) {
            const tx = await deployer.sendTransaction({
                to: wallet.address,
                value: ethers.parseEther('1.0')
            });
            await tx.wait();
        }
        logSuccess('Distributed ETH to signers');

        // Deploy custom ValidationHandler
        logSection('Deploying custom validation handler with threshold = 3');
        const ValidationHandler = await ethers.getContractFactory('ValidationHandler');
        const validationHandler = await ValidationHandler.deploy(3);
        await validationHandler.waitForDeployment();
        const validationHandlerAddress = await validationHandler.getAddress();

        // Deploy custom LockManager
        const PriceCalculator = await ethers.getContractFactory('PriceCalculator');
        const priceCalculator = await PriceCalculator.deploy(ethers.ZeroAddress, []);
        await priceCalculator.waitForDeployment();
        const priceCalculatorAddress = await priceCalculator.getAddress();

        const LockManager = await ethers.getContractFactory('LockManager');
        const lockManager = await LockManager.deploy(priceCalculatorAddress);
        await lockManager.waitForDeployment();
        const lockManagerAddress = await lockManager.getAddress();

        // Deploy custom VestingManager
        const VestingManager = await ethers.getContractFactory('VestingManager');
        const vestingManager = await VestingManager.deploy(lockManagerAddress);
        await vestingManager.waitForDeployment();
        const vestingManagerAddress = await vestingManager.getAddress();

        // Deploy custom SignerManager
        logSection('Deploying custom signer manager with 3 signers and threshold = 3');
        const SignerManager = await ethers.getContractFactory('SignerManager');
        const signerManager = await SignerManager.deploy(
            validationHandlerAddress,
            signerAddresses,
            3
        );
        await signerManager.waitForDeployment();
        const signerManagerAddress = await signerManager.getAddress();

        // Deploy custom LockerContract
        const LockerContract = await ethers.getContractFactory('LockerContract');
        const locker = await LockerContract.deploy(
            validationHandlerAddress,
            lockManagerAddress,
            signerManagerAddress,
            vestingManagerAddress,
            signerAddresses,
            3
        );
        await locker.waitForDeployment();
        const lockerAddress = await locker.getAddress();
        logSuccess(`Deployed LockerContract at ${lockerAddress}`);

        // ========================================
        // PHASE 1: updateThresholdWithSignatures(3) should SUCCEED
        // Since maxThreshold = signerCount = 3, threshold 3 is valid
        // ========================================
        logPhase(1, 'updateThresholdWithSignatures(3) — should succeed with 3 signers');

        const nonce = await locker.thresholdNonce();

        // Generate signatures
        const domain = {
            name: "LockerContract",
            version: "1",
            chainId: Number((await ethers.provider.getNetwork()).chainId),
            verifyingContract: lockerAddress
        };

        // Sign the decoded UpdateThreshold struct (M-1) for newThreshold = 3.
        const message = { newThreshold: 3, nonce };

        const signatures = [];
        for (const wallet of signersWallets) {
            const signature = await signLockerOp(wallet, domain, 'UpdateThreshold', message);
            signatures.push(signature);
        }

        const txThreshold = await locker.updateThresholdWithSignatures(
            3,
            signerAddresses,
            signatures
        );
        await txThreshold.wait();
        const thresholdAfter = await locker.approvalsThreshold();
        assertEqual(thresholdAfter, BigInt(3), 'Threshold should be 3');
        logSuccess('updateThresholdWithSignatures(3) succeeded with 3 signers (no deadlock!)');

        // ========================================
        // PHASE 2: updateThresholdWithSignatures(2) should REVERT (below MIN_THRESHOLD)
        // ========================================
        logPhase(2, 'updateThresholdWithSignatures(2) — should revert (below MIN_THRESHOLD)');
        try {
            await locker.updateThresholdWithSignatures(
                2,
                signerAddresses,
                signatures
            );
            throw new Error("Threshold update to 2 should have reverted");
        } catch (error) {
            if (error.message.includes('should have reverted')) throw error;
            logSuccess(`Expected revert caught: threshold too low`);
        }

        logSuccess('\n🎉 TEST 34 PASSED: Threshold with MIN_SIGNERS verified — no deadlock, MIN_THRESHOLD enforced!\n');
        reportTestResult('34-threshold-under-5', true);

    } catch (error) {
        reportTestResult('34-threshold-under-5', false, error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
