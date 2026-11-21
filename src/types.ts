// Shared types for Trust v1.

export type TrustTier = "unverified" | "sourced" | "reviewed";
export type Status = "active" | "contested" | "stale" | "quarantined" | "retracted";
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
}

export interface SessionInfo {
  id: string;
  scope: string;
  agent: string;
  supervisor: string;
  status: "active" | "paused";
  started_at: number;
}
