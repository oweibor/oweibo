import type { User, CreateUserInput } from './UserService.js';

/** Persistence contract for user records. */
export interface UserRepository {
  findById(id: string): Promise<User | null>;
  create(input: CreateUserInput): Promise<User>;
  delete(id: string): Promise<void>;
  listAll(tenantId: string): Promise<readonly User[]>;
}
