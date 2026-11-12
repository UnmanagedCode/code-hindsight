import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Status } from '@/lib/types';

/** The backend's status, polled. `refresh(true)` also re-reads images and containers. */
export function useStatus(intervalMs = 2000) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async (full = false) => {
    try {
      setStatus(await api<Status>(`-/api/status${full ? '?refresh=1' : ''}`));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void refresh(true);
    const id = setInterval(() => void refresh(false), intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs]);
  return { status, error, refresh };
}
