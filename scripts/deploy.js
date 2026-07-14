// =============================================================
// Locker Protocol — Mainnet Deployment Script
// =============================================================
// Usage: npx hardhat run scripts/deploy.js --network mainnet
//
// Before running:
//   1. Copy .env.example to .env
//   2. Set PRIVATE_KEY, RPC_URL, CHAIN_ID, WETH_ADDRESS
//   3. Set INITIAL_SIGNERS (comma-separated, min 3 addresses)
//   4. Set THRESHOLD (min 3)
//   5. Ensure the deployer has enough native gas tokens
//
// After deployment:
//   Go to https://lockerprotocol.com → "Add Custom Locker"
//   and paste your LockerContract address.
// =============================================================

const hre = require("hardhat");
const ethers = hre.ethers;
const fs = require("fs");
const path = require("path");

// ---- Load configuration from .env ----
function loadConfig() {
  const wethAddress = process.env.WETH_ADDRESS;
  if (
    !wethAddress ||
    wethAddress === "0x0000000000000000000000000000000000000000"
  ) {
    throw new Error(
      "WETH_ADDRESS not set in .env — required for PriceCalculator",
    );
  }

  const signersRaw = process.env.INITIAL_SIGNERS || "";
  const initialSigners = signersRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (initialSigners.length < 3) {
    throw new Error(
      `Need at least 3 signers, got ${initialSigners.length}. Set INITIAL_SIGNERS in .env`,
    );
  }
  if (initialSigners.length > 20) {
    throw new Error(`Maximum 20 signers allowed, got ${initialSigners.length}`);
  }

  const threshold = parseInt(process.env.THRESHOLD || "3", 10);
  if (threshold < 3) {
    throw new Error(`Threshold must be >= 3, got ${threshold}`);
  }
  if (threshold > initialSigners.length) {
    throw new Error(
      `Threshold (${threshold}) cannot exceed signers count (${initialSigners.length})`,
    );
  }

  // Optional comma-separated list of additional wrapped-native addresses,
  // registered immutably in the PriceCalculator constructor.
  const customWethRaw = process.env.CUSTOM_WETH_ADDRESSES || "";
  const customWethAddresses = customWethRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const addr of customWethAddresses) {
    if (!addr.startsWith("0x") || addr.length !== 42) {
      throw new Error(`Invalid CUSTOM_WETH_ADDRESSES entry: ${addr}`);
    }
  }

  return { wethAddress, initialSigners, threshold, customWethAddresses };
}

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
  const config = loadConfig();

  console.log("\n🚀 Deploying Locker Protocol...\n");

  const provider = hre.ethers.provider;
  const [deployer] = await hre.ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);

  console.log("📡 Network Name:", network.name);
  console.log("⛓️  Chain ID:", chainId);
  console.log("📝 Deployer:", deployerAddress);

  const balance = await provider.getBalance(deployerAddress);
  console.log("💰 Balance:", ethers.formatEther(balance), "ETH\n");

  if (balance === 0n) {
    throw new Error("Insufficient balance to deploy!");
  }

  console.log("📊 Configuration:");
  console.log("   WETH address:   ", config.wethAddress);
  console.log("   Custom WETH:    ", config.customWethAddresses.length);
  console.log("   Initial Signers:", config.initialSigners.length);
  console.log("   Threshold:      ", config.threshold, "\n");

  const deployedContracts = {};

  // === DEPLOY CORE CONTRACTS ===

  const { address: priceCalculatorAddr } = await deploy(
    deployer,
    "PriceCalculator",
    [config.wethAddress, config.customWethAddresses],
  );
  deployedContracts.PriceCalculator = priceCalculatorAddr;

  const { address: validationHandlerAddr } = await deploy(
    deployer,
    "ValidationHandler",
    [config.threshold],
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
      config.initialSigners,
      config.threshold,
    ],
  );
  deployedContracts.SignerManager = signerManagerAddr;

  const { address: vestingManagerAddr } = await deploy(
    deployer,
    "VestingManager",
    [lockManagerAddr],
  );
  deployedContracts.VestingManager = vestingManagerAddr;

  // Every administrative operation requires the M-of-N multisig threshold
  const { address: lockerContractAddr } = await deploy(
    deployer,
    "LockerContract",
    [
      validationHandlerAddr,
      lockManagerAddr,
      signerManagerAddr,
      vestingManagerAddr,
      config.initialSigners,
      config.threshold,
    ],
  );
  deployedContracts.LockerContract = lockerContractAddr;

  // === SUMMARY ===

  console.log("\n" + "=".repeat(60));
  console.log("✅ MAINNET DEPLOYMENT COMPLETE!\n");
  console.log("📋 CONTRACT ADDRESSES:\n");
  console.log("   PriceCalculator:    ", deployedContracts.PriceCalculator);
  console.log("   ValidationHandler:  ", deployedContracts.ValidationHandler);
  console.log("   LockManager:        ", deployedContracts.LockManager);
  console.log("   SignerManager:      ", deployedContracts.SignerManager);
  console.log("   VestingManager:     ", deployedContracts.VestingManager);
  console.log(
    "   LockerContract:     ",
    deployedContracts.LockerContract,
    "⭐",
  );
  console.log("\n" + "=".repeat(60));

  // Save addresses
  const deploymentInfo = {
    network: network.name,
    chainId: chainId,
    deployer: deployerAddress,
    deploymentDate: new Date().toISOString(),
    contracts: deployedContracts,
    config: {
      wethAddress: config.wethAddress,
      validationThreshold: config.threshold,
      signers: config.initialSigners,
    },
  };

  const filename = `deployed-addresses-${chainId}.json`;
  fs.writeFileSync(filename, JSON.stringify(deploymentInfo, null, 2));
  console.log(`\n💾 Addresses saved to ${filename}\n`);

  console.log("📌 NEXT STEPS:");
  console.log("   1. Go to https://lockerprotocol.com");
  console.log("   2. Connect your wallet (MetaMask)");
  console.log('   3. Click "Add Custom Locker"');
  console.log(`   4. Paste your LockerContract address: ${lockerContractAddr}`);
  console.log("   5. Your Locker is now registered on the protocol! 🎉\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ MAINNET DEPLOYMENT FAILED:");
    console.error("   ", error.message);
    if (error.stack) console.error("\n📝 Stack:", error.stack);
    process.exit(1);
  });
