import { EventEmitter } from 'events';
import type { UserRepository } from './IUserRepository.js';

/**
 * UserService handles all user lifecycle operations.
 *
 * @example
 * const svc = new UserService(repo);
 * const user = await svc.findById('u-1');
 */
export class UserService extends EventEmitter {
  constructor(private readonly repo: UserRepository) {
    super();
  }

  /**
   * Find a user by their unique identifier.
   * @param id - The stable user ID (UUID v4).
   * @returns The user record, or null when not found.
   */
  async findById(id: string): Promise<User | null> {
    const user = await this.repo.findById(id);
    if (!user) return null;
    this.emit('user-fetched', { id });
    return user;
  }

  /** Create a new user and emit `user-created`. */
  async create(input: CreateUserInput): Promise<User> {
    const user = await this.repo.create(input);
    this.emit('user-created', user);
    return user;
  }

  /** Soft-delete a user. Emits `user-deleted`. */
  async delete(id: string): Promise<void> {
    await this.repo.delete(id);
    this.emit('user-deleted', { id });
  }
}

export interface User {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly createdAt: Date;
}

export interface CreateUserInput {
  readonly email: string;
  readonly displayName: string;
}
