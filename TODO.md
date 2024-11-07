# TODO

- Remove WS token sniping (doesn't work as before)
- Do random buy for the `buy-once` and `buy` commands
  - Use uniform random and min/max options for the commands
- Add sell by percent to start/snipe command
- Reduce log clutter to the start/snipe command
  - Remove waiting logs if `is-buy-once` is true
  - Make MC updates as a one liner
- Detect Raydium migration and change price update strategy
  - Ray Price Calc: [solask](https://solana.stackexchange.com/questions/11939/calculation-of-tocken-price-for-example-sol-usdc)
  - Detection: [codebase](https://github.com/warp-id/solana-trading-bot?tab=readme-ov-file#configuration)
  - Another example: [code](https://gist.github.com/endrsmar/684c336c3729ec4472b2f337c50c3cdb)
  - Logic?:
    - Update and monitor price coming from Pump
    - Detect if the curve is complete(run onLogs in bg to check if `init` instruction occured)
    - Subscribe to Raydium AMM to detect migration(done by prev step)
    - Update metadata `raydium_pool` for the trade commands
    - Switch price monitoring to another source(some RPC API or direct blockchain monitoring using Ray AMM)
