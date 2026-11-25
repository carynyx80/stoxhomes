// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title HouseIndexOracle
/// @notice Holds house price index values (e.g. a city-level home value index) that are
///         published monthly. A new print does not apply instantly: the price is linearly
///         interpolated from the previous value to the new one over `smoothingPeriod`.
///         That removes the cliff that would otherwise liquidate 100x positions in a single block.
contract HouseIndexOracle is Ownable {
    struct Feed {
        uint128 fromPrice; // price at the moment the latest print was pushed (WAD)
        uint128 toPrice; // latest published index value (WAD)
        uint64 updatedAt; // when the latest print was pushed
        bool exists;
        uint64 period; // smoothing period fixed at push time (later setParams only affect new prints)
    }

    uint256 public constant MIN_SMOOTHING_PERIOD = 1 hours;

    uint256 public smoothingPeriod = 7 days;
    /// @notice Largest move a single print may make, in bps. Guards against fat-fingered keepers.
    uint256 public maxPrintMoveBps = 1_000; // 10%

    mapping(bytes32 => Feed) public feeds;
    mapping(address => bool) public keepers;
    /// @notice Timestamp of the next scheduled print per feed (0 = none). Cleared by pushIndex.
    mapping(bytes32 => uint256) public scheduledPrint;

    event KeeperSet(address indexed keeper, bool allowed);
    event FeedCreated(bytes32 indexed id, uint256 price);
    event IndexPushed(bytes32 indexed id, uint256 fromPrice, uint256 toPrice, uint256 timestamp);
    /// @notice A print is scheduled for `printTimestamp` (0 = schedule cancelled). Exchanges enter
    ///         close-only mode for a window before this time until the print is pushed.
    event CloseOnlyScheduled(bytes32 indexed id, uint256 printTimestamp);
    event ParamsSet(uint256 smoothingPeriod, uint256 maxPrintMoveBps);

    error NotKeeper();
    error UnknownFeed();
    error FeedExists();
    error MoveTooLarge();
    error BadParam();

    constructor(address owner_) Ownable(owner_) {
        keepers[owner_] = true;
    }

    modifier onlyKeeper() {
        if (!keepers[msg.sender]) revert NotKeeper();
        _;
    }

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        keepers[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    function setParams(uint256 smoothingPeriod_, uint256 maxPrintMoveBps_) external onlyOwner {
        if (smoothingPeriod_ < MIN_SMOOTHING_PERIOD || smoothingPeriod_ > 60 days || maxPrintMoveBps_ == 0 || maxPrintMoveBps_ > 5_000) revert BadParam();
        smoothingPeriod = smoothingPeriod_;
        maxPrintMoveBps = maxPrintMoveBps_;
        emit ParamsSet(smoothingPeriod_, maxPrintMoveBps_);
    }

    function createFeed(bytes32 id, uint256 initialPrice) external onlyOwner {
        if (feeds[id].exists) revert FeedExists();
        if (initialPrice == 0) revert BadParam();
        uint128 p128 = SafeCast.toUint128(initialPrice);
        feeds[id] = Feed(p128, p128, uint64(block.timestamp), true, uint64(smoothingPeriod));
        emit FeedCreated(id, initialPrice);
    }

    /// @notice Announce when the next print for `id` is expected. Pass 0 to cancel.
    function schedulePrint(bytes32 id, uint256 timestamp) external onlyKeeper {
        if (!feeds[id].exists) revert UnknownFeed();
        if (timestamp != 0 && timestamp <= block.timestamp) revert BadParam();
        scheduledPrint[id] = timestamp;
        emit CloseOnlyScheduled(id, timestamp);
    }

    /// @notice Push a newly published monthly index value.
    function pushIndex(bytes32 id, uint256 newPrice) external onlyKeeper {
        Feed storage f = feeds[id];
        if (!f.exists) revert UnknownFeed();
        uint256 current = price(id);
        uint256 diff = newPrice > current ? newPrice - current : current - newPrice;
        if (newPrice == 0 || diff * 10_000 > current * maxPrintMoveBps) revert MoveTooLarge();
        f.fromPrice = uint128(current);
        f.toPrice = SafeCast.toUint128(newPrice);
        f.updatedAt = uint64(block.timestamp);
        f.period = uint64(smoothingPeriod);
        if (scheduledPrint[id] != 0) {
            scheduledPrint[id] = 0;
            emit CloseOnlyScheduled(id, 0);
        }
        emit IndexPushed(id, current, newPrice, block.timestamp);
    }

    /// @notice Current smoothed index price (WAD).
    function price(bytes32 id) public view returns (uint256) {
        Feed memory f = feeds[id];
        if (!f.exists) revert UnknownFeed();
        uint256 elapsed = block.timestamp - f.updatedAt;
        uint256 period = f.period;
        if (elapsed >= period || period == 0) return f.toPrice;
        if (f.toPrice >= f.fromPrice) {
            return f.fromPrice + (uint256(f.toPrice - f.fromPrice) * elapsed) / period;
        }
        return f.fromPrice - (uint256(f.fromPrice - f.toPrice) * elapsed) / period;
    }

    /// @notice The latest published (target) index value the smoothed price is converging to.
    function targetPrice(bytes32 id) external view returns (uint256) {
        if (!feeds[id].exists) revert UnknownFeed();
        return feeds[id].toPrice;
    }

    function lastUpdate(bytes32 id) external view returns (uint256) {
        if (!feeds[id].exists) revert UnknownFeed();
        return feeds[id].updatedAt;
    }
}
