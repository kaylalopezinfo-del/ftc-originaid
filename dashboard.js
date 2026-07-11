/**
 * Dashboard aggregation — turns raw audit_log + monitored_creators rows into
 * per-creator stats for the "partnerships vs. followers" view.
 *
 * Isolated from the Worker runtime so it's unit-testable (see test/dashboard.test.js).
 */

/**
 * @param {Array} creators - rows from monitored_creators (id, creator_handle, platform, follower_count)
 * @param {Array} auditLogRows - rows from audit_log (creator_id, status, ...)
 * @returns {Array} one summary object per creator, sorted by follower_count descending
 */
function aggregateCreatorStats(creators, auditLogRows) {
  const logsByCreator = new Map();
  for (const row of auditLogRows) {
    if (!logsByCreator.has(row.creator_id)) logsByCreator.set(row.creator_id, []);
    logsByCreator.get(row.creator_id).push(row);
  }

  return creators
    .map((creator) => {
      const logs = logsByCreator.get(creator.id) ?? [];
      const totalChecked = logs.length;
      const flagged = logs.filter((l) => l.status !== "clear").length;
      const compliant = totalChecked - flagged;
      const complianceRate = totalChecked > 0 ? compliant / totalChecked : null;

      return {
        creatorId: creator.id,
        handle: creator.creator_handle,
        platform: creator.platform,
        // follower_count is sourced from SociaVault's profile endpoint — field name/endpoint
        // NOT yet confirmed live (see worker/test/compliance-report.js DEBUG output). Null
        // until confirmed; the dashboard must handle this gracefully, not assume a number.
        followerCount: typeof creator.follower_count === "number" ? creator.follower_count : null,
        totalChecked,
        flaggedCount: flagged,
        complianceRate, // 0.0–1.0, or null if nothing checked yet
      };
    })
    .sort((a, b) => (b.followerCount ?? -1) - (a.followerCount ?? -1));
}

module.exports = { aggregateCreatorStats };
