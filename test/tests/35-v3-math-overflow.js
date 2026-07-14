/**
 * Test 35: Uniswap V3 Math Overflow Verification
 * 
 * Verifies that the Uniswap V3 price calculation stays overflow-safe under
 * extreme price/decimals configurations (large sqrtPriceX96 values).
 */

import {
    logPhase,
    logSection,
    logSuccess,
    log,
    reportTestResult,
    getEthers,
    assert
} from '../core/utils.js';

const ethers = getEthers();

async function main() {
    log('\n🧪 TEST 35: UNISWAP V3 MATH OVERFLOW VERIFICATION\n', '\x1b[1m\x1b[36m');

    try {
        const [deployer] = await ethers.getSigners();

        // 1. Deploy PriceCalculator
        logSection('Deploying PriceCalculator...');
        const PriceCalcFactory = await ethers.getContractFactory('PriceCalculator');
        const priceCalc = await PriceCalcFactory.deploy(ethers.ZeroAddress, []);
        await priceCalc.waitForDeployment();
        const priceCalcAddr = await priceCalc.getAddress();

        // 2. Deploy Mock ERC20s: Target (18 decimals) and USDC (6 decimals)
        logSection('Deploying Mock Tokens...');
        const ERC20Mock = await ethers.getContractFactory('ERC20Mock');
        
        const targetToken = await ERC20Mock.deploy('Target Token', 'TGT', deployer.address, ethers.parseEther('1000000'), 18);
        await targetToken.waitForDeployment();
        const targetAddr = await targetToken.getAddress();

        const usdc = await ERC20Mock.deploy('USD Coin', 'USDC', deployer.address, ethers.parseUnits('1000000', 6), 6);
        await usdc.waitForDeployment();
        const usdcAddr = await usdc.getAddress();

        log(`  Target Token: ${targetAddr} (18 decimals)`);
        log(`  USDC Mock: ${usdcAddr} (6 decimals)`);

        // 3. Deploy Mock Uniswap V3 Pool
        logSection('Deploying Mock Uniswap V3 Pool (Target/USDC)...');
        const MockUniswapV3Pool = await ethers.getContractFactory('MockUniswapV3Pool');
        const pool = await MockUniswapV3Pool.deploy(targetAddr, usdcAddr);
        await pool.waitForDeployment();
        const poolAddr = await pool.getAddress();
        log(`  V3 Pool deployed at: ${poolAddr}`);

        // 4. Case A: Normal price where sqrtPriceX96 is small (e.g. 2^96)
        logSection('Case A: Checking price calculation with standard sqrtPriceX96 (2^96)...');
        // 2^96 is around 79228162514264337593543950336
        const normalSqrtPrice = ethers.getBigInt('79228162514264337593543950336');
        await pool.setSqrtPriceX96(normalSqrtPrice);
        
        let [successA, priceUSDA] = await priceCalc.getPriceUSDWithFallback(
            poolAddr,
            targetAddr,
            ethers.ZeroAddress,
            false,
            2 // stablecoin position = 2 (USDC is token1)
        );
        
        assert(successA, 'Case A: Price calculation should succeed');
        logSuccess(`Case A Succeeded! Price returned: ${ethers.formatUnits(priceUSDA, 18)} USD`);

        // 5. Case B: High ratio/price where sqrtPriceX96 is large (e.g. 2^130)
        // 2^130 is 1361129467683753853853498429727072845824
        // Since 2^130 fits in uint160, it's a valid sqrtPriceX96 value.
        // But (2^130)^2 = 2^260 > 2^256, so a naive single-step squaring would exceed
        // uint256 — v3_step1_getPriceX192 must compute this without overflowing.
        logSection('Case B: Checking price calculation with large sqrtPriceX96 (2^130)...');
        const overflowSqrtPrice = ethers.getBigInt('1361129467683753853853498429727072845824');
        await pool.setSqrtPriceX96(overflowSqrtPrice);

        let [successB, priceUSDB] = await priceCalc.getPriceUSDWithFallback(
            poolAddr,
            targetAddr,
            ethers.ZeroAddress,
            false,
            2 // stablecoin position = 2
        );

        assert(successB, 'Case B: V3 price calculation should succeed without overflow');
        logSuccess(`Case B Succeeded! Price returned: ${ethers.formatUnits(priceUSDB, 18)} USD`);

        logSuccess('\n🎉 TEST 35 PASSED: Uniswap V3 price math is overflow-safe!\n');
        reportTestResult('35-v3-math-overflow', true);

    } catch (error) {
        reportTestResult('35-v3-math-overflow', false, error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
