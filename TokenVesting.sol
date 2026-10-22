// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title TokenVesting
 * @notice Multi-beneficiary ERC-20 vesting vault with a 90-day cliff and
 *         linear vesting over 365 days from each schedule's start.
 *
 * @dev Funding model:
 *      - Push tokens into this contract (ERC-20 transfer).
 *      - `createVesting` may only allocate up to the free (unreserved) balance.
 *      - Invariant: `token.balanceOf(this) >= totalAllocated - totalClaimed`.
 *
 *      Vesting formula (cliff-gated linear from start):
 *        t < start + 90 days              -> 0
 *        start + 90d <= t < start + 365d  -> total * (t - start) / 365 days
 *        t >= start + 365 days            -> total
 */
contract TokenVesting is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant CLIFF_DURATION = 90 days;
    uint256 public constant VESTING_DURATION = 365 days;

    struct VestingSchedule {
        address beneficiary;
        uint256 totalAmount;
        uint64 start;
        uint256 claimed;
    }

    IERC20 public immutable token;

    mapping(address => VestingSchedule) private _schedules;

    /// @notice Sum of all schedule allocations.
    uint256 public totalAllocated;

    /// @notice Sum of all claimed amounts across schedules.
    uint256 public totalClaimed;

    event VestingCreated(
        address indexed beneficiary,
        uint256 amount,
        uint64 start
    );
    event Claimed(address indexed beneficiary, uint256 amount);
    event ExcessRecovered(address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error InvalidStart();
    error ScheduleExists();
    error NoSchedule();
    error NothingToClaim();
    error InsufficientFunding();
    error InsufficientExcess();

    constructor(address token_, address initialOwner) Ownable(initialOwner) {
        if (token_ == address(0) || initialOwner == address(0)) {
            revert ZeroAddress();
        }
        token = IERC20(token_);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function schedules(address beneficiary)
        external
        view
        returns (VestingSchedule memory)
    {
        return _schedules[beneficiary];
    }

    /**
     * @notice Tokens reserved for outstanding vesting (allocated but not yet claimed).
     */
    function reserved() public view returns (uint256) {
        return totalAllocated - totalClaimed;
    }

    /**
     * @notice Tokens held that are not reserved for any schedule.
     */
    function freeBalance() public view returns (uint256) {
        uint256 balance = token.balanceOf(address(this));
        uint256 reservedAmount = reserved();
        return balance > reservedAmount ? balance - reservedAmount : 0;
    }

    function vestedAmount(address beneficiary, uint256 timestamp)
        public
        view
        returns (uint256)
    {
        return _vestedAmount(_schedules[beneficiary], timestamp);
    }

    function claimable(address beneficiary) public view returns (uint256) {
        VestingSchedule memory schedule = _schedules[beneficiary];
        uint256 vested = _vestedAmount(schedule, block.timestamp);
        if (vested <= schedule.claimed) {
            return 0;
        }
        return vested - schedule.claimed;
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /**
     * @notice Create a vesting schedule for `beneficiary`.
     * @dev Requires sufficient free balance so the contract never over-promises.
     *      One schedule per beneficiary. `start` must be at or after now.
     */
    function createVesting(
        address beneficiary,
        uint256 amount,
        uint64 start
    ) external onlyOwner {
        if (beneficiary == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (start < block.timestamp) revert InvalidStart();
        if (_schedules[beneficiary].totalAmount != 0) revert ScheduleExists();
        if (amount > freeBalance()) revert InsufficientFunding();

        _schedules[beneficiary] = VestingSchedule({
            beneficiary: beneficiary,
            totalAmount: amount,
            start: start,
            claimed: 0
        });

        totalAllocated += amount;

        emit VestingCreated(beneficiary, amount, start);
    }

    /**
     * @notice Recover tokens that are not reserved for vesting schedules.
     */
    function recoverExcess(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > freeBalance()) revert InsufficientExcess();

        token.safeTransfer(to, amount);
        emit ExcessRecovered(to, amount);
    }

    // -------------------------------------------------------------------------
    // Beneficiary
    // -------------------------------------------------------------------------

    /**
     * @notice Claim vested but unclaimed tokens for the caller.
     */
    function claim() external nonReentrant {
        _claim(msg.sender);
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    function _claim(address beneficiary) internal {
        VestingSchedule storage schedule = _schedules[beneficiary];
        if (schedule.totalAmount == 0) revert NoSchedule();

        uint256 vested = _vestedAmount(schedule, block.timestamp);
        if (vested <= schedule.claimed) revert NothingToClaim();

        uint256 amount = vested - schedule.claimed;

        // Effects before interaction (CEI)
        schedule.claimed = vested;
        totalClaimed += amount;

        token.safeTransfer(beneficiary, amount);
        emit Claimed(beneficiary, amount);
    }

    /**
     * @dev Cliff-gated linear vesting over VESTING_DURATION from start.
     *      At cliff, unlocked amount is total * CLIFF / DURATION (~90/365).
     */
    function _vestedAmount(VestingSchedule memory schedule, uint256 timestamp)
        internal
        pure
        returns (uint256)
    {
        if (schedule.totalAmount == 0) {
            return 0;
        }

        if (timestamp < uint256(schedule.start) + CLIFF_DURATION) {
            return 0;
        }

        if (timestamp >= uint256(schedule.start) + VESTING_DURATION) {
            return schedule.totalAmount;
        }

        return
            (schedule.totalAmount * (timestamp - uint256(schedule.start))) /
            VESTING_DURATION;
    }
}
