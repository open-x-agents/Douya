/**
 * Multi-stage aggregation pipeline for daily digest
 * Inspired by Superhuman/Shortwave email triage, Linear inbox, GitHub notifications
 * 
 * Pipeline: Fetch -> Normalize -> Dedupe -> Classify -> Group -> Write Brief + Hero
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Stage 1: Fetch data from all active sources (UNCAPPED pagination)
 * Paginate through ALL items in the 24-48h window, no fixed caps
 */
/** Last authenticated GitHub identity seen during aggregation ({ login, name }). */
export let lastGithubIdentity = null;

/** Resolve a display name: explicit profile name, else GitHub name/login. 'User' is the legacy placeholder. */
export function resolveDisplayName(profileName, identity = lastGithubIdentity) {
  if (profileName && profileName !== 'User') return profileName;
  return identity?.name || identity?.login || '';
}

export async function fetchFromSources(composioClient, activeSources) {
  const sourceData = {};
  
  for (const source of activeSources) {
    const slug = source.toolkit.slug;
    
    try {
      if (slug === 'github') {
        // First, fetch the authenticated user's login (since @me doesn't work in Composio)
        console.log('[GitHub] Fetching authenticated user...');
        const userResult = await composioClient.executeAction('GITHUB_GET_THE_AUTHENTICATED_USER', {});
        const username = userResult?.data?.login;
        if (username) lastGithubIdentity = { login: username, name: userResult?.data?.name || '' };
        
        if (!username) {
          console.warn('[GitHub] Could not fetch username, skipping');
          continue;
        }
        
        console.log(`[GitHub] Authenticated as: ${username}`);
        
        // GitHub: paginate through ALL items in last 48h
        const yesterday = new Date(Date.now() - 24*60*60*1000).toISOString().split('T')[0];
        const twoDaysAgo = new Date(Date.now() - 48*60*60*1000).toISOString().split('T')[0];
        
        // Gather multiple types of GitHub activity with real username
        const [
          myOpenPRs,
          myRecentPRs,
          reviewRequested,
          assigned,
          recentActivity,
          mentions,
          mergedPRs,
        ] = await Promise.all([
          paginateGitHubSearch(composioClient, `is:pr is:open author:${username}`),
          paginateGitHubSearch(composioClient, `is:pr author:${username} updated:>=${yesterday}`),
          paginateGitHubSearch(composioClient, `is:pr is:open review-requested:${username}`),
          paginateGitHubIssues(composioClient),
          paginateGitHubSearch(composioClient, `involves:${username} updated:>=${twoDaysAgo}`),
          paginateGitHubSearch(composioClient, `mentions:${username} updated:>=${yesterday}`),
          paginateGitHubSearch(composioClient, `is:pr is:merged author:${username} merged:>=${yesterday}`),
        ]);
        
        sourceData.github = {
          myOpenPRs,
          myRecentPRs,
          reviewRequested,
          assigned,
          recentActivity,
          mentions,
          mergedPRs,
        };
        
        const totalGithub = myOpenPRs.length + myRecentPRs.length + reviewRequested.length + 
                           assigned.length + recentActivity.length + mentions.length + mergedPRs.length;
        console.log(`[GitHub] Fetched ${totalGithub} items total:`);
        console.log(`  - My open PRs: ${myOpenPRs.length}`);
        console.log(`  - My recent PRs (updated): ${myRecentPRs.length}`);
        console.log(`  - Review requested: ${reviewRequested.length}`);
        console.log(`  - Assigned issues: ${assigned.length}`);
        console.log(`  - Recent activity (involves): ${recentActivity.length}`);
        console.log(`  - Mentions: ${mentions.length}`);
        console.log(`  - Merged PRs: ${mergedPRs.length}`);
        
      } else if (slug === 'gmail') {
        // Gmail: paginate through last 24h with newer_than:1d (DOES work in Composio)
        
        const [unread, recent, important] = await Promise.all([
          paginateGmail(composioClient, 'in:inbox is:unread newer_than:1d'),
          paginateGmail(composioClient, 'in:inbox newer_than:1d'),
          paginateGmail(composioClient, 'in:inbox is:important newer_than:1d'),
        ]);
        
        sourceData.gmail = {
          unread,
          recent,
          important,
        };
        
        // Log actual unread count (check labelIds)
        const actualUnread = recent.filter(m => {
          const labels = m.labelIds || [];
          return labels.includes('UNREAD');
        }).length;
        
        console.log(`[Gmail] Fetched ${recent.length} recent messages`);
        console.log(`  - Query 'is:unread newer_than:1d' returned: ${unread.length}`);
        console.log(`  - Actual UNREAD labels in recent: ${actualUnread}`);
        console.log(`  - Important: ${important.length}`);
        
      } else if (slug === 'slack') {
        // Slack: search.messages over the last day (real Composio shape: data.messages.matches[])
        const since = new Date(Date.now() - 24*60*60*1000).toISOString().split('T')[0];
        const matches = [];
        for (let page = 1; page <= 3; page++) {
          const r = await composioClient.executeAction('SLACK_SEARCH_MESSAGES', { query: `after:${since}`, count: 100, page, sort: 'timestamp' });
          const m = r?.data?.messages?.matches || [];
          matches.push(...m);
          const pg = r?.data?.messages?.paging || r?.data?.messages?.pagination;
          if (m.length < 100 || (pg && (pg.page || page) >= (pg.pages || pg.page_count || 1))) break;
        }
        sourceData.slack = { messages: matches };
        console.log(`[Slack] Fetched ${matches.length} messages since ${since}`);
      } else if (slug === 'googlecalendar') {
        // Calendar: today + tomorrow (typically small, no pagination needed)
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        const endOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2).toISOString();
        const next2h = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
        
        const [todayAndTomorrow, upcoming] = await Promise.all([
          composioClient.executeAction('GOOGLECALENDAR_EVENTS_LIST', {
            timeMin: startOfToday,
            timeMax: endOfTomorrow,
            maxResults: 100,
          }),
          composioClient.executeAction('GOOGLECALENDAR_EVENTS_LIST', {
            timeMin: new Date().toISOString(),
            timeMax: next2h,
            maxResults: 50,
          }),
        ]);
        
        const allEvents = todayAndTomorrow?.data?.items || [];
        sourceData.googlecalendar = {
          today: allEvents.filter(e => {
            const start = new Date(e.start?.dateTime || e.start?.date);
            return start < new Date(Date.now() + 24*60*60*1000);
          }),
          tomorrow: allEvents.filter(e => {
            const start = new Date(e.start?.dateTime || e.start?.date);
            return start >= new Date(Date.now() + 24*60*60*1000);
          }),
          upcoming: upcoming?.data?.items || [],
        };
        
        console.log(`[Calendar] Fetched ${sourceData.googlecalendar.today.length} today, ${sourceData.googlecalendar.tomorrow.length} tomorrow`);
      }
    } catch (err) {
      console.warn(`[fetchFromSources] Failed to fetch ${slug}:`, err.message);
    }
  }
  
  return sourceData;
}

/**
 * Helper: Paginate GitHub search (uncapped)
 */
async function paginateGitHubSearch(composioClient, query) {
  const items = [];
  let page = 1;
  const perPage = 100; // GitHub max
  let totalCount = null;
  
  while (true) {
    try {
      const result = await composioClient.executeAction('GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS', {
        q: query,
        per_page: perPage,
        page,
      });
      
      // CRITICAL: Composio double-nests at response.data.data.items
      const d = result?.data?.data ?? result?.data;
      
      // Log total_count on first page
      if (page === 1 && d?.total_count !== undefined) {
        totalCount = d.total_count;
        console.log(`  Query: "${query}" -> total_count: ${totalCount}`);
      }
      
      const batch = d?.items || [];
      if (batch.length === 0) break;
      
      items.push(...batch);
      
      // Stop if we got less than a full page (last page)
      if (batch.length < perPage) break;
      
      page++;
      
      // Safety: stop after 10 pages (1000 items) to avoid infinite loops
      if (page > 10) {
        console.warn(`[GitHub] Hit pagination limit (1000 items) for query: ${query}`);
        break;
      }
    } catch (err) {
      console.warn(`[GitHub] Pagination failed at page ${page} for "${query}":`, err.message);
      break;
    }
  }
  
  return items;
}

/**
 * Helper: Paginate GitHub assigned issues (uncapped)
 */
async function paginateGitHubIssues(composioClient) {
  const items = [];
  let page = 1;
  const perPage = 100;
  
  while (true) {
    try {
      const result = await composioClient.executeAction('GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER', {
        per_page: perPage,
        page,
        state: 'open',
      });
      
      // CRITICAL: Composio double-nests at response.data.data
      const d = result?.data?.data ?? result?.data;
      const batch = d?.issues || d?.items || [];
      
      if (batch.length === 0) break;
      
      items.push(...batch);
      
      if (batch.length < perPage) break;
      page++;
      
      if (page > 10) {
        console.warn(`[GitHub] Hit pagination limit for assigned issues`);
        break;
      }
    } catch (err) {
      console.warn(`[GitHub] Issues pagination failed at page ${page}:`, err.message);
      break;
    }
  }
  
  return items;
}

/**
 * Helper: Paginate Gmail with date-bounded queries
 */
