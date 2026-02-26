const TOKEN_STORAGE_KEY = "istari.auth.token";
const USER_STORAGE_KEY = "istari.auth.user";

export type StoredUser = {
  id: number;
  email: string;
  full_name?: string | null;
  is_admin: boolean;
};

type AuthStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const safeGetItem = (storage: Storage, key: string): string | null => {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
};

const safeSetItem = (storage: Storage, key: string, value: string): void => {
  try {
    storage.setItem(key, value);
  } catch {
    // Ignore storage write failures (private mode/quota) and allow in-memory flow.
  }
};

const safeRemoveItem = (storage: Storage, key: string): void => {
  try {
    storage.removeItem(key);
  } catch {
    // Ignore storage remove failures.
  }
};

const parseStoredUser = (raw: string | null): StoredUser | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredUser;
  } catch {
    return null;
  }
};

const readSessionFromStorage = (storage: Storage): { token: string; user: StoredUser } | null => {
  const token = safeGetItem(storage, TOKEN_STORAGE_KEY);
  const user = parseStoredUser(safeGetItem(storage, USER_STORAGE_KEY));
  if (!token || !user) return null;
  return { token, user };
};

const getActiveSession = (): { token: string; user: StoredUser } | null => {
  if (typeof window === "undefined") return null;

  // Prefer persistent login when available to avoid stale sessionStorage shadowing it.
  const localSession = readSessionFromStorage(localStorage);
  if (localSession) return localSession;

  return readSessionFromStorage(sessionStorage);
};

export const getAuthToken = (): string | null => getActiveSession()?.token ?? null;
export const hasAuthSession = (): boolean => !!getActiveSession();

export const setAuthSession = (token: string, user: StoredUser, rememberMe = true): void => {
  clearAuthSession();
  if (typeof window === "undefined") return;

  const storage: AuthStorage = rememberMe ? localStorage : sessionStorage;
  safeSetItem(storage as Storage, TOKEN_STORAGE_KEY, token);
  safeSetItem(storage as Storage, USER_STORAGE_KEY, JSON.stringify(user));
};

export const clearAuthSession = (): void => {
  if (typeof window === "undefined") return;

  safeRemoveItem(localStorage, TOKEN_STORAGE_KEY);
  safeRemoveItem(localStorage, USER_STORAGE_KEY);
  safeRemoveItem(sessionStorage, TOKEN_STORAGE_KEY);
  safeRemoveItem(sessionStorage, USER_STORAGE_KEY);
};

export const getStoredUser = (): StoredUser | null => getActiveSession()?.user ?? null;
