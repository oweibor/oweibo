import { OperationalModeService, OperationDisabledError } from '../OperationalModeService';
import type { Pool, PoolClient } from 'pg';

describe('OperationalModeService', () => {
  let mockPool: jest.Mocked<Pool>;
  let mockClient: jest.Mocked<PoolClient>;
  let service: OperationalModeService;

  beforeEach(() => {
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    } as unknown as jest.Mocked<PoolClient>;

    mockPool = {
      query: jest.fn(),
      connect: jest.fn().mockResolvedValue(mockClient),
    } as unknown as jest.Mocked<Pool>;

    service = new OperationalModeService(mockPool);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getMode', () => {
    it('returns 5 on DB error (fail-open)', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('DB Error'));
      const mode = await service.getMode();
      expect(mode).toBe(5);
    });

    it('returns the mode from the DB', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ current_mode: 3 }] } as any);
      const mode = await service.getMode();
      expect(mode).toBe(3);
    });

    it('caches the mode', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ current_mode: 2 }] } as any);
      await service.getMode();
      await service.getMode();
      expect(mockPool.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('isAllowed', () => {
    it('allows gepa_mutations only at mode 5', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ current_mode: 4 }] } as any);
      expect(await service.isAllowed('gepa_mutations')).toBe(false);
      
      service.invalidateCache();
      mockPool.query.mockResolvedValue({ rows: [{ current_mode: 5 }] } as any);
      expect(await service.isAllowed('gepa_mutations')).toBe(true);
    });
  });

  describe('assertAllowed', () => {
    it('throws OperationDisabledError if mode is too low', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ current_mode: 0 }] } as any);
      await expect(service.assertAllowed('cohort_routing')).rejects.toThrow(OperationDisabledError);
    });

    it('does not throw if mode is sufficient', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ current_mode: 5 }] } as any);
      await expect(service.assertAllowed('cohort_routing')).resolves.not.toThrow();
    });
  });

  describe('setMode', () => {
    it('updates mode and writes audit log', async () => {
      // Mock the transaction flow: BEGIN, SELECT FOR UPDATE, UPDATE, INSERT, COMMIT
      mockClient.query
        .mockResolvedValueOnce({ rows: [], command: 'BEGIN', oid: 0, fields: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [{ current_mode: 5 }], command: 'SELECT', oid: 0, fields: [] }) // FOR UPDATE
        .mockResolvedValueOnce({ rows: [], command: 'UPDATE', oid: 0, fields: [] }) // UPDATE
        .mockResolvedValueOnce({ rows: [], command: 'INSERT', oid: 0, fields: [] }) // INSERT
        .mockResolvedValueOnce({ rows: [], command: 'COMMIT', oid: 0, fields: [] }); // COMMIT

      await service.setMode(2, { setBy: 'test_user', reason: 'emergency' });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE oweibo.platform_operational_mode'),
        expect.arrayContaining([2, 'test_user', 'emergency', null])
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO oweibo.operational_mode_transitions'),
        expect.arrayContaining([5, 2, 'test_user', 'emergency', null])
      );
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('rolls back on error', async () => {
      mockClient.query.mockRejectedValueOnce(new Error('BEGIN failed'));
      await expect(service.setMode(2, { setBy: 'test', reason: 'test reason' })).rejects.toThrow('BEGIN failed');
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });
});
