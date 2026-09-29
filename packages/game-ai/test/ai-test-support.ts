/**
 * Re-export surface used by the AI tests.
 *
 * The tests import from here rather than from `../src/index.js` so that adding
 * an export to the package barrel is a separate, deliberate act from exposing
 * something for testing.
 */
export {
  alreadyRefused,
  chooseTradeProposal,
  decideBid,
  evaluateIncomingTrade,
  evaluateTrade,
  groupOwnership,
  maximumBid,
  tradeSignature,
  valuePropertyFor,
  valueTilesFor,
  weightsFor,
  preservesLiquidity,
  VALUATION_WEIGHTS,
  TRADE_SHAPES,
  MIN_INCREMENT,
  shouldRespondToTrade,
  type PropertyValuation,
  type TradeEvaluation,
  type ValuationWeights,
  type TradeProposal,
  type BidDecision,
} from "../src/index.js";
