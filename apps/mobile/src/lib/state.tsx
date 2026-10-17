import { createContext, useContext, useEffect, useState, useCallback, type PropsWithChildren } from 'react';
import type { Catalog, Session } from '@towncivic/api-contracts';
import type { ApiClient } from './client';
import { ApiFailure } from './client';
import { initializeApi } from './api';
import { Message } from '../components/ui';

interface AppState {
  api: ApiClient;
  catalog: Catalog;
  town: string;
  setTown(value: string): void;
  session: Session | null;
  refreshSession(): Promise<void>;
}
const Context = createContext<AppState | null>(null);
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please retry.';
export function AppProvider({ children }: PropsWithChildren) {
  const [init] = useState(() => {
    try {
      return { api: initializeApi(), error: '' };
    } catch (e) {
      return { api: null, error: errorMessage(e) };
    }
  });
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [town, setTown] = useState('milton-ma');
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState(init.error);
  const [attempt, setAttempt] = useState(0);
  const refreshSession = useCallback(async () => {
    if (!init.api) return;
    try {
      setSession(await init.api.authenticated<Session>('/session'));
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) setSession(null);
      else throw e;
    }
  }, [init.api]);
  useEffect(() => {
    let active = true;
    if (!init.api) return;
    init.api
      .get<Catalog>('/catalog')
      .then((value) => {
        if (!active) return;
        if (value.apiVersion !== 1 || !value.towns.length)
          throw new Error('This server is not compatible with this app.');
        setCatalog(value);
        setTown(value.defaultTown);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [init.api, attempt]);
  useEffect(() => {
    let active = true;
    init.api
      ?.authenticated<Session>('/session')
      .then((value) => {
        if (active) setSession(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [init.api]);
  if (error)
    return (
      <Message
        title="Unable to open TownCivic"
        detail={error}
        retry={
          init.api
            ? () => {
                setError('');
                setAttempt((n) => n + 1);
              }
            : undefined
        }
      />
    );
  if (!catalog || !init.api) return <Message title="Opening TownCivic…" loading />;
  return (
    <Context.Provider value={{ api: init.api, catalog, town, setTown, session, refreshSession }}>
      {children}
    </Context.Provider>
  );
}
export function useApp() {
  const state = useContext(Context);
  if (!state) throw new Error('Missing AppProvider');
  return state;
}
export function useResource<T>(path: string) {
  const { api } = useApp();
  const [attempt, setAttempt] = useState(0);
  const key = `${path}:${attempt}`;
  const [result, setResult] = useState<{ key: string; data: T | null; error: string } | null>(null);
  useEffect(() => {
    let active = true;
    api
      .get<T>(path)
      .then((data) => {
        if (active) setResult({ key, data, error: '' });
      })
      .catch((e) => {
        if (active) setResult({ key, data: null, error: errorMessage(e) });
      });
    return () => {
      active = false;
    };
  }, [api, path, key]);
  const current = result?.key === key ? result : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? '',
    loading: current === null,
    retry: () => setAttempt((n) => n + 1),
  };
}
