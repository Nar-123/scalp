// Five closed DRY_RUN trades recorded before Phase 5.6H (Pump.fun bonding-curve tokens), with the on-chain curve state (from the recorded
// TradeEvents) at entry and exit. Extracted read-only from the run ledgers used in the Phase 5.6G investigation. Reserves are u64 decimal strings.
// `recordedOldSimPnlSol` is what the pre-5.6H simulator booked (generic 30 bps/leg): kept to prove the discrepancy is gone.
export interface RecordedTrade {
  mint: string;
  entrySizeSol: number;
  entryPriceSol: number;
  exitPriceSol: number;
  tokensRaw: string;
  feeBps: number;
  creatorFeeBps: number;
  exitFeeBps: number;
  exitCreatorFeeBps: number;
  entryState: { vs: string; vt: string; rs: string; rt: string };
  exitState: { vs: string; vt: string; rs: string; rt: string };
  recordedOldSimPnlSol: number;
}

export const RECORDED_TRADES: RecordedTrade[] = [
  {
    "mint": "AigZ6piS",
    "entrySizeSol": 0.3,
    "entryPriceSol": 3.1068385530933837e-07,
    "exitPriceSol": 3.3884510151738743e-07,
    "tokensRaw": "950873402017",
    "feeBps": 95,
    "creatorFeeBps": 30,
    "exitFeeBps": 95,
    "exitCreatorFeeBps": 30,
    "entryState": {
      "vs": "100004566913",
      "vt": "321885303030724",
      "rs": "70004566913",
      "rt": "41985303030724"
    },
    "exitState": {
      "vs": "104438613205",
      "vt": "308219338976163",
      "rs": "74438613205",
      "rt": "28319338976163"
    },
    "recordedOldSimPnlSol": 0.020266636800536197
  },
  {
    "mint": "F8ytZ2B6",
    "entrySizeSol": 0.3,
    "entryPriceSol": 3.6109245458046847e-07,
    "exitPriceSol": 3.713135140729902e-07,
    "tokensRaw": "818306301264",
    "feeBps": 95,
    "creatorFeeBps": 30,
    "exitFeeBps": 95,
    "exitCreatorFeeBps": 30,
    "entryState": {
      "vs": "107812644009",
      "vt": "298573516675282",
      "rs": "77812644009",
      "rt": "18673516675282"
    },
    "exitState": {
      "vs": "109327865234",
      "vt": "294435459767589",
      "rs": "79327865234",
      "rt": "14535459767589"
    },
    "recordedOldSimPnlSol": 0.0020910026115910085
  },
  {
    "mint": "GxqWfaHc",
    "entrySizeSol": 0.3,
    "entryPriceSol": 1.290687444812663e-07,
    "exitPriceSol": 1.3193562152012545e-07,
    "tokensRaw": "2285142820078",
    "feeBps": 95,
    "creatorFeeBps": 30,
    "exitFeeBps": 95,
    "exitCreatorFeeBps": 30,
    "entryState": {
      "vs": "64457140062",
      "vt": "499401619819395",
      "rs": "34457140062",
      "rt": "219501619819395"
    },
    "exitState": {
      "vs": "65169069945",
      "vt": "493945980578559",
      "rs": "35169069945",
      "rt": "214045980578559"
    },
    "recordedOldSimPnlSol": -0.0008194940149016117
  },
  {
    "mint": "B6F3rUqf",
    "entrySizeSol": 0.3,
    "entryPriceSol": 1.7962837529244443e-07,
    "exitPriceSol": 1.978151388772528e-07,
    "tokensRaw": "1643093685357",
    "feeBps": 95,
    "creatorFeeBps": 30,
    "exitFeeBps": 95,
    "exitCreatorFeeBps": 30,
    "entryState": {
      "vs": "76041024507",
      "vt": "423324123391982",
      "rs": "46041024507",
      "rt": "143424123391982"
    },
    "exitState": {
      "vs": "79797677465",
      "vt": "403395199770406",
      "rs": "49797677465",
      "rt": "123495199770406"
    },
    "recordedOldSimPnlSol": 0.022759317582495275
  },
  {
    "mint": "DuaPgniT",
    "entrySizeSol": 0.3,
    "entryPriceSol": 2.0291316389495746e-07,
    "exitPriceSol": 2.0803128502734248e-07,
    "tokensRaw": "1454878483804",
    "feeBps": 95,
    "creatorFeeBps": 30,
    "exitFeeBps": 95,
    "exitCreatorFeeBps": 30,
    "entryState": {
      "vs": "80819396020",
      "vt": "398295480040112",
      "rs": "50819396020",
      "rt": "118395480040112"
    },
    "exitState": {
      "vs": "81832310817",
      "vt": "393365405622738",
      "rs": "51832310817",
      "rt": "113465405622738"
    },
    "recordedOldSimPnlSol": 0.0006262827717353203
  }
];
