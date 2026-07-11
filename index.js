/**
 * Disclosure Log — Cloudflare Worker
 *
 * Routes:
 *   POST /check          { handle, platform?, transcript? }  -> one-off flag, no storage (Free tier)
 *   POST /monitor/add    { creatorHandle, platform, brandId } -> registers a creator for weekly re-checks (Pro)
 *   GET  /log/:creatorId                                      -> returns dated evidence archive
 *
 * Scheduled:
 *   cron trigger (weekly) -> re-checks all monitored creators, writes new log entries,
 *   and cross-checks IG vs TikTok for creators monitored on both platforms.
 *
 * Env bindings expected (wrangler.toml):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, SOCIAVAULT_API_KEY
 */

// ---- FTC disclosure detection engine (unit-tested — see test/detector.test.js) ---

const { evaluateDisclosure, evaluateRepost } = require("./detector");
const { aggregateCreatorStats } = require("./dashboard");

// ---- Supabase helpers -------------------------------------------------------------

async function supabaseInsert(env, table, row) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    throw new Error(`Supabase insert failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function supabaseUpsert(env, table, row, onConflict) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    throw new Error(`Supabase upsert failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function supabaseSelect(env, table, query) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase select failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// ---- Post fetching (via SocialCrawl or platform APIs) ----------------------------

// Confirmed via live testing (July 2026) against SociaVault's Instagram posts endpoint.
// Real response shape: { success, data: { items: { "<index>": {...post}, ... } } }
// Each post has: caption.text (full text, not truncated), is_paid_partnership (bool —
// Instagram's own ground-truth flag for whether the official branded-content tool was used),
// code (the post shortcode, for building the permalink), taken_at (unix timestamp).
// NOTE: TikTok's equivalent endpoint has NOT been confirmed yet — request/response shape
// may differ (their branded-content flag may have a different field name or not exist at all).
async function fetchInstagramPosts(env, handle) {
  const res = await fetch(
    `https://api.sociavault.com/v1/scrape/instagram/posts?handle=${encodeURIComponent(handle)}`,
    { headers: { "x-api-key": env.SOCIAVAULT_API_KEY } }
  );
  if (!res.ok) throw new Error(`SociaVault fetch failed: ${res.status}`);
  const body = await res.json();
  const items = body?.data?.items ?? {};

  return Object.values(items).map((item) => ({
    caption: item?.caption?.text ?? "",
    platformTag: item?.is_paid_partnership === true,
    platform: "instagram",
    postedAt: item?.taken_at ? new Date(item.taken_at * 1000).toISOString() : null,
    postUrl: item?.code ? `https://instagram.com/p/${item.code}` : null,
  }));
}

// Confirmed via live testing (July 2026) against SociaVault's TikTok videos endpoint.
// Real response shape: { success, data: { aweme_list: { "<index>": {...video}, ... } } }
// Each video has: desc (full caption text), is_paid_partnership (bool — same field name as
// Instagram, convenient), is_ad (bool — a second, narrower ad-network flag distinct from
// creator-brand partnerships), commerce_info.bc_label_test_text (human-readable string,
// literally "Paid partnership" when set — a nice redundant confirmation), url (direct video
// link, no shortcode assembly needed), create_time_utc (already ISO format).
async function fetchTikTokPosts(env, handle) {
  const res = await fetch(
    `https://api.sociavault.com/v1/scrape/tiktok/videos?handle=${encodeURIComponent(handle)}&limit=20`,
    { headers: { "x-api-key": env.SOCIAVAULT_API_KEY } }
  );
  if (!res.ok) throw new Error(`SociaVault fetch failed: ${res.status}`);
  const body = await res.json();
  const items = body?.data?.aweme_list ?? {};

  return Object.values(items).map((item) => ({
    caption: item?.desc ?? "",
    platformTag: item?.is_paid_partnership === true,
    platform: "tiktok",
    postedAt: item?.create_time_utc ?? null,
    postUrl: item?.url ?? null,
  }));
}

// Confirmed via SociaVault docs (July 2026): YouTube channel endpoint returns subscriberCount
// (note: different field name than IG/TikTok's follower_count).
async function fetchYouTubeChannelInfo(env, handle) {
  const res = await fetch(
    `https://api.sociavault.com/v1/scrape/youtube/channel?handle=${encodeURIComponent(handle)}`,
    { headers: { "x-api-key": env.SOCIAVAULT_API_KEY } }
  );
  if (!res.ok) throw new Error(`SociaVault fetch failed: ${res.status}`);
  const body = await res.json();
  return { followerCount: body?.data?.subscriberCount ?? null };
}

// CORRECTED (confirmed via live test against @TrentTheTraveler, July 2026): the
// channel-videos LIST endpoint already includes the full description field — no separate
// per-video details call needed. This is cheaper than originally assumed: 1 credit per
// page of up to ~30 videos, not 1+1 per video. The earlier "2x cost" framing was wrong.
async function fetchYouTubeVideos(env, handle, videoLimit = 10) {
  const listRes = await fetch(
    `https://api.sociavault.com/v1/scrape/youtube/channel-videos?handle=${encodeURIComponent(handle)}&sort=latest`,
    { headers: { "x-api-key": env.SOCIAVAULT_API_KEY } }
  );
  if (!listRes.ok) throw new Error(`SociaVault fetch failed: ${listRes.status}`);
  const listBody = await listRes.json();
  const videos = Object.values(listBody?.data?.videos ?? {}).slice(0, videoLimit);

  return videos.map((v) => ({
    caption: v?.description ?? "",
    // No platform ground-truth flag exists for YouTube (confirmed — no third-party-accessible
    // equivalent to is_paid_partnership; the official hasPaidProductPlacement field is
    // OAuth-gated to the video owner only, per Google's own docs).
    platformTag: false,
    platform: "youtube",
    postedAt: v?.publishDate ?? v?.publishedTime ?? null,
    postUrl: v?.url ?? null,
  }));
}

// Single-video details lookup — confirmed the real param is `url`, not `id` (its own error
// message told us: {"error":"Video URL is required","example":"?url=https://..."}).
// Not currently used by fetchYouTubeVideos above since the list endpoint already has
// descriptions, but kept for cases where you need duration/comment count/etc. for one video.
async function fetchYouTubeVideoDetails(env, videoId) {
  const res = await fetch(
    `https://api.sociavault.com/v1/scrape/youtube/video?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`,
    { headers: { "x-api-key": env.SOCIAVAULT_API_KEY } }
  );
  if (!res.ok) throw new Error(`SociaVault fetch failed: ${res.status}`);
  const body = await res.json();
  return body?.data ?? null;
}

// ---- YouTube spoken-disclosure detection (via transcript) -----------------------
// GENUINE DIFFERENTIATOR: the FTC/YouTube research paper we reviewed explicitly excluded
// audio/spoken disclosures "due to computational limits and inconsistent quality of caption
// data" — and every competitor tool we found (Traackr, CreatorIQ, etc.) only checks
// description text. Creators often say the disclosure out loud even when the description is
// weak or missing — CONFIRMED with a real case: a creator disclosed a sponsor verbally with
// zero mention in the description. SociaVault's transcript endpoint is confirmed working.
//
// COST NOTE: this is a SECOND SociaVault call per video (list, already has descriptions for
// free + transcript), on top of the base YouTube monitoring cost. Treat as opt-in
// (checkTranscript flag), not default, until you've confirmed the credit cost is worth it.
//
// Placement matters, not just presence — see evaluateSpokenDisclosure in youtube-merge.js:
// a real case showed a creator disclosing a sponsor at 38:33 of a 39:24 video, so checking
// only the first ~90 seconds would have missed it entirely. We scan the whole transcript,
// but treat a disclosure that only shows up late as borderline, not fully clear.

const { mergeDisclosureSignals, evaluateSpokenDisclosure } = require("./youtube-merge");

async function fetchYouTubeTranscriptDisclosure(env, videoUrl) {
  const res = await fetch(
    `https://api.sociavault.com/v1/scrape/youtube/video/transcript?url=${encodeURIComponent(videoUrl)}`,
    { headers: { "x-api-key": env.SOCIAVAULT_API_KEY } }
  );
  if (!res.ok) throw new Error(`Transcript fetch failed: ${res.status}`);
  const body = await res.json();

  if (body?.data?.notFound || !body?.data?.transcript) {
    return { status: "missing", reason: "No transcript available for this video.", weakSignals: [] };
  }

  // CORRECTED based on a real transcript response (@TrentTheTraveler, July 2026): transcript
  // is a numeric-keyed OBJECT (not an array, matching the pattern of other SociaVault list
  // endpoints), and each segment has startMs (a STRING, in milliseconds) — not `start` in
  // seconds like early docs examples implied.
  const segments = Object.values(body.data.transcript);
  return evaluateSpokenDisclosure(segments);
}

// ---- Router -------------------------------------------------------------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/check") {
      const body = await request.json();

      // Manual paste path: works today, no API dependency.
      if (body.transcript) {
        const evaluation = evaluateDisclosure(body.transcript, body.platformTag);
        return json({ ...evaluation });
      }

      // Handle-based path: confirmed working against SociaVault's Instagram AND TikTok
      // endpoints. Returns the creator's recent posts evaluated, not a single arbitrary
      // post by URL — single-post-by-URL lookup is not yet confirmed as a real endpoint.
      if (body.handle) {
        const platform = ["tiktok", "youtube"].includes(body.platform) ? body.platform : "instagram";
        const posts =
          platform === "tiktok"
            ? await fetchTikTokPosts(env, body.handle)
            : platform === "youtube"
              ? await fetchYouTubeVideos(env, body.handle)
              : await fetchInstagramPosts(env, body.handle);

        const evaluated = [];
        for (const post of posts) {
          let result = evaluateDisclosure(post.caption, post.platformTag);

          // Opt-in only — costs a third SociaVault call per video. See fetchYouTubeTranscriptDisclosure.
          if (platform === "youtube" && body.checkTranscript && post.postUrl) {
            try {
              const transcriptResult = await fetchYouTubeTranscriptDisclosure(env, post.postUrl);
              result = mergeDisclosureSignals(result, transcriptResult);
            } catch (err) {
              console.error(`Transcript check failed for ${post.postUrl}:`, err.message);
            }
          }

          evaluated.push({ postUrl: post.postUrl, postedAt: post.postedAt, ...result });
        }

        return json({ handle: body.handle, platform, posts: evaluated });
      }

      return json({ error: "Provide either 'transcript' or 'handle'." }, 400);
    }

    if (request.method === "POST" && url.pathname === "/monitor/add") {
      const { creatorHandle, platform, brandId } = await request.json();
      if (!["instagram", "tiktok", "youtube"].includes(platform)) {
        return json({ error: "platform must be 'instagram', 'tiktok', or 'youtube'." }, 400);
      }
      const row = await supabaseInsert(env, "monitored_creators", {
        creator_handle: creatorHandle,
        platform,
        brand_id: brandId,
        created_at: new Date().toISOString(),
      });
      return json({ added: row });
    }

    if (request.method === "GET" && url.pathname.startsWith("/log/")) {
      const creatorId = url.pathname.split("/")[2];
      const rows = await supabaseSelect(
        env,
        "audit_log",
        `creator_id=eq.${creatorId}&order=checked_at.desc`
      );
      return json({ creatorId, entries: rows });
    }

    if (request.method === "GET" && url.pathname.startsWith("/dashboard/")) {
      const brandId = url.pathname.split("/")[2];
      const creators = await supabaseSelect(env, "monitored_creators", `brand_id=eq.${brandId}&select=*`);
      const creatorIds = creators.map((c) => c.id);
      const auditLogRows =
        creatorIds.length > 0
          ? await supabaseSelect(env, "audit_log", `creator_id=in.(${creatorIds.join(",")})&select=*`)
          : [];
      const stats = aggregateCreatorStats(creators, auditLogRows);
      return json({ brandId, creators: stats });
    }

    return json({ error: "Not found" }, 404);
  },

  // Weekly cron: re-check every monitored creator's latest posts.
  async scheduled(event, env, ctx) {
    const creators = await supabaseSelect(env, "monitored_creators", "select=*");

    // Group by (brand_id, creator_handle) so we can compare IG vs TikTok for the same
    // creator when they're monitored on both platforms — needed for repost/tag-loss checks.
    const groups = new Map();
    for (const creator of creators) {
      const key = `${creator.brand_id}::${creator.creator_handle}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(creator);
    }

    for (const [, group] of groups) {
      const postsByPlatform = {};

      for (const creator of group) {
        try {
          const posts =
            creator.platform === "tiktok"
              ? await fetchTikTokPosts(env, creator.creator_handle)
              : creator.platform === "youtube"
                ? await fetchYouTubeVideos(env, creator.creator_handle)
                : await fetchInstagramPosts(env, creator.creator_handle);
          postsByPlatform[creator.platform] = { creator, posts };

          for (const post of posts) {
            const evaluation = evaluateDisclosure(post.caption, post.platformTag);
            // Upsert on (creator_id, post_url) so re-running weekly doesn't duplicate
            // rows for posts we've already logged — see schema.sql unique constraint.
            await supabaseUpsert(
              env,
              "audit_log",
              {
                creator_id: creator.id,
                post_url: post.postUrl,
                status: evaluation.status,
                reason: evaluation.reason,
                platform_tag_lost: false,
                checked_at: new Date().toISOString(),
              },
              "creator_id,post_url"
            );
          }
        } catch (err) {
          console.error(`Failed to check ${creator.creator_handle} (${creator.platform}):`, err.message);
        }
      }

      // If we have both platforms for this creator, look for matching content and
      // flag any post where the disclosure survived on one platform but not the other.
      if (postsByPlatform.instagram && postsByPlatform.tiktok) {
        matchAndFlagReposts(env, postsByPlatform).catch((err) =>
          console.error("Repost matching failed:", err.message)
        );
      }
    }
  },
};

// ---- Cross-platform repost matching --------------------------------------------

// Simple word-overlap similarity — good enough to match near-identical captions
// (confirmed in testing: creators who cross-post tend to reuse ~90%+ of the same text).
function captionSimilarity(a, b) {
  const wordsA = new Set(a.toLowerCase().match(/\w+/g) ?? []);
  const wordsB = new Set(b.toLowerCase().match(/\w+/g) ?? []);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.max(wordsA.size, wordsB.size);
}

const SIMILARITY_THRESHOLD = 0.5;

async function matchAndFlagReposts(env, postsByPlatform) {
  const { creator: igCreator, posts: igPosts } = postsByPlatform.instagram;
  const { posts: ttPosts } = postsByPlatform.tiktok;

  for (const igPost of igPosts) {
    let bestMatch = null;
    let bestScore = 0;
    for (const ttPost of ttPosts) {
      const score = captionSimilarity(igPost.caption, ttPost.caption);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = ttPost;
      }
    }
    if (bestMatch && bestScore >= SIMILARITY_THRESHOLD) {
      const result = evaluateRepost(igPost, bestMatch);
      if (result.flagged) {
        await supabaseUpsert(
          env,
          "audit_log",
          {
            creator_id: igCreator.id,
            post_url: `${igPost.postUrl} <-> ${bestMatch.postUrl}`,
            status: "missing",
            reason: `Repost tag/disclosure mismatch between Instagram and TikTok (match confidence ${(bestScore * 100).toFixed(0)}%).`,
            platform_tag_lost: result.tagLost,
            checked_at: new Date().toISOString(),
          },
          "creator_id,post_url"
        );
      }
    }
  }
}
