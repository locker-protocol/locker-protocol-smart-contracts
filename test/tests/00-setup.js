/**
 * 00-setup.js - ONE-TIME SETUP
 *
 * This script runs ONCE before all tests to:
 * 1. Deploy all contracts
 * 2. Generate test mnemonic
 * 3. Create test wallets
 * 4. Distribute ETH to test wallets
 * 5. Distribute test tokens to wallets
 * 6. Save shared state for all tests
 *
 * ALL subsequent tests (01, 02, 03...) will use this shared state.
 */

import {
  saveSharedState,
  clearSharedState,
  clearTestResults,
  generateRandomMnemonic,
  getWalletsFromMnemonic,
  distributeETH,
  distributeTokens,
  logPhase,
  logSection,
  logSuccess,
  log,
  hre,
  getEthers,
} from "../core/utils.js";

const ethers = getEthers();

async function main() {
  log("\n🏗️  SETUP: Initializing Test Environment\n", "\x1b[1m\x1b[36m");

  // Clear previous state
  clearSharedState();
  clearTestResults();
  logSuccess("Cleared previous state");

  // Phase 1: Generate Mnemonic & Wallets
  logPhase(1, "Generate Mnemonic & Wallets");
  const mnemonic = generateRandomMnemonic(12);
  log(`Mnemonic: ${mnemonic}`, "\x1b[90m");

  const wallets = await getWalletsFromMnemonic(mnemonic, 20);
  logSuccess(`Generated 20 wallets from mnemonic`);

  // Log wallet addresses
  logSection("Wallet Addresses");
  for (let i = 0; i < Math.min(5, wallets.length); i++) {
    log(`  Wallet ${i}: ${wallets[i].address}`, "\x1b[90m");
  }
  log(`  ... and ${wallets.length - 5} more wallets`, "\x1b[90m");

  // Phase 2: Deploy Contracts
  logPhase(2, "Deploy Smart Contracts");

  const [deployer] = await ethers.getSigners();
  log(`Deployer: ${deployer.address}`, "\x1b[90m");

  // Deploy PriceCalculator
  logSection("Deploying PriceCalculator");
  const PriceCalculator = await ethers.getContractFactory("PriceCalculator");
  const priceCalculator = await PriceCalculator.deploy(ethers.ZeroAddress, []); // address(0) for Ethereum WETH fallback, no custom WETH
  await priceCalculator.waitForDeployment();
  const priceCalculatorAddress = await priceCalculator.getAddress();
  logSection("Deploying ValidationHandler");
  const ValidationHandler =
    await ethers.getContractFactory("ValidationHandler");
  const INITIAL_THRESHOLD = 3; // Minimum required by contract
  const validationHandler = await ValidationHandler.deploy(INITIAL_THRESHOLD);
  await validationHandler.waitForDeployment();
  const validationHandlerAddress = await validationHandler.getAddress();
  logSuccess(`ValidationHandler: ${validationHandlerAddress}`);

  // Deploy LockManager
  logSection("Deploying LockManager");
  const LockManager = await ethers.getContractFactory("LockManager");
  const lockManager = await LockManager.deploy(priceCalculatorAddress);
  await lockManager.waitForDeployment();
  const lockManagerAddress = await lockManager.getAddress();
  logSuccess(`LockManager: ${lockManagerAddress}`);

  // Deploy VestingManager
  logSection("Deploying VestingManager");
  const VestingManager = await ethers.getContractFactory("VestingManager");
  const vestingManager = await VestingManager.deploy(lockManagerAddress);
  await vestingManager.waitForDeployment();
  const vestingManagerAddress = await vestingManager.getAddress();
  logSuccess(`VestingManager: ${vestingManagerAddress}`);

  // Deploy OperationTracker removed

  // Deploy SignerManager
  logSection("Deploying SignerManager");
  const SignerManager = await ethers.getContractFactory("SignerManager");
  // SignerManager needs: _validationHandler, _owner, _initialSigners[], _initialThreshold
  // Need at least MIN_SIGNERS (3) signers, using 5 for broader test coverage
  const initialSigners = [
    wallets[0].address,
    wallets[1].address,
    wallets[2].address,
    wallets[3].address,
    wallets[4].address,
  ];
  const signerManager = await SignerManager.deploy(
    validationHandlerAddress,
    initialSigners,
    INITIAL_THRESHOLD,
  );
  await signerManager.waitForDeployment();
  const signerManagerAddress = await signerManager.getAddress();
  logSuccess(`SignerManager: ${signerManagerAddress}`);

  // Deploy LockerContract
  logSection("Deploying LockerContract");
  const LockerContract = await ethers.getContractFactory("LockerContract");
  const lockerContract = await LockerContract.deploy(
    validationHandlerAddress,
    lockManagerAddress,
    signerManagerAddress,
    vestingManagerAddress,
    initialSigners,
    INITIAL_THRESHOLD,
  );
  await lockerContract.waitForDeployment();
  const lockerContractAddress = await lockerContract.getAddress();
  logSuccess(`LockerContract: ${lockerContractAddress}`);

  // Deploy Test Tokens
  logSection("Deploying Test Tokens");
  const ERC20Mock = await ethers.getContractFactory("ERC20Mock");

  const testToken = await ERC20Mock.deploy(
    "Test Token",
    "TEST",
    deployer.address,
    ethers.parseEther("10000000"),
    18,
  );
  await testToken.waitForDeployment();
  const testTokenAddress = await testToken.getAddress();
  logSuccess(`TestToken: ${testTokenAddress}`);

  const testToken2 = await ERC20Mock.deploy(
    "Test Token 2",
    "TEST2",
    deployer.address,
    ethers.parseEther("10000000"),
    18,
  );
  await testToken2.waitForDeployment();
  const testToken2Address = await testToken2.getAddress();
  logSuccess(`TestToken2: ${testToken2Address}`);

  const testToken3 = await ERC20Mock.deploy(
    "Test Token 3",
    "TEST3",
    deployer.address,
    ethers.parseEther("10000000"),
    18,
  );
  await testToken3.waitForDeployment();
  const testToken3Address = await testToken3.getAddress();
  logSuccess(`TestToken3: ${testToken3Address}`);

  // Build contracts object
  const contracts = {
    PriceCalculator: priceCalculatorAddress,
    ValidationHandler: validationHandlerAddress,
    LockManager: lockManagerAddress,
    VestingManager: vestingManagerAddress,
    LockerContract: lockerContractAddress,
    TestToken: testTokenAddress,
    TestToken2: testToken2Address,
    TestToken3: testToken3Address,
  };

  // Phase 3: Distribute ETH
  logPhase(3, "Distribute ETH to Test Wallets");
  const ethAmount = ethers.parseEther("10"); // 10 ETH per wallet

  // Distribute to first 10 wallets
  await distributeETH(deployer, wallets.slice(0, 10), ethAmount);

  // Phase 4: Distribute Test Tokens
  logPhase(4, "Distribute Test Tokens");

  const tokenAmount = ethers.parseEther("100000"); // 100k tokens per wallet

  logSection("Distributing TEST");
  await distributeTokens(
    testToken,
    deployer,
    wallets.slice(0, 10),
    tokenAmount,
  );

  logSection("Distributing TEST2");
  await distributeTokens(
    testToken2,
    deployer,
    wallets.slice(0, 10),
    tokenAmount,
  );

  logSection("Distributing TEST3");
  await distributeTokens(
    testToken3,
    deployer,
    wallets.slice(0, 10),
    tokenAmount,
  );

  // Phase 5: Save Shared State
  logPhase(5, "Save Shared State");

  const block = await ethers.provider.getBlock("latest");
  const state = {
    mnemonic,
    contracts,
    setup: {
      timestamp: block.timestamp,
      blockNumber: block.number,
      completed: true,
      date: new Date().toISOString(),
    },
    wallets: wallets.slice(0, 10).map((w, i) => ({
      index: i,
      address: w.address,
      label:
        [
          "deployer",
          "alice",
          "bob",
          "charlie",
          "dave",
          "eve",
          "frank",
          "grace",
          "henry",
          "iris",
        ][i] || `wallet${i}`,
    })),
  };

  saveSharedState(state);

  // Summary
  logPhase("✅", "Setup Complete");
  log(`Contracts deployed: ${Object.keys(contracts).length}`, "\x1b[32m");
  log(`Wallets created: ${wallets.length}`, "\x1b[32m");
  log(`ETH distributed: 10 wallets x 10 ETH`, "\x1b[32m");
  log(`Tokens distributed: TEST, TEST2, TEST3 (100k each)`, "\x1b[32m");
  log(`\nShared state saved to .shared-state.json`, "\x1b[32m");
  log(`\n✅ Ready to run tests!\n`, "\x1b[1m\x1b[32m");
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ SETUP FAILED:\n", error);
    process.exit(1);
  });