async function paginateGmail(composioClient, query) {
  const messages = [];
  let pageToken = null;
  const maxResults = 20; // Smaller pages to avoid 413 Payload Too Large
  
  while (true) {
    try {
      const params = {
        max_results: maxResults,
        query: query,  // Already includes newer_than:1d
        include_payload: false,  // Metadata only, no body
        verbose: false,          // Minimal response
      };
      if (pageToken) params.page_token = pageToken;
      
      const result = await composioClient.executeAction('GMAIL_FETCH_EMAILS', params);
      
      const batch = result?.data?.messages || [];
      if (batch.length === 0) break;
      
      messages.push(...batch);
      
      pageToken = result?.data?.nextPageToken;
      if (!pageToken) break;
      
      // Safety: stop after 25 pages (500 messages)
      if (messages.length >= 500) {
        console.warn(`[Gmail] Hit pagination limit (500 messages) for query: ${query}`);
        break;
      }
    } catch (err) {
      console.warn(`[Gmail] Pagination failed for "${query}":`, err.message);
      break;
    }
  }
  
  console.log(`  Gmail query "${query}" returned ${messages.length} messages`);
  
  return messages;
}

/**
 * Stage 2: Normalize heterogeneous source data into uniform items
 */
export function normalizeItems(sourceData) {
  const items = [];
  for (const m of sourceData.slack?.messages || []) {
    const ch = m.channel || {};
    const isDm = !!(ch.is_im || ch.is_mpim);
    const ws = (m.permalink || '').match(/https:\/\/([^.]+)\.slack\.com/)?.[1] || '';
    items.push({
      source: 'slack', type: isDm ? 'slack-dm' : 'slack-message',
      sourceId: `slack:msg:${ch.id}:${m.ts || m.iid}`,
      title: String(m.text || '').replace(/\s+/g, ' ').slice(0, 140),
      url: m.permalink, body: String(m.text || '').slice(0, 500),
      metadata: { channelId: ch.id, channelName: ch.name || ch.id, isDm, user: m.username || m.user_profile?.display_name || m.user_profile?.real_name || m.user || '', ts: m.ts, workspace: ws },
      timestamp: m.ts ? new Date(parseFloat(m.ts) * 1000).toISOString() : new Date().toISOString(),
    });
  }
  
  // GitHub PRs requiring review (highest priority)
  if (sourceData.github?.reviewRequested) {
    for (const pr of sourceData.github.reviewRequested) {
      items.push({
        source: 'github',
        type: 'pr-review',
        sourceId: `github:pr:${pr.id}`,
        title: pr.title,
        url: pr.html_url,
        body: `#${pr.number} in ${pr.repository_url?.split('/').slice(-2).join('/')}`,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        metadata: {
          state: pr.state,
          author: pr.user?.login,
          labels: pr.labels?.map(l => l.name) || [],
        },
      });
    }
  }
  
  // Assigned GitHub issues
  if (sourceData.github?.assigned) {
    for (const issue of sourceData.github.assigned) {
      items.push({
        source: 'github',
        type: issue.pull_request ? 'pr-assigned' : 'issue-assigned',
        sourceId: `github:issue:${issue.id}`,
        title: issue.title,
        url: issue.html_url,
        body: `#${issue.number} in ${issue.repository_url?.split('/').slice(-2).join('/')}`,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        metadata: {
          state: issue.state,
          labels: issue.labels?.map(l => l.name) || [],
        },
      });
    }
  }
  
  // My open PRs (for tracking CI/feedback)
  if (sourceData.github?.myOpenPRs) {
    for (const pr of sourceData.github.myOpenPRs) {
      items.push({
        source: 'github',
        type: 'pr-mine',
        sourceId: `github:pr:${pr.id}`,
        title: pr.title,
        url: pr.html_url,
        body: `#${pr.number} awaiting review`,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        metadata: {
          state: pr.state,
          repository: pr.repository_url?.split('/').slice(-2).join('/'),
        },
      });
    }
  }
  
  // My recently updated PRs
  if (sourceData.github?.myRecentPRs) {
    for (const pr of sourceData.github.myRecentPRs) {
      // Skip if already added as open PR
      const existing = items.find(i => i.sourceId === `github:pr:${pr.id}`);
      if (!existing) {
        items.push({
          source: 'github',
          type: 'pr-mine-recent',
          sourceId: `github:pr:${pr.id}`,
          title: pr.title,
          url: pr.html_url,
          body: `#${pr.number} recently updated`,
          createdAt: pr.created_at,
          updatedAt: pr.updated_at,
          metadata: {
            state: pr.state,
            repository: pr.repository_url?.split('/').slice(-2).join('/'),
          },
        });
      }
    }
  }
  
  // My merged PRs (achievements)
  if (sourceData.github?.mergedPRs) {
    for (const pr of sourceData.github.mergedPRs) {
      items.push({
        source: 'github',
        type: 'pr-merged',
        sourceId: `github:pr:${pr.id}`,
        title: pr.title,
        url: pr.html_url,
        body: `#${pr.number} merged`,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        metadata: {
          state: pr.state,
          repository: pr.repository_url?.split('/').slice(-2).join('/'),
        },
      });
    }
  }
  
  // Recent activity (involves:@me)
  if (sourceData.github?.recentActivity) {
    for (const item of sourceData.github.recentActivity) {
      // Skip if already added
      const key = item.pull_request ? `github:pr:${item.id}` : `github:issue:${item.id}`;
      const existing = items.find(i => i.sourceId === key);
      if (!existing) {
        items.push({
          source: 'github',
          type: item.pull_request ? 'pr-activity' : 'issue-activity',
          sourceId: key,
          title: item.title,
          url: item.html_url,
          body: `#${item.number} recent activity`,
          createdAt: item.created_at,
          updatedAt: item.updated_at,
          metadata: {
            state: item.state,
            repository: item.repository_url?.split('/').slice(-2).join('/'),
          },
        });
      }
    }
  }
  
  // Mentions
  if (sourceData.github?.mentions) {
    for (const item of sourceData.github.mentions) {
      const key = item.pull_request ? `github:pr:${item.id}` : `github:issue:${item.id}`;
      const existing = items.find(i => i.sourceId === key);
      if (!existing) {
        items.push({
          source: 'github',
          type: item.pull_request ? 'pr-mention' : 'issue-mention',
          sourceId: key,
          title: item.title,
          url: item.html_url,
          body: `#${item.number} mentioned you`,
          createdAt: item.created_at,
          updatedAt: item.updated_at,
          metadata: {
            state: item.state,
            repository: item.repository_url?.split('/').slice(-2).join('/'),
          },
        });
      }
    }
  }
  
  // Important emails
  if (sourceData.gmail?.important) {
    for (const email of sourceData.gmail.important) {
      // Gmail message structure: {messageId, threadId, subject, sender, ...}
      const emailId = email.messageId || email.threadId;
      if (!emailId) {
        console.warn('[normalizeItems] Gmail item missing messageId/threadId:', Object.keys(email));
        continue;
      }
      items.push({
        source: 'gmail',
        type: 'email-important',
        sourceId: `gmail:${emailId}`,
        title: email.subject || '(no subject)',
        url: `https://mail.google.com/mail/u/0/#inbox/${emailId}`,
        body: `From: ${email.sender || 'unknown'}`,
        createdAt: email.messageTimestamp ? new Date(parseInt(email.messageTimestamp)).toISOString() : new Date().toISOString(),
        metadata: {
          from: email.sender,
          snippet: email.preview,
          labelIds: email.labelIds || [],
        },
      });
    }
  }
  
  // Unread emails (lower priority)
  if (sourceData.gmail?.unread) {
    for (const email of sourceData.gmail.unread.slice(0, 20)) {
      const emailId = email.messageId || email.threadId;
      if (!emailId) continue;
      
      if (!items.find(i => i.sourceId === `gmail:${emailId}`)) {
        items.push({
          source: 'gmail',
          type: 'email-unread',
          sourceId: `gmail:${emailId}`,
          title: email.subject || '(no subject)',
          url: `https://mail.google.com/mail/u/0/#inbox/${emailId}`,
          body: `From: ${email.sender || 'unknown'}`,
          createdAt: email.messageTimestamp ? new Date(parseInt(email.messageTimestamp)).toISOString() : new Date().toISOString(),
          metadata: {
            from: email.sender,
            snippet: email.preview,
            labelIds: email.labelIds || [],
          },
        });
      }
    }
  }
  
  // Recent emails (for clustering)
  if (sourceData.gmail?.recent) {
    for (const email of sourceData.gmail.recent) {
      const emailId = email.messageId || email.threadId;
      if (!emailId) continue;
      
      // Skip if already added as important/unread
      if (items.find(i => i.sourceId === `gmail:${emailId}`)) continue;
      
      items.push({
        source: 'gmail',
        type: 'email-recent',
        sourceId: `gmail:${emailId}`,
        title: email.subject || '(no subject)',
        url: `https://mail.google.com/mail/u/0/#inbox/${emailId}`,
        body: `From: ${email.sender || 'unknown'}`,
        createdAt: email.messageTimestamp ? new Date(parseInt(email.messageTimestamp)).toISOString() : new Date().toISOString(),
        metadata: {
          from: email.sender,
          snippet: email.preview,
          labelIds: email.labelIds || [],
        },
      });
    }
  }
  
  console.log(`[normalizeItems] Gmail: ${items.filter(i => i.source === 'gmail').length} items created`);
  
  // Upcoming meetings (<2h)
  if (sourceData.googlecalendar?.upcoming) {
    for (const event of sourceData.googlecalendar.upcoming) {
      items.push({
        source: 'googlecalendar',
        type: 'event-soon',
        sourceId: `calendar:${event.id}`,
        title: event.summary || '(no title)',
        url: event.htmlLink,
        body: event.start?.dateTime || event.start?.date || '',
        createdAt: event.created,
        metadata: {
          location: event.location,
          attendees: event.attendees?.length || 0,
        },
      });
    }
  }
  
  // Today's meetings (>2h)
  if (sourceData.googlecalendar?.today) {
    for (const event of sourceData.googlecalendar.today) {
      if (!items.find(i => i.sourceId === `calendar:${event.id}`)) {
        items.push({
          source: 'googlecalendar',
          type: 'event-today',
          sourceId: `calendar:${event.id}`,
          title: event.summary || '(no title)',
          url: event.htmlLink,
          body: event.start?.dateTime || event.start?.date || '',
          createdAt: event.created,
          metadata: {
            location: event.location,
            attendees: event.attendees?.length || 0,
          },
        });
      }
    }
  }
  
  return items;
}

