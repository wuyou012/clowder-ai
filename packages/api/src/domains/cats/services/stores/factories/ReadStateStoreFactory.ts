/**
 * ReadState Store Factory (F069)
 * REDIS_URL 有值 → RedisThreadReadStateStore
 * 无 → MemoryThreadReadStateStore (in-process fallback, data lost on restart)
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { IMessageStore } from '../ports/MessageStore.js';
import type {
  IThreadReadStateStore,
  ThreadReadState,
  ThreadUnreadSummary,
} from '../ports/ThreadReadStateStore.js';
import { RedisThreadReadStateStore } from '../redis/RedisThreadReadStateStore.js';

/**
 * In-memory read-state store used when Redis is unavailable (memory mode).
 * State is ephemeral — lost on restart — but prevents 501 errors in development
 * and offline usage.
 */
class MemoryThreadReadStateStore implements IThreadReadStateStore {
  private readonly store = new Map<string, ThreadReadState>();

  private key(userId: string, threadId: string): string {
    return `${userId}::${threadId}`;
  }

  get(userId: string, threadId: string): ThreadReadState | null {
    return this.store.get(this.key(userId, threadId)) ?? null;
  }

  ack(userId: string, threadId: string, messageId: string): boolean {
    const k = this.key(userId, threadId);
    const existing = this.store.get(k);
    if (existing && existing.lastReadMessageId === messageId) return false;
    this.store.set(k, { userId, threadId, lastReadMessageId: messageId, updatedAt: Date.now() });
    return true;
  }

  getUnreadSummaries(
    userId: string,
    threadIds: string[],
    _messageStore: IMessageStore,
  ): ThreadUnreadSummary[] {
    return threadIds.map((threadId) => ({
      threadId,
      unreadCount: 0,
      hasUserMention: false,
    }));
  }

  deleteByThread(threadId: string): void {
    for (const key of this.store.keys()) {
      if (key.endsWith(`::${threadId}`)) this.store.delete(key);
    }
  }
}

export function createReadStateStore(redis?: RedisClient): IThreadReadStateStore {
  if (!redis) return new MemoryThreadReadStateStore();
  return new RedisThreadReadStateStore(redis);
}
