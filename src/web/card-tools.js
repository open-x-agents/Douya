/**
 * Chat tools for card manipulation
 */

/**
 * List all today cards
 */
export function createTodayListCardsTool(router) {
  return {
    name: 'today_list_cards',
    description: 'List all cards on the Today page. Use this to see what tasks/events/info the user has.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'done', 'snoozed', 'all'],
          description: 'Filter by status (default: active)',
        },
      },
    },
    execute: async (params) => {
      const result = await router.listCards();
      let cards = result.cards || [];
      
      if (params.status && params.status !== 'all') {
        cards = cards.filter(c => c.status === params.status);
      }
      
      return {
        success: true,
        count: cards.length,
        cards: cards.map(c => ({
          id: c.id,
          title: c.title,
          body: c.body,
          source: c.source,
          type: c.type,
          priority: c.priority,
          status: c.status,
          url: c.url,
        })),
      };
    },
  };
}

/**
 * Create a new card
 */
export function createTodayCreateCardTool(router) {
  return {
    name: 'today_create_card',
    description: 'Create a new card on the Today page. Use when user asks to add a task, reminder, or note.',
    parameters: {
      type: 'object',
      required: ['title'],
      properties: {
        title: {
          type: 'string',
          description: 'Card title (required)',
        },
        body: {
          type: 'string',
          description: 'Card description/details',
        },
        type: {
          type: 'string',
          enum: ['info', 'action', 'task', 'event'],
          description: 'Card type (default: task)',
        },
        priority: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'Priority level (default: medium)',
        },
        url: {
          type: 'string',
          description: 'Related URL',
        },
      },
    },
    execute: async (params) => {
      const result = await router.createCard({
        ...params,
        source: 'manual',
        status: 'active',
      });
      
      if (!result.success) {
        return { success: false, error: result.error };
      }
      
      return {
        success: true,
        message: `创建了卡片：${result.card.title}`,
        card: result.card,
      };
    },
  };
}

/**
 * Update an existing card
 */
export function createTodayUpdateCardTool(router) {
  return {
    name: 'today_update_card',
    description: 'Update an existing card (title, body, priority, status). Use to mark tasks done, change priority, or edit content.',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: {
        id: {
          type: 'string',
          description: 'Card ID to update',
        },
        title: {
          type: 'string',
          description: 'New title',
        },
        body: {
          type: 'string',
          description: 'New body/description',
        },
        priority: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'New priority',
        },
        status: {
          type: 'string',
          enum: ['active', 'done', 'snoozed', 'pinned'],
          description: 'New status',
        },
      },
    },
    execute: async (params) => {
      const { id, ...updates } = params;
      const result = await router.updateCard(id, updates);
      
      if (!result.success) {
        return { success: false, error: result.error };
      }
      
      return {
        success: true,
        message: `更新了卡片：${result.card.title}`,
        card: result.card,
      };
    },
  };
}

/**
 * Delete a card
 */
export function createTodayDeleteCardTool(router) {
  return {
    name: 'today_delete_card',
    description: 'Delete a card from the Today page. Use when user wants to remove a task/note.',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: {
        id: {
          type: 'string',
          description: 'Card ID to delete',
        },
      },
    },
    execute: async (params) => {
      const result = await router.deleteCard(params.id);
      
      if (!result.success) {
        return { success: false, error: result.error };
      }
      
      return {
        success: true,
        message: '已删除卡片',
      };
    },
  };
}

/**
 * Create all today tools
 */
export function createTodayTools(router) {
  return [
    createTodayListCardsTool(router),
    createTodayCreateCardTool(router),
    createTodayUpdateCardTool(router),
    createTodayDeleteCardTool(router),
  ];
}
