const { expect } = require("chai");
const {
  loadFixture,
  time,
} = require("@nomicfoundation/hardhat-network-helpers");
const { ethers } = require("hardhat");

const CLIFF = 90n * 24n * 60n * 60n;
const DURATION = 365n * 24n * 60n * 60n;

function vestedAt(total, start, timestamp) {
  if (timestamp < start + CLIFF) return 0n;
  if (timestamp >= start + DURATION) return total;
  return (total * (timestamp - start)) / DURATION;
}

async function claimedFromTx(tx, vesting, allocation, start) {
  const receipt = await tx.wait();
  const block = await ethers.provider.getBlock(receipt.blockNumber);
  return vestedAt(allocation, start, BigInt(block.timestamp));
}

describe("TokenVesting", function () {
  async function deployFixture() {
    const [owner, alice, bob, charlie, stranger] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("Vest Token", "VEST");
    await token.waitForDeployment();

    const TokenVesting = await ethers.getContractFactory("TokenVesting");
    const vesting = await TokenVesting.deploy(
      await token.getAddress(),
      owner.address
    );
    await vesting.waitForDeployment();

    const allocation = ethers.parseEther("1000");
    await token.mint(owner.address, ethers.parseEther("100000"));
    await token.connect(owner).transfer(await vesting.getAddress(), allocation);

    return {
      owner,
      alice,
      bob,
      charlie,
      stranger,
      token,
      vesting,
      allocation,
    };
  }

  async function freshStart() {
    // Far enough ahead that multiple txs in the same test stay valid.
    return BigInt(await time.latest()) + 365n;
  }

  async function fundedScheduleFixture() {
    const base = await loadFixture(deployFixture);
    const { vesting, alice, allocation } = base;
    const start = await freshStart();
    await vesting.createVesting(alice.address, allocation, start);
    return { ...base, start, allocation };
  }

  describe("createVesting – access & validation", function () {
    it("reverts when a non-owner creates a schedule", async function () {
      const { vesting, alice, stranger, allocation } =
        await loadFixture(deployFixture);
      const start = await freshStart();

      await expect(
        vesting
          .connect(stranger)
          .createVesting(alice.address, allocation, start)
      ).to.be.revertedWithCustomError(vesting, "OwnableUnauthorizedAccount");
    });

    it("reverts on zero beneficiary", async function () {
      const { vesting, allocation } = await loadFixture(deployFixture);
      const start = await freshStart();

      await expect(
        vesting.createVesting(ethers.ZeroAddress, allocation, start)
      ).to.be.revertedWithCustomError(vesting, "ZeroAddress");
    });

    it("reverts on zero allocation", async function () {
      const { vesting, alice } = await loadFixture(deployFixture);
      const start = await freshStart();

      await expect(
        vesting.createVesting(alice.address, 0, start)
      ).to.be.revertedWithCustomError(vesting, "ZeroAmount");
    });

    it("reverts on start in the past", async function () {
      const { vesting, alice, allocation } = await loadFixture(deployFixture);
      const past = BigInt(await time.latest()) - 10n;

      await expect(
        vesting.createVesting(alice.address, allocation, past)
      ).to.be.revertedWithCustomError(vesting, "InvalidStart");
    });

    it("reverts on duplicate schedule for the same beneficiary", async function () {
      const { vesting, token, owner, alice, allocation } =
        await loadFixture(deployFixture);

      const start = await freshStart();
      await vesting.createVesting(alice.address, allocation, start);

      await token
        .connect(owner)
        .transfer(await vesting.getAddress(), allocation);

      const later = BigInt(await time.latest()) + 100n;
      await expect(
        vesting.createVesting(alice.address, allocation, later)
      ).to.be.revertedWithCustomError(vesting, "ScheduleExists");
    });

    it("creates a valid schedule and emits VestingCreated", async function () {
      const { vesting, alice, allocation } = await loadFixture(deployFixture);
      const start = await freshStart();

      await expect(vesting.createVesting(alice.address, allocation, start))
        .to.emit(vesting, "VestingCreated")
        .withArgs(alice.address, allocation, start);

      const schedule = await vesting.schedules(alice.address);
      expect(schedule.beneficiary).to.equal(alice.address);
      expect(schedule.totalAmount).to.equal(allocation);
      expect(schedule.start).to.equal(start);
      expect(schedule.claimed).to.equal(0n);
      expect(await vesting.totalAllocated()).to.equal(allocation);
    });
  });

  describe("claim before / at cliff", function () {
    it("reverts when claiming before the cliff", async function () {
      const { vesting, alice, start } = await loadFixture(
        fundedScheduleFixture
      );

      // Ensure the claim tx itself lands strictly before the cliff.
      await time.increaseTo(start + CLIFF - 2n);
      await time.setNextBlockTimestamp(start + CLIFF - 1n);

      expect(await vesting.claimable(alice.address)).to.equal(0n);
      await expect(vesting.connect(alice).claim()).to.be.revertedWithCustomError(
        vesting,
        "NothingToClaim"
      );
    });

    it("allows claim at the cliff for 90/365 of allocation", async function () {
      const { vesting, token, alice, start, allocation } = await loadFixture(
        fundedScheduleFixture
      );

      const cliffTs = start + CLIFF;
      await time.increaseTo(cliffTs);

      const before = await token.balanceOf(alice.address);
      const tx = await vesting.connect(alice).claim();
      const expected = await claimedFromTx(tx, vesting, allocation, start);

      // At/after cliff: at least the cliff unlock (90/365), possibly +1s of linear.
      expect(expected).to.be.gte((allocation * CLIFF) / DURATION);
      expect(expected).to.be.lte((allocation * (CLIFF + 2n)) / DURATION);

      expect(await token.balanceOf(alice.address)).to.equal(before + expected);
      expect((await vesting.schedules(alice.address)).claimed).to.equal(
        expected
      );
      expect(await vesting.totalClaimed()).to.equal(expected);
    });
  });

  describe("partial and repeated claims", function () {
    it("supports partial then repeated claims without overpaying", async function () {
      const { vesting, token, alice, start, allocation } = await loadFixture(
        fundedScheduleFixture
      );

      const mid = start + 180n * 24n * 60n * 60n;
      await time.increaseTo(mid);

      const tx1 = await vesting.connect(alice).claim();
      const firstVested = await claimedFromTx(tx1, vesting, allocation, start);
      expect(await token.balanceOf(alice.address)).to.equal(firstVested);
      // At the claim block's timestamp, nothing further is claimable.
      expect(await vesting.claimable(alice.address)).to.equal(0n);

      const later = start + 270n * 24n * 60n * 60n;
      await time.increaseTo(later);

      const tx2 = await vesting.connect(alice).claim();
      const secondVested = await claimedFromTx(tx2, vesting, allocation, start);
      expect(await token.balanceOf(alice.address)).to.equal(secondVested);
      expect(await vesting.totalClaimed()).to.equal(secondVested);
      expect(secondVested).to.be.gt(firstVested);
    });
  });

  describe("full vesting", function () {
    it("vests the full allocation at and after the end of the schedule", async function () {
      const { vesting, token, alice, start, allocation } = await loadFixture(
        fundedScheduleFixture
      );

      await time.increaseTo(start + DURATION);

      expect(
        await vesting.vestedAmount(alice.address, await time.latest())
      ).to.equal(allocation);
      expect(await vesting.claimable(alice.address)).to.equal(allocation);

      await vesting.connect(alice).claim();
      expect(await token.balanceOf(alice.address)).to.equal(allocation);
      expect((await vesting.schedules(alice.address)).claimed).to.equal(
        allocation
      );

      await time.increase(30n * 24n * 60n * 60n);
      await expect(
        vesting.connect(alice).claim()
      ).to.be.revertedWithCustomError(vesting, "NothingToClaim");
    });
  });

  describe("multiple beneficiaries", function () {
    it("tracks independent schedules per beneficiary", async function () {
      const { vesting, token, alice, bob } = await loadFixture(deployFixture);

      const aliceAmount = ethers.parseEther("400");
      const bobAmount = ethers.parseEther("600");
      const start = await freshStart();

      await vesting.createVesting(alice.address, aliceAmount, start);
      await vesting.createVesting(bob.address, bobAmount, start);

      expect(await vesting.totalAllocated()).to.equal(
        aliceAmount + bobAmount
      );

      await time.increaseTo(start + DURATION);

      await vesting.connect(alice).claim();
      await vesting.connect(bob).claim();

      expect(await token.balanceOf(alice.address)).to.equal(aliceAmount);
      expect(await token.balanceOf(bob.address)).to.equal(bobAmount);
      expect(await token.balanceOf(await vesting.getAddress())).to.equal(0n);
    });
  });

  describe("insufficient funding", function () {
    it("reverts when creating a schedule larger than free balance", async function () {
      const { vesting, alice, allocation } = await loadFixture(deployFixture);
      const start = await freshStart();

      await expect(
        vesting.createVesting(alice.address, allocation + 1n, start)
      ).to.be.revertedWithCustomError(vesting, "InsufficientFunding");
    });

    it("reverts when free balance is exhausted by prior allocations", async function () {
      const { vesting, alice, bob, allocation } =
        await loadFixture(deployFixture);
      const start = await freshStart();

      await vesting.createVesting(alice.address, allocation, start);

      await expect(
        vesting.createVesting(bob.address, 1n, start)
      ).to.be.revertedWithCustomError(vesting, "InsufficientFunding");
    });
  });

  describe("reentrancy", function () {
    it("blocks reentrant claims via a malicious token callback", async function () {
      const [owner, attacker] = await ethers.getSigners();

      const ReentrantToken = await ethers.getContractFactory("ReentrantToken");
      const token = await ReentrantToken.deploy();
      await token.waitForDeployment();

      const TokenVesting = await ethers.getContractFactory("TokenVesting");
      const vesting = await TokenVesting.deploy(
        await token.getAddress(),
        owner.address
      );
      await vesting.waitForDeployment();

      const amount = ethers.parseEther("100");
      await token.mint(await vesting.getAddress(), amount);

      const start = await freshStart();
      await vesting.createVesting(attacker.address, amount, start);

      await token.setAttack(
        await vesting.getAddress(),
        attacker.address,
        true
      );

      await time.increaseTo(start + DURATION);

      await expect(
        vesting.connect(attacker).claim()
      ).to.be.revertedWithCustomError(vesting, "ReentrancyGuardReentrantCall");
    });
  });

  describe("token transfer & excess recovery edge cases", function () {
    it("reverts claim when caller has no schedule", async function () {
      const { vesting, stranger } = await loadFixture(deployFixture);

      await expect(
        vesting.connect(stranger).claim()
      ).to.be.revertedWithCustomError(vesting, "NoSchedule");
    });

    it("allows recovering only free (unreserved) tokens", async function () {
      const { vesting, token, owner, alice, allocation } =
        await loadFixture(deployFixture);
      const start = await freshStart();

      await vesting.createVesting(alice.address, allocation, start);

      await expect(
        vesting.recoverExcess(owner.address, 1n)
      ).to.be.revertedWithCustomError(vesting, "InsufficientExcess");

      const excess = ethers.parseEther("50");
      await token.connect(owner).transfer(await vesting.getAddress(), excess);

      expect(await vesting.freeBalance()).to.equal(excess);
      await expect(vesting.recoverExcess(owner.address, excess))
        .to.emit(vesting, "ExcessRecovered")
        .withArgs(owner.address, excess);

      expect(await vesting.reserved()).to.equal(allocation);
      expect(await token.balanceOf(await vesting.getAddress())).to.equal(
        allocation
      );
    });

    it("keeps solvency invariant after partial claims", async function () {
      const { vesting, token, alice, start, allocation } = await loadFixture(
        fundedScheduleFixture
      );

      await time.increaseTo(start + 200n * 24n * 60n * 60n);
      await vesting.connect(alice).claim();

      const balance = await token.balanceOf(await vesting.getAddress());
      const reserved = await vesting.reserved();
      expect(balance).to.equal(reserved);
      expect(balance).to.equal(
        (await vesting.totalAllocated()) - (await vesting.totalClaimed())
      );
      expect(allocation).to.equal(await vesting.totalAllocated());
    });

    it("rejects zero-address and zero-amount excess recovery", async function () {
      const { vesting, owner, allocation } = await loadFixture(deployFixture);

      await expect(
        vesting.recoverExcess(ethers.ZeroAddress, 1n)
      ).to.be.revertedWithCustomError(vesting, "ZeroAddress");

      await expect(
        vesting.recoverExcess(owner.address, 0n)
      ).to.be.revertedWithCustomError(vesting, "ZeroAmount");

      expect(await vesting.freeBalance()).to.equal(allocation);
    });
  });
});
