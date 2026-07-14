/**
 * Test 56: PriceCalculator Edge Branches
 *
 * Covers untested PriceCalculator branches:
 * - _getPriceFromV2Pair 'No liquidity' (zero reserves) + 'PAIR' (token not in pair)
 * - _getPriceFromV3Pool 'No liquidity' (sqrtPriceX96 == 0) + 'PAIR' (token not in pool)
 * - identifyWETH 'NO_WETH' (direct call + via getPriceUSD isEthPair with a usdPair lacking WETH)
 * - applyStablecoinLogic direct calls: 'INV_STABLECOIN_POS' (only reachable directly,
 *   getPriceUSD pre-validates via validateStablecoinPosition), stablecoin-is-priced-token
 *   1e18 short-circuits, rawPrice passthrough, 'PAIR' requires
 * - getPriceUSD isEthPair branch with token == wethToken (pricing WETH itself)
 * - getWETHAddress non-zero wethAddress branch + immutable custom WETH list (constructor)
 * - getPriceUSDWithFallback catch path -> (false, 0)
 * - v3_step3_applyDecimals exact values for decimals0 > / < / == decimals1
 * - V3 catch branches of getPairTokens / validatePairContainsToken / validateEthUsdPair
 *   via MockBrokenPool: V2 and V3 share the same token0()/token1() ABI so the regular
 *   mocks cannot reach them; MockBrokenPool discriminates the V2 try from the V3 retry
 *   by forwarded gas (EIP-150 63/64 rule) and needs an explicit low gasLimit.
 */

import {
    loadSharedState,
    getWallet,
    logPhase,
    logSection,
    logSuccess,
    log,
    assert,
    assertEqual,
    reportTestResult,
    getEthers
} from '../core/utils.js';

const ethers = getEthers();

const NO_REVERT = '__NO_REVERT__';

async function expectRevert(promise, reason, label) {
    try {
        await promise;
        throw new Error(NO_REVERT);
    } catch (e) {
        if (e.message === NO_REVERT) {
            throw new Error(`${label}: expected revert '${reason}' but call succeeded`);
        }
        assert(e.message.includes(reason), `${label}: expected revert '${reason}' but got: ${e.message}`);
        logSuccess(`${label} reverts with '${reason}'`);
    }
}

