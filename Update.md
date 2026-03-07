# Version 1.0

- Multi Target Address
- Revert Trade
- Size Multiplier
- Poll Interval_sec
- Take Profit
- Stop Loss
- Trailing Stop
- Buy Amount Limit In Usd
- Entry Trade Sec
- Trade Sec From Resolve (Exit Time)

# Version 1.1

- Multi Target Address
- Fix type error
- Basic UI Implementation
- - User Activity
- - Holding Asset Track

# Version 1.1.1

- Fix Decimal Issue in Traded Share
- Add Dump Dashboard / Setting 

# Version 1.1.2

- Update FrontEnd UI structure
- Init Struct for Dashboard / Settings

# Version 1.1.3

- **Auto-redeem on resolved markets**: When a leader exits a position on a
  market whose end date has passed, the polling loop now emits a `REDEEM`
  event instead of a `SELL`. If the bot copied that trade, it automatically
  calls `CTF.redeemPositions()` on-chain to recover the USDC — no manual
  intervention required.
- Supports EOA and proxy / Magic wallets (same detection as `redeem-one.ts`).
- NegRisk markets are flagged and skipped with a helpful message (require the
  Polymarket UI or a dedicated NegRiskAdapter call).
- Graceful fallback: if the market is not yet resolved on-chain
  (`payoutDenominator = 0`), the bot logs a warning and skips without losing
  funds.
- Simulation mode logs `SIM | would redeem` without submitting any transaction.