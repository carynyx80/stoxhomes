// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {HouseIndexOracle} from "./HouseIndexOracle.sol";

/// @title HousePerpExchange
/// @notice Perpetual futures on house price indices, with up to 100x leverage, backed by a
///         single USDT liquidity pool that takes the other side of every trade.
///
/// Pricing model ("index + trading-driven mark"):
///  - The index price comes from HouseIndexOracle (monthly prints, smoothed).
///  - The mark price = index * (1 + skew / skewScale), where skew = net long size.
///    Trades fill at the average premium before and after the trade, so pushing the market one
///    way costs the trader and pays the pool.
///  - Funding accrues continuously in proportion to skew: longs pay shorts (via the pool) when
///    the market is net long, and the reverse when net short.
///  - PnL and liquidations are marked at the index price, so a large trade cannot move the
///    price used to liquidate other traders.
contract HousePerpExchange is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 public constant MAX_LEVERAGE = 100;
    uint256 public constant MAX_MARKETS = 32;
    uint256 public constant VIRTUAL_SHARES = 1e6; // ERC4626-style inflation-attack offset
    uint256 public constant VIRTUAL_ASSETS = 1;
    uint256 public constant MIN_LIQUIDATION_REWARD = 5e18; // paid from pool cash for bad-debt liquidations
    uint256 public constant PRINT_GRACE = 24 hours; // close-only ends this long after a missed print

    struct Market {
        string name; // e.g. "NYC-USD"
        bytes32 oracleId;
        bool active;
        uint256 skewScale; // size at which the premium reaches 100% (WAD units of size)
        uint256 maxFundingRatePerDay; // WAD, funding rate at |skew| == skewScale
        uint256 maxSkewToPoolBps; // cap on |skew| * price as a share of pool value
        int256 skew; // sum of all position sizes (WAD)
        int256 sumSizeEntry; // sum of size * entryPrice / WAD, for pool unrealized PnL
        int256 fundingIndex; // cumulative funding per unit of size (USD, WAD)
        uint64 lastFundingTime;
        uint256 longSize;
        uint256 shortSize;
        uint256 marginTotal; // sum of margins of this market's positions
    }

    struct Position {
        int256 size; // positive = long, negative = short (WAD units of the index)
        uint256 margin; // USDT (18 decimals)
        uint256 entryPrice; // fill price at open (WAD)
        int256 entryFunding; // market.fundingIndex at open / last settlement
        int256 sizeEntry; // this position's exact contribution to market.sumSizeEntry
    }

    struct MarketView {
        uint256 marketId;
        string name;
        bytes32 oracleId;
        bool active;
        uint256 skewScale;
        uint256 maxFundingRatePerDay;
        uint256 maxSkewToPoolBps;
        int256 skew;
        uint256 longSize;
        uint256 shortSize;
        uint256 indexPrice;
        uint256 markPrice;
        int256 fundingRatePerDay;
        bool closeOnly;
        uint256 scheduledPrint;
    }

    IERC20 public immutable collateral;
    HouseIndexOracle public immutable oracle;

    uint256 public tradingFeeBps = 5; // 0.05% of notional on open and close
    uint256 public maintenanceMarginBps = 50; // 0.5% of notional
    uint256 public liquidationFeeBps = 20; // 0.2% of notional to the liquidator, capped by equity
    uint256 public maxOracleAge = 45 days; // monthly data + publication lag
    /// @notice Opening/increasing is blocked this long before a scheduled print until it lands.
    uint256 public closeOnlyBefore = 6 hours;
    /// @notice Delay between requestWithdraw and withdraw.
    uint256 public withdrawCooldown = 24 hours;
    /// @notice After unlocking, a request can be executed for this long (0 = forever).
    uint256 public withdrawWindow = 3 days;
    /// @notice Share of trading fees (bps of the fee) that goes to the protocol.
    uint256 public protocolFeeShareBps = 1_000; // 10%
    address public feeRecipient;
    /// @notice Unclaimed protocol fees held by the contract (not pool money).
    uint256 public protocolFeesAccrued;
    /// @notice Global cap: sum over markets of |skew| * index <= poolValue * this / BPS.
    uint256 public maxTotalSkewToPoolBps = 50_000; // 5x

    Market[] internal _markets;
    mapping(uint256 => mapping(address => Position)) public positions;

    uint256 public totalMargin; // collateral held as trader margin (not pool money)
    uint256 public totalShares;
    mapping(address => uint256) public shares;
    mapping(address => uint256) public pendingWithdrawShares;
    mapping(address => uint256) public withdrawUnlockTime;
    /// @notice USDT value of the pending shares at request time (withdraw pays min(then, now)).
    mapping(address => uint256) public pendingWithdrawValue;

    event MarketAdded(uint256 indexed marketId, string name, bytes32 oracleId);
    event MarketUpdated(uint256 indexed marketId);
    event PositionOpened(
        uint256 indexed marketId, address indexed trader, int256 size, uint256 margin, uint256 fillPrice, uint256 fee
    );
    event PositionClosed(
        uint256 indexed marketId, address indexed trader, int256 size, uint256 fillPrice, int256 pnl, int256 funding, uint256 payout
    );
    event MarginChanged(uint256 indexed marketId, address indexed trader, int256 delta, uint256 newMargin);
    event Liquidated(
        uint256 indexed marketId, address indexed trader, address indexed liquidator, int256 size, uint256 price, uint256 reward
    );
    event Deposit(address indexed lp, uint256 amount, uint256 sharesMinted);
    event Withdraw(address indexed lp, uint256 amount, uint256 sharesBurned);
    event PositionModified(
        uint256 indexed marketId,
        address indexed trader,
        int256 sizeDelta,
        int256 newSize,
        uint256 fillPrice,
        uint256 newEntryPrice,
        uint256 newMargin,
        int256 realizedPnl,
        int256 fundingSettled,
        uint256 fee
    );
    event WithdrawRequested(address indexed lp, uint256 shares, uint256 unlockTime);
    event WithdrawCancelled(address indexed lp, uint256 shares);
    event ProtocolFeesClaimed(address indexed recipient, uint256 amount);
    event ProtocolFeeSet(address indexed feeRecipient, uint256 protocolFeeShareBps);
    event PoolParamsSet(uint256 closeOnlyBefore, uint256 withdrawCooldown, uint256 withdrawWindow);
    event MaxTotalSkewSet(uint256 maxTotalSkewToPoolBps);
    event FeesSet(uint256 tradingFeeBps, uint256 maintenanceMarginBps, uint256 liquidationFeeBps, uint256 maxOracleAge);

    error MarketInactive();
    error BadMarket();
    error PositionExists();
    error NoPosition();
    error ZeroAmount();
    error LeverageTooHigh();
    error WouldBeLiquidatable();
    error NotLiquidatable();
    error SkewCapExceeded();
    error StaleOracle();
    error InsufficientLiquidity();
    error SlippageExceeded();
    error BadParam();
    error CloseOnly();
    error FlipNotAllowed();
    error WithdrawLocked();
    error WithdrawExpired();
    error ExceedsPending();
    error WithdrawPending();
    error PoolInsolvent();

    constructor(address owner_, IERC20 collateral_, HouseIndexOracle oracle_) Ownable(owner_) {
        collateral = collateral_;
        oracle = oracle_;
        feeRecipient = owner_;
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function addMarket(
        string calldata name,
        bytes32 oracleId,
        uint256 skewScale,
        uint256 maxFundingRatePerDay,
        uint256 maxSkewToPoolBps
    ) external onlyOwner returns (uint256 marketId) {
        if (_markets.length >= MAX_MARKETS || skewScale == 0) revert BadParam();
        oracle.price(oracleId); // reverts for unknown feed
        marketId = _markets.length;
        Market storage m = _markets.push();
        m.name = name;
        m.oracleId = oracleId;
        m.active = true;
        m.skewScale = skewScale;
        m.maxFundingRatePerDay = maxFundingRatePerDay;
        m.maxSkewToPoolBps = maxSkewToPoolBps;
        m.lastFundingTime = uint64(block.timestamp);
        emit MarketAdded(marketId, name, oracleId);
    }

    function updateMarket(
        uint256 marketId,
        bool active,
        uint256 skewScale,
        uint256 maxFundingRatePerDay,
        uint256 maxSkewToPoolBps
    ) external onlyOwner {
        if (skewScale == 0) revert BadParam();
        Market storage m = _market(marketId);
        _accrueFunding(m);
        m.active = active;
        m.skewScale = skewScale;
        m.maxFundingRatePerDay = maxFundingRatePerDay;
        m.maxSkewToPoolBps = maxSkewToPoolBps;
        emit MarketUpdated(marketId);
    }

    function setFees(uint256 tradingFeeBps_, uint256 maintenanceMarginBps_, uint256 liquidationFeeBps_, uint256 maxOracleAge_)
        external
        onlyOwner
    {
        // Maintenance margin must stay below the 1% initial margin implied by 100x.
        if (tradingFeeBps_ > 100 || maintenanceMarginBps_ == 0 || maintenanceMarginBps_ >= BPS / MAX_LEVERAGE) {
            revert BadParam();
        }
        if (liquidationFeeBps_ > maintenanceMarginBps_) revert BadParam();
        tradingFeeBps = tradingFeeBps_;
        maintenanceMarginBps = maintenanceMarginBps_;
        liquidationFeeBps = liquidationFeeBps_;
        maxOracleAge = maxOracleAge_;
        emit FeesSet(tradingFeeBps_, maintenanceMarginBps_, liquidationFeeBps_, maxOracleAge_);
    }

    function setProtocolFee(address recipient, uint256 shareBps) external onlyOwner {
        if (recipient == address(0) || shareBps > BPS) revert BadParam();
        feeRecipient = recipient;
        protocolFeeShareBps = shareBps;
        emit ProtocolFeeSet(recipient, shareBps);
    }

    function setPoolParams(uint256 closeOnlyBefore_, uint256 withdrawCooldown_, uint256 withdrawWindow_)
        external
        onlyOwner
    {
        if (closeOnlyBefore_ > 7 days || withdrawCooldown_ > 30 days) revert BadParam();
        closeOnlyBefore = closeOnlyBefore_;
        withdrawCooldown = withdrawCooldown_;
        withdrawWindow = withdrawWindow_;
        emit PoolParamsSet(closeOnlyBefore_, withdrawCooldown_, withdrawWindow_);
    }

    function setMaxTotalSkew(uint256 bps) external onlyOwner {
        if (bps == 0) revert BadParam();
        maxTotalSkewToPoolBps = bps;
        emit MaxTotalSkewSet(bps);
    }

    /// @notice Sends all unclaimed protocol fees to `feeRecipient`. Callable by anyone.
    function claimProtocolFees() external nonReentrant returns (uint256 amount) {
        amount = protocolFeesAccrued;
        if (amount == 0) revert ZeroAmount();
        protocolFeesAccrued = 0;
        collateral.safeTransfer(feeRecipient, amount);
        emit ProtocolFeesClaimed(feeRecipient, amount);
    }

    // ---------------------------------------------------------------------
    // Liquidity pool
    // ---------------------------------------------------------------------

    function deposit(uint256 amount, uint256 minSharesOut) external nonReentrant returns (uint256 minted) {
        if (amount == 0) revert ZeroAmount();
        _accrueAll();
        uint256 nav = poolValue();
        if (nav == 0 && totalShares > 0) revert PoolInsolvent();
        minted = (amount * (totalShares + VIRTUAL_SHARES)) / (nav + VIRTUAL_ASSETS);
        if (minted == 0) revert ZeroAmount();
        if (minted < minSharesOut) revert SlippageExceeded();
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        totalShares += minted;
        shares[msg.sender] += minted;
        emit Deposit(msg.sender, amount, minted);
    }

    /// @notice Start the withdrawal cooldown for `shareAmount` shares (replaces any pending request
    ///         and restarts the timer). Shares stay in the pool, exposed to PnL, until withdrawn.
    function requestWithdraw(uint256 shareAmount) external nonReentrant {
        if (shareAmount == 0) revert ZeroAmount();
        if (pendingWithdrawShares[msg.sender] != 0) revert WithdrawPending();
        if (shareAmount > shares[msg.sender]) revert ExceedsPending();
        uint256 unlock = block.timestamp + withdrawCooldown;
        shares[msg.sender] -= shareAmount; // escrowed until withdraw or cancel
        pendingWithdrawShares[msg.sender] = shareAmount;
        pendingWithdrawValue[msg.sender] = _sharesToAssets(shareAmount, poolValue());
        withdrawUnlockTime[msg.sender] = unlock;
        emit WithdrawRequested(msg.sender, shareAmount, unlock);
    }

    function cancelWithdraw() external {
        uint256 pending = pendingWithdrawShares[msg.sender];
        if (pending == 0) revert ZeroAmount();
        pendingWithdrawShares[msg.sender] = 0;
        pendingWithdrawValue[msg.sender] = 0;
        withdrawUnlockTime[msg.sender] = 0;
        shares[msg.sender] += pending;
        emit WithdrawCancelled(msg.sender, pending);
    }

    /// @notice Withdraw up to the requested shares once the cooldown has passed.
    function withdraw(uint256 shareAmount, uint256 minAmountOut) external nonReentrant returns (uint256 amount) {
        if (shareAmount == 0) revert ZeroAmount();
        uint256 pending = pendingWithdrawShares[msg.sender];
        if (shareAmount > pending) revert ExceedsPending();
        uint256 unlock = withdrawUnlockTime[msg.sender];
        if (block.timestamp < unlock) revert WithdrawLocked();
        if (withdrawWindow != 0 && block.timestamp > unlock + withdrawWindow) revert WithdrawExpired();
        _accrueAll();
        uint256 nav = poolValue();
        uint256 valueAtRequest = (pendingWithdrawValue[msg.sender] * shareAmount) / pending;
        amount = _sharesToAssets(shareAmount, nav);
        if (amount > valueAtRequest) amount = valueAtRequest;
        if (amount < minAmountOut) revert SlippageExceeded();
        pendingWithdrawShares[msg.sender] = pending - shareAmount;
        pendingWithdrawValue[msg.sender] -= valueAtRequest;
        totalShares -= shareAmount;
        // Every market must still respect its skew cap against the smaller pool.
        uint256 navAfter = nav - amount;
        for (uint256 i; i < _markets.length; ++i) {
            if (!_skewWithinCap(_markets[i], _markets[i].skew, navAfter)) revert InsufficientLiquidity();
        }
        if (amount > _freeBalance()) revert InsufficientLiquidity();
        collateral.safeTransfer(msg.sender, amount);
        emit Withdraw(msg.sender, amount, shareAmount);
    }

    /// @notice Pending withdrawal for the frontend: shares, unlock time, expiry (0 = none) and the
    ///         current USDT value of those shares.
    function pendingWithdrawal(address lp)
        external
        view
        returns (uint256 pendingShares, uint256 unlockTime, uint256 expiresAt, uint256 estimatedAmount)
    {
        pendingShares = pendingWithdrawShares[lp];
        if (pendingShares == 0) return (0, 0, 0, 0);
        unlockTime = withdrawUnlockTime[lp];
        expiresAt = withdrawWindow == 0 ? 0 : unlockTime + withdrawWindow;
        estimatedAmount = _sharesToAssets(pendingShares, poolValue());
        if (estimatedAmount > pendingWithdrawValue[lp]) estimatedAmount = pendingWithdrawValue[lp];
    }

    function _sharesToAssets(uint256 shareAmount, uint256 nav) internal view returns (uint256) {
        return (shareAmount * (nav + VIRTUAL_ASSETS)) / (totalShares + VIRTUAL_SHARES);
    }

    /// @notice Pool cash: contract balance minus trader margin minus unclaimed protocol fees.
    function poolCash() external view returns (uint256) {
        return _freeBalance();
    }

    /// @notice Pool value = pool cash minus traders' net unrealized PnL (at index price).
    ///         Accrued-but-unsettled funding is not included (funding nets out across sides
    ///         except for the skewed portion, which favours the pool).
    function poolValue() public view returns (uint256) {
        int256 value = _freeBalance().toInt256();
        for (uint256 i; i < _markets.length; ++i) {
            Market storage m = _markets[i];
            uint256 p = oracle.price(m.oracleId);
            // Mark at the close-out price (what closing all skew would fill at), not the bare index.
            uint256 closeOut = _applyPremium(p, (m.skew * int256(WAD)) / m.skewScale.toInt256() / 2);
            int256 traderPnl = (m.skew * closeOut.toInt256()) / int256(WAD) - m.sumSizeEntry;
            // Do not credit trader losses beyond the margin actually held for this market.
            int256 maxLoss = -m.marginTotal.toInt256();
            if (traderPnl < maxLoss) traderPnl = maxLoss;
            value -= traderPnl;
        }
        return value > 0 ? uint256(value) : 0;
    }

    // ---------------------------------------------------------------------
    // Trading
    // ---------------------------------------------------------------------

    /// @param size Signed position size in index units (WAD). Long > 0, short < 0.
    /// @param margin USDT margin, including the opening fee.
    /// @param acceptablePrice Worst fill price the trader accepts (max for longs, min for shorts).
    function openPosition(uint256 marketId, int256 size, uint256 margin, uint256 acceptablePrice)
        external
        nonReentrant
    {
        if (size == 0 || margin == 0) revert ZeroAmount();
        Market storage m = _market(marketId);
        if (!m.active) revert MarketInactive();
        if (positions[marketId][msg.sender].size != 0) revert PositionExists();
        if (_isCloseOnly(m)) revert CloseOnly();
        _requireFresh(m);
        _accrueFunding(m);

        uint256 indexPrice = oracle.price(m.oracleId);
        uint256 fill = _fillPrice(m, _openBasePrice(m, indexPrice, size), size);
        if (size > 0 ? fill > acceptablePrice : fill < acceptablePrice) revert SlippageExceeded();

        uint256 absSize = _abs(size);
        uint256 notional = (absSize * fill) / WAD;
        uint256 fee = (notional * tradingFeeBps) / BPS;
        if (margin <= fee) revert ZeroAmount();
        uint256 netMargin = margin - fee;
        if (notional > netMargin * MAX_LEVERAGE) revert LeverageTooHigh();

        int256 newSkew = m.skew + size;
        uint256 protocolCut = (fee * protocolFeeShareBps) / BPS;
        _checkSkewCaps(m, newSkew, poolValue() + fee - protocolCut);

        collateral.safeTransferFrom(msg.sender, address(this), margin);

        Position storage pos = positions[marketId][msg.sender];
        pos.size = size;
        pos.margin = netMargin;
        pos.entryPrice = fill;
        pos.entryFunding = m.fundingIndex;
        int256 se = (size * fill.toInt256()) / int256(WAD);
        pos.sizeEntry = se;

        m.skew = newSkew;
        m.sumSizeEntry += se;
        protocolFeesAccrued += protocolCut;
        if (size > 0) m.longSize += absSize;
        else m.shortSize += absSize;
        m.marginTotal += netMargin;
        totalMargin += netMargin; // fee stays in the contract as pool money

        if (_isLiquidatable(pos, m, indexPrice)) revert WouldBeLiquidatable();
        emit PositionOpened(marketId, msg.sender, size, netMargin, fill, fee);
    }

    function closePosition(uint256 marketId, uint256 acceptablePrice) external nonReentrant returns (uint256 payout) {
        Market storage m = _market(marketId);
        if (positions[marketId][msg.sender].size == 0) revert NoPosition();
        _accrueFunding(m);
        payout = _close(marketId, msg.sender, m, acceptablePrice);
    }

    /// @notice Increase or partially reduce an existing position. Reducing to exactly zero closes it.
    ///         Flipping through zero reverts. Increases use the existing margin (call addMargin
    ///         first if needed); the fee is taken from margin. Partial closes realize PnL, funding
    ///         and fee proportionally into margin, which stays on the position.
    /// @param sizeDelta Signed change in size (same sign as the position = increase).
    /// @param acceptablePrice Worst fill (max when sizeDelta > 0, min when sizeDelta < 0).
    function modifyPosition(uint256 marketId, int256 sizeDelta, uint256 acceptablePrice) external nonReentrant {
        if (sizeDelta == 0) revert ZeroAmount();
        Market storage m = _market(marketId);
        Position storage pos = positions[marketId][msg.sender];
        int256 size = pos.size;
        if (size == 0) revert NoPosition();
        _accrueFunding(m);

        bool increase = (size > 0) == (sizeDelta > 0);
        if (!increase) {
            if (_abs(sizeDelta) > _abs(size)) revert FlipNotAllowed();
            if (_abs(sizeDelta) == _abs(size)) {
                _close(marketId, msg.sender, m, acceptablePrice);
                return;
            }
        } else {
            if (!m.active) revert MarketInactive();
            if (_isCloseOnly(m)) revert CloseOnly();
            _requireFresh(m);
        }

        uint256 idx = oracle.price(m.oracleId);
        uint256 fill = _fillPrice(m, increase ? _openBasePrice(m, idx, sizeDelta) : idx, sizeDelta);
        if (sizeDelta > 0 ? fill > acceptablePrice : fill < acceptablePrice) revert SlippageExceeded();
        uint256 fee = ((_abs(sizeDelta) * fill) / WAD * tradingFeeBps) / BPS;

        // Settle accrued funding into margin and realize PnL on the reduced part.
        int256 funding = _fundingOwed(pos, m);
        int256 realized;
        int256 seDelta;
        if (increase) {
            seDelta = (sizeDelta * fill.toInt256()) / int256(WAD);
        } else {
            seDelta = -((pos.sizeEntry * int256(_abs(sizeDelta))) / int256(_abs(size)));
            // closed part: (-sizeDelta) * fill - its share of entry notional
            realized = (-sizeDelta * fill.toInt256()) / int256(WAD) + seDelta;
            // Realized profit moves from pool cash into margin: it must be backed by pool cash.
            if (realized > 0 && uint256(realized) > _freeBalance()) revert InsufficientLiquidity();
        }
        int256 newMarginSigned = pos.margin.toInt256() + realized - funding - fee.toInt256();
        if (newMarginSigned <= 0) revert WouldBeLiquidatable();
        uint256 newMargin = uint256(newMarginSigned);

        int256 newSize = size + sizeDelta;
        int256 newSkew = m.skew + sizeDelta;
        uint256 protocolCut = (fee * protocolFeeShareBps) / BPS;
        if (increase) {
            if ((_abs(newSize) * fill) / WAD > newMargin * MAX_LEVERAGE) revert LeverageTooHigh();
            _checkSkewCaps(m, newSkew, poolValue() + fee - protocolCut);
        }

        totalMargin = totalMargin - pos.margin + newMargin;
        m.marginTotal = m.marginTotal - pos.margin + newMargin;
        protocolFeesAccrued += protocolCut;
        pos.margin = newMargin;
        pos.size = newSize;
        pos.sizeEntry += seDelta;
        pos.entryPrice = uint256((pos.sizeEntry * int256(WAD)) / newSize);
        pos.entryFunding = m.fundingIndex;

        m.skew = newSkew;
        m.sumSizeEntry += seDelta;
        if (sizeDelta > 0) {
            if (increase) m.longSize += _abs(sizeDelta);
            else m.shortSize -= _abs(sizeDelta);
        } else {
            if (increase) m.shortSize += _abs(sizeDelta);
            else m.longSize -= _abs(sizeDelta);
        }

        if (_isLiquidatable(pos, m, idx)) revert WouldBeLiquidatable();
        emit PositionModified(
            marketId, msg.sender, sizeDelta, newSize, fill, pos.entryPrice, newMargin, realized, funding, fee
        );
    }

    function addMargin(uint256 marketId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Position storage pos = positions[marketId][msg.sender];
        if (pos.size == 0) revert NoPosition();
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        pos.margin += amount;
        totalMargin += amount;
        _markets[marketId].marginTotal += amount;
        emit MarginChanged(marketId, msg.sender, amount.toInt256(), pos.margin);
    }

    function removeMargin(uint256 marketId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Market storage m = _market(marketId);
        Position storage pos = positions[marketId][msg.sender];
        if (pos.size == 0) revert NoPosition();
        _accrueFunding(m);
        uint256 indexPrice = oracle.price(m.oracleId);
        pos.margin -= amount;
        totalMargin -= amount;
        m.marginTotal -= amount;
        int256 equity = _equity(pos, m, indexPrice);
        uint256 notional = (_abs(pos.size) * indexPrice) / WAD;
        if (equity <= 0 || notional > uint256(equity) * MAX_LEVERAGE) revert LeverageTooHigh();
        if (_isLiquidatable(pos, m, indexPrice)) revert WouldBeLiquidatable();
        collateral.safeTransfer(msg.sender, amount);
        emit MarginChanged(marketId, msg.sender, -amount.toInt256(), pos.margin);
    }

    /// @notice Anyone can liquidate a position whose equity is below maintenance margin.
    ///         The liquidator earns a fee; any remaining equity goes to the pool, which also
    ///         absorbs any bad debt.
    function liquidate(uint256 marketId, address trader) external nonReentrant returns (uint256 reward) {
        Market storage m = _market(marketId);
        Position memory pos = positions[marketId][trader];
        if (pos.size == 0) revert NoPosition();
        _accrueFunding(m);
        uint256 indexPrice = oracle.price(m.oracleId);
        if (!_isLiquidatable(pos, m, indexPrice)) revert NotLiquidatable();

        int256 equity = _equity(pos, m, indexPrice);
        reward = ((_abs(pos.size) * indexPrice) / WAD * liquidationFeeBps) / BPS;
        if (equity <= 0) reward = MIN_LIQUIDATION_REWARD;
        else if (reward > uint256(equity)) reward = uint256(equity);

        _removePosition(marketId, trader, pos, m);
        uint256 free = _freeBalance();
        if (reward > free) reward = free;
        if (reward > 0) collateral.safeTransfer(msg.sender, reward);
        emit Liquidated(marketId, trader, msg.sender, pos.size, indexPrice, reward);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function getMarket(uint256 marketId) external view returns (Market memory) {
        return _markets[marketId];
    }

    function indexPrice(uint256 marketId) public view returns (uint256) {
        return oracle.price(_markets[marketId].oracleId);
    }

    /// @notice Index price adjusted by the current skew premium.
    function markPrice(uint256 marketId) public view returns (uint256) {
        Market storage m = _markets[marketId];
        uint256 p = oracle.price(m.oracleId);
        return _applyPremium(p, (m.skew * int256(WAD)) / m.skewScale.toInt256());
    }

    /// @notice Price a trade of `size` would fill at right now.
    function quoteFill(uint256 marketId, int256 size) external view returns (uint256) {
        Market storage m = _markets[marketId];
        return _fillPrice(m, oracle.price(m.oracleId), size);
    }

    /// @notice Fill price for opening/increasing by `size` (uses the worse of smoothed and target index).
    function quoteOpenFill(uint256 marketId, int256 size) external view returns (uint256) {
        Market storage m = _markets[marketId];
        return _fillPrice(m, _openBasePrice(m, oracle.price(m.oracleId), size), size);
    }

    /// @notice Current funding rate per day (WAD). Positive = longs pay shorts.
    function fundingRatePerDay(uint256 marketId) public view returns (int256) {
        return _fundingRatePerDay(_markets[marketId]);
    }

    /// @notice True when opening/increasing is blocked ahead of a scheduled index print.
    function isCloseOnly(uint256 marketId) external view returns (bool) {
        return _isCloseOnly(_market(marketId));
    }

    /// @notice Every market with live index, mark, funding rate and close-only state.
    function getAllMarkets() external view returns (MarketView[] memory out) {
        out = new MarketView[](_markets.length);
        for (uint256 i; i < _markets.length; ++i) {
            Market storage m = _markets[i];
            MarketView memory v = out[i];
            uint256 p = oracle.price(m.oracleId);
            v.marketId = i;
            v.name = m.name;
            v.oracleId = m.oracleId;
            v.active = m.active;
            v.skewScale = m.skewScale;
            v.maxFundingRatePerDay = m.maxFundingRatePerDay;
            v.maxSkewToPoolBps = m.maxSkewToPoolBps;
            v.skew = m.skew;
            v.longSize = m.longSize;
            v.shortSize = m.shortSize;
            v.indexPrice = p;
            v.markPrice = _applyPremium(p, (m.skew * int256(WAD)) / m.skewScale.toInt256());
            v.fundingRatePerDay = _fundingRatePerDay(m);
            v.closeOnly = _isCloseOnly(m);
            v.scheduledPrint = oracle.scheduledPrint(m.oracleId);
        }
    }

    struct PositionInfo {
        int256 size;
        uint256 margin;
        uint256 entryPrice;
        uint256 indexPrice;
        int256 pnl;
        int256 funding;
        int256 equity;
        uint256 liquidationPrice;
        bool liquidatable;
    }

    function positionInfo(uint256 marketId, address trader) external view returns (PositionInfo memory info) {
        Market storage m = _markets[marketId];
        Position memory pos = positions[marketId][trader];
        if (pos.size == 0) return info;
        uint256 p = oracle.price(m.oracleId);
        int256 currentFundingIndex = m.fundingIndex + _pendingFunding(m, p);
        info.size = pos.size;
        info.margin = pos.margin;
        info.entryPrice = pos.entryPrice;
        info.indexPrice = p;
        info.pnl = (pos.size * p.toInt256()) / int256(WAD) - pos.sizeEntry;
        info.funding = (pos.size * (currentFundingIndex - pos.entryFunding)) / int256(WAD);
        info.equity = pos.margin.toInt256() + info.pnl - info.funding;
        info.liquidatable = info.equity < ((_abs(pos.size) * p) / WAD * maintenanceMarginBps / BPS).toInt256();
        info.liquidationPrice = _liquidationPrice(pos, info.funding);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _market(uint256 marketId) internal view returns (Market storage) {
        if (marketId >= _markets.length) revert BadMarket();
        return _markets[marketId];
    }

    function _isCloseOnly(Market storage m) internal view returns (bool) {
        uint256 t = oracle.scheduledPrint(m.oracleId);
        return t != 0 && block.timestamp + closeOnlyBefore >= t && block.timestamp <= t + PRINT_GRACE;
    }

    /// @dev Opens/increases fill against the worse (for the trader) of the smoothed index and the
    ///      published target, so a known phase-in is not a free option. PnL marking stays smoothed.
    function _openBasePrice(Market storage m, uint256 smoothed, int256 size) internal view returns (uint256) {
        uint256 target = oracle.targetPrice(m.oracleId);
        if (size > 0) return target > smoothed ? target : smoothed;
        return target < smoothed ? target : smoothed;
    }

    function _checkSkewCaps(Market storage m, int256 newSkew, uint256 nav) internal view {
        if (!_skewWithinCap(m, newSkew, nav)) revert SkewCapExceeded();
        uint256 total;
        for (uint256 i; i < _markets.length; ++i) {
            Market storage mi = _markets[i];
            int256 sk = _sameMarket(mi, m) ? newSkew : mi.skew;
            total += (_abs(sk) * oracle.price(mi.oracleId)) / WAD;
        }
        if (total * BPS > nav * maxTotalSkewToPoolBps) revert SkewCapExceeded();
    }

    function _sameMarket(Market storage a, Market storage b) internal pure returns (bool r) {
        assembly {
            r := eq(a.slot, b.slot)
        }
    }

    function _close(uint256 marketId, address trader, Market storage m, uint256 acceptablePrice)
        internal
        returns (uint256 payout)
    {
        Position memory pos = positions[marketId][trader];
        uint256 indexPrice_ = oracle.price(m.oracleId);
        uint256 fill = _fillPrice(m, indexPrice_, -pos.size);
        if (pos.size > 0 ? fill < acceptablePrice : fill > acceptablePrice) revert SlippageExceeded();

        int256 pnl = (pos.size * fill.toInt256()) / int256(WAD) - pos.sizeEntry;
        int256 funding = _fundingOwed(pos, m);
        uint256 fee = ((_abs(pos.size) * fill) / WAD * tradingFeeBps) / BPS;
        int256 preFee = pos.margin.toInt256() + pnl - funding;
        uint256 feePaid = preFee <= 0 ? 0 : (uint256(preFee) < fee ? uint256(preFee) : fee);
        payout = preFee > 0 ? uint256(preFee) - feePaid : 0;

        _removePosition(marketId, trader, pos, m);
        protocolFeesAccrued += (feePaid * protocolFeeShareBps) / BPS;
        if (payout > 0) {
            if (payout > _freeBalance()) revert InsufficientLiquidity();
            collateral.safeTransfer(trader, payout);
        }
        emit PositionClosed(marketId, trader, pos.size, fill, pnl, funding, payout);
    }

    function _requireFresh(Market storage m) internal view {
        if (block.timestamp - oracle.lastUpdate(m.oracleId) > maxOracleAge) revert StaleOracle();
    }

    function _freeBalance() internal view returns (uint256) {
        uint256 bal = collateral.balanceOf(address(this));
        uint256 reserved = totalMargin + protocolFeesAccrued;
        return bal > reserved ? bal - reserved : 0;
    }

    function _skewWithinCap(Market storage m, int256 skew, uint256 nav) internal view returns (bool) {
        if (skew == 0) return true;
        uint256 exposure = (_abs(skew) * oracle.price(m.oracleId)) / WAD;
        return exposure * BPS <= nav * m.maxSkewToPoolBps;
    }

    function _applyPremium(uint256 price, int256 premium) internal pure returns (uint256) {
        int256 adj = (price.toInt256() * (int256(WAD) + premium)) / int256(WAD);
        return adj > 0 ? uint256(adj) : 0;
    }

    function _fillPrice(Market storage m, uint256 price, int256 size) internal view returns (uint256) {
        int256 scale = m.skewScale.toInt256();
        int256 before = (m.skew * int256(WAD)) / scale;
        int256 afterTrade = ((m.skew + size) * int256(WAD)) / scale;
        return _applyPremium(price, (before + afterTrade) / 2);
    }

    function _fundingRatePerDay(Market storage m) internal view returns (int256) {
        int256 proportional = (m.skew * int256(WAD)) / m.skewScale.toInt256();
        if (proportional > int256(WAD)) proportional = int256(WAD);
        if (proportional < -int256(WAD)) proportional = -int256(WAD);
        return (proportional * m.maxFundingRatePerDay.toInt256()) / int256(WAD);
    }

    function _pendingFunding(Market storage m, uint256 price) internal view returns (int256) {
        uint256 dt = block.timestamp - m.lastFundingTime;
        if (dt == 0) return 0;
        // funding per unit size = rate/day * price * days
        return (_fundingRatePerDay(m) * price.toInt256() / int256(WAD)) * int256(dt) / 1 days;
    }

    function _accrueFunding(Market storage m) internal {
        m.fundingIndex += _pendingFunding(m, oracle.price(m.oracleId));
        m.lastFundingTime = uint64(block.timestamp);
    }

    function _accrueAll() internal {
        for (uint256 i; i < _markets.length; ++i) _accrueFunding(_markets[i]);
    }

    function _fundingOwed(Position memory pos, Market storage m) internal view returns (int256) {
        return (pos.size * (m.fundingIndex - pos.entryFunding)) / int256(WAD);
    }

    function _equity(Position memory pos, Market storage m, uint256 price) internal view returns (int256) {
        int256 pnl = (pos.size * price.toInt256()) / int256(WAD) - pos.sizeEntry;
        return pos.margin.toInt256() + pnl - _fundingOwed(pos, m);
    }

    function _isLiquidatable(Position memory pos, Market storage m, uint256 price) internal view returns (bool) {
        uint256 maintenance = (_abs(pos.size) * price) / WAD * maintenanceMarginBps / BPS;
        return _equity(pos, m, price) < maintenance.toInt256();
    }

    /// @dev Solves margin + size*(p - entry) - funding = mm * |size| * p for p.
    function _liquidationPrice(Position memory pos, int256 funding) internal view returns (uint256) {
        int256 k = (maintenanceMarginBps * WAD / BPS).toInt256();
        int256 w = int256(WAD);
        int256 s = pos.size;
        int256 numer = (s * pos.entryPrice.toInt256()) / w - pos.margin.toInt256() + funding; // USD
        int256 denom = s > 0 ? (s * (w - k)) / w : (s * (w + k)) / w; // size units
        if (denom == 0) return 0;
        int256 p = (numer * w) / denom;
        return p > 0 ? uint256(p) : 0;
    }

    function _removePosition(uint256 marketId, address trader, Position memory pos, Market storage m) internal {
        m.skew -= pos.size;
        m.sumSizeEntry -= pos.sizeEntry;
        if (pos.size > 0) m.longSize -= _abs(pos.size);
        else m.shortSize -= _abs(pos.size);
        totalMargin -= pos.margin;
        m.marginTotal -= pos.margin;
        delete positions[marketId][trader];
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }
}