/**
 * Stage 3: Deduplicate items across sources
 */
export function dedupeItems(items) {
  const seen = new Map();
  const deduped = [];
  let skippedCount = 0;
  
  // Log sample sourceIds (first 3 with actual values)
  if (items.length > 0) {
    console.log(`[dedupeItems] Sample sourceIds from ${items.length} items:`);
    let sampleCount = 0;
    for (const item of items) {
      if (sampleCount >= 3) break;
      if (item.sourceId) {
        console.log(`  - sourceId="${item.sourceId}" source="${item.source}" type="${item.type}" title="${item.title?.substring(0, 40)}"`);
        sampleCount++;
      }
    }
    if (sampleCount === 0) {
      console.warn(`[dedupeItems] WARNING: First 10 items have no sourceId!`);
      items.slice(0, 10).forEach((item, i) => {
        console.warn(`  Item ${i}: keys=${Object.keys(item).join(',')}`);
      });
    }
  }
  
  for (const item of items) {
    // Use sourceId as primary key, but also check URL for cross-source deduplication
    const key = item.sourceId;
    
    if (!key || key === 'undefined' || key.includes('undefined')) {
      console.warn(`[dedupeItems] Item with invalid sourceId: "${item.sourceId}" title="${item.title?.substring(0, 50)}"`);
      skippedCount++;
      continue;
    }
    
    const urlKey = item.url ? (() => { try { const u = new URL(item.url); return u.host + u.pathname + u.search + u.hash; } catch { return item.url; } })() : null;
    
    if (seen.has(key)) {
      // Already seen, skip
      skippedCount++;
      continue;
    }
    
    if (urlKey && seen.has(urlKey)) {
      // Same URL from different source, merge metadata
      const existing = seen.get(urlKey);
      existing.metadata = {
        ...existing.metadata,
        ...item.metadata,
        sources: [...(existing.metadata.sources || [existing.source]), item.source],
      };
      skippedCount++;
      continue;
    }
    
    seen.set(key, item);
    if (urlKey) seen.set(urlKey, item);
    deduped.push(item);
  }
  
  console.log(`[dedupeItems] ${items.length} -> ${deduped.length} (skipped ${skippedCount} duplicates/invalid)`);
  
  return deduped;
}

/**
 * Stage 3.5: Cluster items by project/theme (NEW)
 * Groups items into themed tiles: e.g., "REPO-A · RELEASE" with aggregated stats
 */
