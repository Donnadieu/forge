import type { StateSnapshot, RunningSessionSnapshot } from "../observability/types.js";

export interface HttpServerDeps {
  getSnapshot: () => StateSnapshot;
  getIssueSnapshot: (identifier: string) => RunningSessionSnapshot | null;
  triggerPoll: () => void;
}
