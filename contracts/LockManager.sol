// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./PriceCalculator.sol";

/**
 * @title Locker Protocol — PriceDirection
 * @notice Price lock trigger rules (above or below threshold).
 * @custom:website https://lockerprotocol.com
 */
enum PriceDirection {
    UPSIDE,   // Unlock triggers when price rises above target threshold
    DOWNSIDE  // Unlock triggers when price drops below target threshold
}

/**
 * @title Locker Protocol — LockManager
 * @notice Manages locked token properties, state validation constraints, price targets, and event history logging.
 * @dev Serves as primary storage layer queried by LockerContract and ValidationHandler.
 * @custom:website https://lockerprotocol.com
 */
contract LockManager {
    using SafeERC20 for IERC20;

    /**
     * @notice Basic metadata properties of a token lock.
     * @member token ERC-20 token address.
     * @member totalAmount Lifetime deposited total (creation + top-ups). Never decremented
     *         by withdrawals — use availableAmount for the remaining balance.
     * @member availableAmount Remaining tokens inside the lock.
     * @member unlockTime Expiration timestamp.
     * @member lockStartTime Start timestamp.
     * @member withdrawn True if fully claimed.
     */
    struct TokenLockBasic {
        address token;
        uint256 totalAmount;
        uint256 availableAmount;
        uint256 unlockTime;
        uint256 lockStartTime;
        bool withdrawn;
    }

    /**
     * @notice Pricing and oracle parameters of a token lock.
     * @member uniswapPair Uniswap liquidity pool address.
     * @member ethUsdPair USD exchange pool.
     * @member isEthPair True if utilizing wrapped native token intermediate pool.
     * @member stablecoinPosition Index of stablecoin in pool (1 or 2).
     * @member targetPriceUSD1e18 Price threshold (18 decimals).
     * @member lastTargetPriceUpdate Last update timestamp.
     * @member averagePurchasePriceUSD1e18 Weighted average entry price.
     * @member totalPurchaseAmount Accumulated tokens top-up amount.
     * @member priceDirection Trigger direction (UPSIDE/DOWNSIDE).
     */
    struct TokenLockPricing {
        address uniswapPair;
        address ethUsdPair;
        bool isEthPair;
        uint8 stablecoinPosition;
        uint256 targetPriceUSD1e18;
        uint256 lastTargetPriceUpdate;
        uint256 averagePurchasePriceUSD1e18;
        uint256 totalPurchaseAmount;
        PriceDirection priceDirection;
    }

    /**
     * @notice Aggregated structure grouping lock metadata and pricing specifications.
     */
    struct TokenLock {
        TokenLockBasic basic;
        TokenLockPricing pricing;
    }

    /// @notice Address of the main Locker Contract.
    address public locker;
    /// @notice Reference to the PriceCalculator contract.
    PriceCalculator public priceCalculator;

    /// @notice Maps unique lock ID to its corresponding TokenLock data.
    mapping(uint256 => TokenLock) public locks;

    /// @notice Index mapping tracking all lock IDs corresponding to a specific token address.
    mapping(address => uint256[]) public tokenLocks;
    /// @dev Fast mapping check to verify if a token has any active locks.
    mapping(address => bool) private _hasLocks;

    /// @notice Array of all unique token addresses with active locks.
    address[] public lockedTokens;
    /// @notice Auto-increment lock ID generator (starting at 1).
    uint256 public nextLockId = 1;

    /// @notice Suggested reference lock duration (1 hour). Not enforced: createLock accepts
    /// any duration including 0 (immediately time-unlockable). Kept for UI/integrator reference.
    uint256 public constant DEFAULT_LOCK_DURATION = 1 hours;
    /// @notice Upper bound on lock duration. unlockTime is derived as lockStartTime + duration;
    /// capping the duration keeps unlockTime within a sane, representable range (100 years is
    /// far beyond any legitimate schedule).
    uint256 public constant MAX_LOCK_DURATION = 100 * 365 days;
    /// @notice Emitted when a new token lock is created.
    event LockCreated(
        address indexed token,
        uint256 indexed lockId,
        uint256 amount,
        uint256 unlockTime,
        address indexed pair,
        address ethUsdPair,
        uint256 targetPriceUSD1e18,
        bool isEthPair,
        address createdBy
    );
    /// @notice Emitted when an existing lock is topped up with tokens.
    event TokensAddedToLock(
        uint256 indexed lockId,
        uint256 amount,
        address indexed addedBy,
        address payer,
        bytes32 paymentRef
    );
    /// @notice Emitted when a lock is deleted due to being empty.
    event LockDeleted(uint256 indexed lockId, address indexed deletedBy);

    /// @notice Types of activities logged in lock history.
    enum LockHistoryType {
        CREATED,
        TOKENS_ADDED
    }

    /**
     * @notice Lock activities history event properties.
     * @member paymentRef Arbitrary payment reference (order ID, product hash, etc.). bytes32(0) if unused.
     */
    struct LockHistory {
        LockHistoryType historyType;
        address token;
        address actor;
        address payer;
        uint256 amount;
        uint256 purchasePriceUSD1e18;
        uint256 targetPriceUSD1e18;
        uint256 unlockTime;
        address uniswapPair;
        address ethUsdPair;
        bool isEthPair;
        uint256 timestamp;
        uint256 blockNumber;
        bytes32 paymentRef;
    }

    /// @notice Maps a lock ID to its chronological array of history events.
    mapping(uint256 => LockHistory[]) public lockHistory;
    /// @notice Maps a lock ID to its total logged history events count.
    mapping(uint256 => uint256) public lockHistoryCount;

    /// @notice Restricts function execution to the main Locker Contract.
    modifier onlyLocker() {
        require(msg.sender == locker, "NA");
        _;
    }

    /// @notice True if Locker Contract address has been configured.
    bool public initialized;

    /// @notice EOA that deployed this module. Only it may perform the one-time wiring, so the
    /// wiring is bound to the deployer's own transaction. Recorded as tx.origin so the check
    /// also holds when modules are deployed through a factory within the deployer's transaction.
    address public immutable deployer;

    /**
     * @notice Initializes the PriceCalculator reference.
     * @param _priceCalculator The PriceCalculator address.
     */
    constructor(address _priceCalculator) {
        require(_priceCalculator != address(0), "Z");
        deployer = tx.origin;
        priceCalculator = PriceCalculator(_priceCalculator);
    }

    /**
     * @notice Configures the Locker Contract address.
     * @dev Wiring is performed by the LockerContract constructor, so msg.sender is the
     *      locker itself — tx.origin authenticates that the transaction was initiated by
     *      the module's deployer (deploy-time only; the check is moot once initialized).
     * @param _locker Locker Contract address.
     */
    function setLocker(address _locker) external {
        // solhint-disable-next-line avoid-tx-origin
        require(tx.origin == deployer, "Only deployer");
        require(!initialized && _locker != address(0), "Z");
        locker = _locker;
        initialized = true;
    }

    /**
     * @dev Validates and configures price parameters in a lock.
     */
    function _configurePricePairs(
        TokenLock storage l,
        address token,
        address pair,
        address ethUsdPair,
        bool isEthPair,
        uint8 stablecoinPosition
    ) internal returns (bool hasPricePair) {
        if (pair == address(0)) {
            return false;
        }

        require(stablecoinPosition <= 2, "INV_STABLECOIN_POS");
        if (!isEthPair) {
            require(stablecoinPosition > 0, "STABLECOIN_REQ");
        }

        priceCalculator.validatePairContainsToken(pair, token);
        l.pricing.uniswapPair = pair;
        l.pricing.lastTargetPriceUpdate = block.timestamp;
        l.pricing.stablecoinPosition = stablecoinPosition;

        if (isEthPair) {
            require(ethUsdPair != address(0), "Z");
            priceCalculator.validateEthUsdPair(ethUsdPair);
            l.pricing.ethUsdPair = ethUsdPair;
            l.pricing.isEthPair = true;
        } else {
            l.pricing.ethUsdPair = ethUsdPair;
            l.pricing.isEthPair = false;
        }

        return true;
    }

    /**
     * @dev Resolves initial entry price and configures weighted purchase parameters.
     */
    function _initializePurchasePrice(
        TokenLock storage l,
        address token,
        address pair,
        uint256 amount
    ) internal returns (uint256 currentPriceUSD1e18) {
        address usdPairToUse = l.pricing.isEthPair
            ? l.pricing.ethUsdPair
            : address(0);
        (bool success, uint256 priceUSD) = priceCalculator
            .getPriceUSDWithFallback(
                pair,
                token,
                usdPairToUse,
                l.pricing.isEthPair,
                l.pricing.stablecoinPosition
            );
        if (success) {
            currentPriceUSD1e18 = priceUSD;
            l.pricing.averagePurchasePriceUSD1e18 = currentPriceUSD1e18;
            l.pricing.totalPurchaseAmount = amount;
        }
    }

    /**
     * @dev Log initial lock event in chronological list.
     */
    function _addLockHistory(
        uint256 lockId,
        address token,
        uint256 amount,
        uint256 currentPriceUSD1e18
    ) internal {
        TokenLock storage l = locks[lockId];
        lockHistory[lockId].push(
            LockHistory({
                historyType: LockHistoryType.CREATED,
                token: token,
                actor: locker,
                payer: locker,
                amount: amount,
                purchasePriceUSD1e18: currentPriceUSD1e18,
                targetPriceUSD1e18: l.pricing.targetPriceUSD1e18,
                unlockTime: l.basic.unlockTime,
                uniswapPair: l.pricing.uniswapPair,
                ethUsdPair: l.pricing.ethUsdPair,
                isEthPair: l.pricing.isEthPair,
                timestamp: block.timestamp,
                blockNumber: block.number,
                paymentRef: bytes32(0)
            })
        );
        lockHistoryCount[lockId]++;
    }

    /**
     * @notice Resolves EIP-712 token prices from pool dependencies.
     * @param token Address of the token.
     * @param pair Pool address.
     * @param ethUsdPair Intermediate USD pool address.
     * @param isEthPair True if utilizing native token intermediate pool.
     * @param stablecoinPosition Stablecoin slot code.
     * @return success True if price calculations resolved successfully.
     * @return priceUSD The computed price in USD.
     */
    function calculatePriceUSD(
        address token,
        address pair,
        address ethUsdPair,
        bool isEthPair,
        uint8 stablecoinPosition
    ) external view returns (bool success, uint256 priceUSD) {
        address usdPairToUse = isEthPair ? ethUsdPair : address(0);
        return
            priceCalculator.getPriceUSDWithFallback(
                pair,
                token,
                usdPairToUse,
                isEthPair,
                stablecoinPosition
            );
    }

    /**
     * @dev Log tokens top-up event in chronological list.
     */
    function _addTokensAddedHistory(
        uint256 lockId,
        address token,
        uint256 amount,
        uint256 currentPriceUSD1e18,
        address payer,
        bytes32 paymentRef
    ) internal {
        TokenLock storage l = locks[lockId];
        lockHistory[lockId].push(
            LockHistory({
                historyType: LockHistoryType.TOKENS_ADDED,
                token: token,
                actor: locker,
                payer: payer,
                amount: amount,
                purchasePriceUSD1e18: currentPriceUSD1e18,
                targetPriceUSD1e18: l.pricing.targetPriceUSD1e18,
                unlockTime: l.basic.unlockTime,
                uniswapPair: l.pricing.uniswapPair,
                ethUsdPair: l.pricing.ethUsdPair,
                isEthPair: l.pricing.isEthPair,
                timestamp: block.timestamp,
                blockNumber: block.number,
                paymentRef: paymentRef
            })
        );
        lockHistoryCount[lockId]++;
    }

    /**
     * @notice Creates a new lock inside LockManager storage (called by LockerContract).
     * @param token Address of the ERC-20 token to lock.
     * @param amount Tokens quantity.
     * @param lockDuration Active period duration.
     * @param pair Optional Uniswap pair address for pricing.
     * @param ethUsdPair Optional USD conversion pool.
     * @param targetPriceUSD1e18 Target price threshold (18 decimals).
     * @param isEthPair True if routing conversions through native assets.
     * @param stablecoinPosition Stablecoin slot code.
     * @param priceDirection Price trigger rule direction.
     * @return lockId The generated lock ID.
     */
    function createLock(
        address token,
        uint256 amount,
        uint256 lockDuration,
        address pair,
        address ethUsdPair,
        uint256 targetPriceUSD1e18,
        bool isEthPair,
        uint8 stablecoinPosition,
        uint8 priceDirection
    ) external onlyLocker returns (uint256 lockId) {
        require(token != address(0) && amount > 0, "Z");
        require(IERC20(token).balanceOf(locker) >= amount, "TF");
        // Keep the lock duration within MAX_LOCK_DURATION.
        require(lockDuration <= MAX_LOCK_DURATION, "DUR_TOO_LONG");

        lockId = nextLockId++;
        TokenLock storage l = locks[lockId];

        // A duration of 0 is allowed and produces a lock that is immediately
        // time-unlockable (unlockTime == lockStartTime). No minimum is enforced.
        uint256 duration = lockDuration;
        l.basic.token = token;
        l.basic.totalAmount = amount;
        l.basic.availableAmount = amount;
        l.basic.lockStartTime = block.timestamp;
        l.basic.unlockTime = block.timestamp + duration;

        bool hasPricePair = _configurePricePairs(
            l,
            token,
            pair,
            ethUsdPair,
            isEthPair,
            stablecoinPosition
        );
        uint256 currentPriceUSD1e18 = 0;

        if (hasPricePair) {
            l.pricing.targetPriceUSD1e18 = targetPriceUSD1e18;
            l.pricing.priceDirection = PriceDirection(priceDirection);
            currentPriceUSD1e18 = _initializePurchasePrice(
                l,
                token,
                pair,
                amount
            );
        }

        tokenLocks[token].push(lockId);

        if (!_hasLocks[token]) {
            _hasLocks[token] = true;
            lockedTokens.push(token);
        }

        emit LockCreated(
            token,
            lockId,
            amount,
            l.basic.unlockTime,
            pair,
            l.pricing.ethUsdPair,
            targetPriceUSD1e18,
            l.pricing.isEthPair,
            locker
        );

        if (hasPricePair) {
            _addLockHistory(lockId, token, amount, currentPriceUSD1e18);
        }
    }

    /**
     * @notice Top-up an existing lock with extra tokens (called by LockerContract).
     * @param lockId Lock ID.
     * @param amount Tokens quantity.
     * @param payer The wallet address that initiated the payment.
     * @param paymentRef Arbitrary payment reference (order ID, product hash, etc.).
     */
    function addToLock(uint256 lockId, uint256 amount, address payer, bytes32 paymentRef) external onlyLocker {
        require(amount > 0, "Z");
        TokenLock storage l = locks[lockId];
        require(l.basic.token != address(0), "LOCK_NOT_EXISTS");

        address token = l.basic.token;
        IERC20 t = IERC20(token);
        require(t.balanceOf(locker) >= amount, "TF");

        uint256 currentPriceUSD1e18 = 0;
        bool hasPricePair = (l.pricing.uniswapPair != address(0));

        if (hasPricePair) {
            address usdPairToUse = l.pricing.isEthPair
                ? l.pricing.ethUsdPair
                : address(0);

            (bool success, uint256 priceUSD) = priceCalculator
                .getPriceUSDWithFallback(
                    l.pricing.uniswapPair,
                    token,
                    usdPairToUse,
                    l.pricing.isEthPair,
                    l.pricing.stablecoinPosition
                );
            if (success) {
                currentPriceUSD1e18 = priceUSD;

                // Adjust weighted average entry price
                if (
                    l.pricing.totalPurchaseAmount > 0 &&
                    l.pricing.averagePurchasePriceUSD1e18 > 0
                ) {
                    uint256 oldTotalValue = l
                        .pricing
                        .averagePurchasePriceUSD1e18 *
                        l.pricing.totalPurchaseAmount;
                    uint256 newValue = currentPriceUSD1e18 * amount;
                    uint256 newTotalAmount = l.pricing.totalPurchaseAmount +
                        amount;
                    l.pricing.averagePurchasePriceUSD1e18 =
                        (oldTotalValue + newValue) /
                        newTotalAmount;
                } else {
                    l.pricing.averagePurchasePriceUSD1e18 = currentPriceUSD1e18;
                }
                l.pricing.totalPurchaseAmount += amount;
            }
        }

        l.basic.totalAmount += amount;
        l.basic.availableAmount += amount;

        emit TokensAddedToLock(lockId, amount, locker, payer, paymentRef);

        // Always record history regardless of price pair presence
        _addTokensAddedHistory(lockId, token, amount, currentPriceUSD1e18, payer, paymentRef);
    }

    /**
     * @dev Clean empty locks from array tracking.
     */
    function _deleteLockIfEmpty(uint256 lockId) internal {
        TokenLock storage l = locks[lockId];
        // availableAmount is the sole "remaining balance" indicator — totalAmount is the
        // lifetime deposited total and stays non-zero after full withdrawal.
        if (l.basic.token != address(0) && l.basic.availableAmount == 0) {
            address token = l.basic.token;

            uint256[] storage lockIds = tokenLocks[token];
            for (uint256 i = 0; i < lockIds.length; i++) {
                if (lockIds[i] == lockId) {
                    lockIds[i] = lockIds[lockIds.length - 1];
                    lockIds.pop();
                    break;
                }
            }

            if (lockIds.length == 0) {
                _hasLocks[token] = false;
                for (uint256 i = 0; i < lockedTokens.length; i++) {
                    if (lockedTokens[i] == token) {
                        lockedTokens[i] = lockedTokens[lockedTokens.length - 1];
                        lockedTokens.pop();
                        break;
                    }
                }
            }

            // Lock history is retained after a lock is emptied. Lock ids are issued
            // monotonically and never reused, so a past lock's history can never collide
            // with a future lock, and retaining it keeps closing a lock constant-cost
            // regardless of how many history entries it accumulated. Only the lock record
            // itself is cleared here.
            delete locks[lockId];

            emit LockDeleted(lockId, msg.sender);
        }
    }

    /**
     * @notice Validates lock constraints (time/price logic) and updates remaining tokens.
     * @dev Time is always a valid trigger: block.timestamp >= unlockTime unlocks regardless of
     *      price (a 0-duration lock unlocks immediately). The oracle is only consulted while the
     *      lock is still time-bound, so a broken pool can never strand a lock past its unlockTime.
     * @param lockId Lock ID.
     * @param amount Tokens count to release.
     */
    function validateAndUnlock(
        uint256 lockId,
        uint256 amount
    ) external onlyLocker {
        TokenLock storage l = locks[lockId];
        require(l.basic.token != address(0), "TREG");

        // Time is always a valid unlock trigger: once block.timestamp >= unlockTime the
        // lock opens regardless of any price condition. A duration of 0 (unlockTime ==
        // lockStartTime) therefore unlocks immediately, even when a price target is set.
        bool timeOk = block.timestamp >= l.basic.unlockTime;
        bool hasPriceLock = l.pricing.targetPriceUSD1e18 > 0 &&
            l.pricing.uniswapPair != address(0);
        bool priceOk = false;

        // Only consult the oracle while time has not already satisfied the unlock. If the
        // pool is unpriceable the read returns success=false (or reverts, caught below),
        // priceOk stays false, and the require keeps the lock closed until unlockTime — the
        // time backstop guarantees it can never be permanently stranded by a broken oracle.
        if (!timeOk && hasPriceLock) {
            address usdPairToUse = l.pricing.isEthPair
                ? l.pricing.ethUsdPair
                : address(0);

            try
                priceCalculator.getPriceUSDWithFallback(
                    l.pricing.uniswapPair,
                    l.basic.token,
                    usdPairToUse,
                    l.pricing.isEthPair,
                    l.pricing.stablecoinPosition
                )
            returns (bool success, uint256 currentUSD) {
                if (success) {
                    if (l.pricing.priceDirection == PriceDirection.UPSIDE) {
                        if (currentUSD >= l.pricing.targetPriceUSD1e18)
                            priceOk = true;
                    } else {
                        if (currentUSD <= l.pricing.targetPriceUSD1e18)
                            priceOk = true;
                    }
                }
            } catch {
                // Leave priceOk = false; the require below keeps the lock closed.
            }
        }

        require(timeOk || priceOk, "COND");

        require(amount <= l.basic.availableAmount, "NA");

        // totalAmount keeps the lifetime deposited total for reporting;
        // availableAmount alone tracks what remains withdrawable.
        l.basic.availableAmount -= amount;
        if (l.basic.availableAmount == 0) {
            l.basic.withdrawn = true;
            _deleteLockIfEmpty(lockId);
        }
    }

    /**
     * @notice Bypasses typical lock limits to unlock vested tokens.
     * @param lockId Lock ID.
     * @param amount Tokens count to release.
     * @return token Token contract address.
     */
    function unlockVestedAmount(
        uint256 lockId,
        uint256 amount
    ) external onlyLocker returns (address token) {
        TokenLock storage l = locks[lockId];
        require(l.basic.token != address(0), "NL");
        require(!l.basic.withdrawn, "WD");
        require(amount > 0 && amount <= l.basic.availableAmount, "NA");

        token = l.basic.token;

        // totalAmount keeps the lifetime deposited total for reporting;
        // availableAmount alone tracks what remains withdrawable.
        l.basic.availableAmount -= amount;

        if (l.basic.availableAmount == 0) {
            l.basic.withdrawn = true;
            _deleteLockIfEmpty(lockId);
        }

        return token;
    }

    /**
     * @notice Returns array of unique tokens with active locks.
     */
    function getLockedTokens() external view returns (address[] memory) {
        return lockedTokens;
    }

    /**
     * @notice Returns array of lock IDs associated with a token.
     */
    function getTokenLocks(
        address token
    ) external view returns (uint256[] memory) {
        return tokenLocks[token];
    }

    /**
     * @notice Returns array of all active lock IDs.
     */
    function getAllLocks() external view returns (uint256[] memory) {
        uint256 totalLocks = 0;
        for (uint256 i = 0; i < lockedTokens.length; i++) {
            totalLocks += tokenLocks[lockedTokens[i]].length;
        }

        uint256[] memory allLocks = new uint256[](totalLocks);
        uint256 index = 0;
        for (uint256 i = 0; i < lockedTokens.length; i++) {
            uint256[] memory tokenLockIds = tokenLocks[lockedTokens[i]];
            for (uint256 j = 0; j < tokenLockIds.length; j++) {
                allLocks[index++] = tokenLockIds[j];
            }
        }

        return allLocks;
    }

    /**
     * @notice Returns TokenLock details.
     * @param lockId Lock ID.
     */
    function getLock(uint256 lockId) external view returns (TokenLock memory) {
        return locks[lockId];
    }

    /**
     * @notice Return struct containing verification indicators and progresses.
     */
    struct LockStatus {
        bool timeOk;
        bool priceOk;
        uint256 timeProgressPercent;
        uint256 priceProgressPercent;
    }

    /**
     * @notice Calculates percent metrics indicators of time and price lock states.
     * @dev priceOk is derived from a manipulable SPOT price (see PriceCalculator security
     *      note) — it is informational for signers and UIs, never a trustless trigger.
     * @param lockId Lock ID.
     * @return status LockStatus struct containing properties.
     */
    function getLockStatus(
        uint256 lockId
    ) external view returns (LockStatus memory) {
        TokenLock storage l = locks[lockId];
        require(l.basic.token != address(0), "TREG");

        address token = l.basic.token;

        LockStatus memory status;
        status.timeOk = block.timestamp >= l.basic.unlockTime;
        if (status.timeOk) {
            status.timeProgressPercent = 100;
        } else if (
            l.basic.unlockTime > block.timestamp && l.basic.lockStartTime > 0
        ) {
            uint256 totalDuration = l.basic.unlockTime - l.basic.lockStartTime;
            uint256 elapsed = block.timestamp - l.basic.lockStartTime;
            if (totalDuration > 0) {
                status.timeProgressPercent = (elapsed * 100) / totalDuration;
                if (status.timeProgressPercent > 100)
                    status.timeProgressPercent = 100;
            } else {
                status.timeProgressPercent = 0;
            }
        } else {
            status.timeProgressPercent = status.timeOk ? 100 : 0;
        }
        status.priceOk = false;
        status.priceProgressPercent = 0;
        if (
            l.pricing.targetPriceUSD1e18 > 0 &&
            l.pricing.uniswapPair != address(0)
        ) {
            address usdPairToUse = l.pricing.isEthPair
                ? l.pricing.ethUsdPair
                : address(0);
            (bool success, uint256 currentUSD) = priceCalculator
                .getPriceUSDWithFallback(
                    l.pricing.uniswapPair,
                    token,
                    usdPairToUse,
                    l.pricing.isEthPair,
                    l.pricing.stablecoinPosition
                );
            if (success) {
                bool targetReached = false;
                if (l.pricing.priceDirection == PriceDirection.UPSIDE) {
                    targetReached = currentUSD >= l.pricing.targetPriceUSD1e18;
                } else {
                    targetReached = currentUSD <= l.pricing.targetPriceUSD1e18;
                }

                if (targetReached) {
                    status.priceOk = true;
                    status.priceProgressPercent = 100;
                } else {
                    if (l.pricing.targetPriceUSD1e18 > 0) {
                        if (l.pricing.priceDirection == PriceDirection.UPSIDE) {
                            status.priceProgressPercent =
                                (currentUSD * 100) /
                                l.pricing.targetPriceUSD1e18;
                        } else {
                            if (currentUSD > 0) {
                                status.priceProgressPercent =
                                    (l.pricing.targetPriceUSD1e18 * 100) /
                                    currentUSD;
                            }
                        }
                        if (status.priceProgressPercent > 100)
                            status.priceProgressPercent = 100;
                    }
                }
            }
        }
        return status;
    }

    /**
     * @notice Returns complete event history for a lock.
     * @param lockId Lock ID.
     */
    function getLockHistory(
        uint256 lockId
    ) external view returns (LockHistory[] memory) {
        return lockHistory[lockId];
    }

    /**
     * @notice Returns specific event detail by index.
     * @param lockId Lock ID.
     * @param index Event index.
     */
    function getLockHistoryEvent(
        uint256 lockId,
        uint256 index
    ) external view returns (LockHistory memory) {
        require(index < lockHistoryCount[lockId], "Index out of bounds");
        return lockHistory[lockId][index];
    }

    /**
     * @notice Returns event history length.
     * @param lockId Lock ID.
     */
    function getLockHistoryCount(
        uint256 lockId
    ) external view returns (uint256) {
        return lockHistoryCount[lockId];
    }

    /**
     * @notice Returns paginated log entries slice.
     * @param lockId Lock ID.
     * @param offset Starting entry offset.
     * @param limit Maximum entry size.
     */
    function getLockHistoryPaginated(
        uint256 lockId,
        uint256 offset,
        uint256 limit
    ) external view returns (LockHistory[] memory history, uint256 total) {
        total = lockHistoryCount[lockId];
        if (offset >= total) {
            return (new LockHistory[](0), total);
        }

        uint256 end = offset + limit;
        if (end > total) {
            end = total;
        }

        uint256 length = end - offset;
        history = new LockHistory[](length);

        for (uint256 i = 0; i < length; i++) {
            history[i] = lockHistory[lockId][offset + i];
        }

        return (history, total);
    }

    /**
     * @notice Returns average purchase entry statistics.
     * @param lockId Lock ID.
     */
    function getAveragePurchasePrice(
        uint256 lockId
    )
        external
        view
        returns (uint256 averagePurchasePrice, uint256 totalPurchaseAmount)
    {
        TokenLock storage l = locks[lockId];
        require(l.basic.token != address(0), "TREG");
        return (
            l.pricing.averagePurchasePriceUSD1e18,
            l.pricing.totalPurchaseAmount
        );
    }

    /**
     * @notice Calculates gain or loss metrics relative to average entry prices.
     * @param lockId Lock ID.
     */
    function calculateGainLoss(
        uint256 lockId
    )
        external
        view
        returns (
            bool success,
            uint256 currentPriceUSD,
            uint256 averagePurchasePrice,
            int256 priceDifference,
            int256 percentageGain,
            int256 totalGainUSD
        )
    {
        TokenLock storage l = locks[lockId];
        require(l.basic.token != address(0), "TREG");

        if (
            l.pricing.uniswapPair == address(0) ||
            l.pricing.averagePurchasePriceUSD1e18 == 0
        ) {
            return (false, 0, 0, 0, 0, 0);
        }

        (bool priceSuccess, uint256 currentPriceUSD1e18) = priceCalculator
            .getPriceUSDWithFallback(
                l.pricing.uniswapPair,
                l.basic.token,
                l.pricing.ethUsdPair,
                l.pricing.isEthPair,
                l.pricing.stablecoinPosition
            );

        if (!priceSuccess) {
            return (false, 0, 0, 0, 0, 0);
        }

        currentPriceUSD = currentPriceUSD1e18;
        averagePurchasePrice = l.pricing.averagePurchasePriceUSD1e18;

        // Calculate price difference (with int256 overflow guard)
        if (currentPriceUSD >= averagePurchasePrice) {
            uint256 diff = currentPriceUSD - averagePurchasePrice;
            require(diff <= uint256(type(int256).max), "Price diff overflow");
            priceDifference = int256(diff);
        } else {
            uint256 diff = averagePurchasePrice - currentPriceUSD;
            require(diff <= uint256(type(int256).max), "Price diff overflow");
            priceDifference = -int256(diff);
        }

        if (averagePurchasePrice > 0) {
            uint256 absDiff = currentPriceUSD > averagePurchasePrice
                ? currentPriceUSD - averagePurchasePrice
                : averagePurchasePrice - currentPriceUSD;
            uint256 percentage = (absDiff * 100 * 1e18) / averagePurchasePrice;
            require(percentage <= uint256(type(int256).max), "Percentage overflow");
            if (currentPriceUSD >= averagePurchasePrice) {
                percentageGain = int256(percentage);
            } else {
                percentageGain = -int256(percentage);
            }
        }

        if (l.pricing.totalPurchaseAmount > 0) {
            uint8 tokenDecimals = IERC20Metadata(l.basic.token).decimals();
            uint256 decimalsMultiplier = 10 ** tokenDecimals;

            if (currentPriceUSD >= averagePurchasePrice) {
                uint256 priceDiff = currentPriceUSD - averagePurchasePrice;
                uint256 gain = (priceDiff * l.pricing.totalPurchaseAmount) /
                    decimalsMultiplier;
                require(gain <= uint256(type(int256).max), "Gain overflow");
                totalGainUSD = int256(gain);
            } else {
                uint256 priceDiff = averagePurchasePrice - currentPriceUSD;
                uint256 loss = (priceDiff * l.pricing.totalPurchaseAmount) /
                    decimalsMultiplier;
                require(loss <= uint256(type(int256).max), "Loss overflow");
                totalGainUSD = -int256(loss);
            }
        }

        return (
            true,
            currentPriceUSD,
            averagePurchasePrice,
            priceDifference,
            percentageGain,
            totalGainUSD
        );
    }
}
