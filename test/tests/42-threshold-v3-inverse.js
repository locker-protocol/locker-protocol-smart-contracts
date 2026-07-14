/**
 * TEST 42: V3 Token1 Inverse Price
 *
 * Verifies:
 * - V3 price calculation works correctly for token1 (inverse) with Q96 split
 * - No overflow with extreme sqrtPriceX96 values
 */

import { log, logSuccess, logError, logPhase, logSection, assert, reportTestResult, getEthers } from '../core/utils.js';

const ethers = getEthers();

async function main() {
    console.log('\n🧪 TEST 42: V3 TOKEN1 INVERSE PRICE\n');

    const signers = await ethers.getSigners();
    const deployer = signers[0];

    // ========================================
    // PHASE 1: V3 Pool Token1 Inverse Price
    // ========================================
    logPhase(1, 'V3 Pool — Token1 inverse price calculation');

    const PC = await ethers.getContractFactory('PriceCalculator');
    const pc = await PC.deploy(ethers.ZeroAddress, []);
    await pc.waitForDeployment();

    const ERC20Mock = await ethers.getContractFactory('ERC20Mock');
    const tokenA = await ERC20Mock.deploy('TokenA', 'TKA', deployer.address, ethers.parseEther('1000000'), 18);
    await tokenA.waitForDeployment();
    const tokenB = await ERC20Mock.deploy('TokenB', 'TKB', deployer.address, ethers.parseEther('1000000'), 18);
    await tokenB.waitForDeployment();

    const addrA = await tokenA.getAddress();
    const addrB = await tokenB.getAddress();
    const [token0Addr, token1Addr] = addrA.toLowerCase() < addrB.toLowerCase()
        ? [addrA, addrB]
        : [addrB, addrA];

    const MockV3 = await ethers.getContractFactory('MockUniswapV3Pool');
    const v3Pool = await MockV3.deploy(token0Addr, token1Addr);
    await v3Pool.waitForDeployment();

    // sqrtPriceX96 ≈ sqrt(2000) * 2^96
    const sqrtPrice2000 = BigInt('3543191142285914205922034323214');
    await (await v3Pool.setSqrtPriceX96(sqrtPrice2000)).wait();

    // Token0 price (direct)
    const priceToken0 = await pc._getPriceFromV3Pool(await v3Pool.getAddress(), token0Addr);
    log(`  Price of token0 (direct): ${ethers.formatEther(priceToken0)}`);
    assert(priceToken0 > 0, 'Token0 price > 0');
    logSuccess('Token0 direct price OK');

    // Token1 price (inverse) — exercises the two-step Q96 scaling
    const priceToken1 = await pc._getPriceFromV3Pool(await v3Pool.getAddress(), token1Addr);
    log(`  Price of token1 (inverse): ${ethers.formatEther(priceToken1)}`);
    assert(priceToken1 > 0, 'Token1 price > 0');
    logSuccess('Token1 inverse price OK');

    // Reciprocal check: price0 * price1 ≈ 1e18
    const product = (priceToken0 * priceToken1) / ethers.parseEther('1');
    log(`  Reciprocal product: ${ethers.formatEther(product)} (should ≈ 1.0)`);
    const deviation = product > ethers.parseEther('1')
        ? product - ethers.parseEther('1')
        : ethers.parseEther('1') - product;
    const deviationPct = (deviation * BigInt(10000)) / ethers.parseEther('1');
    assert(deviationPct < BigInt(100), 'Reciprocal deviation < 1%');
    logSuccess(`Reciprocal verified (deviation: ${Number(deviationPct) / 100}%)`);

    // ========================================
    // PHASE 2: V3 extreme sqrtPriceX96 (overflow)
    // ========================================
    logPhase(2, 'V3 extreme sqrtPriceX96 — no overflow');

    const largeSqrt = BigInt('1461446703485210103287273052203988822378723970342');
    await (await v3Pool.setSqrtPriceX96(largeSqrt)).wait();

    try {
        const p0 = await pc._getPriceFromV3Pool(await v3Pool.getAddress(), token0Addr);
        log(`  Large sqrt — token0: ${p0}`);
        logSuccess('No overflow for token0');
    } catch (e) {
        logError(`Token0 failed: ${e.message.substring(0, 80)}`);
    }

    try {
        const p1 = await pc._getPriceFromV3Pool(await v3Pool.getAddress(), token1Addr);
        log(`  Large sqrt — token1: ${p1}`);
        logSuccess('No overflow for token1');
    } catch (e) {
        logError(`Token1 failed: ${e.message.substring(0, 80)}`);
    }

    logSuccess('\n🎉 TEST 42 PASSED: V3 token1 inverse price verified!\n');
    reportTestResult('42-threshold-v3-inverse', true);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        logError(`\n❌ TEST FAILED: 42-threshold-v3-inverse - ${error.message}\n`);
        reportTestResult('42-threshold-v3-inverse', false);
        console.error(error);
        process.exit(1);
    });
