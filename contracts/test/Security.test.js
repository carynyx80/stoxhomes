const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Adversarial security review POCs for HouseDEX.
// "POC: ..." tests assert that a bad outcome actually happens on the current code.
// "defence: ..." tests show a protection that works.

const E = (n) => ethers.parseEther(String(n));
const F = (x) => Number(ethers.formatEther(x));
const NYC = ethers.encodeBytes32String("NYC");
const DAY = 86400;

describe("Security review", () => {
  let owner, lp, alice, bob, carol, dave, keeper;
  let usdt, oracle, ex, exAddr;

  async function deploy(seed) {
    [owner, lp, alice, bob, carol, dave, keeper] = await ethers.getSigners();
    usdt = await (await ethers.getContractFactory("MockUSDT")).deploy();
    oracle = await (await ethers.getContractFactory("HouseIndexOracle")).deploy(owner.address);
    ex = await (await ethers.getContractFactory("HousePerpExchange")).deploy(
      owner.address,
      await usdt.getAddress(),
      await oracle.getAddress()
    );
    exAddr = await ex.getAddress();
    await oracle.createFeed(NYC, E(300));
    await ex.addMarket("NYC-USD", NYC, E(1_000_000), E(0.001), 30_000);
    for (const s of [lp, alice, bob, carol, dave]) {
      await usdt.mint(s.address, E(10_000_000));
      await usdt.connect(s).approve(exAddr, ethers.MaxUint256);
    }
    if (seed > 0) await ex.connect(lp).deposit(E(seed), 0);
  }

  const bal = async (a) => usdt.balanceOf(a.address);
  const arm = async (s, sh) => {
    // A withdrawal request does not lock shares, so it can be kept armed permanently.
    await ex.connect(s).requestWithdraw(sh ?? (await ex.shares(s.address)));
    await time.increase(Number(await ex.withdrawCooldown()) + 1);
  };
  const lpValue = async (a) => ((await ex.shares(a.address)) * (await ex.poolValue())) / (await ex.totalShares());

  describe("critical / high", () => {
    beforeEach(async () => deploy(1_000_000));

    it("FIXED: C1 - opening after a push fills at the published target, so the phase-in is no free option", async () => {
      const t = (await time.latest()) + 3600;
      await oracle.schedulePrint(NYC, t);
      await expect(ex.connect(alice).openPosition(0, E(9000), E(30_000), E(400))).to.be.revertedWithCustomError(ex, "CloseOnly");
      await time.increaseTo(t);
      await oracle.pushIndex(NYC, E(330));
      // The quote for an open now uses max(smoothed, target) for longs.
      expect(await ex.quoteOpenFill(0, E(9000))).to.be.gte(E(330));
      expect(await ex.quoteFill(0, E(9000))).to.be.lt(E(305)); // closes/reductions still use smoothed
      // The old 30k-margin attack is now rejected outright (fills at ~330, marked at ~300).
      await expect(ex.connect(alice).openPosition(0, E(9000), E(30_000), E(400))).to.be.reverted;
      const before = await bal(alice);
      await ex.connect(alice).openPosition(0, E(9000), E(400_000), E(400));
      await time.increase(7 * DAY);
      await ex.connect(alice).closePosition(0, 0);
      const profit = F((await bal(alice)) - before);
      console.log(`      alice profit ${profit.toFixed(0)} USDT (was +268k); pool NAV ${F(await ex.poolValue()).toFixed(0)}`);
      expect(profit).to.be.lt(0);
      expect(await ex.poolValue()).to.be.gt(E(1_000_000));
    });

    it("FIXED: H1 - partial close cannot realize profit beyond pool cash; NAV=0 deposits revert", async () => {
      await deploy(100_000);
      await ex.connect(alice).openPosition(0, E(950), E(20_000), E(310));
      await ex.connect(bob).openPosition(0, E(10), E(300_000), E(310));
      let p = 300;
      for (let i = 0; i < 5; i++) {
        p = Math.floor(p * 1.1);
        await oracle.pushIndex(NYC, E(p));
        await time.increase(7 * DAY);
      }
      expect(await ex.poolValue()).to.equal(0);
      await expect(ex.connect(alice).closePosition(0, 0)).to.be.revertedWithCustomError(ex, "InsufficientLiquidity");
      await expect(ex.connect(alice).modifyPosition(0, E(-940), 0)).to.be.revertedWithCustomError(ex, "InsufficientLiquidity");
      expect(await usdt.balanceOf(exAddr)).to.be.gte(await ex.totalMargin()); // margins stay backed
      await expect(ex.connect(carol).deposit(E(100_000), 0)).to.be.revertedWithCustomError(ex, "PoolInsolvent");
    });

    it("FIXED: H1 - global open-interest cap across markets", async () => {
      const LA = ethers.encodeBytes32String("LA");
      await oracle.createFeed(LA, E(300));
      await ex.addMarket("LA-USD", LA, E(1_000_000), E(0.001), 30_000);
      await ex.setMaxTotalSkew(40_000); // 4x pool across all markets
      await ex.connect(alice).openPosition(0, E(9000), E(100_000), E(320)); // 2.7M
      await expect(ex.connect(bob).openPosition(1, E(-5000), E(100_000), 0)).to.be.revertedWithCustomError(ex, "SkewCapExceeded");
      await ex.connect(bob).openPosition(1, E(-3000), E(100_000), 0); // 3.6M total
    });

    it("FIXED: H2 - LP sandwich: close-out marking, escrowed requests and min(value at request, now)", async () => {
      await ex.connect(carol).deposit(E(1_000_000), 0);
      await arm(carol);
      expect(await ex.shares(carol.address)).to.equal(0); // escrowed
      await expect(ex.connect(carol).requestWithdraw(1n)).to.be.revertedWithCustomError(ex, "WithdrawPending");
      const start = (await bal(carol)) + (await bal(dave));
      const nav0 = await ex.poolValue();
      await ex.connect(dave).openPosition(0, E(10_000), E(100_000), E(310));
      const navInflated = await ex.poolValue();
      // only the fee (net of protocol share) is added, not size * premium
      expect(navInflated - nav0).to.be.lt(E(2_000));
      await ex.connect(carol).withdraw(await ex.pendingWithdrawShares(carol.address), 0);
      await ex.connect(dave).closePosition(0, 0);
      const gain = F((await bal(carol)) + (await bal(dave)) - start) - 1_000_000;
      const lpLeft = F(await lpValue(lp));
      console.log(`      attacker net ${gain.toFixed(0)}; honest LP 1,000,000 -> ${lpLeft.toFixed(0)}`);
      expect(gain).to.be.lt(0);
      expect(lpLeft).to.be.gt(999_999);
    });
  });

  describe("medium", () => {
    it("FIXED: M1 - first-depositor inflation is unprofitable and the victim is protected by minSharesOut", async () => {
      await deploy(0);
      await ex.connect(carol).deposit(1n, 0);
      const cs = await ex.shares(carol.address);
      await arm(carol, cs);
      await usdt.connect(carol).transfer(exAddr, E(1000));
      // victim quoting 1999 shares-per-USDT-ish expectation reverts instead of getting dust
      await expect(ex.connect(alice).deposit(E(1999), E(1999))).to.be.revertedWithCustomError(ex, "SlippageExceeded");
      await ex.connect(alice).deposit(E(1999), 0);
      expect(await ex.shares(alice.address)).to.be.gt(1n);
      const c0 = await bal(carol);
      await ex.connect(carol).withdraw(cs, 0);
      const carolOut = F((await bal(carol)) - c0);
      console.log(`      carol spent 1000 + 1 wei, withdrew ${carolOut.toFixed(6)}`);
      expect(carolOut).to.be.lt(1); // attacker loses the donation
    });

    it("FIXED: M2 - underwater losses are not credited beyond margin; bad-debt liquidations pay a minimum reward", async () => {
      await deploy(1_000_000);
      await ex.connect(alice).openPosition(0, E(1000), E(3200), E(301));
      await oracle.pushIndex(NYC, E(270));
      await time.increase(2 * DAY);
      const info = await ex.positionInfo(0, alice.address);
      expect(info.equity).to.be.lt(0);
      const navBefore = await ex.poolValue();
      await ex.connect(bob).liquidate(0, alice.address);
      const navAfter = await ex.poolValue();
      expect((await bal(bob)) - E(10_000_000)).to.equal(await ex.MIN_LIQUIDATION_REWARD());
      const drop = F(navBefore - navAfter);
      console.log(`      equity ${F(info.equity).toFixed(0)}; poolValue drops only ${drop.toFixed(2)} (the liquidator reward)`);
      expect(drop).to.be.closeTo(5, 1);
    });

    it("FIXED: M3 - smoothing period is fixed per print and cannot be set to 0", async () => {
      await deploy(1_000_000);
      await oracle.pushIndex(NYC, E(330));
      await time.increase(DAY);
      await ex.connect(alice).openPosition(0, E(-1000), E(3300), 0);
      const p0 = await oracle.price(NYC);
      await expect(oracle.setParams(0, 1000)).to.be.revertedWithCustomError(oracle, "BadParam");
      await oracle.setParams(3600, 1000);
      expect(await oracle.price(NYC)).to.be.closeTo(p0, E(0.01)); // in-flight print unaffected
      expect((await ex.positionInfo(0, alice.address)).liquidatable).to.equal(false);
      await oracle.setParams(60 * DAY, 1000);
      expect(await oracle.price(NYC)).to.be.closeTo(p0, E(0.01));
    });

    it("POC: poolValue ignores accrued funding; it is recognised only at settlement (step change in share price)", async () => {
      await deploy(1_000_000);
      await ex.updateMarket(0, true, E(1_000_000), E(0.1), 30_000); // high funding to make it visible
      await ex.connect(alice).openPosition(0, E(10_000), E(200_000), E(310));
      const nav0 = await ex.poolValue();
      await time.increase(30 * DAY);
      const nav1 = await ex.poolValue();
      const owed = (await ex.positionInfo(0, alice.address)).funding;
      expect(nav1).to.equal(nav0); // 30 days of funding receivable not in NAV
      await ex.connect(alice).closePosition(0, 0);
      const nav2 = await ex.poolValue();
      console.log(`      funding owed ${F(owed).toFixed(0)} not in NAV; NAV jumps ${F(nav2 - nav1).toFixed(0)} at close`);
      expect(owed).to.be.gt(E(8000));
    });
  });

  describe("low", () => {
    it("FIXED: L2 - close-only expires 24h after a scheduled print that never arrives", async () => {
      await deploy(1_000_000);
      const t = (await time.latest()) + 3600;
      await oracle.schedulePrint(NYC, t);
      await time.increaseTo(t + 3600);
      expect(await ex.isCloseOnly(0)).to.equal(true);
      await time.increase(30 * DAY);
      expect(await ex.isCloseOnly(0)).to.equal(false);
      await ex.connect(alice).openPosition(0, E(10), E(1000), E(310));
    });
  });

  describe("defences verified", () => {
    beforeEach(async () => deploy(1_000_000));

    it("defence: consecutive pushes cannot accelerate the move (cap is measured from the current smoothed price)", async () => {
      await oracle.pushIndex(NYC, E(330));
      await expect(oracle.pushIndex(NYC, E(363))).to.be.revertedWithCustomError(oracle, "MoveTooLarge");
      await oracle.pushIndex(NYC, E(330)); // re-push restarts phase from current: no jump
      expect(await oracle.price(NYC)).to.be.closeTo(E(300), E(0.01));
    });

    it("defence: skew pushing does not change others' liquidation (marked at index)", async () => {
      await ex.connect(alice).openPosition(0, E(1000), E(3200), E(301));
      const before = await ex.positionInfo(0, alice.address);
      await ex.connect(bob).openPosition(0, E(-9000), E(300_000), 0);
      const after = await ex.positionInfo(0, alice.address);
      expect(after.equity).to.be.closeTo(before.equity, E(0.01)); // only 1s of funding
      expect(after.liquidatable).to.equal(false);
      await expect(ex.liquidate(0, alice.address)).to.be.revertedWithCustomError(ex, "NotLiquidatable");
    });

    it("defence: open/close round trip and long+short self-trade lose money", async () => {
      const s = (await bal(alice)) + (await bal(bob));
      await ex.connect(alice).openPosition(0, E(5000), E(100_000), E(310));
      await ex.connect(bob).openPosition(0, E(-5000), E(100_000), 0);
      await ex.connect(alice).closePosition(0, 0);
      await ex.connect(bob).closePosition(0, E(1000));
      expect((await bal(alice)) + (await bal(bob))).to.be.lt(s);
      const a = await bal(alice);
      await ex.connect(alice).openPosition(0, E(5000), E(100_000), E(310));
      await ex.connect(alice).closePosition(0, 0);
      expect(await bal(alice)).to.be.lt(a);
    });

    it("defence: splitting a trade gives the same fill cost (linear premium, no rounding gain)", async () => {
      const one = await ex.quoteFill(0, E(4000));
      await ex.connect(alice).openPosition(0, E(2000), E(100_000), E(310));
      const f1 = (await ex.positions(0, alice.address)).entryPrice;
      await ex.connect(bob).openPosition(0, E(2000), E(100_000), E(310));
      const f2 = (await ex.positions(0, bob.address)).entryPrice;
      expect((f1 + f2) / 2n).to.be.closeTo(one, 10n);
    });

    it("defence: cannot open an immediately-liquidatable position; removeMargin cannot exceed margin or 100x", async () => {
      // skewScale 500k: 10k units pay ~1% avg premium; at ~99x, equity at index < maintenance
      await ex.updateMarket(0, true, E(500_000), E(0.001), 30_000);
      await expect(ex.connect(alice).openPosition(0, E(10_000), E(31_900), E(310))).to.be.revertedWithCustomError(
        ex,
        "WouldBeLiquidatable"
      );
      await ex.connect(alice).openPosition(0, E(1000), E(10_000), E(301));
      await expect(ex.connect(alice).removeMargin(0, E(10_000))).to.be.reverted; // underflow / leverage
      await expect(ex.connect(alice).removeMargin(0, E(8000))).to.be.revertedWithCustomError(ex, "LeverageTooHigh");
      await oracle.pushIndex(NYC, E(330));
      await time.increase(7 * DAY);
      // unrealized profit cannot be withdrawn through removeMargin (margin underflows)
      await expect(ex.connect(alice).removeMargin(0, E(20_000))).to.be.reverted;
    });

    it("defence: sumSizeEntry has no rounding drift across odd-sized round trips", async () => {
      const sizes = ["1.000000000000000001", "-7.3333333333333", "123.456789", "-0.000000001"];
      const signers = [alice, bob, carol, dave];
      for (let i = 0; i < 4; i++) {
        const sz = ethers.parseEther(sizes[i]);
        await ex.connect(signers[i]).openPosition(0, sz, E(1000), sz > 0n ? E(310) : 0);
      }
      for (let i = 0; i < 4; i++) await ex.connect(signers[i]).closePosition(0, sizes[i].startsWith("-") ? E(400) : 0);
      const m = await ex.getMarket(0);
      expect(m.skew).to.equal(0);
      expect(m.sumSizeEntry).to.equal(0);
      expect(await ex.totalMargin()).to.equal(0);
    });

    it("defence: stale oracle blocks opens but not closes or liquidations", async () => {
      await ex.connect(alice).openPosition(0, E(100), E(10_000), E(301));
      await time.increase(46 * DAY);
      await expect(ex.connect(bob).openPosition(0, E(100), E(10_000), E(301))).to.be.revertedWithCustomError(
        ex,
        "StaleOracle"
      );
      await ex.connect(alice).closePosition(0, 0);
    });

    it("defence: access control on admin/keeper functions", async () => {
      await expect(ex.connect(alice).setFees(5, 50, 20, 1)).to.be.revertedWithCustomError(ex, "OwnableUnauthorizedAccount");
      await expect(ex.connect(alice).addMarket("X", NYC, 1, 1, 1)).to.be.revertedWithCustomError(ex, "OwnableUnauthorizedAccount");
      await expect(ex.connect(alice).updateMarket(0, false, 1, 1, 1)).to.be.revertedWithCustomError(ex, "OwnableUnauthorizedAccount");
      await expect(oracle.connect(alice).setParams(0, 1000)).to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
      await expect(oracle.connect(alice).setKeeper(alice.address, true)).to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
      await expect(oracle.connect(alice).pushIndex(NYC, E(301))).to.be.revertedWithCustomError(oracle, "NotKeeper");
      await expect(ex.connect(alice).liquidate(0, bob.address)).to.be.revertedWithCustomError(ex, "NoPosition");
    });

    it("defence: liquidation reward never exceeds equity; remaining equity goes to the pool", async () => {
      await ex.connect(alice).openPosition(0, E(1000), E(3200), E(301));
      await oracle.pushIndex(NYC, E(297));
      await time.increase(7 * DAY);
      const info = await ex.positionInfo(0, alice.address);
      expect(info.liquidatable).to.equal(true);
      const b0 = await bal(bob);
      await ex.connect(bob).liquidate(0, alice.address);
      const reward = (await bal(bob)) - b0;
      expect(reward).to.be.lte(info.equity > 0n ? info.equity : await ex.MIN_LIQUIDATION_REWARD()); // M2: minimum reward on bad debt
      expect(await ex.totalMargin()).to.equal(0);
    });
  });
});