export function clusterByProjectTheme(items) {
  const clusters = [];
  
  // Cluster GitHub items by repository
  const githubByRepo = new Map();
  items.filter(i => i.source === 'github').forEach(item => {
    const repo = extractRepoFromItem(item);
    if (!githubByRepo.has(repo)) {
      githubByRepo.set(repo, []);
    }
    githubByRepo.get(repo).push(item);
  });
  
  // Create a cluster card for each repo with multiple items
  for (const [repo, repoItems] of githubByRepo) {
    if (repoItems.length === 0) continue;
    
    const prCount = repoItems.filter(i => i.type.includes('pr')).length;
    const issueCount = repoItems.filter(i => i.type.includes('issue')).length;
    const reviewCount = repoItems.filter(i => i.type === 'pr-review').length;
    const myPRCount = repoItems.filter(i => i.type === 'pr-mine').length;
    
    // Determine priority and status
    const hasUrgent = repoItems.some(i => i.type === 'pr-review');
    const priority = hasUrgent ? 'urgent' : prCount + issueCount > 3 ? 'high' : 'medium';
    
    // Pick top 3 items for highlights
    const sortedItems = [...repoItems].sort((a, b) => {
      const typeScore = { 'pr-review': 3, 'pr-assigned': 2, 'issue-assigned': 2, 'pr-mine': 1 };
      return (typeScore[b.type] || 0) - (typeScore[a.type] || 0);
    });
    const topItems = sortedItems.slice(0, 3);
    
    // Extract repo name parts for title
    const [owner, name] = repo.split('/');
    const projectName = (name || repo).toUpperCase();
    
    // Use date-based sourceId to avoid replacing old individual items
    const today = new Date().toISOString().split('T')[0];
    
    clusters.push({
      id: `cluster_github_${repo.replace(/\//g, '_')}_${Date.now()}`,
      type: 'project-cluster',
      source: 'github',
      sourceId: `github:cluster:${repo}:${today}`,
      title: projectName,
      subtitle: owner ? `${owner}` : '',
      body: `目前有 ${prCount} 个 PR、${issueCount} 个 issue 待跟进。`,
      url: `https://github.com/${repo}`,
      priority,
      status: reviewCount > 0 ? 'needs-review' : 'active',
      clusterSize: repoItems.length,
      items: repoItems,
      topItems,
      metadata: {
        repo,
        prCount,
        issueCount,
        reviewCount,
        myPRCount,
        labels: [...new Set(repoItems.flatMap(i => i.metadata?.labels || []))],
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  
  console.log(`[Clustering] GitHub: ${githubByRepo.size} repo clusters from ${items.filter(i => i.source === 'github').length} items`);
  
  // Cluster Gmail with smart categorization
  const emailItems = items.filter(i => i.source === 'gmail');
  const githubNotifications = [];
  const newsletters = [];
  const emailBySender = new Map();
  
  emailItems.forEach(item => {
    const sender = item.metadata?.from || 'unknown';
    const senderName = extractSenderName(sender);
    const subject = item.title || '';
    
    // Detect GitHub notification emails (e.g., "Re: [acme/repo-a] ... PR #1915")
    const githubRepoMatch = subject.match(/\[([\w-]+\/[\w-]+)\]/);
    if (githubRepoMatch || sender.includes('notifications@github.com')) {
      const repo = githubRepoMatch ? githubRepoMatch[1] : null;
      item.metadata.githubRepo = repo;
      githubNotifications.push(item);
    }
    // Classify as newsletter
    else if (isNewsletter(sender, subject)) {
      newsletters.push(item);
    }
    // Personal/work emails
    else {
      if (!emailBySender.has(senderName)) {
        emailBySender.set(senderName, []);
      }
      emailBySender.get(senderName).push(item);
    }
  });
  
  // Merge GitHub notification emails into repo clusters
  githubNotifications.forEach(email => {
    const repo = email.metadata.githubRepo;
    if (repo && githubByRepo.has(repo)) {
      // Add email to existing GitHub cluster
      githubByRepo.get(repo).push(email);
      console.log(`  [Clustering] Merged GitHub email into ${repo} tile`);
    } else {
      // No matching repo cluster, keep as email
      const senderName = extractSenderName(email.metadata?.from || 'unknown');
      if (!emailBySender.has(senderName)) {
        emailBySender.set(senderName, []);
      }
      emailBySender.get(senderName).push(email);
    }
  });
  
  // Regenerate GitHub clusters with merged emails
  clusters.length = 0; // Clear previous GitHub clusters
  for (const [repo, repoItems] of githubByRepo) {
    if (repoItems.length === 0) continue;
    
    const prCount = repoItems.filter(i => i.type && i.type.includes('pr')).length;
    const issueCount = repoItems.filter(i => i.type && i.type.includes('issue')).length;
    const reviewCount = repoItems.filter(i => i.type === 'pr-review').length;
    const myPRCount = repoItems.filter(i => i.type === 'pr-mine').length;
    const emailCount = repoItems.filter(i => i.source === 'gmail').length;
    
    const hasUrgent = repoItems.some(i => i.type === 'pr-review');
    const priority = hasUrgent ? 'urgent' : prCount + issueCount > 3 ? 'high' : 'medium';
    
    const sortedItems = [...repoItems].sort((a, b) => {
      const typeScore = { 'pr-review': 3, 'pr-assigned': 2, 'issue-assigned': 2, 'pr-mine': 1, 'email-important': 2 };
      return (typeScore[b.type] || 0) - (typeScore[a.type] || 0);
    });
    const topItems = sortedItems.slice(0, 3);
    
    const [owner, name] = repo.split('/');
    const projectName = (name || repo).toUpperCase();
    const today = new Date().toISOString().split('T')[0];
    
    clusters.push({
      id: `cluster_github_${repo.replace(/\//g, '_')}_${Date.now()}`,
      type: 'project-cluster',
      source: 'github',
      sourceId: `github:cluster:${repo}:${today}`,
      title: projectName,  // Will be replaced with LLM headline
      subtitle: owner ? `${owner}` : '',
      body: `目前有 ${prCount} 个 PR、${issueCount} 个 issue 待跟进${emailCount > 0 ? `，另有 ${emailCount} 封相关通知邮件` : ''}。`,
      url: `https://github.com/${repo}`,
      priority,
      status: reviewCount > 0 ? 'needs-review' : 'active',
      clusterSize: repoItems.length,
      items: repoItems,
      topItems,
      metadata: {
        repo,
        prCount,
        issueCount,
        reviewCount,
        myPRCount,
        emailCount,
        labels: [...new Set(repoItems.filter(i => i.metadata?.labels).flatMap(i => i.metadata.labels))],
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  
  console.log(`[Clustering] GitHub: ${githubByRepo.size} repo clusters (${githubNotifications.length} emails merged)`);
  
  // Create email sender clusters for 2+ emails
  for (const [sender, senderItems] of emailBySender) {
    if (senderItems.length < 2) continue;
    
    const unreadCount = senderItems.filter(i => i.type === 'email-unread').length;
    const importantCount = senderItems.filter(i => i.type === 'email-important').length;
    const today = new Date().toISOString().split('T')[0];
    
    clusters.push({
      id: `cluster_gmail_${sender.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}`,
      type: 'email-cluster',
      source: 'gmail',
      sourceId: `gmail:cluster:${sender}:${today}`,
      title: (lastGithubIdentity?.name && sender === lastGithubIdentity.name) ? '我自己发出/抄送的邮件' : `${sender} 的邮件`,
      subtitle: 'Emails',
      body: `最近 24h 收到 ${senderItems.length} 封邮件${unreadCount > 0 ? `，其中 ${unreadCount} 封未读` : ''}`,
      url: `https://mail.google.com/mail/u/0/#search/from:${encodeURIComponent(sender)}`,
      priority: importantCount > 0 ? 'high' : 'medium',
      status: 'active',
      clusterSize: senderItems.length,
      items: senderItems,
      topItems: senderItems.slice(0, 3),
      metadata: {
        sender,
        unreadCount,
        importantCount,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  
  console.log(`[Clustering] Gmail: ${emailBySender.size} sender clusters from ${emailItems.length - githubNotifications.length} emails`);
  
  // Newsletter digest cluster
  if (newsletters.length > 1) {
    const today = new Date().toISOString().split('T')[0];
    
    clusters.push({
      id: `cluster_gmail_newsletters_${Date.now()}`,
      type: 'newsletter-cluster',
      source: 'gmail',
      sourceId: `gmail:newsletters:${today}`,
      title: 'Newsletters & Updates',
      subtitle: '',
      body: `${newsletters.length} newsletters`,
      url: `https://mail.google.com/mail/u/0/#inbox`,
      priority: 'low',
      status: 'active',
      clusterSize: newsletters.length,
      items: newsletters,
      topItems: newsletters.slice(0, 3),
      metadata: {
        sources: [...new Set(newsletters.map(n => extractSenderName(n.metadata?.from || '')))],
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    
    console.log(`[Clustering] Gmail: ${newsletters.length} newsletters in digest tile`);
  }
  
  // Email categories donut (if we have enough variety)
  const categories = {
    'GitHub': githubNotifications.length,
    'Newsletters': newsletters.length,
    'People': emailItems.length - githubNotifications.length - newsletters.length,
  };
  
  if (emailItems.length > 5) {
    const today = new Date().toISOString().split('T')[0];
    clusters.push({
      id: `cluster_gmail_categories_${Date.now()}`,
      type: 'email-categories',
      source: 'gmail',
      sourceId: `gmail:categories:${today}`,
      title: 'Email Overview',
      subtitle: '',
      body: `${emailItems.length} emails by category`,
      url: `https://mail.google.com/mail/u/0/#inbox`,
      priority: 'low',
      status: 'active',
      clusterSize: emailItems.length,
      items: emailItems.slice(0, 5),
      topItems: [],
      metadata: {
        categories,
      },
      blocks: [{
        type: 'chart',
        chartType: 'donut',
        data: Object.values(categories).filter(v => v > 0),
        labels: Object.keys(categories).filter(k => categories[k] > 0),
      }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    
    console.log(`[Clustering] Gmail: category donut (GitHub:${categories.GitHub}, News:${categories.Newsletters}, People:${categories.People})`);
  }
  
  // Slack: cluster per channel / DM
  const slackItems = items.filter(i => i.source === 'slack');
  const byChan = new Map();
  for (const it of slackItems) { const k = it.metadata.channelId || 'unknown'; if (!byChan.has(k)) byChan.set(k, []); byChan.get(k).push(it); }
  for (const [chanId, chItems] of byChan) {
    const m0 = chItems[0].metadata;
    const people = [...new Set(chItems.map(i => i.metadata.user).filter(Boolean))];
    const today = new Date().toISOString().split('T')[0];
    clusters.push({
      id: `cluster_slack_${chanId}_${Date.now()}`,
      type: 'slack-cluster', source: 'slack', sourceId: `slack:cluster:${chanId}:${today}`,
      title: m0.isDm ? `私信 · ${people[0] || ''}` : `#${m0.channelName}`,
      subtitle: m0.workspace || 'Slack',
      body: `最近 24h 有 ${chItems.length} 条消息${people.length ? `，来自 ${people.slice(0, 3).join('、')}${people.length > 3 ? ` 等 ${people.length} 人` : ''}` : ''}。`,
      url: chItems[0].url, priority: m0.isDm ? 'high' : chItems.length >= 5 ? 'medium' : 'low', status: 'active',
      clusterSize: chItems.length, items: chItems, topItems: chItems.slice(0, 3),
      metadata: { channel: m0.channelName, isDm: m0.isDm, people, messageCount: chItems.length },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  }
  if (slackItems.length) console.log(`[Clustering] Slack: ${byChan.size} channel clusters from ${slackItems.length} messages`);

  // Calendar events: cluster today's events
  const calendarItems = items.filter(i => i.source === 'googlecalendar');
  if (calendarItems.length > 0) {
    const upcomingCount = calendarItems.filter(i => i.type === 'event-soon').length;
    const todayCount = calendarItems.filter(i => i.type === 'event-today').length;
    
    const today = new Date().toISOString().split('T')[0];
    
    clusters.push({
      id: `cluster_calendar_today_${Date.now()}`,
      type: 'calendar-cluster',
      source: 'googlecalendar',
      sourceId: `calendar:today:${today}`,
      title: "Today's Schedule",
      subtitle: '',
      body: `${todayCount} events${upcomingCount > 0 ? `, ${upcomingCount} starting soon` : ''}`,
      url: `https://calendar.google.com`,
      priority: upcomingCount > 0 ? 'urgent' : 'medium',
      status: 'active',
      clusterSize: calendarItems.length,
      items: calendarItems,
      topItems: calendarItems.slice(0, 5),
      metadata: {
        upcomingCount,
        todayCount,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    
    console.log(`[Clustering] Calendar: ${calendarItems.length} events in today cluster`);
  }
  
  // Add remaining individual items that didn't cluster
  const clusteredSourceIds = new Set(
    clusters.flatMap(c => c.items.map(i => i.sourceId))
  );
  
  let singleCount = 0;
  items.forEach(item => {
    if (!clusteredSourceIds.has(item.sourceId)) {
      // Convert to cluster format for consistency
      clusters.push({
        id: `cluster_single_${item.sourceId}_${Date.now()}`,
        type: 'single-item',
        source: item.source,
        sourceId: item.sourceId,
        title: item.title,
        subtitle: '',
        body: item.body,
        url: item.url,
        priority: 'medium',
        status: 'active',
        clusterSize: 1,
        items: [item],
        topItems: [item],
        metadata: item.metadata,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      });
      singleCount++;
    }
  });
  
  console.log(`[Clustering] Total: ${clusters.length} tiles (${clusters.length - singleCount} multi-item clusters + ${singleCount} single items)`);
  
  return clusters;
}

/**
 * Helper: Extract repo name from GitHub item
 */
function extractRepoFromItem(item) {
  // Try metadata first
  if (item.metadata?.repository) return item.metadata.repository;
  
  // Extract from URL
  const match = item.url?.match(/github\.com\/([^\/]+\/[^\/]+)/);
  if (match) return match[1];
  
  // Extract from body (e.g., "#42 in owner/repo")
  const bodyMatch = item.body?.match(/in ([^\/\s]+\/[^\/\s]+)/);
  if (bodyMatch) return bodyMatch[1];
  
  return 'unknown';
}

/**
 * Helper: Extract sender name from email address
 */
function extractSenderName(sender) {
  // "John Doe <john@example.com>" -> "John Doe"
  // "john@example.com" -> "john"
  const nameMatch = sender.match(/^([^<]+)</);
  if (nameMatch) return nameMatch[1].trim();
  
  const emailMatch = sender.match(/^([^@]+)@/);
  if (emailMatch) return emailMatch[1].trim();
  
  return sender;
}

/**
 * Helper: Detect newsletters
 */
function isNewsletter(sender, subject) {
  const newsletterPatterns = [
    /no-?reply@/i,
    /newsletter/i,
    /digest/i,
    /updates@/i,
    /notifications@/i,
    /noreply/i,
    /@substack\.com/i,
    /@medium\.com/i,
  ];
  
  return newsletterPatterns.some(p => p.test(sender) || p.test(subject));
}

/**
 * Stage 4: Classify each cluster (needs-action-urgent/needs-action/fyi/noise)
 * Classify based on cluster priority and content
 */
export function classifyClusters(clusters) {
  const classified = clusters.map(cluster => {
    let category = 'fyi';
    let score = 50;
    let reasoning = '';
    
    // Project clusters with reviews: urgent
    if (cluster.type === 'project-cluster' && cluster.metadata?.reviewCount > 0) {
      category = 'needs-action-urgent';
      score = 95;
      reasoning = `${cluster.metadata.reviewCount} PR review${cluster.metadata.reviewCount > 1 ? 's' : ''} needed`;
    }
    // Project clusters with assignments: action needed
    else if (cluster.type === 'project-cluster' && (cluster.metadata?.prCount > 0 || cluster.metadata?.issueCount > 0)) {
      category = 'needs-action';
      score = 80;
      reasoning = `${cluster.metadata.prCount + cluster.metadata.issueCount} active items`;
    }
    // Email clusters with important: action needed
    else if (cluster.type === 'email-cluster' && cluster.metadata?.importantCount > 0) {
      category = 'needs-action';
      score = 85;
      reasoning = `${cluster.metadata.importantCount} important email${cluster.metadata.importantCount > 1 ? 's' : ''}`;
    }
    // Email clusters with unread: fyi
    else if (cluster.type === 'email-cluster' && cluster.metadata?.unreadCount > 0) {
      category = 'fyi';
      score = 60;
      reasoning = `${cluster.metadata.unreadCount} unread`;
    }
    // Newsletter cluster: low priority
    else if (cluster.type === 'newsletter-cluster') {
      category = 'fyi';
      score = 40;
      reasoning = 'Newsletters';
    }
    else if (cluster.type === 'slack-cluster') {
      category = cluster.metadata?.isDm ? 'needs-action' : 'fyi';
      score = cluster.metadata?.isDm ? 82 : 55 + Math.min(20, cluster.clusterSize);
      reasoning = `${cluster.clusterSize} Slack messages`;
    }
    // Calendar cluster with upcoming: urgent
    else if (cluster.type === 'calendar-cluster' && cluster.metadata?.upcomingCount > 0) {
      category = 'needs-action-urgent';
      score = 98;
      reasoning = `${cluster.metadata.upcomingCount} event${cluster.metadata.upcomingCount > 1 ? 's' : ''} starting soon`;
    }
    // Calendar cluster today: action needed
    else if (cluster.type === 'calendar-cluster') {
      category = 'needs-action';
      score = 75;
      reasoning = "Today's events";
    }
    // Single items: classify based on original type
    else if (cluster.type === 'single-item' && cluster.items[0]) {
      const item = cluster.items[0];
      if (item.type === 'pr-review') {
        category = 'needs-action-urgent';
        score = 95;
        reasoning = 'Review requested';
      } else if (item.type === 'issue-assigned' || item.type === 'pr-assigned') {
        category = 'needs-action';
        score = 80;
        reasoning = 'Assigned to you';
      } else if (item.type === 'email-important') {
        category = 'needs-action';
        score = 85;
        reasoning = 'Important email';
      } else if (item.type === 'event-soon') {
        category = 'needs-action-urgent';
        score = 98;
        reasoning = 'Starting soon';
      } else {
        category = 'fyi';
        score = 55;
        reasoning = 'For your information';
      }
    }
    
    return {
      ...cluster,
      classification: {
        category,
        score,
        reasoning,
      },
    };
  });
  
  return classified;
}

/**
 * Stage 5: Group and rank clusters
 */
export function groupAndRank(classified) {
  // Sort by category priority then score
  const categoryOrder = {
    'needs-action-urgent': 0,
    'needs-action': 1,
    'fyi': 2,
    'noise': 3,
  };
  
  const sorted = [...classified].sort((a, b) => {
    const catDiff = categoryOrder[a.classification.category] - categoryOrder[b.classification.category];
    if (catDiff !== 0) return catDiff;
    return b.classification.score - a.classification.score;
  });
  
  // Group by category for display
  const grouped = {
    urgent: sorted.filter(c => c.classification.category === 'needs-action-urgent'),
    action: sorted.filter(c => c.classification.category === 'needs-action'),
    fyi: sorted.filter(c => c.classification.category === 'fyi'),
  };
  
  return grouped;
}

/**
 * Stage 6: Generate brief with LLM using clustered data
 * Generates rich project-themed cards with stats, charts, and action buttons
 */
export async function writeBrief(grouped, llmClient, profileContext) {
  const promptTemplate = await readFile(join(__dirname, 'prompts/write-brief.md'), 'utf-8');
  
  // Build clusters summary for LLM
  const clustersSummary = {
    urgent: grouped.urgent.map(c => ({
      title: c.title,
      subtitle: c.subtitle,
      body: c.body,
      source: c.source,
      url: c.url,
      reasoning: c.classification.reasoning,
      clusterSize: c.clusterSize,
      metadata: c.metadata,
      topItems: c.topItems.map(i => ({ title: i.title, url: i.url })),
    })),
    action: grouped.action.map(c => ({
      title: c.title,
      subtitle: c.subtitle,
      body: c.body,
      source: c.source,
      url: c.url,
      reasoning: c.classification.reasoning,
      clusterSize: c.clusterSize,
      metadata: c.metadata,
      topItems: c.topItems.map(i => ({ title: i.title, url: i.url })),
    })),
    fyi: grouped.fyi.slice(0, 10).map(c => ({
      title: c.title,
      subtitle: c.subtitle,
      body: c.body,
      source: c.source,
      url: c.url,
      reasoning: c.classification.reasoning,
      clusterSize: c.clusterSize,
      metadata: c.metadata,
    })),
  };
  
  const prompt = promptTemplate
    .replace('{{items}}', JSON.stringify(clustersSummary, null, 2))
    .replace('{{userName}}', resolveDisplayName(profileContext?.name) || '你')
    .replace('{{userRole}}', 'Developer')
    .replace('{{currentTime}}', new Date().toLocaleString('zh-CN'));
  
  // Call LLM
  let fullText = '';
  for await (const chunk of llmClient.stream({
    messages: [
      { role: 'system', content: 'You are a daily briefing assistant. Generate concise, actionable project-themed cards with visual blocks and stats.' },
      { role: 'user', content: prompt },
    ],
    maxTokens: 6000,
    responseFormat: { type: 'json_object' },
  })) {
    if (chunk.type === 'text' && chunk.text) {
      fullText += chunk.text;
    }
  }
  
  const brief = JSON.parse(fullText);
  
  // Convert clusters to cards with deterministic visual blocks
  brief.cards = generateClusterCards(grouped);
  
  return brief;
}

/**
 * Generate rich visual cards from clusters
 * Each card has: title, subtitle, status pill, stat row, mini chart, action button
 */
function generateClusterCards(grouped) {
  const cards = [];
  const allClusters = [...grouped.urgent, ...grouped.action, ...grouped.fyi];
  
  allClusters.forEach((cluster, idx) => {
    const card = {
      id: cluster.id || `card_${Date.now()}_${idx}`,
      sourceId: cluster.sourceId,
      source: cluster.source,
      type: cluster.type,
      title: cluster.title,
      subtitle: cluster.subtitle,
      body: cluster.summary || cluster.body, // Use LLM summary if available
      url: cluster.url,
      priority: cluster.priority,
      status: cluster.status || 'active',
      size: cluster.priority === 'urgent' ? 'large' : cluster.clusterSize > 3 ? 'wide' : 'normal',
      blocks: [],
      actions: [],
      createdAt: cluster.createdAt,
      updatedAt: cluster.updatedAt,
      suggestedQuestions: Array.isArray(cluster.suggestedQuestions) ? cluster.suggestedQuestions.slice(0, 3) : undefined,
    };
    
    // Add status pill for project clusters (Chinese, waiting-on-you vs others)
    if (cluster.type === 'project-cluster') {
      const reviewCount = cluster.metadata.reviewCount || 0;
      const myPRCount = cluster.metadata.myPRCount || 0;
      const openPRs = cluster.items.filter(i => i.type?.includes('pr') && i.metadata?.state === 'open').length
        || cluster.metadata.prCount || 0;
      const mergedPRs = cluster.items.filter(i => i.metadata?.state === 'closed' && i.metadata?.merged_at).length
        || cluster.metadata.mergedCount || 0;
      const openIssues = cluster.metadata.issueCount || 0;
      const waitingOnYou = reviewCount + (cluster.metadata.assignedIssueCount || 0);
      const waitingOnOthers = Math.max(0, (myPRCount || openPRs) - reviewCount);

      const statusText = reviewCount > 0 ? '待你审' :
                        myPRCount > 0 ? '你开的' : '进行中';
      card.blocks.push({
        type: 'tags',
        tags: [
          { text: statusText, color: reviewCount > 0 ? 'red' : 'blue' },
          ...(waitingOnYou ? [{ text: `${waitingOnYou} 件等你`, color: 'orange' }] : []),
          ...(waitingOnOthers ? [{ text: `${waitingOnOthers} 件等别人`, color: 'gray' }] : []),
        ],
      });

      // Dense Chinese-labeled stats
      const stats = [
        { label: '待你审', value: reviewCount, color: '#e2667a', hint: '别人在等你 review' },
        { label: '你开的 PR', value: myPRCount || openPRs, color: '#22a898', hint: '你发起、待推进' },
        { label: '已合并 24h', value: mergedPRs, color: '#00d084', hint: '过去一天合入' },
        { label: '待解决 issue', value: openIssues, color: '#8a74d0', hint: '仍开着的 issue' },
      ].filter(s => s.value > 0);
      if (stats.length) {
        card.blocks.push({ type: 'stat-row', stats });
      }
      // Stacked bar: waiting on you vs others
      if (waitingOnYou || waitingOnOthers) {
        card.blocks.push({
          type: 'chart',
          chartType: 'bar',
          data: [waitingOnYou, waitingOnOthers],
          labels: ['等你', '等别人'],
          color: 'blue',
        });
      }
      
      // Add 7-day activity sparkline from updated_at dates
      const last7Days = [];
      const now = new Date();
      for (let i = 6; i >= 0; i--) {
        const day = new Date(now);
        day.setDate(day.getDate() - i);
        day.setHours(0, 0, 0, 0);
        const dayEnd = new Date(day);
        dayEnd.setHours(23, 59, 59, 999);
        
        const count = cluster.items.filter(item => {
          const date = item.metadata?.updated_at ? new Date(item.metadata.updated_at) : null;
          return date && date >= day && date <= dayEnd;
        }).length;
        
        last7Days.push(count);
      }
      
      card.blocks.push({
        type: 'sparkline',
        data: last7Days,
        label: '最近 7 天活动',
      });
      
      // Add contributor avatars (first 5 unique)
      const contributors = [...new Set(
        cluster.items
          .filter(i => i.metadata?.user?.avatar_url)
          .map(i => i.metadata.user.avatar_url)
      )].slice(0, 5);
      
      if (contributors.length > 0) {
        card.blocks.push({
          type: 'avatars',
          urls: contributors,
        });
      }
      
      // Deep links: up to 5 real items (tile shows 1–3; zoom shows all)
      const topLinks = (cluster.topItems || cluster.items || []).slice(0, 5).map(item => ({
        title: item.title,
        url: item.url,
        type: item.type,
      })).filter(l => l.url);
      if (topLinks.length > 0) {
        card.blocks.push({ type: 'link-list', links: topLinks });
      }

      // Concrete next action + 1–3 deep-link buttons (never invent URLs)
      const actions = [];
      const reviewPRs = (cluster.topItems || []).filter(i => i.type === 'pr-review' && i.url).slice(0, 2);
      if (reviewPRs.length > 0) {
        reviewPRs.forEach(pr => {
          const prNumber = pr.url.match(/\/pull\/(\d+)/)?.[1];
          actions.push({
            label: prNumber ? `先审 #${prNumber}` : '去 review',
            value: pr.url.includes('/files') ? pr.url : pr.url.replace(/\/?$/, '') + '/files',
            primary: true,
          });
        });
        card.nextAction = actions[0].label + (reviewPRs[0].title ? `：${String(reviewPRs[0].title).slice(0, 36)}` : '');
      }
      const assignedIssues = (cluster.topItems || []).filter(i => i.type === 'issue-assigned' && i.url).slice(0, 1);
      if (assignedIssues.length > 0 && actions.length < 2) {
        const issue = assignedIssues[0];
        const issueNumber = issue.url.match(/\/issues\/(\d+)/)?.[1];
        actions.push({
          label: issueNumber ? `处理 issue #${issueNumber}` : '处理 issue',
          value: issue.url,
          primary: false,
        });
        if (!card.nextAction) card.nextAction = actions[actions.length - 1].label;
      }
      const myOpen = (cluster.topItems || []).filter(i => (i.type === 'pr-mine' || i.type === 'pr-mine-recent') && i.url).slice(0, 1);
      if (actions.length === 0 && myOpen.length) {
        const pr = myOpen[0];
        const n = pr.url.match(/\/pull\/(\d+)/)?.[1];
        actions.push({ label: n ? `推进 #${n}` : '推进我的 PR', value: pr.url, primary: true });
        card.nextAction = `先推进「${String(pr.title).slice(0, 36)}」，催 review 或合并`;
      }
      if (actions.length === 0 && cluster.metadata.prCount > 1 && cluster.metadata.repo) {
        actions.push({
          label: `查看 ${cluster.metadata.prCount} 个 PR`,
          value: `https://github.com/${cluster.metadata.repo}/pulls`,
          primary: true,
        });
        card.nextAction = `逐个推进 ${cluster.metadata.prCount} 个 PR 的 review 与合并`;
      }
      if (actions.length === 0 && cluster.url) {
        actions.push({ label: '打开仓库', value: cluster.url, primary: true });
        card.nextAction = card.nextAction || '打开仓库查看最新进展';
      }
      if (!card.nextAction && actions[0]) card.nextAction = actions[0].label;
      card.actions.push(...actions.slice(0, 3));
    }
    
    // Email clusters
    else if (cluster.type === 'email-cluster') {
      card.blocks.push({
        type: 'stat',
        value: cluster.clusterSize,
        label: '封邮件',
      });
      
      if (cluster.metadata.unreadCount > 0) {
        card.blocks.push({
          type: 'tags',
          tags: [{ text: `${cluster.metadata.unreadCount} 封未读`, color: 'orange' }],
        });
      }
      
      // Add tag for timeframe if not all are unread
      if (cluster.clusterSize > cluster.metadata.unreadCount) {
        card.blocks.push({
          type: 'tags',
          tags: [{ text: '最近 24h', color: 'gray' }],
        });
      }
      
      // Add specific action - link to most recent unread email
      const unreadEmail = cluster.items.find(i => i.type === 'email-unread');
      const actions = [];
      
      if (unreadEmail && unreadEmail.metadata?.threadId) {
        actions.push({
          label: `回复 ${cluster.metadata.sender}`,
          value: `https://mail.google.com/mail/u/0/#inbox/${unreadEmail.metadata.threadId}`,
          primary: true,
        });
      } else {
        actions.push({
          label: `查看 ${cluster.metadata.sender} 的邮件`,
          value: cluster.url,
          primary: true,
        });
      }
      
      card.actions.push(...actions);
    }
    
    // Newsletter cluster
    else if (cluster.type === 'newsletter-cluster') {
      card.blocks.push({
        type: 'stat',
        value: cluster.clusterSize,
        label: '封Newsletter',
      });
      
      // Show sources as tags
      if (cluster.metadata.sources && cluster.metadata.sources.length > 0) {
        card.blocks.push({
          type: 'tags',
          tags: cluster.metadata.sources.slice(0, 3).map(s => ({ text: s, color: 'gray' })),
        });
      }
      
      card.actions.push({
        label: '查看',
        value: cluster.url,
        primary: false,
      });
    }
    
    // Email categories donut
    else if (cluster.type === 'email-categories') {
      // Add donut chart block (already in cluster.blocks)
      if (cluster.blocks && cluster.blocks.length > 0) {
        card.blocks.push(...cluster.blocks);
      }
      
      // Add stat row for total
      card.blocks.push({
        type: 'stat',
        value: cluster.clusterSize,
        label: '封邮件总数',
      });
      
      card.actions.push({
        label: '打开收件箱',
        value: cluster.url,
        primary: false,
      });
    }
    
    else if (cluster.type === 'slack-cluster') {
      card.blocks.push({ type: 'stat', value: cluster.clusterSize, label: '条消息' });
      if (cluster.metadata.people?.length) card.blocks.push({ type: 'tags', tags: cluster.metadata.people.slice(0, 3).map(p => ({ text: p, color: 'gray' })) });
      card.actions.push({ label: cluster.metadata.isDm ? '回复私信' : `打开 #${cluster.metadata.channel}`, value: cluster.url, primary: true });
    }
    // Calendar cluster
    else if (cluster.type === 'calendar-cluster') {
      card.blocks.push({
        type: 'stat',
        value: cluster.metadata.todayCount,
        label: '个日程',
      });
      
      if (cluster.metadata.upcomingCount > 0) {
        card.blocks.push({
          type: 'tags',
          tags: [{ text: `${cluster.metadata.upcomingCount} 个即将开始`, color: 'red' }],
        });
      }
      
      // Add timeline
      const timeline = cluster.topItems.map(item => {
        const timeMatch = item.body?.match(/T(\d{2}:\d{2})/);
        const time = timeMatch ? timeMatch[1] : '';
        return { time, title: item.title };
      }).filter(t => t.time);
      
      if (timeline.length > 0) {
        card.blocks.push({
          type: 'timeline',
          items: timeline,
        });
      }
      
      card.actions.push({
        label: '打开日历',
        value: cluster.url,
        primary: true,
      });
    }
    
    // Single items: simpler card
    else if (cluster.type === 'single-item' && cluster.items[0]) {
      const item = cluster.items[0];
      card.blocks.push({
        type: 'tags',
        tags: item.metadata?.labels?.slice(0, 3).map(l => ({ text: l, color: 'blue' })) || [],
      });
      
      card.actions.push({
        label: 'Open',
        value: item.url,
        primary: true,
      });
    }
    
    cards.push(card);
  });
  
  return cards;
}

/**
 * Generate LLM headlines and summaries for project clusters
 * Style: headline in English, summary in Chinese with clear context
 */
async function generateProjectHeadlinesAndSummaries(grouped, llmClient) {
  const projectClusters = [
    ...grouped.urgent.filter(c => c.type === 'project-cluster'),
    ...grouped.action.filter(c => c.type === 'project-cluster'),
    ...grouped.fyi.filter(c => c.type === 'project-cluster'),
  ];
  
  if (projectClusters.length === 0) return;
  
  // Generate headlines and summaries in batch
  for (const cluster of projectClusters.slice(0, 10)) { // Limit to 10 for performance
    try {
      const repoName = cluster.metadata.repo;
      const openPRs = cluster.items.filter(i => i.type?.includes('pr') && i.metadata?.state === 'open').length;
      const mergedPRs = cluster.items.filter(i => i.metadata?.state === 'closed' && i.metadata?.merged_at).length;
      const openIssues = cluster.metadata.issueCount || 0;
      const reviewCount = cluster.metadata.reviewCount || 0;
      
      // Get top items for context
      const topTitles = cluster.topItems.slice(0, 3).map(i => `"${i.title}"`).join(', ');
      
      const prompt = `为代码仓库 ${repoName} 生成一个英文标题和中文摘要。

**活动数据（真实数据，不要编造）**:
- ${openPRs} 个 PR 待处理
- ${mergedPRs} 个 PR 已合并（最近 24h）
- ${openIssues} 个 issue
- ${reviewCount} 个 PR 需要 review
- 热点项目: ${topTitles}

**生成两部分**:
1. **headline**（英文，最多 60 字符）: 简洁描述活动重点
   - 风格示例: "v0.2.14 shipped with new features across 17 PRs"
   - 风格示例: "Major refactor in progress, 5 reviews pending"
   - 风格示例: "Bug fixes merged, 3 critical issues remain open"

2. **summary**（中文，1-2 句话，最多 100 字）: 说明发生了什么、为什么重要
   - 必须基于真实数据（数字、PR 标题）
   - 说明具体工作内容（如果有热点项目名称就提）
   - 说明需要的行动（如果有待 review 的）
   - 示例: "repo-a 过去 24h 合并了 17 个 PR，主要是 task-read-model 重构工作；还有 3 个 PR 等待 review。"
   - 示例: "repo-b 今天没有新 PR，有 2 个 issue 待处理，包括 UI 性能优化。"

JSON: {"headline": "英文标题", "summary": "中文摘要"}`;
      
      let headline = cluster.title; // Fallback
      let summary = `${openPRs} 个 PR 待处理，${openIssues} 个 issue。`;
      
      try {
        let fullText = '';
        for await (const chunk of llmClient.stream({
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 200,
          responseFormat: { type: 'json_object' },
        })) {
          if (chunk.type === 'text' && chunk.text) fullText += chunk.text;
        }
        const parsed = JSON.parse(fullText);
        headline = (parsed.headline || headline).substring(0, 60);
        summary = parsed.summary || summary;
      } catch (err) {
        console.warn(`[Headlines] LLM failed for ${repoName}, using fallback`);
      }
      
      // Update cluster
      cluster.title = headline;
      cluster.summary = summary;
      console.log(`  [Headlines] ${repoName} -> "${headline}"`);
      console.log(`             -> ${summary}`);
      
    } catch (err) {
      console.warn(`[Headlines] Failed for cluster:`, err.message);
    }
  }
}

/**
 * One batched LLM call: 3 card-specific follow-up questions per cluster, grounded in real item titles/people.
 */
async function generateSuggestedQuestions(grouped, llmClient) {
  const all = [...grouped.urgent, ...grouped.action, ...grouped.fyi].slice(0, 30);
  if (!all.length || !llmClient) return;
  const brief = all.map((c, i) => {
    const items = (c.topItems || c.items || []).slice(0, 4).map(it => `「${String(it.title || '').slice(0, 70)}」${it.metadata?.from ? ' from ' + extractSenderName(it.metadata.from) : ''}${it.metadata?.user ? ' by ' + it.metadata.user : ''}`).join('; ');
    return `${i}. [${c.source}/${c.type}] ${c.metadata?.repo || c.title} — ${items}`;
  }).join('\n');
  const prompt = `下面是今天的信息卡片（真实数据）。为每张卡片写 3 个用户可能想追问助手的中文问题（每个 ≤22 字），必须点名卡片里的具体 PR/issue 标题、人名、频道或仓库，不要泛泛而谈，不要编造不存在的条目。可以是"总结/起草回复/判断优先级/下一步"类问题。

${brief}

只输出 JSON: {"cards":[{"i":0,"q":["...","...","..."]}, ...]}`;
  try {
    let text = '';
    for await (const chunk of llmClient.stream({ messages: [{ role: 'user', content: prompt }], maxTokens: 4000, responseFormat: { type: 'json_object' } })) {
      if (chunk.type === 'text' && chunk.text) text += chunk.text;
    }
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : text);
    let n = 0;
    for (const row of parsed.cards || []) {
      const c = all[row.i];
      if (c && Array.isArray(row.q)) { c.suggestedQuestions = row.q.filter(q => typeof q === 'string' && q.trim()).slice(0, 3); n++; }
    }
    console.log(`[Suggestions] card-specific questions for ${n}/${all.length} clusters`);
  } catch (err) {
    console.warn('[Suggestions] LLM failed, client will use domain fallback:', err.message);
  }
}

/**
 * Main aggregation pipeline
 */
export async function runAggregationPipeline(composioClient, activeSources, llmClient, profileContextIn) {
  const profileContext = profileContextIn ? { ...profileContextIn } : {};
  console.log('[Aggregation] Stage 1: Fetching from sources...');
  const sourceData = await fetchFromSources(composioClient, activeSources);
  
  console.log('[Aggregation] Stage 2: Normalizing items...');
  const items = normalizeItems(sourceData);
  console.log(`[Aggregation] Normalized ${items.length} items`);
  
  console.log('[Aggregation] Stage 3: Deduplicating...');
  const deduped = dedupeItems(items);
  console.log(`[Aggregation] Deduped to ${deduped.length} items`);
  
  console.log('[Aggregation] Stage 3.5: Clustering by project/theme...');
  const clusters = clusterByProjectTheme(deduped);
  console.log(`[Aggregation] Clustered into ${clusters.length} themed tiles`);
  
  console.log('[Aggregation] Stage 4: Classifying clusters...');
  const classified = classifyClusters(clusters);
  
  console.log('[Aggregation] Stage 5: Grouping and ranking...');
  const grouped = groupAndRank(classified);
  console.log(`[Aggregation] ${grouped.urgent.length} urgent, ${grouped.action.length} action, ${grouped.fyi.length} fyi clusters`);
  
  console.log('[Aggregation] Stage 5.5: Generating project headlines and summaries...');
  await generateProjectHeadlinesAndSummaries(grouped, llmClient);
  await generateSuggestedQuestions(grouped, llmClient);
  
  console.log('[Aggregation] Stage 6: Writing brief with LLM...');
  profileContext.name = resolveDisplayName(profileContext.name) || '你';
  const brief = await writeBrief(grouped, llmClient, profileContext);
  
  console.log('[Aggregation] Stage 7: Generating hero card...');
  const heroCard = await generateHeroCard(grouped, sourceData, llmClient, profileContext);
  brief.cards.unshift(heroCard);
  
  console.log('[Aggregation] Stage 8: Generating timetable...');
  const timetable = await generateTimetable(grouped, sourceData, llmClient, profileContext);
  brief.cards.splice(1, 0, timetable);
  
  console.log('[Aggregation] Stage 9: Generating achievements tile...');
  const achievements = generateAchievementsTile(sourceData, items);
  if (achievements) brief.cards.push(achievements);
  
  console.log('[Aggregation] Stage 10: Generating inbox overview...');
  const inbox = generateInboxOverview(sourceData);
  if (inbox) brief.cards.push(inbox);
  
  console.log(`[Aggregation] Complete: ${brief.cards.length} cards generated`);
  
  return brief;
}

/**
 * Generate personalized hero greeting card with achievement rings
 */
async function generateHeroCard(grouped, sourceData, llmClient, profileContext) {
  const now = new Date();
  const hour = now.getHours();
  const timeOfDay = hour < 12 ? '早上' : hour < 17 ? '下午' : '晚上';
  const greeting = hour < 12 ? '早上好' : hour < 17 ? '下午好' : '晚上好';
  
  const date = now.toLocaleDateString('zh-CN', { weekday: 'long', month: 'long', day: 'numeric' });
  
  // Calculate today's achievements
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const githubItems = sourceData.github?.all || [];
  
  const prsMergedToday = githubItems.filter(item => 
    item.state === 'closed' && 
    item.merged_at && 
    new Date(item.merged_at) >= todayStart
  ).length;
  
  const issuesClosedToday = githubItems.filter(item => 
    item.closed_at && 
    new Date(item.closed_at) >= todayStart &&
    !item.pull_request
  ).length;
  
  const emailsProcessed = (sourceData.gmail?.all || []).filter(email => 
    !email.labelIds?.includes('UNREAD')
  ).length;
  
  // Build data summary for warm narrative
  const urgentCount = grouped.urgent.length;
  const actionCount = grouped.action.length;
  const meetings = sourceData.googlecalendar?.today?.length || 0;
  const emails = sourceData.gmail?.unread?.length || 0;
  
  const prompt = `为用户生成一条温暖的、个性化的每日叙述（1-2 句话，最多 120 字符）。

**今日数据（真实数据，不要编造）**:
- ${urgentCount} 个紧急事项（需要 review 的 PR、即将开始的会议）
- ${actionCount} 个待处理事项（分配的任务、今天的会议、邮件）
- ${meetings} 个日历事件
- ${emails} 封未读邮件

**用户信息**:
- 姓名: ${profileContext?.name || '你'}
- 常用仓库: ${profileContext?.favoriteRepos?.join('、') || '暂无'}
- 常联系人: ${profileContext?.frequentContacts?.join('、') || '暂无'}
- 最近话题: ${profileContext?.recentTopics?.join('、') || '暂无'}

**要求**:
- 仅基于上述真实数据
- 温暖、鼓励的语气
- 提及具体数字（如果显著）
- 不要空泛的套话
- 最多 120 字符
- 用中文

示例: "今天有 ${actionCount} 件事需要你处理，其中 ${urgentCount} 件比较紧急。让我们一起搞定它们！"

JSON: {"narrative": "你的 1-2 句叙述"}`;

  let narrative = '准备好开启美好的一天！';
  try {
    let fullText = '';
    for await (const chunk of llmClient.stream({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 200,
      responseFormat: { type: 'json_object' },
    })) {
      if (chunk.type === 'text' && chunk.text) fullText += chunk.text;
    }
    const parsed = JSON.parse(fullText);
    narrative = parsed.narrative || narrative;
  } catch (err) {
    console.warn('[HeroCard] LLM failed, using fallback narrative');
  }
  
  return {
    id: `card_hero_${Date.now()}`,
    type: 'hero',
    title: `${date} · ${timeOfDay}`,
    body: `${greeting}, ${profileContext?.name || '你'}`,
    source: 'system',
    sourceId: `hero:${new Date().toISOString().split('T')[0]}`,
    priority: 'high',
    status: 'active',
    size: 'large',
    blocks: [
      {
        type: 'narrative',
        text: narrative,
      },
      {
        type: 'achievement-rings',
        rings: [
          { label: '今日合并 PR', value: prsMergedToday, max: 5, color: '#00d084' },
          { label: '今日关闭 issue', value: issuesClosedToday, max: 3, color: '#4a6cf7' },
          { label: '已读邮件', value: Math.min(emailsProcessed, 10), max: 10, color: '#ffa600' },
        ],
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Generate My Day timetable with real events + LLM suggestions
 */
async function generateTimetable(grouped, sourceData, llmClient, profileContext) {
  const now = new Date();
  const events = sourceData.googlecalendar?.today || [];
  
  // Build fixed blocks from real calendar events
  const fixedBlocks = events.map(event => {
    const start = event.start?.dateTime || event.start?.date;
    const end = event.end?.dateTime || event.end?.date;
    return {
      type: 'fixed',
      start,
      end,
      title: event.summary || 'Event',
      color: 'blue',
    };
  });
  
  // Get top-priority cards for focus blocks
  const topCards = [...grouped.urgent, ...grouped.action].slice(0, 3);
  
  const prompt = `Generate a suggested daily schedule filling gaps between fixed events.

**Fixed Calendar Events** (REAL, do not modify):
${fixedBlocks.map(b => `- ${b.start}: ${b.title}`).join('\n') || '(none)'}

**Top Priority Tasks** (suggest focus blocks):
${topCards.map((c, i) => `${i + 1}. ${c.title} (${c.classification.reasoning})`).join('\n') || '(none)'}

**User Habits**:
- Typical active hours: ${profileContext?.typicalActiveHours?.join(', ') || 'unknown'}
- Name: ${profileContext?.name || '你'}

**Generate suggested blocks** (JSON array):
- Focus blocks for top tasks (1-2h each, during active hours, avoid fixed events)
- Meals: breakfast (8-9am), lunch (12-1pm), dinner (6-7pm) if gaps exist
- Breaks: 15min breaks between long focus blocks
- Exercise: 30-60min if afternoon/evening gap
- Wind-down: 30min before typical sleep time

RULES:
- Start/end times in HH:MM format (24h, Asia/Shanghai timezone)
- Never overlap with fixed events
- Mark all as type: "suggested"
- Titles MUST be short Simplified Chinese (<=14 chars), e.g. "专注：评审 PR #42", "午餐", "散步休息"
- Realistic durations (focus 1-2h, meals 30-60min, breaks 15-30min)
- Respect user's active hours
- If no calendar: still build reasonable schedule from tasks

JSON: {
  "suggestedBlocks": [
    {"type": "suggested", "category": "focus|meal|break|exercise|winddown", "start": "09:00", "end": "11:00", "title": "专注：评审 PR #42", "color": "green"},
    ...
  ]
}`;

  let suggestedBlocks = [];
  try {
    let fullText = '';
    for await (const chunk of llmClient.stream({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 800,
      responseFormat: { type: 'json_object' },
    })) {
      if (chunk.type === 'text' && chunk.text) fullText += chunk.text;
    }
    const parsed = JSON.parse(fullText);
    suggestedBlocks = parsed.suggestedBlocks || [];
  } catch (err) {
    console.warn('[Timetable] LLM failed, using minimal fallback');
    // Fallback: just add lunch and a focus block
    suggestedBlocks = [
      {type: 'suggested', category: 'meal', start: '12:00', end: '13:00', title: 'Lunch break', color: 'orange'},
      {type: 'suggested', category: 'focus', start: '14:00', end: '16:00', title: '专注时段', color: 'green'},
    ];
  }
  
  return {
    id: `card_timetable_${Date.now()}`,
    type: 'timetable',
    title: '我的一天',
    body: events.length > 0 ? `已安排 ${events.length} 个日程` : '规划你的一天',
    source: 'system',
    sourceId: `timetable:${new Date().toISOString().split('T')[0]}`,
    priority: 'high',
    status: 'active',
    size: 'wide',
    blocks: [{
      type: 'timetable',
      fixedBlocks,
      suggestedBlocks,
      nowTime: now.toTimeString().substring(0, 5),
    }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Generate achievements tile with streak and contribution heatmap
 */
function generateAchievementsTile(sourceData, items) {
  const githubItems = sourceData.github?.all || [];
  
  // Calculate total merged PRs
  const mergedPRs = githubItems.filter(i => i.state === 'closed' && i.merged_at).length;
  
  // Calculate streak (consecutive days with activity)
  const activityDates = new Set();
  items.forEach(item => {
    if (item.metadata?.updated_at) {
      const date = new Date(item.metadata.updated_at).toISOString().split('T')[0];
      activityDates.add(date);
    }
  });
  
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 365; i++) {
    const checkDate = new Date(today);
    checkDate.setDate(checkDate.getDate() - i);
    const dateStr = checkDate.toISOString().split('T')[0];
    if (activityDates.has(dateStr)) {
      streak++;
    } else if (i > 0) {
      break; // Streak broken
    }
  }
  
  // Build 8-week contribution heatmap data
  const heatmapData = [];
  for (let week = 0; week < 8; week++) {
    const weekData = [];
    for (let day = 0; day < 7; day++) {
      const checkDate = new Date(today);
      checkDate.setDate(checkDate.getDate() - ((7 - week) * 7 - day));
      const dateStr = checkDate.toISOString().split('T')[0];
      
      const count = items.filter(item => {
        const itemDate = item.metadata?.updated_at ? 
          new Date(item.metadata.updated_at).toISOString().split('T')[0] : null;
        return itemDate === dateStr;
      }).length;
      
      weekData.push({ date: dateStr, count });
    }
    heatmapData.push(weekData);
  }
  
  if (mergedPRs === 0 && streak === 0) return null; // Skip if no data
  
  return {
    id: `card_achievements_${Date.now()}`,
    type: 'achievements-tile',
    title: '成就统计',
    body: `连续活跃 ${streak} 天，已合并 ${mergedPRs} 个 PR`,
    source: 'system',
    sourceId: `achievements:${new Date().toISOString().split('T')[0]}`,
    priority: 'medium',
    status: 'active',
    size: 'wide',
    blocks: [
      {
        type: 'stat-row',
        stats: [
          { label: '已合并 PR', value: mergedPRs, color: '#00d084' },
          { label: '连续活跃天数', value: streak, color: '#4a6cf7' },
        ],
      },
      {
        type: 'heatmap',
        data: heatmapData,
        label: '最近 8 周贡献',
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Generate inbox overview with category donut and top senders bar
 */
function generateInboxOverview(sourceData) {
  const emails = sourceData.gmail?.all || [];
  
  if (emails.length === 0) return null;
  
  // Categorize emails
  const categories = {
    github: 0,
    newsletters: 0,
    personal: 0,
  };
  
  const senders = {};
  
  emails.forEach(email => {
    const sender = email.from || 'unknown';
    const subject = email.subject || '';
    
    // Track sender
    senders[sender] = (senders[sender] || 0) + 1;
    
    // Categorize
    if (sender.includes('notifications@github.com') || subject.match(/\[[\w-]+\/[\w-]+\]/)) {
      categories.github++;
    } else if (isNewsletter(sender, subject)) {
      categories.newsletters++;
    } else {
      categories.personal++;
    }
  });
  
  // Top 5 senders
  const topSenders = Object.entries(senders)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([sender, count]) => ({
      label: extractSenderName(sender),
      value: count,
    }));
  
  return {
    id: `card_inbox_${Date.now()}`,
    type: 'email-categories',
    title: '收件箱概览',
    body: `共 ${emails.length} 封邮件，来自 ${Object.keys(senders).length} 个发件人`,
    source: 'gmail',
    sourceId: `inbox-overview:${new Date().toISOString().split('T')[0]}`,
    priority: 'low',
    status: 'active',
    size: 'normal',
    blocks: [
      {
        type: 'chart',
        chartType: 'donut',
        data: [categories.github, categories.newsletters, categories.personal].filter(v => v > 0),
        labels: ['GitHub', 'Newsletter', '个人邮件'].filter((_, i) => 
          [categories.github, categories.newsletters, categories.personal][i] > 0
        ),
      },
      {
        type: 'chart',
        chartType: 'bar',
        data: topSenders.map(s => s.value),
        labels: topSenders.map(s => s.label),
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
