import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { keywordRouter } from "./routers/keyword";
import { clientRouter } from "./routers/client";
import { searchTermRouter } from "./routers/searchTerm";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(async (opts) => {
      if (!opts.ctx.user) return null;
      // Lazy-reset quota on every auth.me call
      const { lazyResetQuota } = await import("./_core/quota");
      const updatedUser = await lazyResetQuota(opts.ctx.user);
      return updatedUser;
    }),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),
  keyword: keywordRouter,
  clients: clientRouter,
  searchTerm: searchTermRouter,
});

export type AppRouter = typeof appRouter;
