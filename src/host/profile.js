/**
 * User profile and preference learning system
 * Tracks interactions, learns patterns, personalizes content
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Default profile structure
 */
export function emptyProfile() {
  return {
    name: '', // resolved at runtime from profile / Composio identity
    preferences: {
      // Learned from data
      topRepos: {},           // {repo: count}
      topSenders: {},         // {sender: count}
      topProjects: {},        // {project: count}
      activeHours: {},        // {hour: count}
      
      // Learned from interactions
      cardInteractions: {
        opened: {},           // {sourceId: count}
        dismissed: {},        // {sourceId: count}
        completed: {},        // {sourceId: count}
      },
      
      // Learned from chat
      chatTopics: [],         // Recent topics
    },
    stats: {
      totalCards: 0,
      totalInteractions: 0,
      lastActive: null,
    },
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Create profile manager
 */
export function createProfileManager(path) {
  let profile = emptyProfile();
  
  return {
    async load() {
      try {
        const data = await readFile(path, 'utf-8');
        profile = { ...emptyProfile(), ...JSON.parse(data) };
      } catch {
        profile = emptyProfile();
      }
      return profile;
    },
    
    get() {
      return profile;
    },
    
    async save(updates) {
      profile = {
        ...profile,
        ...updates,
        lastUpdated: new Date().toISOString(),
      };
      
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(profile, null, 2), 'utf-8');
      return profile;
    },
    
    /**
     * Learn from card data (repos, senders, projects)
     */
    async learnFromCards(cards) {
      const updates = { ...profile };
      
      for (const card of cards) {
        // Track repos
        if (card.source === 'github' && card.url) {
          const repo = card.url.match(/github\.com\/([^\/]+\/[^\/]+)/)?.[1];
          if (repo) {
            updates.preferences.topRepos[repo] = (updates.preferences.topRepos[repo] || 0) + 1;
          }
        }
        
        // Track senders
        if (card.source === 'gmail' && card.metadata?.from) {
          const sender = card.metadata.from.split('<')[0].trim();
          updates.preferences.topSenders[sender] = (updates.preferences.topSenders[sender] || 0) + 1;
        }
        
        // Track projects (from card tags or title patterns)
        if (card.blocks) {
          for (const block of card.blocks) {
            if (block.type === 'tags') {
              for (const tag of block.items || []) {
                updates.preferences.topProjects[tag.label] = (updates.preferences.topProjects[tag.label] || 0) + 1;
              }
            }
          }
        }
      }
      
      // Track active hour
      const hour = new Date().getHours();
      updates.preferences.activeHours[hour] = (updates.preferences.activeHours[hour] || 0) + 1;
      
      updates.stats.totalCards = cards.length;
      updates.stats.lastActive = new Date().toISOString();
      
      await this.save(updates);
      return profile;
    },
    
    /**
     * Track card interaction
     */
    async trackInteraction(sourceId, action) {
      const updates = { ...profile };
      
      if (action === 'open') {
        updates.preferences.cardInteractions.opened[sourceId] = 
          (updates.preferences.cardInteractions.opened[sourceId] || 0) + 1;
      } else if (action === 'dismiss') {
        updates.preferences.cardInteractions.dismissed[sourceId] = 
          (updates.preferences.cardInteractions.dismissed[sourceId] || 0) + 1;
      } else if (action === 'done') {
        updates.preferences.cardInteractions.completed[sourceId] = 
          (updates.preferences.cardInteractions.completed[sourceId] || 0) + 1;
      }
      
      updates.stats.totalInteractions += 1;
      updates.stats.lastActive = new Date().toISOString();
      
      await this.save(updates);
      return profile;
    },
    
    /**
     * Track chat topic
     */
    async trackChatTopic(topic) {
      const updates = { ...profile };
      updates.preferences.chatTopics.unshift(topic);
      updates.preferences.chatTopics = updates.preferences.chatTopics.slice(0, 20);
      await this.save(updates);
      return profile;
    },
    
    /**
     * Get personalization context for LLM
     */
    getPersonalizationContext() {
      const topRepos = Object.entries(profile.preferences.topRepos)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([repo]) => repo);
      
      const topSenders = Object.entries(profile.preferences.topSenders)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([sender]) => sender);
      
      const activeHours = Object.entries(profile.preferences.activeHours)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([hour]) => hour);
      
      return {
        name: profile.name || 'User',
        favoriteRepos: topRepos,
        frequentContacts: topSenders,
        typicalActiveHours: activeHours,
        recentTopics: profile.preferences.chatTopics.slice(0, 5),
      };
    },
  };
}
