import "@nomicfoundation/hardhat-ethers";
import dotenv from "dotenv";

dotenv.config();

// Read environment variables
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const MNEMONIC = process.env.MNEMONIC;
const RPC_URL = process.env.RPC_URL;
const CHAIN_ID = parseInt(process.env.CHAIN_ID || "1", 10);

// Parse accounts config (PRIVATE_KEY takes precedence over MNEMONIC)
let accountsConfig;
if (
  PRIVATE_KEY &&
  PRIVATE_KEY !== "0xYourPrivateKeyHere" &&
  PRIVATE_KEY.trim().length > 10
) {
  accountsConfig = [
    PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`,
  ];
} else if (
  MNEMONIC &&
  MNEMONIC !== "your mnemonic here" &&
  MNEMONIC.trim().length > 0
) {
  accountsConfig = {
    mnemonic: MNEMONIC.trim(),
    path: "m/44'/60'/0'/0",
    initialIndex: 0,
    count: 10,
  };
} else {
  accountsConfig = [];
}

/** @type import('hardhat/config').HardhatUserConfig */
export default {
  solidity: {
    compilers: [
      {
        // Must match the deployment profile of the dev repo EXACTLY so the bytecode is
        // reproducible/verifiable on-chain (C-1). All contracts are pragma ^0.8.20, so pinning
        // 0.8.20 (not 0.8.28) + evmVersion "paris" avoids PUSH0 and keeps the same bytecode
        // valid on every EVM chain in the deploy set, including chains without PUSH0.
        version: "0.8.20",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1,
          },
          viaIR: true,
          evmVersion: "paris",
        },
      },
    ],
  },
  networks: {
    hardhat: {
      chainId: 1337,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 1337,
    },
    // Preset Mainnets
    ethereum: {
      url: process.env.ETHEREUM_RPC_URL || "https://eth.llamarpc.com",
      chainId: 1,
      accounts: accountsConfig,
    },
    bsc: {
      url: process.env.BSC_RPC_URL || "https://binance.llamarpc.com",
      chainId: 56,
      accounts: accountsConfig,
    },
    polygon: {
      url: process.env.POLYGON_RPC_URL || "https://polygon.llamarpc.com",
      chainId: 137,
      accounts: accountsConfig,
    },
    arbitrum: {
      url: process.env.ARBITRUM_RPC_URL || "https://arbitrum.llamarpc.com",
      chainId: 42161,
      accounts: accountsConfig,
    },
    optimism: {
      url: process.env.OPTIMISM_RPC_URL || "https://optimism.llamarpc.com",
      chainId: 10,
      accounts: accountsConfig,
    },
    base: {
      url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      chainId: 8453,
      accounts: accountsConfig,
    },
    // Preset Testnets
    sepolia: {
      url:
        process.env.SEPOLIA_RPC_URL ||
        "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      accounts: accountsConfig,
    },
    amoy: {
      url: process.env.AMOY_RPC_URL || "https://rpc-amoy.polygon.technology",
      chainId: 80002,
      accounts: accountsConfig,
    },
    bscTestnet: {
      url:
        process.env.BSC_TESTNET_RPC_URL ||
        "https://bsc-testnet-rpc.publicnode.com",
      chainId: 97,
      accounts: accountsConfig,
    },
    // Mainnet / any EVM chain — configured dynamically via .env (custom / mainnet aliases)
    mainnet: {
      url: RPC_URL || "",
      chainId: CHAIN_ID,
      accounts: accountsConfig,
    },
    custom: {
      url: RPC_URL || "",
      chainId: CHAIN_ID,
      accounts: accountsConfig,
    },
  },
};