async function main() {
    log('\n🧪 TEST 56: PRICECALCULATOR EDGE BRANCHES\n', '\x1b[1m\x1b[36m');

    try {
        const state = loadSharedState();
        const deployer = await getWallet(0);

        const ERC20Mock = await ethers.getContractFactory('ERC20Mock', deployer);
        const MockV2 = await ethers.getContractFactory('MockUniswapV2Pair', deployer);
        const MockV3 = await ethers.getContractFactory('MockUniswapV3Pool', deployer);
        const MockBroken = await ethers.getContractFactory('MockBrokenPool', deployer);
        const PriceCalcFactory = await ethers.getContractFactory('PriceCalculator', deployer);

        // ====================================================================
        logPhase(1, 'Fresh infrastructure (tokens + PriceCalculator with custom WETH list)');
        // ====================================================================

        const weth = await ERC20Mock.deploy('Wrapped ETH', 'WETH', deployer.address, ethers.parseEther('1000000'), 18);
        await weth.waitForDeployment();
        const wethAddr = await weth.getAddress();

        const customWeth = await ERC20Mock.deploy('Custom WETH', 'cWETH', deployer.address, ethers.parseEther('1000'), 18);
        await customWeth.waitForDeployment();
        const customWethAddr = await customWeth.getAddress();

        const usdc = await ERC20Mock.deploy('USD Coin', 'USDC', deployer.address, ethers.parseUnits('100000000', 6), 6);
        await usdc.waitForDeployment();
        const usdcAddr = await usdc.getAddress();

        const tkn = await ERC20Mock.deploy('Token', 'TKN', deployer.address, ethers.parseEther('1000000'), 18);
        await tkn.waitForDeployment();
        const tknAddr = await tkn.getAddress();

        const other = await ERC20Mock.deploy('Other', 'OTH', deployer.address, ethers.parseEther('1000000'), 18);
        await other.waitForDeployment();
        const otherAddr = await other.getAddress();

        // Non-zero default WETH + immutable custom WETH list, both set at construction
        const pc = await PriceCalcFactory.deploy(wethAddr, [customWethAddr]);
        await pc.waitForDeployment();
        logSuccess(`Fresh PriceCalculator deployed: ${await pc.getAddress()}`);

        // getWETHAddress — wethAddress != 0 branch (returns the constructor value,
        // not the mainnet fallback)
        assertEqual(await pc.getWETHAddress(), wethAddr, 'getWETHAddress returns constructor wethAddress (non-zero branch)');
        assert(await pc.isWETH(wethAddr), 'constructor wethAddress recognized by isWETH');
        assert(await pc.customWETHAddresses(customWethAddr), 'custom WETH mapping set immutably at construction');
        assert(await pc.isWETH(customWethAddr), 'custom WETH recognized by isWETH');
        logSuccess('Custom WETH configuration verified');

        // ====================================================================
        logPhase(2, "V2/V3 'No liquidity' and 'PAIR' reverts");
        // ====================================================================

        // _getPriceFromV2Pair — zero reserves (setReserves(0,0) is allowed by the mock)
        const emptyV2 = await MockV2.deploy(tknAddr, usdcAddr);
        await emptyV2.waitForDeployment();
        await (await emptyV2.setReserves(0, 0)).wait();
        const emptyV2Addr = await emptyV2.getAddress();
        await expectRevert(
            pc._getPriceFromV2Pair(emptyV2Addr, tknAddr),
            'No liquidity',
            '_getPriceFromV2Pair with zero reserves'
        );

        // _getPriceFromV3Pool — fresh pool, sqrtPriceX96 defaults to 0
        const v3Pool = await MockV3.deploy(tknAddr, usdcAddr);
        await v3Pool.waitForDeployment();
        const v3PoolAddr = await v3Pool.getAddress();
        await expectRevert(
            pc._getPriceFromV3Pool(v3PoolAddr, tknAddr),
            'No liquidity',
            '_getPriceFromV3Pool with sqrtPriceX96 == 0'
        );

        // _getPriceFromV2Pair — 'PAIR' (token neither token0 nor token1)
        const liqV2 = await MockV2.deploy(tknAddr, usdcAddr);
        await liqV2.waitForDeployment();
        await (await liqV2.setReserves(ethers.parseEther('1000'), ethers.parseUnits('2000', 6))).wait();
        const liqV2Addr = await liqV2.getAddress();
        await expectRevert(
            pc._getPriceFromV2Pair(liqV2Addr, otherAddr),
            'PAIR',
            '_getPriceFromV2Pair with token not in pair'
        );

        // _getPriceFromV3Pool — 'PAIR' (needs sqrtPriceX96 > 0 to get past the liquidity check)
        await (await v3Pool.setSqrtPriceX96(2n ** 96n)).wait(); // 1:1 raw ratio
        await expectRevert(
            pc._getPriceFromV3Pool(v3PoolAddr, otherAddr),
            'PAIR',
            '_getPriceFromV3Pool with token not in pool'
        );

        // ====================================================================
        logPhase(3, "identifyWETH 'NO_WETH'");
        // ====================================================================

        // Direct call — neither token is WETH
        await expectRevert(
            pc.identifyWETH(tknAddr, usdcAddr),
            'NO_WETH',
            'identifyWETH with no WETH in pair'
        );

        // Via getPriceUSD isEthPair routing: tokenPair prices fine, but the usdPair
        // contains no WETH, so identifyWETH(usdToken0, usdToken1) reverts.
        const tknWethV2 = await MockV2.deploy(tknAddr, wethAddr);
        await tknWethV2.waitForDeployment();
        await (await tknWethV2.setReserves(ethers.parseEther('1000'), ethers.parseEther('50'))).wait(); // 1 TKN = 0.05 WETH
        const tknWethV2Addr = await tknWethV2.getAddress();
        await expectRevert(
            pc.getPriceUSD(tknWethV2Addr, tknAddr, liqV2Addr, true, 2), // usdPair = TKN/USDC (no WETH)
            'NO_WETH',
            'getPriceUSD isEthPair with usdPair lacking WETH'
        );

        // ====================================================================
        logPhase(4, 'applyStablecoinLogic direct calls');
        // ====================================================================

        const rawPrice = ethers.parseUnits('7', 17); // arbitrary 0.7e18
        const ONE_E18 = ethers.parseEther('1');

        // Stablecoin IS the priced token -> hard 1e18
        assertEqual(
            await pc.applyStablecoinLogic(rawPrice, tknAddr, tknAddr, usdcAddr, 1),
            ONE_E18,
            'pos=1 & token==token0 -> 1e18'
        );
        assertEqual(
            await pc.applyStablecoinLogic(rawPrice, usdcAddr, tknAddr, usdcAddr, 2),
            ONE_E18,
            'pos=2 & token==token1 -> 1e18'
        );

        // Priced token is the non-stable side -> rawPrice passthrough
        assertEqual(
            await pc.applyStablecoinLogic(rawPrice, usdcAddr, tknAddr, usdcAddr, 1),
            rawPrice,
            'pos=1 & token==token1 -> rawPrice'
        );
        assertEqual(
            await pc.applyStablecoinLogic(rawPrice, tknAddr, tknAddr, usdcAddr, 2),
            rawPrice,
            'pos=2 & token==token0 -> rawPrice'
        );

        // Token in neither slot -> 'PAIR'
        await expectRevert(
            pc.applyStablecoinLogic(rawPrice, otherAddr, tknAddr, usdcAddr, 1),
            'PAIR',
            'applyStablecoinLogic pos=1 with token not in pair'
        );
        await expectRevert(
            pc.applyStablecoinLogic(rawPrice, otherAddr, tknAddr, usdcAddr, 2),
            'PAIR',
            'applyStablecoinLogic pos=2 with token not in pair'
        );

        // 'INV_STABLECOIN_POS' — only reachable via direct call: getPriceUSD calls
        // validateStablecoinPosition (which reverts 'Stablecoin required' / 'Invalid
        // stablecoin position') BEFORE applyStablecoinLogic.
        await expectRevert(
            pc.applyStablecoinLogic(rawPrice, tknAddr, tknAddr, usdcAddr, 0),
            'INV_STABLECOIN_POS',
            'applyStablecoinLogic pos=0'
        );
        await expectRevert(
            pc.applyStablecoinLogic(rawPrice, tknAddr, tknAddr, usdcAddr, 3),
            'INV_STABLECOIN_POS',
            'applyStablecoinLogic pos=3'
        );

        // ====================================================================
        logPhase(5, 'getPriceUSD isEthPair with token == wethToken (pricing WETH itself)');
        // ====================================================================

        const wethUsdcV2 = await MockV2.deploy(wethAddr, usdcAddr);
        await wethUsdcV2.waitForDeployment();
        // 1000 WETH (18d) vs 3,000,000 USDC (6d) -> exactly 3000e18
        await (await wethUsdcV2.setReserves(ethers.parseEther('1000'), ethers.parseUnits('3000000', 6))).wait();
        const wethUsdcV2Addr = await wethUsdcV2.getAddress();

        const wethPriceUSD = await pc.getPriceUSD(wethUsdcV2Addr, wethAddr, wethUsdcV2Addr, true, 2);
        assertEqual(wethPriceUSD, ethers.parseUnits('3000', 18), 'getPriceUSD(WETH, isEthPair) short-circuits to usdPair price');

        // ====================================================================
        logPhase(6, 'getPriceUSDWithFallback catch -> (false, 0)');
        // ====================================================================

        // Broken pair: zero reserves -> V2 path reverts 'No liquidity', V3 path reverts
        // (no slot0() on a V2 mock) -> getPriceFromPair reverts 'PAIR' -> caught.
        const [okBroken, priceBroken] = await pc.getPriceUSDWithFallback(emptyV2Addr, tknAddr, ethers.ZeroAddress, false, 2);
        assert(okBroken === false, 'getPriceUSDWithFallback should return success=false for broken pair');
        assertEqual(priceBroken, 0n, 'getPriceUSDWithFallback price for broken pair');

        // Pair address with no code at all (EOA) also falls into the catch
        const [okEoa, priceEoa] = await pc.getPriceUSDWithFallback(deployer.address, tknAddr, ethers.ZeroAddress, false, 2);
        assert(okEoa === false, 'getPriceUSDWithFallback should return success=false for codeless pair');
        assertEqual(priceEoa, 0n, 'getPriceUSDWithFallback price for codeless pair');

        // ====================================================================
        logPhase(7, 'v3_step3_applyDecimals exact values');
        // ====================================================================

        // mulDiv(rawRatioX18, 10**decimals0, 10**decimals1)
        assertEqual(
            await pc.v3_step3_applyDecimals(ethers.parseEther('1'), 18, 18),
            ethers.parseEther('1'),
            'v3_step3_applyDecimals(1e18, 18, 18) == 1e18'
        );
        assertEqual(
            await pc.v3_step3_applyDecimals(ethers.parseEther('1'), 18, 6),
            10n ** 30n,
            'v3_step3_applyDecimals(1e18, 18, 6) == 1e30'
        );
        assertEqual(
            await pc.v3_step3_applyDecimals(ethers.parseEther('1'), 6, 18),
            10n ** 6n,
            'v3_step3_applyDecimals(1e18, 6, 18) == 1e6'
        );

        // ====================================================================
        logPhase(8, 'V3 catch branches via MockBrokenPool (gas-discriminated V2 failure)');
        // ====================================================================

        // V2 and V3 expose the same token0()/token1() selectors, so with the regular
        // mocks the catch branches are unreachable (if the try fails, the identical
        // retry fails too). MockBrokenPool.token0() burns almost all forwarded gas and
        // reverts when entered with > 150k gas (the V2 try), then succeeds on the V3
        // retry which — per EIP-150 — only receives ~63/64 of the 1/64 the caller kept.
        // An explicit low top-level gasLimit keeps the retry under the ceiling.
        const GAS = { gasLimit: 1000000 };

        const broken = await MockBroken.deploy(wethAddr, usdcAddr);
        await broken.waitForDeployment();
        const brokenAddr = await broken.getAddress();

        // getPairTokens — catch branch returns the V3 tokens
        const [bt0, bt1] = await pc.getPairTokens(brokenAddr, GAS);
        assertEqual(bt0, wethAddr, 'getPairTokens V3 catch: token0');
        assertEqual(bt1, usdcAddr, 'getPairTokens V3 catch: token1');

        // validatePairContainsToken — catch branch, token present (no revert)
        await pc.validatePairContainsToken(brokenAddr, usdcAddr, GAS);
        logSuccess('validatePairContainsToken V3 catch passes for contained token');

        // validatePairContainsToken — catch branch, token absent
        await expectRevert(
            pc.validatePairContainsToken(brokenAddr, otherAddr, GAS),
            'Invalid pair',
            'validatePairContainsToken V3 catch with foreign token'
        );

        // validateEthUsdPair — catch branch, token0 is the configured WETH (no revert)
        await pc.validateEthUsdPair(brokenAddr, GAS);
        logSuccess('validateEthUsdPair V3 catch passes for WETH pair');

        // validateEthUsdPair — catch branch, no WETH in pool
        const brokenNoWeth = await MockBroken.deploy(tknAddr, usdcAddr);
        await brokenNoWeth.waitForDeployment();
        await expectRevert(
            pc.validateEthUsdPair(await brokenNoWeth.getAddress(), GAS),
            'Invalid pair',
            'validateEthUsdPair V3 catch without WETH'
        );

        reportTestResult('56-pricecalculator-edges', true);
        logSuccess('\n✅ TEST 56 PASSED!\n');

    } catch (error) {
        console.error(error);
        reportTestResult('56-pricecalculator-edges', false, error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => process.exit(1));
