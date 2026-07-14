// =============================================================
// Locker Protocol — Local Testnet Deployment Script
// =============================================================
// Usage: npx hardhat node (terminal 1)
//        npx hardhat run scripts/deploy-local.js --network localhost (terminal 2)
//
// Deploys the full Locker suite on a local Hardhat node for testing.
// No external dependencies (no blockchain-config.json, no UI).
// =============================================================

const ethers = require("ethers");
const fs = require("fs");
const path = require("path");

// ---- Configuration ----
const CONFIG = {
  rpcUrl: "http://127.0.0.1:8545",
  // Default Hardhat test accounts as signers (for local testing only)
  initialSigners: [
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", // Hardhat account #0
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // Hardhat account #1
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", // Hardhat account #2
    "0x90F79bf6EB2c4f870365E785982E1f101E93b906", // Hardhat account #3
    "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", // Hardhat account #4
  ],
  threshold: 3,
};

// Helper: load a compiled Hardhat artifact
function loadArtifact(contractName) {
  const artifactPath = path.join(
    process.cwd(),
    "artifacts/contracts",
    `${contractName}.sol`,
    `${contractName}.json`,
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Artifact not found: ${artifactPath}`);
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8"));
}

// Helper: deploy a contract
async function deploy(deployer, contractName, constructorArgs = []) {
  console.log(`📦 Deploying ${contractName}...`);

  const artifact = loadArtifact(contractName);
  const factory = new ethers.ContractFactory(
    artifact.abi,
    artifact.bytecode,
    deployer,
  );
  const contract = await factory.deploy(...constructorArgs);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log(`   ✅ ${contractName}: ${address}\n`);
  return { contract, address };
}

async function main() {
  console.log("\n🚀 Deploying Locker Protocol on local testnet...\n");

  // Connect to local Hardhat node
  const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
  const deployer = await provider.getSigner(0);
  const deployerAddress = await deployer.getAddress();

  console.log("📝 Deployer:", deployerAddress);
  const balance = await provider.getBalance(deployerAddress);
  console.log("💰 Balance:", ethers.formatEther(balance), "ETH\n");

  const deployedContracts = {};

  console.log("📊 Configuration:");
  console.log("   Network: Hardhat Local Testnet");
  console.log("   ChainId: 1337");
  console.log("   Signers:", CONFIG.initialSigners.length);
  console.log("   Threshold:", CONFIG.threshold, "\n");

  // === DEPLOY MOCK WETH (required by PriceCalculator) ===

  const { address: wethAddr } = await deploy(deployer, "ERC20Mock", [
    "Wrapped Ether",
    "WETH",
    deployerAddress,
    ethers.parseEther("1000000000"),
    18,
  ]);
  deployedContracts.WETH = wethAddr;

  // === DEPLOY CORE CONTRACTS ===

  const { address: priceCalculatorAddr } = await deploy(
    deployer,
    "PriceCalculator",
    [wethAddr, []],
  );
  deployedContracts.PriceCalculator = priceCalculatorAddr;

  const { address: validationHandlerAddr } = await deploy(
    deployer,
    "ValidationHandler",
    [CONFIG.threshold],
  );
  deployedContracts.ValidationHandler = validationHandlerAddr;

  const { address: lockManagerAddr } = await deploy(deployer, "LockManager", [
    priceCalculatorAddr,
  ]);
  deployedContracts.LockManager = lockManagerAddr;

  const { address: signerManagerAddr } = await deploy(
    deployer,
    "SignerManager",
    [
      validationHandlerAddr,
      CONFIG.initialSigners,
      CONFIG.threshold,
    ],
  );
  deployedContracts.SignerManager = signerManagerAddr;

  const { address: vestingManagerAddr } = await deploy(
    deployer,
    "VestingManager",
    [lockManagerAddr],
  );
  deployedContracts.VestingManager = vestingManagerAddr;

  const { address: lockerContractAddr } = await deploy(
    deployer,
    "LockerContract",
    [
      validationHandlerAddr,
      lockManagerAddr,
      signerManagerAddr,
      vestingManagerAddr,
      CONFIG.initialSigners,
      CONFIG.threshold,
    ],
  );
  deployedContracts.LockerContract = lockerContractAddr;

  // === DEPLOY STABLECOIN MOCKS ===

  console.log("💰 Deploying stablecoin mocks...\n");

  const { address: usdtAddr } = await deploy(deployer, "ERC20Mock", [
    "Tether USD",
    "USDT",
    deployerAddress,
    ethers.parseUnits("10000000", 6),
    6,
  ]);
  deployedContracts.USDT = usdtAddr;

  const { address: usdcAddr } = await deploy(deployer, "ERC20Mock", [
    "USD Coin",
    "USDC",
    deployerAddress,
    ethers.parseUnits("10000000", 6),
    6,
  ]);
  deployedContracts.USDC = usdcAddr;

  const { address: daiAddr } = await deploy(deployer, "ERC20Mock", [
    "Dai Stablecoin",
    "DAI",
    deployerAddress,
    ethers.parseUnits("10000000", 18),
    18,
  ]);
  deployedContracts.DAI = daiAddr;

  // === SUMMARY ===

  console.log("\n" + "=".repeat(60));
  console.log("✅ LOCAL DEPLOYMENT COMPLETE!\n");
  console.log("📋 CONTRACT ADDRESSES:\n");
  console.log("   Core Contracts:");
  console.log("      PriceCalculator:    ", deployedContracts.PriceCalculator);
  console.log(
    "      ValidationHandler:  ",
    deployedContracts.ValidationHandler,
  );
  console.log("      LockManager:        ", deployedContracts.LockManager);
  console.log("      SignerManager:      ", deployedContracts.SignerManager);
  console.log("      VestingManager:     ", deployedContracts.VestingManager);
  console.log(
    "      LockerContract:     ",
    deployedContracts.LockerContract,
    "⭐\n",
  );

  console.log("   Tokens (Mock):");
  console.log("      WETH:               ", deployedContracts.WETH);
  console.log("      USDT:               ", deployedContracts.USDT);
  console.log("      USDC:               ", deployedContracts.USDC);
  console.log("      DAI:                ", deployedContracts.DAI);
  console.log("\n" + "=".repeat(60) + "\n");

  // Save addresses to file
  const deploymentInfo = {
    network: "localhost",
    chainId: 1337,
    deployer: deployerAddress,
    deploymentDate: new Date().toISOString(),
    contracts: deployedContracts,
    config: {
      validationThreshold: CONFIG.threshold,
      signers: CONFIG.initialSigners,
    },
  };

  fs.writeFileSync(
    "deployed-addresses.json",
    JSON.stringify(deploymentInfo, null, 2),
  );
  console.log("💾 Addresses saved to deployed-addresses.json\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ DEPLOYMENT FAILED:");
    console.error("   ", error.message);
    if (error.stack) console.error("\n📝 Stack:", error.stack);
    process.exit(1);
  });
