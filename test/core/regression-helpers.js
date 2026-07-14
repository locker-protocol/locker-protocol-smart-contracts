/**
 * Shared helpers for the audit-regression tests (62-65).
 *
 * These mirror the local helpers proven in 60-adversarial-fund-theft.js, factored out
 * so the regression suite stays DRY. They are intentionally NOT added to core/utils.js
 * (which every test imports) to keep the blast radius of a change minimal — only the
 * regression tests import from here.
 */

import { signLockerOp, assert, log, logSuccess, getEthers } from './utils.js';

const ethers = getEthers();

// Flatten every place ethers/Hardhat can stash a revert reason into one searchable string,
// including the ABI-encoded Error(string) payload when the reason is not surfaced directly.
export function revertText(error) {
    const parts = [error.shortMessage, error.reason, error.message].filter(Boolean);
    const data = error?.data || error?.info?.error?.data || error?.error?.data;
    if (typeof data === 'string' && data.startsWith('0x')) {
        parts.push(data);
        if (data.startsWith('0x08c379a0')) {
            try {
                parts.push(ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10))[0]);
            } catch (_) { /* not an Error(string) payload */ }
        }
    }
    return parts.join(' | ');
}

// Assert that `callFn` reverts. `expected` may be a single substring or an array of
// acceptable substrings (any match passes) — useful for custom errors whose NAME some
// Hardhat/ethers combos decode and others surface only as the 4-byte selector.
export async function expectRevert(callFn, label, expected = null) {
    try {
        const tx = await callFn();
        if (tx && tx.wait) await tx.wait();
    } catch (error) {
        const text = revertText(error);
        log(`  Revert: ${text.substring(0, 150)}`);
        if (expected) {
            const needles = Array.isArray(expected) ? expected : [expected];
            assert(
                needles.some((n) => text.includes(n)),
                `${label}: expected revert matching one of ${JSON.stringify(needles)}, got: ${text.substring(0, 220)}`
            );
        }
        logSuccess(`${label} correctly reverted${expected ? ` (${JSON.stringify(expected)})` : ''}`);
        return;
    }
    throw new Error(`${label}: expected revert but the call SUCCEEDED (funds may be at risk!)`);
}

// Collect `count` EIP-712 signatures over the typed op struct from DISTINCT signers.
// `signerAddresses` are Hardhat accounts (retrievable via ethers.getSigner).
export async function collectSignatures(primaryType, message, signerAddresses, count, domain) {
    const signatures = [];
    const addresses = [];
    for (let i = 0; i < count && i < signerAddresses.length; i++) {
        const wallet = await ethers.getSigner(signerAddresses[i]);
        signatures.push(await signLockerOp(wallet, domain, primaryType, message));
        addresses.push(signerAddresses[i]);
    }
    return { addresses, signatures };
}
