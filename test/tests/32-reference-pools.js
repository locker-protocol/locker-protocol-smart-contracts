/**
 * Test 32: Reference Pools Verification (Standalone)
 * 
 * Tests PriceCalculator logic against realistic reference pairs:
 * USDC/WETH, WBTC/WETH, DAI/WETH, USDC/USDT, DAI/USDC, UNI/WETH, LINK/WETH, stETH/WETH
 * 
 * Self-contained: deploys its own mock pools with realistic mainnet prices.
 * No external data files required.
 */

import {
    loadSharedState,
    getWallet,
    logPhase,
    logSection,
    logSuccess,
    log,
    assert,
    reportTestResult,
    getEthers
} from '../core/utils.js';

const ethers = getEthers();

// Realistic mainnet-like prices and token configurations
const REFERENCE_POOLS = [
    // ETH-paired pools (token/WETH → routed via WETH/USDC for USD price)
    { name: "WBTC/WETH",  token: { sym: "WBTC",  dec: 8 },  priceInETH: 22.5,     expectedUSD: 67500,  type: "V2" },
    { name: "WBTC/WETH",  token: { sym: "WBTC",  dec: 8 },  priceInETH: 22.5,     expectedUSD: 67500,  type: "V3" },
    { name: "UNI/WETH",   token: { sym: "UNI",   dec: 18 }, priceInETH: 0.003,    expectedUSD: 9,      type: "V2" },
    { name: "UNI/WETH",   token: { sym: "UNI",   dec: 18 }, priceInETH: 0.003,    expectedUSD: 9,      type: "V3" },
    { name: "LINK/WETH",  token: { sym: "LINK",  dec: 18 }, priceInETH: 0.005,    expectedUSD: 15,     type: "V2" },
    { name: "LINK/WETH",  token: { sym: "LINK",  dec: 18 }, priceInETH: 0.005,    expectedUSD: 15,     type: "V3" },
    { name: "stETH/WETH", token: { sym: "stETH", dec: 18 }, priceInETH: 0.999,    expectedUSD: 2997,   type: "V2" },
    { name: "stETH/WETH", token: { sym: "stETH", dec: 18 }, priceInETH: 0.999,    expectedUSD: 2997,   type: "V3" },

    // Stablecoin direct pools (no ETH routing)
    { name: "DAI/USDC",   token: { sym: "DAI",   dec: 18 }, stable: { sym: "USDC", dec: 6 },  priceInStable: 1.0,    expectedUSD: 1,     type: "V2", stablePos: 2, direct: true },
    { name: "DAI/USDC",   token: { sym: "DAI",   dec: 18 }, stable: { sym: "USDC", dec: 6 },  priceInStable: 1.0,    expectedUSD: 1,     type: "V3", stablePos: 2, direct: true },
    { name: "USDC/USDT",  token: { sym: "USDC",  dec: 6 },  stable: { sym: "USDT", dec: 6 },  priceInStable: 1.0,    expectedUSD: 1,     type: "V2", stablePos: 2, direct: true },
    { name: "USDC/USDT",  token: { sym: "USDC",  dec: 6 },  stable: { sym: "USDT", dec: 6 },  priceInStable: 1.0,    expectedUSD: 1,     type: "V3", stablePos: 2, direct: true },

    // Direct stablecoin pairs with non-stable tokens
    { name: "WETH/USDC",  token: { sym: "WETH2", dec: 18 }, stable: { sym: "USDC", dec: 6 },  priceInStable: 3000,   expectedUSD: 3000,  type: "V2", stablePos: 2, direct: true },
    { name: "WETH/USDC",  token: { sym: "WETH2", dec: 18 }, stable: { sym: "USDC", dec: 6 },  priceInStable: 3000,   expectedUSD: 3000,  type: "V3", stablePos: 2, direct: true },
    { name: "WETH/USDT",  token: { sym: "WETH3", dec: 18 }, stable: { sym: "USDT", dec: 6 },  priceInStable: 3000,   expectedUSD: 3000,  type: "V2", stablePos: 2, direct: true },
];

// Reference ETH price in USD for routing calculations
const ETH_PRICE_USD = 3000;

