/**
 * Centralized Test Utilities for Locker Smart Contract Tests
 * 
 * This module provides common functions, constants, and helpers
 * used across all test files in tests-locker/
 * 
 * SHARED STATE ARCHITECTURE:
 * - 00-setup.js runs ONCE and creates .shared-state.json
 * - All tests load shared state (no redeployment)
 * - Tests run sequentially on same blockchain
 */

import hre from "hardhat";
import { Wallet, Contract } from "ethers";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Getter function for ethers - will work with Hardhat v2
function getEthers() {
    if (!hre.ethers) {
        throw new Error('hre.ethers is not available. Make sure Hardhat v2 and @nomicfoundation/hardhat-ethers plugin are installed.');
    }
    return hre.ethers;
}

// Getter for hre itself
function getHre() {
    return hre;
}

// ============================================================================
// PATHS & CONSTANTS
// ============================================================================

const SHARED_STATE_PATH = path.join(__dirname, '.shared-state.json');
const CONTRACTS_DIR = path.join(__dirname, '../artifacts/contracts');
const MNEMONIC_WORD_LIST = ["abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract", "absurd", "abuse",
    "access", "accident", "account", "accuse", "achieve", "acid", "acoustic", "acquire", "across", "act",
    "action", "actor", "actress", "actual", "adapt", "add", "addict", "address", "adjust", "admit",
    "adult", "advance", "advice", "aerobic", "affair", "afford", "afraid", "again", "age", "agent",
    "agree", "ahead", "aim", "air", "airport", "aisle", "alarm", "album", "alcohol", "alert",
    "alien", "all", "alley", "allow", "almost", "alone", "alpha", "already", "also", "alter",
    "always", "amateur", "amazing", "among", "amount", "amused", "analyst", "anchor", "ancient", "anger",
    "angle", "angry", "animal", "ankle", "announce", "annual", "another", "answer", "antenna", "antique",
    "anxiety", "any", "apart", "apology", "appear", "apple", "approve", "april", "arch", "arctic"];

// Common time constants
const ONE_DAY = 86400;
const ONE_WEEK = 604800;
const ONE_MONTH = 2592000;
const ONE_YEAR = 31536000;

const PRICE_DIRECTION = {
    UPSIDE: 0,
    DOWNSIDE: 1
};

// Terminal colors
const COLORS = {
    RESET: '\x1b[0m',
    RED: '\x1b[31m',
    GREEN: '\x1b[32m',
    YELLOW: '\x1b[33m',
    BLUE: '\x1b[34m',
    MAGENTA: '\x1b[35m',
    CYAN: '\x1b[36m',
    WHITE: '\x1b[37m',
    BOLD: '\x1b[1m'
};

// Test results tracking
let testResults = [];

// ============================================================================
// SHARED STATE MANAGEMENT
// ============================================================================

function saveSharedState(state) {
    fs.writeFileSync(SHARED_STATE_PATH, JSON.stringify(state, null, 2));
    logSuccess(`Shared state saved to ${SHARED_STATE_PATH}`);
}

function loadSharedState() {
    if (!fs.existsSync(SHARED_STATE_PATH)) {
        throw new Error(`Shared state not found. Run 00-setup.js first!`);
    }
    const state = JSON.parse(fs.readFileSync(SHARED_STATE_PATH, 'utf8'));
    if (!state.setup || !state.setup.completed) {
        throw new Error(`Setup incomplete. Run 00-setup.js first!`);
    }
    return state;
}

function clearSharedState() {
    if (fs.existsSync(SHARED_STATE_PATH)) {
        fs.unlinkSync(SHARED_STATE_PATH);
    }
}

// ============================================================================
// MNEMONIC & WALLET GENERATION
// ============================================================================

function generateRandomMnemonic(wordCount = 12) {
    // For Hardhat, we use the built-in test accounts instead of generating mnemonics
    // This is simpler and accounts are already funded
    const randomWallet = Wallet.createRandom();
    return randomWallet.mnemonic.phrase;
}

async function getWalletsFromMnemonic(mnemonic, count = 20) {
    // For Hardhat, we just use the built-in signers (already funded)
    const signers = await getEthers().getSigners();
    return signers.slice(0, count);
}

async function getWallets(count = 20) {
    // Return Hardhat test signers (already funded with ETH)
    const signers = await getEthers().getSigners();
    return signers.slice(0, count);
}

async function getWallet(index) {
    const signers = await getEthers().getSigners();
    return signers[index];
}

// ============================================================================
// CONTRACT ACCESS
// ============================================================================

function getContractABI(contractName) {
    // Artifacts are in parent directory (../../artifacts from core/)
    const artifactPath = path.join(__dirname, `../../artifacts/contracts/${contractName}.sol/${contractName}.json`);

    if (!fs.existsSync(artifactPath)) {
        throw new Error(`Contract artifact not found: ${artifactPath}`);
    }

    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    return artifact.abi;
}

