import type { Claim } from '../contracts/index.js';
import { isAncestor } from './git.js';

export async function evaluateStaleness(
  claims: Claim[],
  head: string,
  cwd: string,
): Promise<{ claimId: string; sha: string }[]> {
  const ancestryBySha = new Map<string, boolean>();
  const reported = new Set<string>();
  const stale: { claimId: string; sha: string }[] = [];

  for (const claim of claims) {
    for (const evidence of claim.evidence) {
      if (evidence.stale === true) continue;

      let ancestor = ancestryBySha.get(evidence.sha);
      if (ancestor === undefined) {
        ancestor = await isAncestor(evidence.sha, head, cwd);
        ancestryBySha.set(evidence.sha, ancestor);
      }

      if (!ancestor) {
        const key = `${claim.id}\u0000${evidence.sha}`;
        if (!reported.has(key)) {
          reported.add(key);
          stale.push({ claimId: claim.id, sha: evidence.sha });
        }
      }
    }
  }

  return stale;
}
