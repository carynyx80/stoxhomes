const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const NYC = ethers.encodeBytes32String("NYC");
const DAY = 86400;

describe("HousePerpExchange", () => {
  let owner, lp, alice, bob, keeper;
  let usdt, oracle, ex;

  beforeEach(async () => {
    [owner, lp, alice, bob, keeper] = await ethers.getSigners();
    usdt = await (await ethers.getContractFactory("MockUSDT")).deploy();
    oracle = await (await ethers.getContractFactory("HouseIndexOracle")).deploy(owner.address);
    ex = await (await ethers.getContractFactory("HousePerpExchange")).deploy(
      owner.address,
      await usdt.getAddress(),
      await oracle.getAddress()
    );

    await oracle.createFeed(NYC, E(300)); // index level 300
    // skewScale 1,000,000 units: 10k units of skew = 1% premium
    await ex.addMarket("NYC-USD", NYC, E(1_000_000), E(0.001), 30_000); // 0.1%/day max funding, skew <= 3x pool

    for (const s of [lp, alice, bob]) {
      await usdt.mint(s.address, E(10_000_000));
      await usdt.connect(s).approve(await ex.getAddress(), ethers.MaxUint256);
    }
    await ex.connect(lp).deposit(E(1_000_000), 0);
  });

  describe("oracle", () => {
    it("smooths a new print over the smoothing period", async () => {
      await oracle.pushIndex(NYC, E(330));
      expect(await oracle.price(NYC)).to.be.closeTo(E(300), E(0.01));
      await time.increase(3.5 * DAY);
      expect(await oracle.price(NYC)).to.be.closeTo(E(315), E(0.01));
      await time.increase(4 * DAY);
      expect(await oracle.price(NYC)).to.equal(E(330));
    });

    it("rejects prints that move more than the cap", async () => {
      await expect(oracle.pushIndex(NYC, E(400))).to.be.revertedWithCustomError(oracle, "MoveTooLarge");
    });

    it("only keepers can push", async () => {
      await expect(oracle.connect(alice).pushIndex(NYC, E(301))).to.be.revertedWithCustomError(oracle, "NotKeeper");
    });
  });

  describe("opening positions", () => {
    it("opens a 100x long", async () => {
      // 1000 units * ~300 = ~300k notional; margin 3,200 → ~94x after fee
      await ex.connect(alice).openPosition(0, E(1000), E(3200), E(301));
      const p = await ex.positions(0, alice.address);
      expect(p.size).to.equal(E(1000));
      expect(p.entryPrice).to.be.gt(E(300)); // paid a premium for adding long skew
      const m = await ex.getMarket(0);
      expect(m.skew).to.equal(E(1000));
    });

    it("rejects leverage above 100x", async () => {
      await expect(ex.connect(alice).openPosition(0, E(1000), E(2900), E(301))).to.be.revertedWithCustomError(
        ex,
        "LeverageTooHigh"
      );
    });

    it("enforces slippage protection", async () => {
      await expect(ex.connect(alice).openPosition(0, E(1000), E(10_000), E(300))).to.be.revertedWithCustomError(
        ex,
        "SlippageExceeded"
      );
    });

    it("caps skew relative to pool size", async () => {
      // pool 1M * 3x = 3M exposure ≈ 10k units at 300
      await expect(ex.connect(alice).openPosition(0, E(11_000), E(500_000), E(400))).to.be.revertedWithCustomError(
        ex,
        "SkewCapExceeded"
      );
    });

    it("refuses to trade on a stale oracle", async () => {
      await time.increase(46 * DAY);
      await expect(ex.connect(alice).openPosition(0, E(100), E(1000), E(301))).to.be.revertedWithCustomError(
        ex,
        "StaleOracle"
      );
    });

    it("a short reduces skew and pays a lower price", async () => {
      await ex.connect(alice).openPosition(0, E(1000), E(10_000), E(301));
      const quote = await ex.quoteFill(0, E(-1000));
      expect(quote).to.be.lt(await ex.markPrice(0));
      await ex.connect(bob).openPosition(0, E(-1000), E(10_000), E(299));
      expect((await ex.getMarket(0)).skew).to.equal(0);
    });
  });

  describe("PnL and closing", () => {
    it("long profits when the index rises", async () => {
      await ex.connect(alice).openPosition(0, E(1000), E(10_000), E(301));
      await oracle.pushIndex(NYC, E(303)); // +1%
      await time.increase(7 * DAY);
      const before = await usdt.balanceOf(alice.address);
      await ex.connect(alice).closePosition(0, 0);
      const gained = (await usdt.balanceOf(alice.address)) - before;
      // margin ~9,850 + ~3,000 pnl - fees - funding
      expect(gained).to.be.gt(E(12_000));
      expect(gained).to.be.lt(E(13_000));
    });

    it("short profits when the index falls", async () => {
      await ex.connect(bob).openPosition(0, E(-1000), E(10_000), 0);
      await oracle.pushIndex(NYC, E(297));
      await time.increase(7 * DAY);
      const before = await usdt.balanceOf(bob.address);
      await ex.connect(bob).closePosition(0, E(1_000));
      expect((await usdt.balanceOf(bob.address)) - before).to.be.gt(E(12_000));
    });

    it("pool value moves opposite to trader PnL", async () => {
      const nav0 = await ex.poolValue();
      await ex.connect(alice).openPosition(0, E(1000), E(10_000), E(301));
      await oracle.pushIndex(NYC, E(303));
      await time.increase(7 * DAY);
      expect(await ex.poolValue()).to.be.lt(nav0);
    });
  });

  describe("funding", () => {
    it("longs pay funding when the market is net long", async () => {
      await ex.connect(alice).openPosition(0, E(5000), E(50_000), E(310));
      await time.increase(10 * DAY);
      const info = await ex.positionInfo(0, alice.address);
      expect(info.funding).to.be.gt(0);
      // rate = 0.1%/day * 5000/1e6 = 0.0005%/day → 1.5M notional * 10 days ≈ 75
      expect(info.funding).to.be.closeTo(E(75), E(2));
    });
  });

  describe("liquidation", () => {
    it("liquidates a 100x long after a ~0.5% drop", async () => {
      await ex.connect(alice).openPosition(0, E(1000), E(3200), E(301));
      const info0 = await ex.positionInfo(0, alice.address);
      expect(info0.liquidatable).to.equal(false);
      const liqPrice = info0.liquidationPrice;
      expect(liqPrice).to.be.lt(E(300));
      expect(liqPrice).to.be.gt(E(297));

      await expect(ex.connect(bob).liquidate(0, alice.address)).to.be.revertedWithCustomError(ex, "NotLiquidatable");

      await oracle.pushIndex(NYC, E(297)); // -1%
      await time.increase(7 * DAY);
      expect((await ex.positionInfo(0, alice.address)).liquidatable).to.equal(true);

      const before = await usdt.balanceOf(bob.address);
      await ex.connect(bob).liquidate(0, alice.address);
      expect(await usdt.balanceOf(bob.address)).to.be.gte(before);
      expect((await ex.positions(0, alice.address)).size).to.equal(0);
      expect((await ex.getMarket(0)).skew).to.equal(0);
      expect(await ex.totalMargin()).to.equal(0);
    });

    it("liquidation price matches when the position becomes liquidatable", async () => {
      await ex.connect(alice).openPosition(0, E(1000), E(3200), E(301));
      const liq = (await ex.positionInfo(0, alice.address)).liquidationPrice;
      // push index a hair above and below the computed liq price
      await oracle.setParams(3600, 1000);
      await oracle.pushIndex(NYC, liq + E(0.01));
      await time.increase(3600);
      expect((await ex.positionInfo(0, alice.address)).liquidatable).to.equal(false);
      await oracle.pushIndex(NYC, liq - E(0.01));
      await time.increase(3600);
      expect((await ex.positionInfo(0, alice.address)).liquidatable).to.equal(true);
    });

    it("smoothing delays the liquidation instead of a one-block cliff", async () => {
      await ex.connect(alice).openPosition(0, E(1000), E(3200), E(301));
      await oracle.pushIndex(NYC, E(297));
      expect((await ex.positionInfo(0, alice.address)).liquidatable).to.equal(false);
      // trader has time to add margin before the price fully converges
      await ex.connect(alice).addMargin(0, E(5000));
      await time.increase(7 * DAY);
      expect((await ex.positionInfo(0, alice.address)).liquidatable).to.equal(false);
    });
  });

  describe("margin management", () => {
    it("cannot remove margin past 100x", async () => {
      await ex.connect(alice).openPosition(0, E(1000), E(10_000), E(301));
      await expect(ex.connect(alice).removeMargin(0, E(8000))).to.be.revertedWithCustomError(ex, "LeverageTooHigh");
      await ex.connect(alice).removeMargin(0, E(5000));
    });
  });

  describe("liquidity pool", () => {
    it("LP earns trading fees", async () => {
      await ex.connect(alice).openPosition(0, E(1000), E(10_000), E(301));
      await ex.connect(alice).closePosition(0, 0);
      expect(await ex.poolValue()).to.be.gt(E(1_000_000));
      const s = await ex.shares(lp.address);
      await ex.connect(lp).requestWithdraw(s);
      await time.increase(DAY);
      const before = await usdt.balanceOf(lp.address);
      await ex.connect(lp).withdraw(s, 0);
      expect((await usdt.balanceOf(lp.address)) - before).to.be.gt(E(1_000_000));
    });

    it("blocks withdrawals that would breach the skew cap", async () => {
      await ex.connect(alice).openPosition(0, E(9000), E(100_000), E(320));
      const s = await ex.shares(lp.address);
      await ex.connect(lp).requestWithdraw(s / 2n);
      await time.increase(DAY);
      await expect(ex.connect(lp).withdraw(s / 2n, 0)).to.be.revertedWithCustomError(ex, "InsufficientLiquidity");
    });
  });
});