async function getContract(contractName, signerIndex = 0) {
    const state = loadSharedState();
    const address = state.contracts[contractName];
    if (!address) {
        throw new Error(`Contract ${contractName} not in shared state`);
    }

    const abi = getContractABI(contractName);
    const signer = await getWallet(signerIndex);
    return new Contract(address, abi, signer);
}

async function getAllContracts(signerIndex = 0) {
    const state = loadSharedState();
    const contracts = {};

    for (const [name, address] of Object.entries(state.contracts)) {
        const abi = getContractABI(name);
        const signer = await getWallet(signerIndex);
        contracts[name] = new Contract(address, abi, signer);
    }

    return contracts;
}

// ============================================================================
// LOGGING FUNCTIONS
// ============================================================================

function log(message, color = COLORS.WHITE) {
    console.log(`${color}${message}${COLORS.RESET}`);
}

function logSuccess(message) {
    log(`✅ ${message}`, COLORS.GREEN);
}

function logError(message) {
    log(`❌ ${message}`, COLORS.RED);
}

function logWarning(message) {
    log(`⚠️  ${message}`, COLORS.YELLOW);
}

function logPhase(phaseNumber, phaseName) {
    log(`\n${'='.repeat(80)}`, COLORS.CYAN);
    log(`PHASE ${phaseNumber}: ${phaseName}`, COLORS.CYAN + COLORS.BOLD);
    log('='.repeat(80), COLORS.CYAN);
}

function logSection(title) {
    log(`\n--- ${title} ---`, COLORS.BLUE);
}

function formatETH(value) {
    return getEthers().formatEther(value);
}

function formatTokens(value, decimals = 18) {
    return getEthers().formatUnits(value, decimals);
}

// ============================================================================
// TEST RESULT TRACKING
// ============================================================================

function reportTestResult(testName, passed, details = '') {
    const result = {
        name: testName,
        passed,
        details,
        timestamp: Date.now()
    };
    testResults.push(result);

    if (passed) {
        logSuccess(`TEST PASSED: ${testName}`);
    } else {
        logError(`TEST FAILED: ${testName} - ${details}`);
    }
}

function getTestResults() {
    return testResults;
}

function saveTestResults() {
    const resultsPath = path.join(__dirname, '.test-results.json');
    const existing = fs.existsSync(resultsPath) ?
        JSON.parse(fs.readFileSync(resultsPath, 'utf8')) : [];

    const updated = [...existing, ...testResults];
    fs.writeFileSync(resultsPath, JSON.stringify(updated, null, 2));
}

function clearTestResults() {
    testResults = [];
    const resultsPath = path.join(__dirname, '.test-results.json');
    if (fs.existsSync(resultsPath)) {
        fs.unlinkSync(resultsPath);
    }
}

// ============================================================================
// ASSERTION HELPERS
// ============================================================================

function assert(condition, message) {
    if (!condition) {
        logError(`Assertion failed: ${message}`);
        throw new Error(message);
    }
}

function assertEqual(actual, expected, label) {
    const actualStr = actual.toString();
    const expectedStr = expected.toString();
    if (actualStr !== expectedStr) {
        logError(`${label}: expected ${expectedStr}, got ${actualStr}`);
        throw new Error(`Assertion failed: ${label}`);
    }
    logSuccess(`${label}: ${actualStr}`);
}

function assertBalance(actualBalance, expectedBalance, tolerance = 0n) {
    const diff = actualBalance > expectedBalance ?
        actualBalance - expectedBalance :
        expectedBalance - actualBalance;

    if (diff > tolerance) {
        logError(`Balance mismatch: expected ${expectedBalance}, got ${actualBalance}, diff ${diff}`);
        throw new Error('Balance assertion failed');
    }
    logSuccess(`Balance correct: ${actualBalance}`);
}

// ============================================================================
// TIME MANIPULATION
// ============================================================================

async function advanceTime(seconds) {
    await getEthers().provider.send("evm_increaseTime", [seconds]);
    await getEthers().provider.send("evm_mine", []);
    log(`⏰ Advanced time by ${seconds} seconds`);
}

async function advanceBlocks(blocks) {
    for (let i = 0; i < blocks; i++) {
        await getEthers().provider.send("evm_mine", []);
    }
    log(`⛏️  Mined ${blocks} blocks`);
}

async function getCurrentTimestamp() {
    const block = await getEthers().provider.getBlock('latest');
    return block.timestamp;
}

// ============================================================================
// TOKEN HELPERS
// ============================================================================

async function distributeETH(from, recipients, amount) {
    logSection(`Distributing ${formatETH(amount)} ETH to ${recipients.length} wallets`);

    for (let i = 0; i < recipients.length; i++) {
        const tx = await from.sendTransaction({
            to: recipients[i].address,
            value: amount
        });
        await tx.wait();
    }

    logSuccess(`ETH distributed to ${recipients.length} wallets`);
}

