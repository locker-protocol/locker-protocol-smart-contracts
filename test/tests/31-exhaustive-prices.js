/**
 * Test 31: Exhaustive Price Calculation Tests
 * 
 * Tests PriceCalculator logic extensively with:
 * - Different token types: ETH/USDC, Token/ETH, Token/USDC
 * - Flipped pairs: USDC/ETH, ETH/Token, USDC/Token
 * - Different decimals: 6, 8, 12, 18
 * - Both V2 and V3 mock pairs
 */

import {
    loadSharedState,
    getContract,
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

// Test combinations
const DECIMALS = [6, 8, 12, 18];
const TARGET_PRICES = [0.001, 1, 2500, 1000000]; // Various ranges

async function main() {
    log('\n🧪 TEST 31: EXHAUSTIVE PRICE CALCULATIONS\n', '\x1b[1m\x1b[36m');

    try {
        const state = loadSharedState();
        const deployer = await getWallet(0);

        // We deploy a fresh PriceCalculator to be sure
        const PriceCalcFactory = await ethers.getContractFactory('PriceCalculator', deployer);

        // Let's create a mock WETH for our PriceCalculator to recognize
        const ERC20Mock = await ethers.getContractFactory('ERC20Mock', deployer);
        const weth = await ERC20Mock.deploy('Wrapped ETH', 'WETH', deployer.address, ethers.parseEther('100'), 18);
        await weth.waitForDeployment();
        const wethAddr = await weth.getAddress();

        const priceCalc = await PriceCalcFactory.deploy(wethAddr, []);
        await priceCalc.waitForDeployment();
        const priceCalcAddr = await priceCalc.getAddress();

        logSuccess(`Fresh PriceCalculator deployed: ${priceCalcAddr}`);

        // Helper to deploy ERC20s
        async function deployToken(name, symbol, decimals) {
            const t = await ERC20Mock.deploy(name, symbol, deployer.address, ethers.parseUnits('1000000', decimals), decimals);
            await t.waitForDeployment();
            return t;
        }

        // Helper to deploy V2 pair and set price
        async function deployV2Pair(token0, token1, priceToken0InToken1Num) {
            const MockV2 = await ethers.getContractFactory('MockUniswapV2Pair', deployer);
            const pair = await MockV2.deploy(await token0.getAddress(), await token1.getAddress());
            await pair.waitForDeployment();

            // To set price P of token0 in token1 for V2:
            // R1 / R0 = P (adjusted for decimals)
            // Let's fix R0 = 1000 (with its decimals)
            const d0 = Number(await token0.decimals());
            const d1 = Number(await token1.decimals());

            const r0 = ethers.parseUnits("1000", d0);

            // R1 = R0 * P
            // Wait, we need to apply P as a math string to avoid JS float issues,
            // but for mocks we can just use standard JS math carefully if P is safe.
            let r1String = (1000 * priceToken0InToken1Num).toFixed(d1 > 6 ? 6 : d1);
            if (r1String.includes('.')) {
                r1String = r1String.replace(/\.?0+$/, ''); // trim trailing zeros
            }
            const r1 = ethers.parseUnits(r1String, d1);

            await pair.setReserves(r0, r1);
            return pair;
        }

        // Helper to deploy V3 pair and set price
        async function deployV3Pair(token0, token1, priceToken0InToken1Num) {
            const MockV3 = await ethers.getContractFactory('MockUniswapV3Pool', deployer);
            const pool = await MockV3.deploy(await token0.getAddress(), await token1.getAddress());
            await pool.waitForDeployment();

            // Expected P in 1e18 format
            const p1e18 = ethers.parseUnits(priceToken0InToken1Num.toFixed(18), 18);
            await pool.setPriceToken0InToken1(p1e18);

            return pool;
        }

        async function verifyPrice(tokenToCheck, pairAddr, ethUsdPairAddr, isEthPair, stablecoinPos, expectedPriceUSDNum, description) {
            const [success, price1e18] = await priceCalc.getPriceUSDWithFallback(
                pairAddr,
                tokenToCheck,
                ethUsdPairAddr,
                isEthPair,
                stablecoinPos
            );

            assert(success, `${description}: Should return success=true`);

            const calculatedPriceNum = Number(ethers.formatUnits(price1e18, 18));

            // Allow small floating point difference (0.1% max)
            const diff = Math.abs(calculatedPriceNum - expectedPriceUSDNum);
            const tolerance = expectedPriceUSDNum * 0.001;

            if (diff > tolerance) {
                throw new Error(`${description}: Price mismatch. Expected ~${expectedPriceUSDNum}, got ${calculatedPriceNum}`);
            }
            log(`  ✅ ${description} | Expected: ${expectedPriceUSDNum} | Got: ${calculatedPriceNum}`);
        }

        logPhase(1, 'Exhaustive Configurations');

        for (const targetDecimals of DECIMALS) {
            for (const quoteDecimals of DECIMALS) {
                logSection(`Testing Decimals: Target(${targetDecimals}) / Quote(${quoteDecimals})`);

                const targetToken = await deployToken('Target', 'TGT', targetDecimals);
                const targetAddr = await targetToken.getAddress();

                const quoteToken = await deployToken('Quote', 'QTE', quoteDecimals);
                const quoteAddr = await quoteToken.getAddress();

                // We test just one test price per combination to save time, but it rotates
                const price = TARGET_PRICES[(targetDecimals + quoteDecimals) % TARGET_PRICES.length];

                // CASE 1: Direct stablecoin pair (e.g., TGT/USDC where USDC is quote)
                // token0 = TGT, token1 = Quote
                let v2Pair = await deployV2Pair(targetToken, quoteToken, price);
                await verifyPrice(targetAddr, await v2Pair.getAddress(), ethers.ZeroAddress, false, 2, price, `V2 Direct Token0=Target, Stable=Token1(${quoteDecimals}d)`);

                let v3Pair = await deployV3Pair(targetToken, quoteToken, price);
                await verifyPrice(targetAddr, await v3Pair.getAddress(), ethers.ZeroAddress, false, 2, price, `V3 Direct Token0=Target, Stable=Token1(${quoteDecimals}d)`);

                // CASE 2: Flipped direct stablecoin pair (e.g., USDC/TGT where USDC is token0)
                // token0 = Quote, token1 = TGT
                // Price of quote in TGT is 1/price
                v2Pair = await deployV2Pair(quoteToken, targetToken, 1 / price);
                await verifyPrice(targetAddr, await v2Pair.getAddress(), ethers.ZeroAddress, false, 1, price, `V2 Direct Stable=Token0(${quoteDecimals}d), Token1=Target`);

                v3Pair = await deployV3Pair(quoteToken, targetToken, 1 / price);
                const slot0QuoteFirst = await v3Pair.slot0();
                console.log(`DEBUG: Target(${targetDecimals}), Quote(${quoteDecimals}), P=${1 / price} => slot0=${slot0QuoteFirst[0].toString()}`);

                // For V3 mock, setPriceToken0InToken1 expects Price of Token0 in Token1.
                // Token0 is Quote, Token1 is Target. Price of Quote in Target is 1/price.
                await verifyPrice(targetAddr, await v3Pair.getAddress(), ethers.ZeroAddress, false, 1, price, `V3 Direct Stable=Token0(${quoteDecimals}d), Token1=Target`);
            }
        }

        logPhase(2, 'ETH Routing Configurations');
        // Test Token -> WETH -> USDC routing
        const targetDecimals = 18; // mostly ERC20s are 18
        const wethDec = 18;
        const usdcDec = 6;

        const tkn = await deployToken('TK', 'TK', targetDecimals);
        const usdc = await deployToken('USDC', 'USDC', usdcDec);

        const priceTknInWeth = 0.05; // 1 TKN = 0.05 WETH
        const priceWethInUsdc = 3000; // 1 WETH = 3000 USDC
        const expectedPriceTknInUsdc = priceTknInWeth * priceWethInUsdc; // 150

        // Setup TKN/WETH V2
        const tknWethV2 = await deployV2Pair(tkn, weth, priceTknInWeth);
        // Setup WETH/USDC V2
        const wethUsdcV2 = await deployV2Pair(weth, usdc, priceWethInUsdc);

        await verifyPrice(
            await tkn.getAddress(),
            await tknWethV2.getAddress(),
            await wethUsdcV2.getAddress(),
            true,
            2, // token1 is stablecoin in WETH/USDC
            expectedPriceTknInUsdc,
            "V2 ETH Routing (TKN/WETH -> WETH/USDC)"
        );

        // Same but flipped WETH/USDC -> USDC/WETH
        const usdcWethV2 = await deployV2Pair(usdc, weth, 1 / priceWethInUsdc);
        await verifyPrice(
            await tkn.getAddress(),
            await tknWethV2.getAddress(),
            await usdcWethV2.getAddress(),
            true,
            1, // token0 is stablecoin currently in logic? Wait, the param is `stablecoinPosition` for the USD pair!
            expectedPriceTknInUsdc,
            "V2 ETH Routing (TKN/WETH -> USDC/WETH)"
        );

        // V3 variants
        const tknWethV3 = await deployV3Pair(tkn, weth, priceTknInWeth);
        const wethUsdcV3 = await deployV3Pair(weth, usdc, priceWethInUsdc);

        await verifyPrice(
            await tkn.getAddress(),
            await tknWethV3.getAddress(),
            await wethUsdcV3.getAddress(),
            true,
            2,
            expectedPriceTknInUsdc,
            "V3 ETH Routing (TKN/WETH -> WETH/USDC)"
        );

        reportTestResult('31-exhaustive-prices', true);
        logSuccess('\n✅ TEST 31 PASSED!\n');

    } catch (error) {
        console.error(error);
        reportTestResult('31-exhaustive-prices', false, error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => process.exit(1));
