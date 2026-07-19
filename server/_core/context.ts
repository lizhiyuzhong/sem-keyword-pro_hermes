import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { sdk } from "./sdk";
import { ENV } from "./env";
import * as db from "../db";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
};

/** Mock admin user injected in DEV_MODE. */
const MOCK_ADMIN: User = {
  id: 0,
  openId: "dev-admin",
  name: "Dev Admin",
  email: "dev@localhost",
  loginMethod: "dev",
  role: "admin",
  daily_keyword_count: 0,
  daily_keyword_limit: 1000,
  last_reset_date: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  lastSignedIn: new Date(),
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  // DEV_MODE: skip Manus OAuth, inject mock admin user
  if (ENV.devMode) {
    // Ensure mock user exists in DB (best-effort)
    try {
      await db.upsertUser({
        openId: MOCK_ADMIN.openId,
        name: MOCK_ADMIN.name,
        email: MOCK_ADMIN.email,
        loginMethod: "dev",
        role: "admin",
        lastSignedIn: new Date(),
      });
    } catch {
      // DB may not be available — still return mock user for read-only ops
    }

    return {
      req: opts.req,
      res: opts.res,
      user: MOCK_ADMIN,
    };
  }

  let user: User | null = null;

  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    // Authentication is optional for public procedures.
    user = null;
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