async function distributeTokens(tokenContract, from, recipients, amount) {
    logSection(`Distributing ${formatTokens(amount)} tokens to ${recipients.length} wallets`);

    for (let i = 0; i < recipients.length; i++) {
        const tx = await tokenContract.connect(from).transfer(recipients[i].address, amount);
        await tx.wait();
    }

    logSuccess(`Tokens distributed to ${recipients.length} wallets`);
}

// ============================================================================
// EIP-712 HELPERS
// ============================================================================

function getDomainSeparator(contractAddress, chainId = 31337) {
    return {
        name: "LockerContract",
        version: "1",
        chainId: chainId,
        verifyingContract: contractAddress
    };
}

async function signTypedData(signer, domain, types, value) {
    return await signer.signTypedData(domain, types, value);
}

// ─── Locker EIP-712 typed operations (M-1) ───────────────────────────────────
// Each op is signed as a typed struct whose hashStruct equals the on-chain opKey
// (keccak256(abi.encode(<OP>_TYPEHASH, fields...))). Signers therefore approve the
// decoded fields in their wallet, which recomputes the identical hash — no blind
// signing of an opaque ApproveOperation(bytes32 opKey). Field order MUST match the
// on-chain *_TYPEHASH strings exactly.
const LOCKER_OP_TYPES = {
    Unlock: [
        { name: 'lockId', type: 'uint256' },
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
    ],
    RescueToken: [
        { name: 'token', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'chainId', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
    ],
    RescueNative: [
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'chainId', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
    ],
    VestingUnlock: [
        { name: 'lockId', type: 'uint256' },
        { name: 'recipient', type: 'address' },
        { name: 'maxAmountTokens', type: 'uint256' },
        { name: 'chainId', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
    ],
    UpdateThreshold: [
        { name: 'newThreshold', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
    ],
    BatchUpdateSigners: [
        { name: 'signersToRemove', type: 'address[]' },
        { name: 'signersToAdd', type: 'address[]' },
        { name: 'nonce', type: 'uint256' },
    ],
    CreateLock: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'lockDuration', type: 'uint256' },
        { name: 'pair', type: 'address' },
        { name: 'ethUsdPair', type: 'address' },
        { name: 'targetPriceUSD1e18', type: 'uint256' },
        { name: 'isEthPair', type: 'bool' },
        { name: 'stablecoinPosition', type: 'uint8' },
        { name: 'priceDirection', type: 'uint8' },
        { name: 'vestingTokensPerPeriod', type: 'uint256' },
        { name: 'vestingPeriodSeconds', type: 'uint256' },
        { name: 'vestingAccumulate', type: 'bool' },
        { name: 'nonce', type: 'uint256' },
        { name: 'signer', type: 'address' },
    ],
};

// Build the EIP-712 domain for a Locker deployment.
function lockerDomain(lockerAddress, chainId) {
    return {
        name: 'LockerContract',
        version: '1',
        chainId: Number(chainId),
        verifyingContract: lockerAddress,
    };
}

// Compute the opKey off-chain exactly as the contract does (= EIP-712 hashStruct).
function lockerOpKey(primaryType, message) {
    return getEthers().TypedDataEncoder.hashStruct(
        primaryType,
        { [primaryType]: LOCKER_OP_TYPES[primaryType] },
        message
    );
}

// Sign a Locker operation the way the production wallet does: over the typed struct.
async function signLockerOp(signer, domain, primaryType, message) {
    return await signer.signTypedData(
        domain,
        { [primaryType]: LOCKER_OP_TYPES[primaryType] },
        message
    );
}

// ============================================================================
// EXPORTS
// ============================================================================

export {
    // Constants
    ONE_DAY,
    ONE_WEEK,
    ONE_MONTH,
    ONE_YEAR,
    PRICE_DIRECTION,
    COLORS,

    // State Management
    saveSharedState,
    loadSharedState,
    clearSharedState,

    // Wallets
    generateRandomMnemonic,
    getWalletsFromMnemonic,
    getWallets,
    getWallet,

    // Contracts
    getContractABI,
    getContract,
    getAllContracts,

    // Logging
    log,
    logSuccess,
    logError,
    logWarning,
    logPhase,
    logSection,
    formatETH,
    formatTokens,

    // Test Results
    reportTestResult,
    getTestResults,
    saveTestResults,
    clearTestResults,

    // Assertions
    assert,
    assertEqual,
    assertBalance,

    // Time
    advanceTime,
    advanceBlocks,
    getCurrentTimestamp,

    // Tokens
    distributeETH,
    distributeTokens,

    // EIP-712
    getDomainSeparator,
    signTypedData,
    LOCKER_OP_TYPES,
    lockerDomain,
    lockerOpKey,
    signLockerOp,

    // Hardhat runtime environment
    hre,
    getHre,
    getEthers
};
