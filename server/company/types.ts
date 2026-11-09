import type { SizingResult } from "../../core/risk";
import type { LeverageDecision } from "../../core/leverage";
import type { Side, Signal } from "../../core/types";
import type { MarketInfo } from "../market";

// evidence gathered by the flow, derivatives and sentiment workers for one candidate
export interface CandidateIntel {
  imbalance: number;
  spreadBps: number;
  funding: number;
  xFunding: number | null;
  premium: number;
  change24h: number;
  volumeUsd: number;
  oiUsd: number;
  news: number;
  flags: string[];
}

// a quant signal that survived the first filter and is being considered for a trade
export interface Candidate {
  coin: string;
  side: Side;
  signal: Signal;
  market: MarketInfo;
  intel: CandidateIntel;
}

// research verdict on one candidate, from a model or the rules engine
export interface Opinion {
  decision: "long" | "short" | "skip";
  confidence: number;
  thesis: string;
  risk: string;
  source: string;
}

// a sized trade waiting for the boss
export interface Proposal {
  id: number;
  cand: Candidate;
  opinion: Opinion;
  leverage: LeverageDecision;
  sizing: SizingResult;
  size: number;
  riskMult: number;
  rr: number;
}

// boss answer for one proposal
export interface Verdict {
  approve: boolean;
  size: number;
  note: string;
  source: string;
}
