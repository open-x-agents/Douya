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
export async function fetchFromSources(composioClient, activeSources) {
  const sourceData = {};
  
  for (const source of activeSources) {
    const slug = source.toolkit.slug;
    
    try {
      if (slug === 'github') {
        // GitHub: paginate through ALL items in last 48h
        const cutoff = new Date(Date.now() - 48*60*60*1000).toISOString().split('T')[0];
        
        sourceData.github = {
          myPRs: await paginateGitHubSearch(composioClient, `is:pr is:open author:@me`),
          reviewRequested: await paginateGitHubSearch(composioClient, `is:pr is:open review-requested:@me`),
          assigned: await paginateGitHubIssues(composioClient),
          recentActivity: await paginateGitHubSearch(composioClient, `involves:@me updated:>${cutoff}`),
          mentions: await paginateGitHubSearch(composioClient, `mentions:@me is:open`),
        };
        
        const totalGithub = sourceData.github.myPRs.length + sourceData.github.reviewRequested.length + 
                           sourceData.github.assigned.length + sourceData.github.recentActivity.length + 
                           sourceData.github.mentions.length;
        console.log(`[GitHub] Fetched ${totalGithub} items (myPRs:${sourceData.github.myPRs.length}, review:${sourceData.github.reviewRequested.length}, assigned:${sourceData.github.assigned.length}, activity:${sourceData.github.recentActivity.length}, mentions:${sourceData.github.mentions.length})`);
        
      } else if (slug === 'gmail') {
        // Gmail: paginate through ALL messages from last 24h
        const yesterday = new Date(Date.now() - 24*60*60*1000).toISOString().split('T')[0].replace(/-/g, '/');
        
        sourceData.gmail = {
          unread: await paginateGmail(composioClient, 'in:inbox is:unread'),
          recent: await paginateGmail(composioClient, `in:inbox after:${yesterday}`),
          important: await paginateGmail(composioClient, 'in:inbox is:important'),
        };
        
        console.log(`[Gmail] Fetched ${sourceData.gmail.recent.length} recent messages (${sourceData.gmail.unread.length} unread, ${sourceData.gmail.important.length} important)`);
        
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
  
  while (true) {
    try {
      const result = await composioClient.executeAction('GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS', {
        q: query,
        per_page: perPage,
        page,
      });
      
      const batch = result?.data?.items || [];
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
      console.warn(`[GitHub] Pagination failed at page ${page}:`, err.message);
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
      
      const batch = result?.data?.issues || result?.data?.items || [];
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
 * Helper: Paginate Gmail (uncapped)
 */
async function paginateGmail(composioClient, query) {
  const messages = [];
  let pageToken = null;
  const maxResults = 100;
  
  while (true) {
    try {
      const params = {
        max_results: maxResults,
        query,
      };
      if (pageToken) params.page_token = pageToken;
      
      const result = await composioClient.executeAction('GMAIL_FETCH_EMAILS', params);
      
      const batch = result?.data?.messages || [];
      if (batch.length === 0) break;
      
      messages.push(...batch);
      
      pageToken = result?.data?.nextPageToken;
      if (!pageToken) break;
      
      // Safety: stop after 500 messages
      if (messages.length >= 500) {
        console.warn(`[Gmail] Hit pagination limit (500 messages) for query: ${query}`);
        break;
      }
    } catch (err) {
      console.warn(`[Gmail] Pagination failed:`, err.message);
      break;
    }
  }
  
  return messages;
}

/**
 * Stage 2: Normalize heterogeneous source data into uniform items
 */
export function normalizeItems(sourceData) {
  const items = [];
  
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
  if (sourceData.github?.myPRs) {
    for (const pr of sourceData.github.myPRs) {
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
        },
      });
    }
  }
  
  // Important emails
  if (sourceData.gmail?.important) {
    for (const email of sourceData.gmail.important) {
      // Gmail uses messageId or threadId, not id
      const emailId = email.messageId || email.threadId || email.id;
      items.push({
        source: 'gmail',
        type: 'email-important',
        sourceId: `gmail:${emailId}`,
        title: email.subject || '(no subject)',
        url: `https://mail.google.com/mail/u/0/#inbox/${emailId}`,
        body: `From: ${email.from || 'unknown'}`,
        createdAt: email.internalDate ? new Date(parseInt(email.internalDate)).toISOString() : null,
        metadata: {
          from: email.from,
          snippet: email.snippet,
        },
      });
    }
  }
  
  // Unread emails (lower priority)
  if (sourceData.gmail?.unread) {
    for (const email of sourceData.gmail.unread.slice(0, 10)) {
      const emailId = email.messageId || email.threadId || email.id;
      if (!items.find(i => i.sourceId === `gmail:${emailId}`)) {
        items.push({
          source: 'gmail',
          type: 'email-unread',
          sourceId: `gmail:${emailId}`,
          title: email.subject || '(no subject)',
          url: `https://mail.google.com/mail/u/0/#inbox/${emailId}`,
          body: `From: ${email.from || 'unknown'}`,
          createdAt: email.internalDate ? new Date(parseInt(email.internalDate)).toISOString() : null,
          metadata: {
            from: email.from,
            snippet: email.snippet,
          },
        });
      }
    }
  }
  
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
  
  for (const item of items) {
    // Use sourceId as primary key, but also check URL for cross-source deduplication
    const key = item.sourceId;
    const urlKey = item.url ? new URL(item.url).pathname : null;
    
    if (seen.has(key)) {
      // Already seen, skip
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
      continue;
    }
    
    seen.set(key, item);
    if (urlKey) seen.set(urlKey, item);
    deduped.push(item);
  }
  
  return deduped;
}

/**
 * Stage 3.5: Cluster items by project/theme (NEW)
 * Groups items into themed tiles: e.g., "FLYBOT · RELEASE" with aggregated stats
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
    
    clusters.push({
      id: `cluster_github_${repo.replace(/\//g, '_')}`,
      type: 'project-cluster',
      source: 'github',
      sourceId: `github:repo:${repo}`,
      title: projectName,
      subtitle: owner ? `${owner}` : '',
      body: `${prCount} PRs, ${issueCount} issues`,
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
  
  // Cluster Gmail by sender category
  const emailItems = items.filter(i => i.source === 'gmail');
  const emailBySender = new Map();
  const newsletters = [];
  
  emailItems.forEach(item => {
    const sender = item.metadata?.from || 'unknown';
    const senderName = extractSenderName(sender);
    
    // Classify as newsletter if certain patterns
    if (isNewsletter(sender, item.title)) {
      newsletters.push(item);
    } else {
      if (!emailBySender.has(senderName)) {
        emailBySender.set(senderName, []);
      }
      emailBySender.get(senderName).push(item);
    }
  });
  
  // Create clusters for senders with 2+ emails
  for (const [sender, senderItems] of emailBySender) {
    if (senderItems.length < 2) {
      // Single emails remain as individual items (handled later)
      continue;
    }
    
    const unreadCount = senderItems.filter(i => i.type === 'email-unread').length;
    const importantCount = senderItems.filter(i => i.type === 'email-important').length;
    
    clusters.push({
      id: `cluster_gmail_${sender.replace(/[^a-z0-9]/gi, '_')}`,
      type: 'email-cluster',
      source: 'gmail',
      sourceId: `gmail:sender:${sender}`,
      title: `${sender}`,
      subtitle: 'Emails',
      body: `${senderItems.length} messages${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`,
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
  
  // Newsletter cluster
  if (newsletters.length > 1) {
    clusters.push({
      id: `cluster_gmail_newsletters`,
      type: 'newsletter-cluster',
      source: 'gmail',
      sourceId: `gmail:newsletters`,
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
  }
  
  // Calendar events: cluster today's events
  const calendarItems = items.filter(i => i.source === 'googlecalendar');
  if (calendarItems.length > 0) {
    const upcomingCount = calendarItems.filter(i => i.type === 'event-soon').length;
    const todayCount = calendarItems.filter(i => i.type === 'event-today').length;
    
    clusters.push({
      id: `cluster_calendar_today`,
      type: 'calendar-cluster',
      source: 'googlecalendar',
      sourceId: `calendar:today`,
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
  }
  
  // Add remaining individual items that didn't cluster
  const clusteredSourceIds = new Set(
    clusters.flatMap(c => c.items.map(i => i.sourceId))
  );
  
  items.forEach(item => {
    if (!clusteredSourceIds.has(item.sourceId)) {
      // Convert to cluster format for consistency
      clusters.push({
        id: `cluster_single_${item.sourceId}`,
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
    }
  });
  
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
export async function writeBrief(grouped, llmClient) {
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
    .replace('{{userName}}', 'User')
    .replace('{{userRole}}', 'Developer')
    .replace('{{currentTime}}', new Date().toLocaleString('zh-CN'));
  
  // Call LLM
  let fullText = '';
  for await (const chunk of llmClient.stream({
    messages: [
      { role: 'system', content: 'You are a daily briefing assistant. Generate concise, actionable project-themed cards with visual blocks and stats.' },
      { role: 'user', content: prompt },
    ],
    maxTokens: 2000,
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
      body: cluster.body,
      url: cluster.url,
      priority: cluster.priority,
      status: cluster.status || 'active',
      size: cluster.priority === 'urgent' ? 'large' : cluster.clusterSize > 3 ? 'wide' : 'normal',
      blocks: [],
      actions: [],
      createdAt: cluster.createdAt,
      updatedAt: cluster.updatedAt,
    };
    
    // Add status pill for project clusters
    if (cluster.type === 'project-cluster') {
      const statusText = cluster.metadata.reviewCount > 0 ? 'Needs Review' : 
                        cluster.metadata.myPRCount > 0 ? 'In Progress' : 'Active';
      card.blocks.push({
        type: 'tags',
        tags: [{ text: statusText, color: cluster.metadata.reviewCount > 0 ? 'red' : 'blue' }],
      });
      
      // Add stat row
      const stats = [];
      if (cluster.metadata.prCount > 0) stats.push({ label: 'PRs', value: cluster.metadata.prCount });
      if (cluster.metadata.issueCount > 0) stats.push({ label: 'Issues', value: cluster.metadata.issueCount });
      if (cluster.metadata.reviewCount > 0) stats.push({ label: 'Reviews', value: cluster.metadata.reviewCount });
      
      if (stats.length > 0) {
        stats.forEach(stat => {
          card.blocks.push({ type: 'stat', value: stat.value, label: stat.label });
        });
      }
      
      // Add chart for repos with multiple types
      if (cluster.metadata.prCount > 0 && cluster.metadata.issueCount > 0) {
        card.blocks.push({
          type: 'chart',
          chartType: 'donut',
          data: [cluster.metadata.prCount, cluster.metadata.issueCount],
          labels: ['PRs', 'Issues'],
        });
      }
      
      // Add action button
      card.actions.push({
        label: cluster.metadata.reviewCount > 0 ? 'Review PRs' : 'View Repository',
        value: cluster.url,
        primary: true,
      });
    }
    
    // Email clusters
    else if (cluster.type === 'email-cluster') {
      card.blocks.push({
        type: 'stat',
        value: cluster.clusterSize,
        label: 'Messages',
      });
      
      if (cluster.metadata.unreadCount > 0) {
        card.blocks.push({
          type: 'tags',
          tags: [{ text: `${cluster.metadata.unreadCount} Unread`, color: 'orange' }],
        });
      }
      
      card.actions.push({
        label: 'Open in Gmail',
        value: cluster.url,
        primary: true,
      });
    }
    
    // Newsletter cluster
    else if (cluster.type === 'newsletter-cluster') {
      card.blocks.push({
        type: 'stat',
        value: cluster.clusterSize,
        label: 'Newsletters',
      });
      
      // Show sources as tags
      if (cluster.metadata.sources && cluster.metadata.sources.length > 0) {
        card.blocks.push({
          type: 'tags',
          tags: cluster.metadata.sources.slice(0, 3).map(s => ({ text: s, color: 'gray' })),
        });
      }
      
      card.actions.push({
        label: 'Review',
        value: cluster.url,
        primary: false,
      });
    }
    
    // Calendar cluster
    else if (cluster.type === 'calendar-cluster') {
      card.blocks.push({
        type: 'stat',
        value: cluster.metadata.todayCount,
        label: 'Events',
      });
      
      if (cluster.metadata.upcomingCount > 0) {
        card.blocks.push({
          type: 'tags',
          tags: [{ text: `${cluster.metadata.upcomingCount} Soon`, color: 'red' }],
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
        label: 'Open Calendar',
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
 * Main aggregation pipeline
 */
export async function runAggregationPipeline(composioClient, activeSources, llmClient, profileContext) {
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
  
  console.log('[Aggregation] Stage 6: Writing brief with LLM...');
  const brief = await writeBrief(grouped, llmClient, profileContext);
  
  console.log('[Aggregation] Stage 7: Generating hero card...');
  const heroCard = await generateHeroCard(grouped, sourceData, llmClient, profileContext);
  brief.cards.unshift(heroCard);
  
  console.log('[Aggregation] Stage 8: Generating timetable...');
  const timetable = await generateTimetable(grouped, sourceData, llmClient, profileContext);
  brief.cards.splice(1, 0, timetable);
  
  console.log(`[Aggregation] Complete: ${brief.cards.length} cards generated`);
  
  return brief;
}

/**
 * Generate personalized hero greeting card
 */
async function generateHeroCard(grouped, sourceData, llmClient, profileContext) {
  const now = new Date();
  const hour = now.getHours();
  const timeOfDay = hour < 12 ? 'MORNING' : hour < 17 ? 'AFTERNOON' : 'EVENING';
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  
  const date = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase();
  
  // Build data summary for warm narrative
  const urgentCount = grouped.urgent.length;
  const actionCount = grouped.action.length;
  const meetings = sourceData.googlecalendar?.today?.length || 0;
  const emails = sourceData.gmail?.unread?.length || 0;
  
  const prompt = `Generate a warm, personalized daily narrative (1-2 sentences, max 120 chars) for ${profileContext?.name || 'the user'}.

**Today's Data (REAL, do not fabricate)**:
- ${urgentCount} urgent items (review-requested PRs, imminent meetings)
- ${actionCount} actionable items (assigned tasks, today's meetings, emails)
- ${meetings} calendar events today
- ${emails} unread emails

**User Context**:
- Name: ${profileContext?.name || 'User'}
- Favorite repos: ${profileContext?.favoriteRepos?.join(', ') || 'none yet'}
- Frequent contacts: ${profileContext?.frequentContacts?.join(', ') || 'none yet'}
- Recent topics: ${profileContext?.recentTopics?.join(', ') || 'none yet'}

**Write a warm, honest narrative**:
- Grounded ONLY in the real data above
- Personal, encouraging tone
- Mention specific counts if notable
- No generic platitudes
- Max 120 characters

Example: "${actionCount} items need you today, including ${urgentCount} time-sensitive ones. Let's tackle them together!"

JSON: {"narrative": "your 1-2 sentence narrative here"}`;

  let narrative = 'Ready to make today count!';
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
    body: `${greeting}, ${profileContext?.name || 'there'}`,
    source: 'system',
    sourceId: 'hero',
    priority: 'high',
    status: 'active',
    size: 'large',
    blocks: [{
      type: 'narrative',
      text: narrative,
    }],
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
- Name: ${profileContext?.name || 'User'}

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
- Realistic durations (focus 1-2h, meals 30-60min, breaks 15-30min)
- Respect user's active hours
- If no calendar: still build reasonable schedule from tasks

JSON: {
  "suggestedBlocks": [
    {"type": "suggested", "category": "focus|meal|break|exercise|winddown", "start": "09:00", "end": "11:00", "title": "Focus: Review PR #42", "color": "green"},
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
      {type: 'suggested', category: 'focus', start: '14:00', end: '16:00', title: 'Focus time', color: 'green'},
    ];
  }
  
  return {
    id: `card_timetable_${Date.now()}`,
    type: 'timetable',
    title: 'My Day',
    body: events.length > 0 ? `${events.length} events scheduled` : 'Plan your day',
    source: 'system',
    sourceId: 'timetable',
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