async function main() {
    log('\n🧪 TEST 32: REFERENCE POOLS PRICE CALCULATIONS\n', '\x1b[1m\x1b[36m');

    try {
        const state = loadSharedState();
        const deployer = await getWallet(0);

        // Deploy fresh infrastructure for isolation
        const ERC20Mock = await ethers.getContractFactory('ERC20Mock', deployer);
        const MockV2 = await ethers.getContractFactory('MockUniswapV2Pair', deployer);
        const MockV3 = await ethers.getContractFactory('MockUniswapV3Pool', deployer);
        const PriceCalcFactory = await ethers.getContractFactory('PriceCalculator', deployer);

        // Deploy WETH
        const weth = await ERC20Mock.deploy('Wrapped Ether', 'WETH', deployer.address, ethers.parseEther('1000000'), 18);
        await weth.waitForDeployment();
        const wethAddr = await weth.getAddress();

        // Deploy PriceCalculator
        const priceCalc = await PriceCalcFactory.deploy(wethAddr, []);
        await priceCalc.waitForDeployment();
        logSuccess(`PriceCalculator deployed: ${await priceCalc.getAddress()}`);

        // Deploy reference WETH/USDC pair for ETH routing
        const usdcRef = await ERC20Mock.deploy('USD Coin', 'USDC', deployer.address, ethers.parseUnits('1000000000', 6), 6);
        await usdcRef.waitForDeployment();
        const usdcRefAddr = await usdcRef.getAddress();

        // V2 WETH/USDC reference pair
        const wethUsdcV2 = await MockV2.deploy(wethAddr, usdcRefAddr);
        await wethUsdcV2.waitForDeployment();
        await wethUsdcV2.setReserves(ethers.parseEther('1000'), ethers.parseUnits('3000000', 6));
        const wethUsdcV2Addr = await wethUsdcV2.getAddress();

        // V3 WETH/USDC reference pair
        const wethUsdcV3 = await MockV3.deploy(wethAddr, usdcRefAddr);
        await wethUsdcV3.waitForDeployment();
        await wethUsdcV3.setPriceToken0InToken1(ethers.parseUnits('3000', 18));
        const wethUsdcV3Addr = await wethUsdcV3.getAddress();

        logSuccess(`WETH/USDC reference pairs deployed (V2 + V3)`);

        // Token cache to avoid redeploying same symbols
        const tokenCache = {};
        tokenCache['WETH'] = weth;

        async function getOrDeployToken(sym, decimals) {
            const key = `${sym}_${decimals}`;
            if (tokenCache[key]) return tokenCache[key];
            const token = await ERC20Mock.deploy(sym, sym, deployer.address, ethers.parseUnits('1000000', decimals), decimals);
            await token.waitForDeployment();
            tokenCache[key] = token;
            return token;
        }

        let passed = 0;
        let total = 0;

        // ====================================================================
        logPhase(1, 'ETH-Routed Reference Pools');
        // ====================================================================

        for (const pool of REFERENCE_POOLS.filter(p => !p.direct)) {
            total++;
            logSection(`${pool.name} (${pool.type})`);

            const token = await getOrDeployToken(pool.token.sym, pool.token.dec);
            const tokenAddr = await token.getAddress();

            let pairAddr;
            if (pool.type === 'V2') {
                const pair = await MockV2.deploy(tokenAddr, wethAddr);
                await pair.waitForDeployment();

                const r0 = ethers.parseUnits('1000', pool.token.dec);
                const r1Num = (1000 * pool.priceInETH).toFixed(18).replace(/\.?0+$/, '');
                const r1 = ethers.parseUnits(r1Num, 18);
                await pair.setReserves(r0, r1);

                pairAddr = await pair.getAddress();
            } else {
                const pool3 = await MockV3.deploy(tokenAddr, wethAddr);
                await pool3.waitForDeployment();

                const p1e18 = ethers.parseUnits(pool.priceInETH.toFixed(18), 18);
                await pool3.setPriceToken0InToken1(p1e18);

                pairAddr = await pool3.getAddress();
            }

            // Use the matching ethUsd pair type
            const ethUsdPairAddr = pool.type === 'V2' ? wethUsdcV2Addr : wethUsdcV3Addr;

            const [success, price1e18] = await priceCalc.getPriceUSDWithFallback(
                pairAddr,
                tokenAddr,
                ethUsdPairAddr,
                true,  // isEthPair
                2      // stablecoinPosition (USDC is token1 in WETH/USDC)
            );

            assert(success, `${pool.name} (${pool.type}): getPriceUSD should succeed`);

            const calculatedPrice = Number(ethers.formatUnits(price1e18, 18));
            const tolerance = pool.expectedUSD * 0.01; // 1% tolerance
            const diff = Math.abs(calculatedPrice - pool.expectedUSD);

            if (diff > tolerance) {
                throw new Error(`${pool.name} (${pool.type}): Expected ~$${pool.expectedUSD}, got $${calculatedPrice.toFixed(6)}`);
            }

            log(`  ✅ ${pool.name} (${pool.type}) | Expected: $${pool.expectedUSD} | Got: $${calculatedPrice.toFixed(6)}`);
            passed++;
        }

        // ====================================================================
        logPhase(2, 'Direct Stablecoin Reference Pools');
        // ====================================================================

        for (const pool of REFERENCE_POOLS.filter(p => p.direct)) {
            total++;
            logSection(`${pool.name} (${pool.type})`);

            const token = await getOrDeployToken(pool.token.sym, pool.token.dec);
            const tokenAddr = await token.getAddress();

            const stable = await getOrDeployToken(pool.stable.sym, pool.stable.dec);
            const stableAddr = await stable.getAddress();

            let pairAddr;
            if (pool.type === 'V2') {
                const pair = await MockV2.deploy(tokenAddr, stableAddr);
                await pair.waitForDeployment();

                const r0 = ethers.parseUnits('1000', pool.token.dec);
                const r1Num = (1000 * pool.priceInStable).toFixed(pool.stable.dec > 6 ? 6 : pool.stable.dec).replace(/\.?0+$/, '');
                const r1 = ethers.parseUnits(r1Num, pool.stable.dec);
                await pair.setReserves(r0, r1);

                pairAddr = await pair.getAddress();
            } else {
                const pool3 = await MockV3.deploy(tokenAddr, stableAddr);
                await pool3.waitForDeployment();

                const p1e18 = ethers.parseUnits(pool.priceInStable.toFixed(18), 18);
                await pool3.setPriceToken0InToken1(p1e18);

                pairAddr = await pool3.getAddress();
            }

            const [success, price1e18] = await priceCalc.getPriceUSDWithFallback(
                pairAddr,
                tokenAddr,
                ethers.ZeroAddress,
                false,           // not ETH pair
                pool.stablePos
            );

            assert(success, `${pool.name} (${pool.type}): getPriceUSD should succeed`);

            const calculatedPrice = Number(ethers.formatUnits(price1e18, 18));
            const tolerance = pool.expectedUSD * 0.01; // 1% tolerance
            const diff = Math.abs(calculatedPrice - pool.expectedUSD);

            if (diff > tolerance) {
                throw new Error(`${pool.name} (${pool.type}): Expected ~$${pool.expectedUSD}, got $${calculatedPrice.toFixed(6)}`);
            }

            log(`  ✅ ${pool.name} (${pool.type}) | Expected: $${pool.expectedUSD} | Got: $${calculatedPrice.toFixed(6)}`);
            passed++;
        }

        // ====================================================================
        logPhase(3, 'Flipped Pair Configurations');
        // ====================================================================

        // Test with token1 = asset (reversed token order)
        total++;
        logSection('USDC/WBTC (flipped, V2)');

        const wbtc = await getOrDeployToken('WBTC_FLIP', 8);
        const wbtcAddr = await wbtc.getAddress();

        // USDC is token0, WBTC is token1 → price of USDC in WBTC = 1/67500
        const flippedV2 = await MockV2.deploy(usdcRefAddr, wbtcAddr);
        await flippedV2.waitForDeployment();
        // R0 = 67500 USDC (6 dec), R1 = 1 WBTC (8 dec)
        await flippedV2.setReserves(ethers.parseUnits('67500', 6), ethers.parseUnits('1', 8));

        const [flipSuccess, flipPrice] = await priceCalc.getPriceUSDWithFallback(
            await flippedV2.getAddress(),
            wbtcAddr,
            ethers.ZeroAddress,
            false,
            1  // stablecoin is token0
        );

        assert(flipSuccess, 'Flipped USDC/WBTC should succeed');
        const flipCalcPrice = Number(ethers.formatUnits(flipPrice, 18));
        const flipTolerance = 67500 * 0.01;
        assert(Math.abs(flipCalcPrice - 67500) <= flipTolerance, `Flipped price should be ~$67500, got $${flipCalcPrice.toFixed(2)}`);
        log(`  ✅ USDC/WBTC (flipped V2) | Expected: $67500 | Got: $${flipCalcPrice.toFixed(6)}`);
        passed++;

        // Summary
        log(`\n══════════════════════════════════════════════════════════════════════`);
        log(`RESULTS: ${passed}/${total} reference pool tests PASSED`);
        log(`══════════════════════════════════════════════════════════════════════`);

        reportTestResult('32-reference-pools', true);
        logSuccess('\n✅ TEST 32 PASSED!\n');

    } catch (error) {
        console.error(error);
        reportTestResult('32-reference-pools', false, error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => process.exit(1));
