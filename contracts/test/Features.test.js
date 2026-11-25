const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const NYC = ethers.encodeBytes32String("NYC");
const LA = ethers.encodeBytes32String("LA");
const DAY = 86400;
const HOUR = 3600;

async function eventArgs(ex, tx, name) {
  const rc = await tx.wait();
  for (const log of rc.logs) {
    try {
      const parsed = ex.interface.parseLog(log);
      if (parsed && parsed.name === name) return parsed.args;
    } catch (_) {}
  }
  throw new Error(`no ${name} event`);
}

describe("HousePerpExchange features", () => {
  let owner, lp, alice, bob, carol, treasury;
  let usdt, oracle, ex;

  beforeEach(async () => {
    [owner, lp, alice, bob, carol, treasury] = await ethers.getSigners();
    usdt = await (await ethers.getContractFactory("MockUSDT")).deploy();
    oracle = await (await ethers.getContractFactory("HouseIndexOracle")).deploy(owner.address);
    ex = await (await ethers.getContractFactory("HousePerpExchange")).deploy(
      owner.address,
      await usdt.getAddress(),
      await oracle.getAddress()
    );
    await oracle.createFeed(NYC, E(300));
    await oracle.createFeed(LA, E(440));
    await ex.addMarket("NYC-USD", NYC, E(1_000_000), E(0.001), 30_000);
    await ex.addMarket("LA-USD", LA, E(1_000_000), E(0.001), 30_000);
    for (const s of [lp, alice, bob, carol]) {
      await usdt.mint(s.address, E(10_000_000));
      await usdt.connect(s).approve(await ex.getAddress(), ethers.MaxUint256);
    }
    await ex.connect(lp).deposit(E(1_000_000), 0);
  });

  describe("modifyPosition", () => {
    it("increase uses size-weighted average entry and keeps sumSizeEntry exact", async () => {
      await ex.connect(alice).openPosition(0, E(1000), E(20_000), E(310));
      const p0 = await ex.positions(0, alice.address);
      await oracle.setParams(3600, 1000);
      await oracle.pushIndex(NYC, E(306));
      await time.increase(3600);
      const fill = await ex.quoteFill(0, E(500));
      const tx = await ex.connect(alice).modifyPosition(0, E(500), E(320));
      const ev = await eventArgs(ex, tx, "PositionModified");
      expect(ev.fillPrice).to.equal(fill);
      const p1 = await ex.positions(0, alice.address);
      expect(p1.size).to.equal(E(1500));
      const expected = (p0.entryPrice * E(1000) + fill * E(500)) / E(1500);
      expect(p1.entryPrice).to.be.closeTo(expected, 10n);
      expect(ev.newSize).to.equal(E(1500));
      expect(ev.newEntryPrice).to.equal(p1.entryPrice);
      expect(ev.newMargin).to.equal(p1.margin);
      expect(ev.realizedPnl).to.equal(0);
      // margin reduced by the fee
      expect(p1.margin).to.equal(p0.margin - ev.fee - ev.fundingSettled);
      const m = await ex.getMarket(0);
      expect(m.sumSizeEntry).to.equal(p1.sizeEntry);
      expect(m.skew).to.equal(E(1500));
      expect(m.longSize).to.equal(E(1500));
    });

    it("partial close realizes PnL proportionally into margin", async () => {
      await ex.connect(alice).openPosition(0, E(1000), E(20_000), E(310));
      await oracle.setParams(3600, 1000);
      await oracle.pushIndex(NYC, E(303));
      await time.increase(3600);
      const p0 = await ex.positions(0, alice.address);
      const balBefore = await usdt.balanceOf(alice.address);
      const tx = await ex.connect(alice).modifyPosition(0, E(-400), 0);
      const ev = await eventArgs(ex, tx, "PositionModified");
      // realized = 400 * fill - 40% of entry notional
      const expectedPnl = (E(400) * ev.fillPrice) / E(1) - (p0.sizeEntry * 400n) / 1000n;
      expect(ev.realizedPnl).to.equal(expectedPnl);
      expect(ev.realizedPnl).to.be.gt(E(1000)); // ~400 * (303 - 300.15)
      const p1 = await ex.positions(0, alice.address);
      expect(p1.size).to.equal(E(600));
      expect(p1.margin).to.equal(p0.margin + ev.realizedPnl - ev.fundingSettled - ev.fee);
      expect(p1.entryPrice).to.be.closeTo(p0.entryPrice, 10n); // entry unchanged on reduce
      expect(await usdt.balanceOf(alice.address)).to.equal(balBefore); // nothing paid out
      const m = await ex.getMarket(0);
      expect(m.sumSizeEntry).to.equal(p1.sizeEntry);
      expect(m.skew).to.equal(E(600));
      expect(await ex.totalMargin()).to.equal(p1.margin);
    });

    it("reverts on flip-through-zero; reducing to exactly zero closes", async () => {
      await ex.connect(bob).openPosition(0, E(-1000), E(20_000), 0);
      await expect(ex.connect(bob).modifyPosition(0, E(1001), E(400))).to.be.revertedWithCustomError(
        ex,
        "FlipNotAllowed"
      );
      await expect(ex.connect(bob).modifyPosition(0, E(1000), E(400))).to.emit(ex, "PositionClosed");
      expect((await ex.positions(0, bob.address)).size).to.equal(0);
      const m = await ex.getMarket(0);
      expect(m.skew).to.equal(0);
      expect(m.sumSizeEntry).to.equal(0);
      expect(m.shortSize).to.equal(0);
      expect(await ex.totalMargin()).to.equal(0);
    });

    it("increase enforces leverage, slippage and needs a position", async () => {
      await expect(ex.connect(alice).modifyPosition(0, E(10), E(400))).to.be.revertedWithCustomError(ex, "NoPosition");
      await ex.connect(alice).openPosition(0, E(1000), E(3200), E(301));
      await expect(ex.connect(alice).modifyPosition(0, E(100), E(400))).to.be.revertedWithCustomError(
        ex,
        "LeverageTooHigh"
      );
      await ex.connect(alice).addMargin(0, E(1000));
      await expect(ex.connect(alice).modifyPosition(0, E(100), E(300))).to.be.revertedWithCustomError(
        ex,
        "SlippageExceeded"
      );
      await ex.connect(alice).modifyPosition(0, E(100), E(400));
      expect((await ex.positions(0, alice.address)).size).to.equal(E(1100));
    });

    it("settles funding into margin on modify", async () => {
      await ex.connect(alice).openPosition(0, E(5000), E(100_000), E(310));
      await time.increase(10 * DAY);
      await oracle.pushIndex(NYC, E(300)); // keep oracle fresh, same price
      const tx = await ex.connect(alice).modifyPosition(0, E(-1000), 0);
      const ev = await eventArgs(ex, tx, "PositionModified");
      expect(ev.fundingSettled).to.be.closeTo(E(75), E(2));
      expect((await ex.positionInfo(0, alice.address)).funding).to.equal(0);
    });
  });

  describe("close-only window", () => {
    it("blocks opens/increases before a scheduled print until it is pushed", async () => {
      await ex.connect(alice).openPosition(0, E(1000), E(20_000), E(310));
      await ex.connect(bob).openPosition(0, E(-200), E(5_000), 0);
      const printAt = (await time.latest()) + 2 * DAY;
      await expect(oracle.schedulePrint(NYC, printAt)).to.emit(oracle, "CloseOnlyScheduled").withArgs(NYC, printAt);
      expect(await ex.isCloseOnly(0)).to.equal(false);
      await time.increaseTo(printAt - 6 * HOUR);
      expect(await ex.isCloseOnly(0)).to.equal(true);
      expect(await ex.isCloseOnly(1)).to.equal(false);

      await expect(ex.connect(carol).openPosition(0, E(10), E(1000), E(310))).to.be.revertedWithCustomError(
        ex,
        "CloseOnly"
      );
      await expect(ex.connect(alice).modifyPosition(0, E(10), E(310))).to.be.revertedWithCustomError(ex, "CloseOnly");
      // other markets unaffected
      await ex.connect(carol).openPosition(1, E(10), E(1000), E(450));
      // reduce, add margin, close still work
      await ex.connect(alice).modifyPosition(0, E(-100), 0);
      await ex.connect(alice).addMargin(0, E(100));
      await ex.connect(bob).closePosition(0, E(400));

      // still close-only after the scheduled time if the print is late
      await time.increaseTo(printAt + HOUR);
      expect(await ex.isCloseOnly(0)).to.equal(true);
      await oracle.pushIndex(NYC, E(301));
      expect(await ex.isCloseOnly(0)).to.equal(false);
      expect(await oracle.scheduledPrint(NYC)).to.equal(0);
      await ex.connect(carol).openPosition(0, E(10), E(1000), E(310));
    });

    it("liquidations work during close-only", async () => {
      await ex.connect(alice).openPosition(0, E(1000), E(3200), E(301));
      await oracle.setParams(3600, 1000);
      await oracle.pushIndex(NYC, E(297));
      await time.increase(3600);
      await oracle.schedulePrint(NYC, (await time.latest()) + HOUR);
      expect(await ex.isCloseOnly(0)).to.equal(true);
      await ex.connect(bob).liquidate(0, alice.address);
      expect((await ex.positions(0, alice.address)).size).to.equal(0);
    });

    it("window length is configurable and scheduling is keeper-only", async () => {
      await expect(oracle.connect(alice).schedulePrint(NYC, (await time.latest()) + DAY)).to.be.revertedWithCustomError(
        oracle,
        "NotKeeper"
      );
      await ex.setPoolParams(HOUR, DAY, 3 * DAY);
      await oracle.schedulePrint(NYC, (await time.latest()) + 2 * HOUR);
      expect(await ex.isCloseOnly(0)).to.equal(false);
      await time.increase(HOUR + 1);
      expect(await ex.isCloseOnly(0)).to.equal(true);
      await oracle.schedulePrint(NYC, 0); // cancel
      expect(await ex.isCloseOnly(0)).to.equal(false);
    });
  });

  describe("withdrawal cooldown", () => {
    it("requires a request and a 24h wait", async () => {
      const s = await ex.shares(lp.address);
      await expect(ex.connect(lp).withdraw(s, 0)).to.be.revertedWithCustomError(ex, "ExceedsPending");
      const tx = await ex.connect(lp).requestWithdraw(s / 2n);
      const unlock = BigInt((await time.latest()) + DAY);
      await expect(tx).to.emit(ex, "WithdrawRequested").withArgs(lp.address, s / 2n, unlock);
      const pw = await ex.pendingWithdrawal(lp.address);
      expect(pw.pendingShares).to.equal(s / 2n);
      expect(pw.unlockTime).to.equal(unlock);
      expect(pw.expiresAt).to.equal(unlock + BigInt(3 * DAY));
      expect(pw.estimatedAmount).to.be.closeTo(E(500_000), E(0.001));
      await expect(ex.connect(lp).withdraw(s / 2n, 0)).to.be.revertedWithCustomError(ex, "WithdrawLocked");
      await time.increase(DAY);
      await expect(ex.connect(lp).withdraw(s, 0)).to.be.revertedWithCustomError(ex, "ExceedsPending");
      await expect(ex.connect(lp).withdraw(s / 4n, 0)).to.emit(ex, "Withdraw");
      expect(await ex.pendingWithdrawShares(lp.address)).to.equal(s / 4n);
      await ex.connect(lp).withdraw(s / 4n, 0);
      expect(await ex.shares(lp.address)).to.equal(s / 2n);
      expect((await ex.pendingWithdrawal(lp.address)).pendingShares).to.equal(0);
    });

    it("requests expire after the window and can be cancelled", async () => {
      const s = await ex.shares(lp.address);
      await ex.connect(lp).requestWithdraw(s);
      await time.increase(DAY + 3 * DAY + 1);
      await expect(ex.connect(lp).withdraw(s, 0)).to.be.revertedWithCustomError(ex, "WithdrawExpired");
      await expect(ex.connect(lp).cancelWithdraw()).to.emit(ex, "WithdrawCancelled").withArgs(lp.address, s);
      expect(await ex.pendingWithdrawShares(lp.address)).to.equal(0);
      await expect(ex.connect(lp).requestWithdraw(s + 1n)).to.be.revertedWithCustomError(ex, "ExceedsPending");
    });

    it("cooldown is configurable", async () => {
      await ex.setPoolParams(6 * HOUR, HOUR, 0);
      const s = await ex.shares(lp.address);
      await ex.connect(lp).requestWithdraw(s);
      await time.increase(HOUR);
      await ex.connect(lp).withdraw(s, 0);
      expect(await ex.totalShares()).to.equal(0);
    });
  });

  describe("protocol fees", () => {
    it("splits 10% of trading fees to the fee recipient and excludes them from pool value", async () => {
      await ex.setProtocolFee(treasury.address, 1000);
      const tx = await ex.connect(alice).openPosition(0, E(1000), E(10_000), E(301));
      const { fee } = await eventArgs(ex, tx, "PositionOpened");
      expect(await ex.protocolFeesAccrued()).to.equal(fee / 10n);
      // pool value = 1M + 90% of fee (trader pnl at index ~ -premium paid)
      const m = await ex.getMarket(0);
      // pool marks trader PnL at the close-out price (H2 fix)
      const premium = (m.skew * E(1)) / E(1_000_000) / 2n;
      const closeOut = (E(300) * (E(1) + premium)) / E(1);
      const traderPnl = (m.skew * closeOut) / E(1) - m.sumSizeEntry;
      expect(await ex.poolValue()).to.equal(E(1_000_000) + fee - fee / 10n - traderPnl);
      expect(await ex.poolCash()).to.equal(E(1_000_000) + fee - fee / 10n);

      await ex.connect(alice).closePosition(0, 0);
      const accrued = await ex.protocolFeesAccrued();
      expect(accrued).to.be.gt(fee / 10n);
      await expect(ex.connect(bob).claimProtocolFees())
        .to.emit(ex, "ProtocolFeesClaimed")
        .withArgs(treasury.address, accrued);
      expect(await usdt.balanceOf(treasury.address)).to.equal(accrued);
      expect(await ex.protocolFeesAccrued()).to.equal(0);
      await expect(ex.claimProtocolFees()).to.be.revertedWithCustomError(ex, "ZeroAmount");
    });

    it("defaults to the owner and 10%, owner-only setter", async () => {
      expect(await ex.feeRecipient()).to.equal(owner.address);
      expect(await ex.protocolFeeShareBps()).to.equal(1000);
      await expect(ex.connect(alice).setProtocolFee(alice.address, 0)).to.be.revertedWithCustomError(
        ex,
        "OwnableUnauthorizedAccount"
      );
      await expect(ex.setProtocolFee(treasury.address, 10_001)).to.be.revertedWithCustomError(ex, "BadParam");
    });
  });

  describe("getAllMarkets", () => {
    it("returns index, mark, funding and close-only per market", async () => {
      await ex.connect(alice).openPosition(0, E(5000), E(100_000), E(310));
      await oracle.schedulePrint(LA, (await time.latest()) + HOUR);
      const all = await ex.getAllMarkets();
      expect(all.length).to.equal(2);
      expect(all[0].name).to.equal("NYC-USD");
      expect(all[0].indexPrice).to.equal(await ex.indexPrice(0));
      expect(all[0].markPrice).to.equal(await ex.markPrice(0));
      expect(all[0].fundingRatePerDay).to.equal(await ex.fundingRatePerDay(0));
      expect(all[0].fundingRatePerDay).to.be.gt(0);
      expect(all[0].skew).to.equal(E(5000));
      expect(all[0].closeOnly).to.equal(false);
      expect(all[1].oracleId).to.equal(LA);
      expect(all[1].indexPrice).to.equal(E(440));
      expect(all[1].closeOnly).to.equal(true);
      expect(all[1].scheduledPrint).to.be.gt(0);
    });
  });

  describe("invariants under random activity", () => {
    it("balance == margin + pool cash + protocol fees, skew == sum of sizes", async function () {
      this.timeout(300_000);
      let seed = 0xc0ffee;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      const traders = [alice, bob, carol];
      const ids = [NYC, LA];
      await oracle.setParams(2 * DAY, 300);
      await ex.setProtocolFee(treasury.address, 1500);
      let ok = 0;

      const check = async () => {
        const bal = await usdt.balanceOf(await ex.getAddress());
        const tm = await ex.totalMargin();
        const pf = await ex.protocolFeesAccrued();
        const cash = await ex.poolCash();
        expect(bal).to.equal(tm + pf + cash);
        let sumMargin = 0n;
        for (let mid = 0; mid < 2; mid++) {
          const m = await ex.getMarket(mid);
          let skew = 0n,
            longs = 0n,
            shorts = 0n,
            se = 0n;
          for (const t of traders) {
            const p = await ex.positions(mid, t.address);
            skew += p.size;
            se += p.sizeEntry;
            if (p.size > 0n) longs += p.size;
            else shorts -= p.size;
            sumMargin += p.margin;
          }
          expect(m.skew).to.equal(skew);
          expect(m.longSize).to.equal(longs);
          expect(m.shortSize).to.equal(shorts);
          expect(m.sumSizeEntry).to.equal(se);
        }
        expect(tm).to.equal(sumMargin);
      };

      for (let step = 0; step < 120; step++) {
        const action = rnd();
        const mid = rnd() < 0.5 ? 0 : 1;
        const t = traders[Math.floor(rnd() * traders.length)];
        const pos = await ex.positions(mid, t.address);
        const sizeUnits = BigInt(1 + Math.floor(rnd() * 3000));
        const long = rnd() < 0.5;
        try {
          if (action < 0.15) {
            const idx = await oracle.price(ids[mid]);
            const move = BigInt(Math.floor((rnd() - 0.5) * 400)); // up to +/-2%
            await oracle.pushIndex(ids[mid], idx + (idx * move) / 10_000n);
          } else if (action < 0.25) {
            await time.increase(Math.floor(rnd() * 2 * DAY));
          } else if (pos.size === 0n) {
            const size = long ? E(sizeUnits) : -E(sizeUnits);
            const margin = E(Number(sizeUnits) * (5 + Math.floor(rnd() * 40)));
            await ex.connect(t).openPosition(mid, size, margin, long ? E(10_000) : 0);
          } else if (action < 0.45) {
            await ex.connect(t).closePosition(mid, pos.size > 0n ? 0 : E(10_000));
          } else if (action < 0.75) {
            // partial reduce
            const frac = BigInt(1 + Math.floor(rnd() * 99));
            const delta = -(pos.size * frac) / 100n;
            await ex.connect(t).modifyPosition(mid, delta, delta > 0n ? E(10_000) : 0);
          } else if (action < 0.9) {
            const delta = pos.size > 0n ? E(sizeUnits) / 4n : -E(sizeUnits) / 4n;
            await ex.connect(t).addMargin(mid, E(Number(sizeUnits) * 10));
            await ex.connect(t).modifyPosition(mid, delta, delta > 0n ? E(10_000) : 0);
          } else {
            const info = await ex.positionInfo(mid, t.address);
            if (info.liquidatable) await ex.connect(lp).liquidate(mid, t.address);
            else await ex.connect(t).addMargin(mid, E(100));
          }
          ok++;
        } catch (e) {
          // expected business reverts (leverage, skew cap, liquidatable, etc.) are fine
          if (!/reverted with custom error/.test(e.message)) throw e;
        }
        await check();
        if (step % 40 === 39) await ex.claimProtocolFees().catch(() => {});
      }
      expect(ok).to.be.gt(60);
    });
  });
});
