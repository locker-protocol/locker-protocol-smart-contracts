const hre = require('hardhat');
const ethers = hre.ethers;

async function main() {
    const deployer = (await ethers.getSigners())[0];
    const MockV3 = await ethers.getContractFactory('MockUniswapV3Pool', deployer);
    // Fake tokens with 6 decimals Just to test the math
    const pool = await MockV3.deploy(deployer.address, deployer.address);
    await pool.waitForDeployment();
    console.log("Deployed");

    const Q192 = 2n ** 192n;
    const P = 1000n;
    const priceX192 = P * Q192;
    console.log("priceX192 in JS:", priceX192.toString());

    // Test what _sqrt does inside the pool! 
    // Wait, _sqrt is internal. Let's just call setPriceToken0InToken1 and see what slot0 says.
    // wait, deploy token first.
    const ERC20Mock = await ethers.getContractFactory('ERC20Mock', deployer);
    const t0 = await ERC20Mock.deploy('T0', 'T0', deployer.address, 100n, 6);
    const t1 = await ERC20Mock.deploy('T1', 'T1', deployer.address, 100n, 6);
    await t0.waitForDeployment();
    await t1.waitForDeployment();

    const poolReal = await MockV3.deploy(await t0.getAddress(), await t1.getAddress());
    await poolReal.waitForDeployment();

    const p1e18 = ethers.parseUnits("1000", 18);
    await poolReal.setPriceToken0InToken1(p1e18);

    const slot0 = await poolReal.slot0();
    const sqrtPriceX96_fromContract = slot0[0];

    // JS exact sqrt
    // BigInt sqrt
    function bigIntSqrt(value) {
        if (value < 0n) throw 'square root of negative numbers is not supported'
        if (value < 2n) return value;
        function newtonIteration(n, x0) {
            const x1 = ((n / x0) + x0) >> 1n;
            if (x0 === x1 || x0 === (x1 - 1n)) {
                return x0;
            }
            return newtonIteration(n, x1);
        }
        return newtonIteration(value, 1n);
    }
    const jsSqrt = bigIntSqrt(priceX192);

    console.log("Contract  sqrtPriceX96 =", sqrtPriceX96_fromContract.toString());
    console.log("JS Exact  sqrtPriceX96 =", jsSqrt.toString());
}
main().catch(console.error);
