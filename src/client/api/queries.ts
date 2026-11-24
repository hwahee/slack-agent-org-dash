/**
 * TanStack Query bindings for the API catalog (./endpoints.ts).
 *
 * Server state lives exclusively in the query cache — components never copy
 * it into local state. Cache keys are produced only by the key factories
 * (`authKeys`, …) so invalidation stays consistent.
 */
import { useQuery } from '@tanstack/react-query';

import { authApi, sitemapApi } from './endpoints';

const authKeys = {
  me: ['auth', 'me'] as const,
};

/**
 * The signed-in user: `User`, or `null` when signed out. The query errors
 * (404 `NOT_FOUND`) when the server runs without sign-in (`AUTH_DRIVER=none`).
 */
export function useMe() {
  return useQuery({ queryKey: authKeys.me, queryFn: () => authApi.me() });
}

/**
 * Service directory for the footer. It is a deploy-time-ish document, so it
 * is fetched once and kept fresh for the session rather than re-validated on
 * every mount; failures stay silent (the footer degrades to no column).
 */
export function useSitemap() {
  return useQuery({
    queryKey: ['sitemap'] as const,
    queryFn: () => sitemapApi.get(),
    staleTime: 5 * 60_000,
  });
}
