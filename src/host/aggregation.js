/**
 * Multi-stage aggregation pipeline for daily digest
 * Inspired by Superhuman/Shortwave email triage, Linear inbox, GitHub notifications
 * 
 * Pipeline: Fetch -> Normalize -> Dedupe -> Classify -> Group -> Write Brief
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Stage 1: Fetch data from all active sources
 */
export async function fetchFromSources(composioClient, activeSources) {
  const sourceData = {};
  
  for (const source of activeSources) {
    const slug = source.toolkit.slug;
    
    try {
      if (slug === 'github') {
        // GitHub: prioritize review-requested > assigned > participating
        const [myPRs, reviewRequested, assigned] = await Promise.all([
          composioClient.executeAction('GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS', {
            q: 'is:pr is:open author:@me',
            per_page: 10,
          }),
          composioClient.executeAction('GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS', {
            q: 'is:pr is:open review-requested:@me',
            per_page: 10,
          }),
          composioClient.executeAction('GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER', {
            per_page: 10,
            state: 'open',
          }),
        ]);
        
        sourceData.github = {
          myPRs: myPRs?.data?.items || [],
          reviewRequested: reviewRequested?.data?.items || [],
          assigned: assigned?.data?.issues || [],
        };
      } else if (slug === 'gmail') {
        // Gmail: unread important emails (from:VIP or to:me)
        const [unread, important] = await Promise.all([
          composioClient.executeAction('GMAIL_FETCH_EMAILS', {
            max_results: 20,
            query: 'in:inbox is:unread',
          }),
          composioClient.executeAction('GMAIL_FETCH_EMAILS', {
            max_results: 10,
            query: 'in:inbox is:important is:unread',
          }),
        ]);
        
        sourceData.gmail = {
          unread: unread?.data?.messages || [],
          important: important?.data?.messages || [],
        };
      } else if (slug === 'googlecalendar') {
        // Calendar: today's events + next 2 hours
        const now = new Date();
        const startOfDay = new Date(now.setHours(0, 0, 0, 0)).toISOString();
        const endOfDay = new Date(now.setHours(23, 59, 59, 999)).toISOString();
        const next2h = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
        
        const [today, upcoming] = await Promise.all([
          composioClient.executeAction('GOOGLECALENDAR_EVENTS_LIST', {
            timeMin: startOfDay,
            timeMax: endOfDay,
            maxResults: 20,
          }),
          composioClient.executeAction('GOOGLECALENDAR_EVENTS_LIST', {
            timeMin: new Date().toISOString(),
            timeMax: next2h,
            maxResults: 5,
          }),
        ]);
        
        sourceData.googlecalendar = {
          today: today?.data?.items || [],
          upcoming: upcoming?.data?.items || [],
        };
      }
    } catch (err) {
      console.warn(`[fetchFromSources] Failed to fetch ${slug}:`, err.message);
    }
  }
  
  return sourceData;
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
 * Stage 4: Classify each item (needs-action-urgent/needs-action/fyi/noise)
 * Using a lightweight rule-based classifier for speed (can be enhanced with LLM later)
 */
export function classifyItems(items) {
  const classified = items.map(item => {
    let category = 'fyi';
    let score = 50;
    let reasoning = '';
    
    // GitHub review-requested: urgent action
    if (item.type === 'pr-review') {
      category = 'needs-action-urgent';
      score = 95;
      reasoning = 'Review requested on your PR';
    }
    // Assigned issues: action needed
    else if (item.type === 'issue-assigned' || item.type === 'pr-assigned') {
      category = 'needs-action';
      score = 80;
      reasoning = 'Assigned to you';
    }
    // My PRs: fyi (check status)
    else if (item.type === 'pr-mine') {
      category = 'fyi';
      score = 60;
      reasoning = 'Your open PR';
    }
    // Important emails: action needed
    else if (item.type === 'email-important') {
      category = 'needs-action';
      score = 85;
      reasoning = 'Important email';
    }
    // Unread emails: fyi
    else if (item.type === 'email-unread') {
      category = 'fyi';
      score = 55;
      reasoning = 'Unread email';
    }
    // Meeting <2h: urgent
    else if (item.type === 'event-soon') {
      const timeUntil = new Date(item.body).getTime() - Date.now();
      if (timeUntil < 30 * 60 * 1000) {
        category = 'needs-action-urgent';
        score = 98;
        reasoning = 'Meeting in <30min';
      } else {
        category = 'needs-action';
        score = 90;
        reasoning = 'Meeting soon';
      }
    }
    // Meeting today: action needed
    else if (item.type === 'event-today') {
      category = 'needs-action';
      score = 70;
      reasoning = 'Meeting today';
    }
    
    return {
      ...item,
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
 * Stage 5: Group and rank items
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
  
  // Group by source for display
  const grouped = {
    urgent: sorted.filter(i => i.classification.category === 'needs-action-urgent'),
    action: sorted.filter(i => i.classification.category === 'needs-action'),
    fyi: sorted.filter(i => i.classification.category === 'fyi'),
  };
  
  return grouped;
}

/**
 * Stage 6: Generate brief with LLM (using write-brief prompt)
 */
export async function writeBrief(grouped, llmClient) {
  const promptTemplate = await readFile(join(__dirname, 'prompts/write-brief.md'), 'utf-8');
  
  // Analyze data for chart opportunities
  const chartOpportunities = analyzeForCharts(grouped);
  
  // Build items summary with chart hints
  const itemsSummary = {
    urgent: grouped.urgent.map(i => ({
      title: i.title,
      body: i.body,
      source: i.source,
      url: i.url,
      reasoning: i.classification.reasoning,
      metadata: i.metadata,
    })),
    action: grouped.action.map(i => ({
      title: i.title,
      body: i.body,
      source: i.source,
      url: i.url,
      reasoning: i.classification.reasoning,
      metadata: i.metadata,
    })),
    fyi: grouped.fyi.slice(0, 10).map(i => ({
      title: i.title,
      body: i.body,
      source: i.source,
      url: i.url,
      reasoning: i.classification.reasoning,
      metadata: i.metadata,
    })),
    chartOpportunities,
  };
  
  const prompt = promptTemplate
    .replace('{{items}}', JSON.stringify(itemsSummary, null, 2))
    .replace('{{userName}}', 'User')
    .replace('{{userRole}}', 'Developer')
    .replace('{{currentTime}}', new Date().toLocaleString('zh-CN'));
  
  // Call LLM
  let fullText = '';
  for await (const chunk of llmClient.stream({
    messages: [
      { role: 'system', content: 'You are a daily briefing assistant. Generate concise, actionable summaries with visual blocks.' },
      { role: 'user', content: prompt },
    ],
    maxTokens: 1500,
    responseFormat: { type: 'json_object' },
  })) {
    if (chunk.type === 'text' && chunk.text) {
      fullText += chunk.text;
    }
  }
  
  const brief = JSON.parse(fullText);
  
  // Add sourceId and metadata to cards
  brief.cards = brief.cards.map((card, idx) => {
    // Find corresponding item to get sourceId
    const item = [...grouped.urgent, ...grouped.action, ...grouped.fyi].find(
      i => i.url === card.url || i.title === card.title
    );
    
    return {
      ...card,
      id: `card_${Date.now()}_${idx}`,
      sourceId: item?.sourceId || `generated_${idx}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  });
  
  return brief;
}

/**
 * Analyze grouped items for chart opportunities
 * Returns suggestions for the LLM to create chart blocks
 */
function analyzeForCharts(grouped) {
  const charts = [];
  
  // GitHub: PRs/issues per repo
  const githubItems = [...grouped.urgent, ...grouped.action, ...grouped.fyi].filter(i => i.source === 'github');
  if (githubItems.length > 2) {
    const repoCount = {};
    githubItems.forEach(item => {
      // Extract repo from metadata or URL
      const repo = item.metadata?.repository || item.url?.match(/github\.com\/([^\/]+\/[^\/]+)/)?.[1];
      if (repo) {
        repoCount[repo] = (repoCount[repo] || 0) + 1;
      }
    });
    
    const topRepos = Object.entries(repoCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    
    if (topRepos.length > 1) {
      charts.push({
        type: 'chart',
        title: 'GitHub items by repository',
        chartType: 'bar',
        data: topRepos.map(([_, count]) => count),
        labels: topRepos.map(([repo]) => repo.split('/')[1] || repo),
        suggestion: `Create a bar chart showing ${topRepos.map(([r, c]) => `${r}: ${c}`).join(', ')}`,
      });
    }
  }
  
  // Gmail: Emails by sender
  const emailItems = [...grouped.urgent, ...grouped.action, ...grouped.fyi].filter(i => i.source === 'gmail');
  if (emailItems.length > 3) {
    const senderCount = {};
    emailItems.forEach(item => {
      const sender = item.metadata?.from || 'Unknown';
      // Extract name before email
      const senderName = sender.split('<')[0].trim() || sender.split('@')[0];
      senderCount[senderName] = (senderCount[senderName] || 0) + 1;
    });
    
    const topSenders = Object.entries(senderCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);
    
    if (topSenders.length > 1) {
      charts.push({
        type: 'chart',
        title: 'Emails by sender',
        chartType: 'bar',
        data: topSenders.map(([_, count]) => count),
        labels: topSenders.map(([sender]) => sender.substring(0, 12)),
        suggestion: `Create a bar chart showing emails from ${topSenders.map(([s, c]) => `${s}: ${c}`).join(', ')}`,
      });
    }
  }
  
  // Calendar: Timeline for today's events
  const calendarItems = [...grouped.urgent, ...grouped.action].filter(i => i.source === 'googlecalendar');
  if (calendarItems.length > 0) {
    const timeline = calendarItems.map(item => {
      const timeMatch = item.body?.match(/(\d{1,2}:\d{2})/);
      const time = timeMatch ? timeMatch[1] : '';
      return { time, title: item.title };
    }).filter(t => t.time);
    
    if (timeline.length > 0) {
      charts.push({
        type: 'timeline',
        title: "Today's schedule",
        items: timeline,
        suggestion: `Create a timeline block with events: ${timeline.map(t => `${t.time} ${t.title}`).join(', ')}`,
      });
    }
  }
  
  return charts;
}

/**
 * Main aggregation pipeline
 */
export async function runAggregationPipeline(composioClient, activeSources, llmClient) {
  console.log('[Aggregation] Stage 1: Fetching from sources...');
  const sourceData = await fetchFromSources(composioClient, activeSources);
  
  console.log('[Aggregation] Stage 2: Normalizing items...');
  const items = normalizeItems(sourceData);
  console.log(`[Aggregation] Normalized ${items.length} items`);
  
  console.log('[Aggregation] Stage 3: Deduplicating...');
  const deduped = dedupeItems(items);
  console.log(`[Aggregation] Deduped to ${deduped.length} items`);
  
  console.log('[Aggregation] Stage 4: Classifying...');
  const classified = classifyItems(deduped);
  
  console.log('[Aggregation] Stage 5: Grouping and ranking...');
  const grouped = groupAndRank(classified);
  console.log(`[Aggregation] ${grouped.urgent.length} urgent, ${grouped.action.length} action, ${grouped.fyi.length} fyi`);
  
  console.log('[Aggregation] Stage 6: Writing brief with LLM...');
  const brief = await writeBrief(grouped, llmClient);
  
  return brief;
}
