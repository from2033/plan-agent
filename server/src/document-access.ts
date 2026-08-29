import { sharedResourcesForViewer } from "./family-sharing.js";
import { knowledgeSpaceIdForUser } from "./knowledge-space.js";

export interface SharedDocumentScope {
  spaceId: string;
  documentIds: string[];
}

// Build a least-privilege search grant for the desktop worker. The worker gets
// only opaque owner-space ids and explicitly shared document ids, never family
// member account ids or unrestricted access to another member's vault.
export function sharedDocumentScopesForViewer(userId: string): SharedDocumentScope[] {
  const byOwner = new Map<string, Set<string>>();
  for (const resource of sharedResourcesForViewer(userId, "document")) {
    if (resource.ownerUserId === userId) continue;
    const ids = byOwner.get(resource.ownerUserId) || new Set<string>();
    ids.add(resource.resourceId);
    byOwner.set(resource.ownerUserId, ids);
  }
  return [...byOwner.entries()].slice(0, 20).map(([ownerUserId, documentIds]) => ({
    spaceId: knowledgeSpaceIdForUser(ownerUserId),
    documentIds: [...documentIds].slice(0, 200),
  }));
}
