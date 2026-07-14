# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| latest  | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in the Locker Protocol smart contracts, **please do NOT open a public GitHub issue**.

Instead, please report it responsibly:

1. **Email**: Send details to **security@lockerprotocol.com**
2. **Subject**: `[SECURITY] Locker Smart Contract Vulnerability`
3. **Include**:
   - A description of the vulnerability
   - Steps to reproduce
   - Potential impact assessment
   - Suggested fix (if any)

We will acknowledge receipt within **48 hours** and aim to provide a fix or mitigation within **7 days** for critical issues.

## Scope

The following are in scope for security reports:

- All Solidity smart contracts in `contracts/`
- Deployment scripts in `scripts/`
- Any issue that could lead to loss of funds, unauthorized access, or denial of service

## Out of Scope

- Frontend/UI applications (private, not in this repository)
- Third-party dependencies (report to their maintainers)
- Issues in test/mock contracts (`contracts/mocks/`)

## Security Model — Design Decisions to Know

These are deliberate, documented properties of the protocol — not vulnerabilities:

### Price conditions use SPOT prices (not a trustless oracle)

Price targets are evaluated from live Uniswap pool state (`getReserves()` on V2, `slot0()`
on V3) with no TWAP. A spot price can be moved within a single block (e.g. flash loans) to
satisfy or defeat a target. This is acceptable because **no funds ever move on a price
condition alone** — every release requires the M-of-N signer threshold. Price conditions
are a business-rule gate layered on top of the multi-sig.

**Operational rule for signers:** never treat an on-chain "target price reached" as
authoritative. Independently verify market conditions before signing any unlock.

### Time is always a valid unlock trigger

Once `block.timestamp >= unlockTime` a lock is unlockable regardless of any price
condition (a 0-duration lock is unlockable immediately). A broken or unpriceable pool can
therefore never permanently strand funds past their unlock time.

### Governance changes invalidate pending approvals (config epoch)

Any signer-set or threshold change advances a governance epoch in the
`ValidationHandler`. Approvals registered before the change stop counting instantly:

- In-flight operations must have their signatures **re-submitted** after any governance
  change (signatures stay cryptographically valid; re-registration re-checks signer
  status, so a removed signer can no longer contribute to any quorum).
- Plan governance changes accordingly: execute or let expire any pending operation first,
  or expect to re-collect its on-chain approvals afterwards.

### One-time module wiring is deployer-restricted

Each module's `setLocker()` can only be triggered in a transaction originated by the
module's deployer (checked via `tx.origin`, deploy-time only), preventing third parties
from front-running the wiring between deployment transactions.

## Bug Bounty

We may offer rewards for critical vulnerabilities at our discretion. Contact us for details.

## Acknowledgments

We appreciate the security research community's efforts to responsibly disclose vulnerabilities.
