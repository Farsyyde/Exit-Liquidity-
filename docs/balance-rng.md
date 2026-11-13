# Balance sim: mulberry32 vs xoshiro256**

50000 runs per arm. Same bots, same bot randomness; only the market generator differs.
Bots trade headlines with a 2 tick reaction delay. "headline" never shops (the spec's no power ups bot); "headline+shop" buys indicators by a fixed priority list.
Pass rate = cleared / reached for that layer, with a 95% interval. z is the two proportion z score (new minus old); |z| > 3 would suggest a real difference.

## headline

| Level (UI layer) | Coin | old reached | old pass | new reached | new pass | z |
|---|---|---|---|---|---|---|
| 1 (8) | $WAGMI | 50000 | 81.7% ± 0.3% | 50000 | 81.6% ± 0.3% | -0.60 |
| 2 (7) | $COPE | 40861 | 68.6% ± 0.4% | 40788 | 68.6% ± 0.5% | 0.06 |
| 3 (6) | $RUGDAO | 28036 | 63.0% ± 0.6% | 27994 | 63.7% ± 0.6% | 1.75 |
| 4 (5) | $HOPIUM | 17660 | 46.1% ± 0.7% | 17833 | 46.1% ± 0.7% | -0.06 |
| 5 (4) | $GRANDMA | 8145 | 53.6% ± 1.1% | 8219 | 52.8% ± 1.1% | -1.02 |
| 6 (3) | $SOURCE | 4365 | 31.2% ± 1.4% | 4339 | 29.3% ± 1.4% | -1.96 |
| 7 (2) | $LASTONE | 1363 | 48.3% ± 2.7% | 1271 | 49.7% ± 2.7% | 0.74 |
| 8 (1) | $REAL | 658 | 33.6% ± 3.6% | 632 | 36.6% ± 3.8% | 1.12 |

Full clears: old 221, new 231.

## headline+shop

| Level (UI layer) | Coin | old reached | old pass | new reached | new pass | z |
|---|---|---|---|---|---|---|
| 1 (8) | $WAGMI | 50000 | 81.7% ± 0.3% | 50000 | 81.6% ± 0.3% | -0.60 |
| 2 (7) | $COPE | 40861 | 71.7% ± 0.4% | 40788 | 72.1% ± 0.4% | 1.50 |
| 3 (6) | $RUGDAO | 29287 | 71.7% ± 0.5% | 29427 | 72.0% ± 0.5% | 0.83 |
| 4 (5) | $HOPIUM | 20989 | 64.0% ± 0.6% | 21180 | 63.9% ± 0.6% | -0.13 |
| 5 (4) | $GRANDMA | 13430 | 75.2% ± 0.7% | 13539 | 74.5% ± 0.7% | -1.36 |
| 6 (3) | $SOURCE | 10103 | 55.0% ± 1.0% | 10088 | 55.7% ± 1.0% | 1.08 |
| 7 (2) | $LASTONE | 5554 | 76.1% ± 1.1% | 5622 | 76.4% ± 1.1% | 0.31 |
| 8 (1) | $REAL | 4227 | 60.8% ± 1.5% | 4293 | 59.3% ± 1.5% | -1.45 |

Full clears: old 2570, new 2544.

Took 246 s.
