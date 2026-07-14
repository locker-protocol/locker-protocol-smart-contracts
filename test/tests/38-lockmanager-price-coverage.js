/**
 * Test 38: LockManager + PriceCalculator + VestingManager Coverage
 *
 * Tests untested public functions:
 * - calculateGainLoss (gain / loss / no pair)
 * - getAveragePurchasePrice (positive + revert)
 * - calculatePriceUSD / getPriceFromPair
 * - getVestingConfig / getLockHistoryEvent
 * - isSigner / getLockedTokens
 * - validatePairContainsToken / validateEthUsdPair
 * - validateStablecoinPosition / isWETH / getWETHAddress
 * - constructor-set custom WETH addresses (immutable, no owner/setters)
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
    log('\n🧪 TEST 38: LOCKMANAGER + PRICECALCULATOR + VESTING COVERAGE\n', '\x1b[1m\x1b[36m');

    try {
        const [deployer] = await ethers.getSigners();

        // Generate 5 signer wallets (need >= MIN_SIGNERS for batchUpdateSigners)
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
        // Custom WETH list is immutable and set at construction. We register the mock
        // WETH deployed below — so deploy the mock token first, then the calculator.
        const ERC20MockEarly = await ethers.getContractFactory('ERC20Mock');
        const weth = await ERC20MockEarly.deploy('Wrapped ETH', 'WETH', deployer.address, ethers.parseEther('1000000'), 18);
        await weth.waitForDeployment();
        const wethAddr = await weth.getAddress();

        const pc = await PC.deploy(ethers.ZeroAddress, [wethAddr]);
        await pc.waitForDeployment();
        const pcAddr = await pc.getAddress();

        const VH = await ethers.getContractFactory('ValidationHandler');
        const vh = await VH.deploy(3);
        await vh.waitForDeployment();

        const LM = await ethers.getContractFactory('LockManager');
        const lm = await LM.deploy(pcAddr);
        await lm.waitForDeployment();
        const lmAddr = await lm.getAddress();

        const VMgr = await ethers.getContractFactory('VestingManager');
        const vmgr = await VMgr.deploy(lmAddr);
        await vmgr.waitForDeployment();

        const SM = await ethers.getContractFactory('SignerManager');
        const sm = await SM.deploy(await vh.getAddress(), signerAddresses, 3);
        await sm.waitForDeployment();

        const LC = await ethers.getContractFactory('LockerContract');
        const locker = await LC.deploy(
            await vh.getAddress(),
            lmAddr,
            await sm.getAddress(),
            await vmgr.getAddress(),
            signerAddresses,
            3
        );
        await locker.waitForDeployment();
        const lockerAddress = await locker.getAddress();

        // Deploy mock tokens
        const ERC20Mock = await ethers.getContractFactory('ERC20Mock');
        const token = await ERC20Mock.deploy('Test Token', 'TST', deployer.address, ethers.parseEther('1000000'), 18);
        await token.waitForDeployment();
        const tokenAddr = await token.getAddress();

        const usdc = await ERC20Mock.deploy('USD Coin', 'USDC', deployer.address, ethers.parseUnits('1000000', 6), 6);
        await usdc.waitForDeployment();
        const usdcAddr = await usdc.getAddress();

        // Mock WETH was deployed earlier (registered in the PriceCalculator constructor)

        // Deploy mock V2 pair (token/USDC)
        const MockV2 = await ethers.getContractFactory('MockUniswapV2Pair');
        const v2pair = await MockV2.deploy(tokenAddr, usdcAddr);
        await v2pair.waitForDeployment();
        const v2pairAddr = await v2pair.getAddress();

        // Set reserves: 1 TST = 2 USDC (r0=500000e18, r1=1000000e6)
        await v2pair.setReserves(ethers.parseEther('500000'), ethers.parseUnits('1000000', 6));

        // Deploy mock V2 pair for WETH/USDC
        const v2ethPair = await MockV2.deploy(wethAddr, usdcAddr);
        await v2ethPair.waitForDeployment();
        const v2ethPairAddr = await v2ethPair.getAddress();
        await v2ethPair.setReserves(ethers.parseEther('500'), ethers.parseUnits('1000000', 6));

        logSuccess('All contracts and mocks deployed');

        // ========================================
        // PHASE 1: PriceCalculator view functions
        // ========================================
        logPhase(1, 'PriceCalculator view functions');

        // getWETHAddress — returns hardcoded (since we deployed with ZeroAddress)
        const wethAddress = await pc.getWETHAddress();
        assertEqual(wethAddress, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'Should return mainnet WETH');
        logSuccess('getWETHAddress returns mainnet WETH fallback');

        // isWETH — positive (hardcoded addresses)
        assert(await pc.isWETH('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'), 'Mainnet WETH');
        assert(await pc.isWETH('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'), 'Arbitrum WETH');
        logSuccess('isWETH returns true for known addresses');

        // isWETH — negative
        assert(!(await pc.isWETH(tokenAddr)), 'Random token is not WETH');
        logSuccess('isWETH returns false for random address');

        // Custom WETH addresses — set immutably at construction
        assert(await pc.isWETH(wethAddr), 'Constructor-registered custom WETH should be recognized');
        assert(await pc.customWETHAddresses(wethAddr), 'customWETHAddresses mapping should be set');
        logSuccess('Constructor-registered custom WETH recognized');

        // Custom WETH list is immutable — no setters exist
        assert(pc.addCustomWETHAddress === undefined, 'addCustomWETHAddress must not exist');
        assert(pc.removeCustomWETHAddress === undefined, 'removeCustomWETHAddress must not exist');
        assert(pc.owner === undefined, 'PriceCalculator owner must not exist');
        logSuccess('Custom WETH config is immutable (no owner, no setters)');

        // validateStablecoinPosition — positive
        await pc.validateStablecoinPosition(1); // should not revert
        await pc.validateStablecoinPosition(2); // should not revert
        logSuccess('validateStablecoinPosition passes for 1 and 2');

        // validateStablecoinPosition — negative
        try {
            await pc.validateStablecoinPosition(0);
            throw new Error('Should revert');
        } catch (e) {
            assert(e.message.includes('Stablecoin required'), `Expected 'Stablecoin required' but got: ${e.message}`);
            logSuccess('validateStablecoinPosition reverts for 0');
        }
        try {
            await pc.validateStablecoinPosition(3);
            throw new Error('Should revert');
        } catch (e) {
            assert(e.message.includes('Invalid stablecoin position'), `Expected 'Invalid stablecoin position' but got: ${e.message}`);
            logSuccess('validateStablecoinPosition reverts for 3');
        }

        // validatePairContainsToken — positive
        await pc.validatePairContainsToken(v2pairAddr, tokenAddr); // should not revert
        logSuccess('validatePairContainsToken passes for valid token');

        // validatePairContainsToken — negative
        try {
            await pc.validatePairContainsToken(v2pairAddr, wethAddr);
            throw new Error('Should revert');
        } catch (e) {
            assert(e.message.includes('Invalid pair'), `Expected 'Invalid pair' but got: ${e.message}`);
            logSuccess('validatePairContainsToken reverts for invalid token');
        }

        // validateEthUsdPair — positive (custom WETH registered at construction)
        await pc.validateEthUsdPair(v2ethPairAddr); // should not revert
        logSuccess('validateEthUsdPair passes for WETH pair');

        // validateEthUsdPair — negative
        try {
            await pc.validateEthUsdPair(v2pairAddr); // token/USDC, no WETH
            throw new Error('Should revert');
        } catch (e) {
            assert(e.message.includes('Invalid pair'), `Expected 'Invalid pair' but got: ${e.message}`);
            logSuccess('validateEthUsdPair reverts for non-WETH pair');
        }

        // getPriceFromPair — positive (V2)
        const price = await pc.getPriceFromPair(v2pairAddr, tokenAddr);
        log(`  getPriceFromPair: ${ethers.formatUnits(price, 18)} USDC per TST`);
        assert(price > 0, 'Price should be > 0');
        logSuccess('getPriceFromPair returns valid price');

        // getPriceFromPair — negative (token not in pair)
        try {
            await pc.getPriceFromPair(v2pairAddr, wethAddr);
            throw new Error('Should revert');
        } catch (e) {
            assert(e.message.includes('PAIR'), `Expected 'PAIR' but got: ${e.message}`);
            logSuccess('getPriceFromPair reverts for invalid token');
        }

        // calculatePriceUSD — via LockManager
        const [success, priceUSD] = await lm.calculatePriceUSD(tokenAddr, v2pairAddr, ethers.ZeroAddress, false, 2);
        assert(success, 'calculatePriceUSD should succeed');
        assert(priceUSD > 0, 'Price should be > 0');
        logSuccess(`calculatePriceUSD returns: ${ethers.formatUnits(priceUSD, 18)} USD`);

        // ========================================
        // PHASE 2: LockerContract view functions
        // ========================================
        logPhase(2, 'LockerContract view functions');

        // isSigner — positive
        const isSig = await locker.isSigner(signerAddresses[0]);
        assert(isSig, 'Should be a signer');
        logSuccess('isSigner returns true for actual signer');

        // isSigner — negative
        const isNotSig = await locker.isSigner(deployer.address);
        assert(!isNotSig, 'Deployer should not be a signer');
        logSuccess('isSigner returns false for non-signer');

        // getLockedTokens — empty initially
        const lockedTokens = await locker.getLockedTokens();
        assertEqual(BigInt(lockedTokens.length), BigInt(0), 'Should have no locked tokens initially');
        logSuccess('getLockedTokens returns empty array initially');

        // ========================================
        // PHASE 3: Create a lock and test history/pricing functions
        // ========================================
        logPhase(3, 'Lock creation + history + pricing');

        // Approve and create lock as signer
        const lockAmount = ethers.parseEther('1000');
        await (await token.transfer(signersWallets[0].address, lockAmount)).wait();
        await (await token.connect(signersWallets[0]).approve(lockerAddress, lockAmount)).wait();

        await (await locker.connect(signersWallets[0]).createLock({
            token: tokenAddr,
            amount: lockAmount,
            lockDuration: 3600, // 1 hour
            pair: v2pairAddr,
            ethUsdPair: ethers.ZeroAddress,
            targetPriceUSD1e18: ethers.parseUnits('10', 18), // $10 target
            isEthPair: false,
            stablecoinPosition: 2,
            priceDirection: 0, // UPSIDE
            vestingTokensPerPeriod: ethers.parseUnits('100', 18), // 100 tokens/period
            vestingPeriodSeconds: 3600,
            vestingAccumulate: false
        })).wait();
        logSuccess('Lock created with price pair and vesting');

        // getLockedTokens — should now have 1
        const lockedTokens2 = await locker.getLockedTokens();
        assertEqual(BigInt(lockedTokens2.length), BigInt(1), 'Should have 1 locked token');
        logSuccess('getLockedTokens returns 1 token after lock');

        // getLockHistoryEvent — positive
        const historyEvent = await lm.getLockHistoryEvent(1, 0);
        assertEqual(historyEvent.token, tokenAddr, 'History token should match');
        assert(historyEvent.amount > 0, 'History amount should be > 0');
        logSuccess('getLockHistoryEvent returns correct data');

        // getLockHistoryEvent — negative (out of bounds)
        try {
            await lm.getLockHistoryEvent(1, 99);
            throw new Error('Should revert');
        } catch (e) {
            assert(e.message.includes('Index out of bounds'), `Expected 'Index out of bounds' but got: ${e.message}`);
            logSuccess('getLockHistoryEvent reverts for out-of-bounds index');
        }

        // getAveragePurchasePrice — positive
        const [avgPrice, totalPurchase] = await lm.getAveragePurchasePrice(1);
        assert(avgPrice > 0, 'Average purchase price should be > 0');
        assertEqual(totalPurchase, lockAmount, 'Total purchase amount should match lock amount');
        logSuccess(`getAveragePurchasePrice: ${ethers.formatUnits(avgPrice, 18)} USD`);

        // getAveragePurchasePrice — negative (non-existent lock)
        try {
            await lm.getAveragePurchasePrice(999);
            throw new Error('Should revert');
        } catch (e) {
            assert(e.message.includes('TREG'), `Expected 'TREG' but got: ${e.message}`);
            logSuccess('getAveragePurchasePrice reverts for non-existent lock');
        }

        // calculateGainLoss — positive (should return current price data)
        const [glSuccess, currentPrice, avgPurchase, priceDiff, pctGain, totalGain] =
            await lm.calculateGainLoss(1);
        assert(glSuccess, 'calculateGainLoss should succeed');
        assert(currentPrice > 0, 'Current price should be > 0');
        log(`  calculateGainLoss: current=${ethers.formatUnits(currentPrice, 18)}, avg=${ethers.formatUnits(avgPurchase, 18)}, diff=${priceDiff}, pct=${pctGain}`);
        logSuccess('calculateGainLoss returns valid data');

        // calculateGainLoss — negative (non-existent lock)
        try {
            await lm.calculateGainLoss(999);
            throw new Error('Should revert');
        } catch (e) {
            assert(e.message.includes('TREG'), `Expected 'TREG' but got: ${e.message}`);
            logSuccess('calculateGainLoss reverts for non-existent lock');
        }

        // ========================================
        // PHASE 4: VestingManager coverage
        // ========================================
        logPhase(4, 'VestingManager coverage');

        // getVestingConfig — positive
        const vestingConfig = await locker.getVestingConfig(1);
        assert(vestingConfig.enabled, 'Vesting should be enabled');
        assertEqual(vestingConfig.tokensPerPeriod, ethers.parseUnits('100', 18), 'Tokens per period should be 100');
        assertEqual(vestingConfig.periodDuration, BigInt(3600), 'Period should be 3600s');
        logSuccess('getVestingConfig returns correct data');

        // getVestingConfig — for lock without vesting (create another lock)
        const lockAmount2 = ethers.parseEther('500');
        await (await token.transfer(signersWallets[1].address, lockAmount2)).wait();
        await (await token.connect(signersWallets[1]).approve(lockerAddress, lockAmount2)).wait();

        await (await locker.connect(signersWallets[1]).createLock({
            token: tokenAddr,
            amount: lockAmount2,
            lockDuration: 3600,
            pair: ethers.ZeroAddress,
            ethUsdPair: ethers.ZeroAddress,
            targetPriceUSD1e18: 0,
            isEthPair: false,
            stablecoinPosition: 0,
            priceDirection: 0,
            vestingTokensPerPeriod: 0, // No vesting
            vestingPeriodSeconds: 0,
            vestingAccumulate: false
        })).wait();

        const vestingConfig2 = await locker.getVestingConfig(2);
        assert(!vestingConfig2.enabled, 'Vesting should be disabled for lock 2');
        logSuccess('getVestingConfig returns disabled for lock without vesting');

        // calculateGainLoss for lock without pair — should return success=false
        const [glSuccess2] = await lm.calculateGainLoss(2);
        assert(!glSuccess2, 'calculateGainLoss should return false for lock without pair');
        logSuccess('calculateGainLoss returns false for lock without price pair');

        logSuccess('\n🎉 TEST 38 PASSED: LockManager + PriceCalculator + VestingManager coverage complete!\n');
        reportTestResult('38-lockmanager-price-coverage', true);

    } catch (error) {
        reportTestResult('38-lockmanager-price-coverage', false, error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
