/**
 * Test 36: Signature Malleability Protection
 * 
 * Verifies that malleable signatures (with s in upper half of secp256k1 curve)
 * are rejected by the ValidationHandler's _recoverSignerOptimized function.
 * 
 * The secp256k1 curve order n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
 * For any valid signature (v, r, s), a "flipped" signature (v', r, n-s) also recovers
 * to the same address. EIP-2 mandates s <= n/2 to prevent this.
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
    lockerOpKey,
    signLockerOp
} from '../core/utils.js';

const ethers = getEthers();

// secp256k1 curve order
const SECP256K1_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
const SECP256K1_N_DIV_2 = BigInt('0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0');

async function main() {
    log('\n🧪 TEST 36: SIGNATURE MALLEABILITY PROTECTION\n', '\x1b[1m\x1b[36m');

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

        // Distribute ETH to signers
        for (const wallet of signersWallets) {
            const tx = await deployer.sendTransaction({
                to: wallet.address,
                value: ethers.parseEther('1.0')
            });
            await tx.wait();
        }
        logSuccess('Distributed ETH to signers');

        // Deploy contracts
        logSection('Deploying contracts...');
        const ValidationHandler = await ethers.getContractFactory('ValidationHandler');
        const validationHandler = await ValidationHandler.deploy(3);
        await validationHandler.waitForDeployment();
        const validationHandlerAddress = await validationHandler.getAddress();

        const PriceCalculator = await ethers.getContractFactory('PriceCalculator');
        const priceCalculator = await PriceCalculator.deploy(ethers.ZeroAddress, []);
        await priceCalculator.waitForDeployment();

        const LockManager = await ethers.getContractFactory('LockManager');
        const lockManager = await LockManager.deploy(await priceCalculator.getAddress());
        await lockManager.waitForDeployment();

        const VestingManager = await ethers.getContractFactory('VestingManager');
        const vestingManager = await VestingManager.deploy(
            await lockManager.getAddress()
        );
        await vestingManager.waitForDeployment();

        const SignerManager = await ethers.getContractFactory('SignerManager');
        const signerManager = await SignerManager.deploy(
            validationHandlerAddress,
            signerAddresses,
            3
        );
        await signerManager.waitForDeployment();

        const LockerContract = await ethers.getContractFactory('LockerContract');
        const locker = await LockerContract.deploy(
            validationHandlerAddress,
            await lockManager.getAddress(),
            await signerManager.getAddress(),
            await vestingManager.getAddress(),
            signerAddresses,
            3
        );
        await locker.waitForDeployment();
        const lockerAddress = await locker.getAddress();
        logSuccess(`Deployed LockerContract at ${lockerAddress}`);

        // ========================================
        // PHASE 1: Normal signature works
        // ========================================
        logSection('PHASE 1: Verify normal signatures work');

        const message = { newThreshold: 3, nonce: 0 };
        const opKey = lockerOpKey('UpdateThreshold', message);

        const domain = {
            name: "LockerContract",
            version: "1",
            chainId: Number((await ethers.provider.getNetwork()).chainId),
            verifyingContract: lockerAddress
        };

        // Sign with signer 0 over the decoded UpdateThreshold struct (M-1)
        const normalSig = await signLockerOp(signersWallets[0], domain, 'UpdateThreshold', message);
        log(`  Normal signature: ${normalSig.substring(0, 30)}...`);

        // Extract r, s, v from normal signature
        const normalS = '0x' + normalSig.substring(66, 130);

        const sValue = BigInt(normalS);
        log(`  s value: ${sValue.toString(16).substring(0, 20)}...`);
        log(`  s <= n/2: ${sValue <= SECP256K1_N_DIV_2}`);
        assert(sValue <= SECP256K1_N_DIV_2, 'ethers.js should produce lower-half s values');
        logSuccess('Normal signature has s in lower half (as expected from ethers.js)');

        // Verify the normal signature passes recovery via verifySignatureOnly
        // (view — exercises the same _recoverSignerOptimized path as the atomic flow).
        await validationHandler.verifySignatureOnly(
            opKey,
            signersWallets[0].address,
            normalSig
        );
        logSuccess('Normal signature accepted by contract');

        // ========================================
        // PHASE 2: Malleable signature is rejected
        // ========================================
        logSection('PHASE 2: Verify malleable signatures are rejected');

        // Create a new opKey for signer 1 (fresh, not yet approved)
        const message2 = { newThreshold: 3, nonce: 1 }; // different nonce
        const opKey2 = lockerOpKey('UpdateThreshold', message2);

        // Sign with signer 1
        const normalSig2 = await signLockerOp(signersWallets[1], domain, 'UpdateThreshold', message2);

        // Extract s and flip it: s' = n - s (upper half)
        const normalS2 = BigInt('0x' + normalSig2.substring(66, 130));
        const flippedS = SECP256K1_N - normalS2;

        log(`  Original s: ${normalS2.toString(16).substring(0, 20)}...`);
        log(`  Flipped s:  ${flippedS.toString(16).substring(0, 20)}...`);
        log(`  Flipped s > n/2: ${flippedS > SECP256K1_N_DIV_2}`);
        assert(flippedS > SECP256K1_N_DIV_2, 'Flipped s must be in upper half');

        // Flip v: if v=27 then v'=28, if v=28 then v'=27
        const normalVByte2 = parseInt(normalSig2.substring(130, 132), 16);
        const flippedV = normalVByte2 === 27 ? 28 : 27;

        // Reconstruct the malleable signature
        const flippedSHex = flippedS.toString(16).padStart(64, '0');
        const flippedVHex = flippedV.toString(16).padStart(2, '0');
        const malleableSig = normalSig2.substring(0, 66) + flippedSHex + flippedVHex;

        log(`  Malleable sig: ${malleableSig.substring(0, 30)}...`);

        // Try to use the malleable signature — should REVERT
        try {
            await validationHandler.verifySignatureOnly(
                opKey2,
                signersWallets[1].address,
                malleableSig
            );
            log('❌ ERROR: Malleable signature was accepted! This should have reverted!');
            throw new Error('Malleable signature should have been rejected');
        } catch (error) {
            if (error.message.includes('Malleable signature should have been rejected')) {
                throw error;
            }
            assert(
                error.message.includes("ERR_006") || error.message.includes("Invalid signature 's' value"),
                `Expected ERR_006 but got: ${error.message}`
            );
            logSuccess(`Malleable signature correctly rejected: ERR_006`);
        }

        // ========================================
        // PHASE 3: Verify normal signature still works for signer 1
        // ========================================
        logSection('PHASE 3: Verify normal signature still works after malleability check');

        await validationHandler.verifySignatureOnly(
            opKey2,
            signersWallets[1].address,
            normalSig2
        );
        logSuccess('Normal signature for signer 1 accepted (malleability check did not break normal flow)');

        logSuccess('\n🎉 TEST 36 PASSED: Signature malleability protection verified!\n');
        reportTestResult('36-signature-malleability', true);

    } catch (error) {
        reportTestResult('36-signature-malleability', false, error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
