// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title Locker Protocol — ILockerReentry
 * @notice Minimal view of LockerContract's unlock entry point, used by the
 *         reentrancy mock below to attempt a nested withdrawal.
 */
interface ILockerReentry {
    function executeUnlockWithSignatures(
        uint256 lockId,
        address to,
        uint256 amount,
        address[] calldata signers,
        bytes[] calldata signatures
    ) external;
}

/**
 * @title Locker Protocol — ReentrantUnlockToken (TEST-ONLY malicious ERC-20)
 * @notice On its OUT transfer (the transfer LockerContract performs while releasing
 *         an unlock) this token re-enters executeUnlockWithSignatures with a pre-armed
 *         payload. It exists to prove that the ReentrancyGuard on the Locker's entry
 *         points, together with the effects-before-interactions ordering
 *         (availableAmount debit + markAsExecuted BEFORE the token transfer), make a
 *         reentrant double-withdrawal impossible.
 * @dev NOT for production. transferFrom (used by createLock deposits) is left untouched
 *      so only the unlock out-transfer triggers the re-entry attempt.
 */
contract ReentrantUnlockToken is ERC20 {
    address public locker;
    uint256 public atkLockId;
    address public atkTo;
    uint256 public atkAmount;
    address[] private atkSigners;
    bytes[] private atkSigs;

    /// @notice When true, the next out-transfer attempts to re-enter the Locker.
    bool public armed;
    /// @notice Set once a re-entry has been attempted.
    bool public reentryAttempted;
    /// @notice True if the attempted re-entry reverted (i.e. the guard held).
    bool public reentryBlocked;

    constructor(address initialAccount, uint256 initialBalance)
        ERC20("Reentrant Unlock Token", "REENT")
    {
        _mint(initialAccount, initialBalance);
    }

    /**
     * @notice Arm the re-entry payload. The stored (lockId,to,amount,signers,sigs) is
     *         replayed from inside the next out-transfer.
     */
    function arm(
        address _locker,
        uint256 _lockId,
        address _to,
        uint256 _amount,
        address[] calldata _signers,
        bytes[] calldata _sigs
    ) external {
        require(_signers.length == _sigs.length, "len mismatch");
        locker = _locker;
        atkLockId = _lockId;
        atkTo = _to;
        atkAmount = _amount;
        delete atkSigners;
        delete atkSigs;
        for (uint256 i = 0; i < _signers.length; i++) {
            atkSigners.push(_signers[i]);
            atkSigs.push(_sigs[i]);
        }
        armed = true;
        reentryAttempted = false;
        reentryBlocked = false;
    }

    /**
     * @dev Only the Locker's OUT transfer re-enters. transferFrom (deposits) is not
     *      overridden, so lock creation and funding remain normal ERC-20 flows.
     */
    function transfer(address to, uint256 amount) public override returns (bool) {
        if (armed && msg.sender == locker) {
            armed = false; // one-shot: never recurse past the first attempt
            reentryAttempted = true;
            try
                ILockerReentry(locker).executeUnlockWithSignatures(
                    atkLockId,
                    atkTo,
                    atkAmount,
                    atkSigners,
                    atkSigs
                )
            {
                // The nested unlock SUCCEEDED — this is the failure the test guards against.
                reentryBlocked = false;
            } catch {
                // The nested unlock reverted — the guard/ordering held as expected.
                reentryBlocked = true;
            }
        }
        return super.transfer(to, amount);
    }
}
