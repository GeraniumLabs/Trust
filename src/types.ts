// Shared types for Trust v1.

export type TrustTier = "unverified" | "sourced" | "reviewed";
export type Status = "active" | "contested" | "stale" | "superseded" | "quarantined" | "retracted";
export type Derivation = "observed" | "inferred" | "stated" | "imported" | "promoted";

export interface SourceRef {
  uri: string; // e.g. "northwind/billing/round.ts", "ci-note://883", "https://..."
  hash?: string; // content hash or commit the agent actually saw
  kind?: string; // file | log | doc | url | note | matter
}

export interface Origin {
  agent: string;
  session: string;
  supervisor: string;
  step: number;
}

export interface RememberInput {
  title: string;
  body: string;
  kind?: string;
  sources?: SourceRef[];
  parents?: string[];
  derivation?: Derivation;
  origin: Origin; // always supplied by the Worker from the session, never by the agent
}

export interface Entry {
  id: string;
  kind: string;
  title: string;
  body: string;
  status: Status;
  trust: TrustTier;
  derivation: Derivation;
  origin: Origin;
  version: number;
  created_at: number;
  updated_at: number;
  sources: (SourceRef & { id: string })[];
  parents: string[];
  signature?: string;
  conflict?: { id: string; with: string; reason: string } | null;
  corroborations?: Corroboration[];
  superseded_by?: string | null;
  // Set on the value returned by remember() when the write was merged into an existing entry.
  deduped?: { into: string; judge: string; confidence: number } | null;
  // Open "the judge wasn't sure" notes involving this memory, visible to every agent that recalls it.
  unsure?: UnsureNote[];
}

export interface Reading {
  relation: string;
  confidence: number;
  judge: string;
}

// A pair the judge couldn't call confidently. Trust took no action; the agent decides with memory_relate.
export interface UnsureNote {
  id: string;
  entry: string; // the newer memory
  with: string; // the existing memory it was compared with
  with_title?: string;
  first: Reading;
  second: Reading | null;
  status: "open" | "decided";
  decision?: string | null;
}

export interface Corroboration {
  agent: string;
  session: string;
  supervisor: string;
  step: number;
  sources: SourceRef[];
  judge: string;
  confidence: number;
  at: number;
}

export interface SessionInfo {
  id: string;
  scope: string;
  agent: string;
  supervisor: string;
  status: "active" | "paused" | "ended";
  started_at: number;
}
