import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { clients } from "../../drizzle/schema";

// ---------------------------------------------------------------------------
// Client CRUD router — all operations are scoped to ctx.user.id
// ---------------------------------------------------------------------------
export const clientRouter = router({
  /** List all clients belonging to the current user */
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
    return db
      .select()
      .from(clients)
      .where(eq(clients.userId, ctx.user.id))
      .orderBy(clients.createdAt);
  }),

  /** Get a single client by id, enforcing ownership */
  getById: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const rows = await db
        .select()
        .from(clients)
        .where(and(eq(clients.id, input.id), eq(clients.userId, ctx.user.id)))
        .limit(1);
      if (rows.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "客户档案不存在或无权访问" });
      }
      return rows[0];
    }),

  /** Create a new client profile */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1, "请输入客户名称").max(255),
        businessDirection: z.string().min(1, "请输入业务方向").max(2000),
        businessType: z.enum(["B2B", "B2C"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const result = await db.insert(clients).values({
        userId: ctx.user.id,
        name: input.name,
        businessDirection: input.businessDirection,
        businessType: input.businessType,
      });
      const insertId = (result as any)[0]?.insertId ?? (result as any).insertId;
      const rows = await db
        .select()
        .from(clients)
        .where(eq(clients.id, Number(insertId)))
        .limit(1);
      return rows[0];
    }),

  /** Update an existing client profile (ownership enforced) */
  update: protectedProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(255).optional(),
        businessDirection: z.string().min(1).max(2000).optional(),
        businessType: z.enum(["B2B", "B2C"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      // Verify ownership first
      const existing = await db
        .select()
        .from(clients)
        .where(and(eq(clients.id, input.id), eq(clients.userId, ctx.user.id)))
        .limit(1);
      if (existing.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "客户档案不存在或无权修改" });
      }

      const updateData: Partial<typeof clients.$inferInsert> = {};
      if (input.name !== undefined) updateData.name = input.name;
      if (input.businessDirection !== undefined) updateData.businessDirection = input.businessDirection;
      if (input.businessType !== undefined) updateData.businessType = input.businessType;

      if (Object.keys(updateData).length > 0) {
        await db
          .update(clients)
          .set(updateData)
          .where(and(eq(clients.id, input.id), eq(clients.userId, ctx.user.id)));
      }

      const updated = await db
        .select()
        .from(clients)
        .where(eq(clients.id, input.id))
        .limit(1);
      return updated[0];
    }),

  /** Delete a client profile (ownership enforced) */
  delete: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      // Verify ownership first
      const existing = await db
        .select()
        .from(clients)
        .where(and(eq(clients.id, input.id), eq(clients.userId, ctx.user.id)))
        .limit(1);
      if (existing.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "客户档案不存在或无权删除" });
      }

      await db
        .delete(clients)
        .where(and(eq(clients.id, input.id), eq(clients.userId, ctx.user.id)));
      return { success: true };
    }),
});
