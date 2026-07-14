// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./LockManager.sol";

/**
 * @title Locker Protocol — VestingManager
 * @notice Manages progressive token-denominated vesting schedules for locked tokens.
 * @dev Releases a fixed number of locked tokens per elapsed period (1:1, no USD
 *      conversion). When accumulation is enabled the claimable amount grows with
 *      every elapsed period; otherwise only a single period's worth is claimable.
 * @custom:website https://lockerprotocol.com
 */
contract VestingManager {
    /// @notice The LockManager module reference.
    LockManager public lockManager;
    /// @notice The main Locker Contract address.
    address public locker;

    /**
     * @notice Vesting configuration settings for a given lock.
     * @member tokensPerPeriod The number of tokens (native token units) released per period.
     * @member periodDuration Duration of the vesting interval in seconds.
     * @member lastWithdrawalTime The timestamp of the last release execution.
     * @member accumulate True if unclaimed periods accumulate (tokensPerPeriod × elapsed periods).
     * @member enabled True if vesting is active for this lock ID.
     */
    struct VestingConfig {
        uint256 tokensPerPeriod;
        uint256 periodDuration;
        uint256 lastWithdrawalTime;
        bool accumulate;
        bool enabled;
    }

    /// @notice Maps a lock ID to its corresponding VestingConfig.
    mapping(uint256 => VestingConfig) public vestingConfigs;

    /// @notice Emitted when a vesting schedule is configured for a lock.
    event VestingConfigured(
        uint256 indexed lockId,
        uint256 tokensPerPeriod,
        uint256 periodDuration,
        bool accumulate
    );
    /// @notice Emitted when tokens are released under a vesting schedule.
    event VestingWithdrawn(
        uint256 indexed lockId,
        uint256 amountTokens,
        address indexed by
    );

    /// @notice Restricts functions to the main Locker Contract.
    modifier onlyLocker() {
        require(msg.sender == locker, "Not authorized");
        _;
    }

    /// @notice EOA that deployed this module. Only it may perform the one-time wiring, so the
    /// wiring is bound to the deployer's own transaction. Recorded as tx.origin so the check
    /// also holds when modules are deployed through a factory within the deployer's transaction.
    address public immutable deployer;

    /**
     * @notice Initializes the module with the address of LockManager.
     * @param _lockManager Address of the LockManager.
     */
    constructor(address _lockManager) {
        require(_lockManager != address(0), "Zero address");
        deployer = tx.origin;
        lockManager = LockManager(_lockManager);
    }

    /**
     * @notice Sets the Locker Contract address. Can only be configured once.
     * @dev Wiring is performed by the LockerContract constructor, so msg.sender is the
     *      locker itself — tx.origin authenticates that the transaction was initiated by
     *      the module's deployer (deploy-time only; the check is moot once initialized).
     * @param _locker Address of the Locker Contract.
     */
    function setLocker(address _locker) external {
        // solhint-disable-next-line avoid-tx-origin
        require(tx.origin == deployer, "Only deployer");
        require(
            locker == address(0) && _locker != address(0),
            "Already set or zero"
        );
        locker = _locker;
    }

    /**
     * @notice Configures the vesting schedule parameters for a new lock.
     * @dev Restricts initialization to once per lock ID.
     * @param lockId The lock ID.
     * @param tokensPerPeriod The number of tokens released per period (native token units).
     * @param periodDuration Duration in seconds.
     * @param accumulate True if unclaimed periods accumulate.
     */
    function initializeVesting(
        uint256 lockId,
        uint256 tokensPerPeriod,
        uint256 periodDuration,
        bool accumulate
    ) external onlyLocker {
        require(!vestingConfigs[lockId].enabled, "Vesting already initialized");

        if (tokensPerPeriod == 0) {
            return;
        }

        require(periodDuration > 0, "Invalid period duration");

        LockManager.TokenLock memory lock = lockManager.getLock(lockId);
        require(lock.basic.token != address(0), "No lock found");

        vestingConfigs[lockId] = VestingConfig({
            tokensPerPeriod: tokensPerPeriod,
            periodDuration: periodDuration,
            lastWithdrawalTime: block.timestamp,
            accumulate: accumulate,
            enabled: true
        });

        emit VestingConfigured(
            lockId,
            tokensPerPeriod,
            periodDuration,
            accumulate
        );
    }

    /**
     * @notice Calculates the currently vested and withdrawable amount of tokens.
     * @dev With accumulation enabled the amount is tokensPerPeriod × fully elapsed
     *      periods; otherwise a single period's worth. The result is always capped
     *      by the lock's remaining available balance. Claims are all-or-nothing —
     *      no partial claim of the returned amount is possible.
     * @param lockId The lock ID.
     * @return amountTokens The withdrawable token count.
     */
    function calculateVestedAmount(
        uint256 lockId
    ) public view returns (uint256 amountTokens) {
        VestingConfig memory config = vestingConfigs[lockId];

        if (!config.enabled || config.tokensPerPeriod == 0) {
            return 0;
        }

        uint256 timeSinceLastWithdrawal = block.timestamp -
            config.lastWithdrawalTime;
        uint256 elapsedPeriods = timeSinceLastWithdrawal /
            config.periodDuration;
        if (elapsedPeriods == 0) {
            return 0;
        }

        LockManager.TokenLock memory lock = lockManager.getLock(lockId);
        uint256 available = lock.basic.availableAmount;

        if (config.accumulate) {
            // Overflow-safe: cap at the available balance without multiplying
            // when the accumulated periods already exceed what the lock can pay.
            if (elapsedPeriods > available / config.tokensPerPeriod) {
                amountTokens = available;
            } else {
                amountTokens = config.tokensPerPeriod * elapsedPeriods;
            }
        } else {
            // Non-cumulative: a single period's value per claim.
            amountTokens = config.tokensPerPeriod;
        }

        // Vesting release cannot exceed the remaining locked balance.
        if (amountTokens > available) {
            amountTokens = available;
        }

        return amountTokens;
    }

    /**
     * @notice Releases the currently vested tokens if available.
     * @dev Advances the vesting clock and returns the number of tokens to unlock.
     *      With accumulation, the clock advances by the exact number of claimed
     *      periods (preserving the in-progress period remainder); without it, the
     *      clock restarts at the current block timestamp (unclaimed periods are
     *      forfeited).
     * @param lockId The lock ID.
     * @return amountTokens The number of tokens unlocked.
     */
    function unlockVested(
        uint256 lockId
    ) external onlyLocker returns (uint256 amountTokens) {
        VestingConfig storage config = vestingConfigs[lockId];
        require(config.enabled, "Vesting not enabled");

        LockManager.LockStatus memory status = lockManager.getLockStatus(
            lockId
        );
        require(!status.timeOk && !status.priceOk, "USE_REGULAR_UNLOCK");

        amountTokens = calculateVestedAmount(lockId);
        require(amountTokens > 0, "VESTING_NOT_AVAILABLE");

        if (config.accumulate) {
            uint256 elapsedPeriods = (block.timestamp -
                config.lastWithdrawalTime) / config.periodDuration;
            config.lastWithdrawalTime += elapsedPeriods * config.periodDuration;
        } else {
            config.lastWithdrawalTime = block.timestamp;
        }

        emit VestingWithdrawn(lockId, amountTokens, locker);

        return amountTokens;
    }

    /**
     * @notice Returns the vesting configuration details for a lock.
     * @param lockId The lock ID.
     * @return VestingConfig struct detailing limits and timestamps.
     */
    function getVestingConfig(
        uint256 lockId
    ) external view returns (VestingConfig memory) {
        return vestingConfigs[lockId];
    }
}
