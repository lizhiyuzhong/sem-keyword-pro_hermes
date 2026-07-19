/**
 * Tests for the clients tRPC router.
 * Uses a mock DB to verify CRUD logic and ownership isolation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vi.mock must NOT reference variables defined in the same scope
// Use a factory that creates fresh mocks per call
// ---------------------------------------------------------------------------
vi.mock("./db", () => {
  const mockDb = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockResolvedValue([]),
    limit: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockResolvedValue([{ insertId: 1 }]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  };
  return {
    getDb: vi.fn().mockResolvedValue(mockDb),
  };
});

// ---------------------------------------------------------------------------
// Import AFTER mocking
// ---------------------------------------------------------------------------
import { getDb } from "./db";
import { clientRouter } from "./routers/client";

// ---------------------------------------------------------------------------
// Helper: create a minimal tRPC caller context
// ---------------------------------------------------------------------------
function makeCtx(userId = 1) {
  return {
    user: { id: userId, name: "Test User", email: "test@example.com", role: "user" as const },
    req: {} as any,
    res: {} as any,
  };
}

describe("clients router", () => {
  let db: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = await getDb();
    // Reset all chain mocks to return `this` by default
    db.select.mockReturnThis();
    db.from.mockReturnThis();
    db.where.mockReturnThis();
    db.orderBy.mockResolvedValue([]);
    db.limit.mockResolvedValue([]);
    db.insert.mockReturnThis();
    db.values.mockResolvedValue([{ insertId: 1 }]);
    db.update.mockReturnThis();
    db.set.mockReturnThis();
    db.delete.mockReturnThis();
  });

  it("list returns empty array when no clients", async () => {
    db.orderBy.mockResolvedValue([]);
    const caller = clientRouter.createCaller(makeCtx());
    const result = await caller.list();
    expect(result).toEqual([]);
  });

  it("list returns rows for the current user", async () => {
    const fakeClient = {
      id: 1,
      userId: 1,
      name: "Test Corp",
      businessDirection: "Software",
      businessType: "B2B",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    db.orderBy.mockResolvedValue([fakeClient]);
    const caller = clientRouter.createCaller(makeCtx());
    const result = await caller.list();
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("Test Corp");
  });

  it("getById returns NOT_FOUND when row is missing", async () => {
    db.limit.mockResolvedValue([]);
    const caller = clientRouter.createCaller(makeCtx());
    await expect(caller.getById({ id: 999 })).rejects.toThrow("客户档案不存在或无权访问");
  });

  it("getById returns the client when found", async () => {
    const fakeClient = {
      id: 5,
      userId: 1,
      name: "Found Corp",
      businessDirection: "Manufacturing",
      businessType: "B2C",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    db.limit.mockResolvedValue([fakeClient]);
    const caller = clientRouter.createCaller(makeCtx());
    const result = await caller.getById({ id: 5 });
    expect(result?.name).toBe("Found Corp");
  });

  it("create inserts and returns the new client", async () => {
    const newClient = {
      id: 1,
      userId: 1,
      name: "New Corp",
      businessDirection: "Logistics",
      businessType: "B2B",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    // values() returns insertId, then select().from().where().limit() returns the new row
    db.values.mockResolvedValue([{ insertId: 1 }]);
    db.limit.mockResolvedValue([newClient]);
    const caller = clientRouter.createCaller(makeCtx());
    const result = await caller.create({
      name: "New Corp",
      businessDirection: "Logistics",
      businessType: "B2B",
    });
    expect(result?.name).toBe("New Corp");
  });

  it("delete throws NOT_FOUND when client does not exist", async () => {
    db.limit.mockResolvedValue([]);
    const caller = clientRouter.createCaller(makeCtx());
    await expect(caller.delete({ id: 42 })).rejects.toThrow("客户档案不存在或无权删除");
  });

  it("delete succeeds when client exists and belongs to user", async () => {
    const fakeClient = {
      id: 7,
      userId: 1,
      name: "To Delete",
      businessDirection: "Retail",
      businessType: "B2C",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    // First call to limit (ownership check) returns the client
    // Second call to where (delete) resolves undefined
    db.limit.mockResolvedValue([fakeClient]);
    // delete chain: db.delete().where() — where returns a promise
    const deleteChain = { where: vi.fn().mockResolvedValue(undefined) };
    db.delete.mockReturnValue(deleteChain);
    const caller = clientRouter.createCaller(makeCtx());
    const result = await caller.delete({ id: 7 });
    expect(result).toEqual({ success: true });
  });

  it("update throws NOT_FOUND when client does not belong to user", async () => {
    db.limit.mockResolvedValue([]);
    const caller = clientRouter.createCaller(makeCtx());
    await expect(
      caller.update({ id: 99, name: "New Name" })
    ).rejects.toThrow("客户档案不存在或无权修改");
  });
});
