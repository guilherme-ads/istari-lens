const TOKEN_STORAGE_KEY = "istari.auth.token";
const USER_STORAGE_KEY = "istari.auth.user";

export type StoredUser = {
  id: number;
  email: string;
  full_name?: string | null;
  is_admin: boolean;
};

const getFromStorages = (key: string): string | null =>
  sessionStorage.getItem(key) || localStorage.getItem(key);

export const getAuthToken = (): string | null => getFromStorages(TOKEN_STORAGE_KEY);
export const hasAuthSession = (): boolean => !!getAuthToken() && !!getStoredUser();

export const setAuthSession = (token: string, user: StoredUser, rememberMe = true): void => {
  clearAuthSession();
  const storage = rememberMe ? localStorage : sessionStorage;
  storage.setItem(TOKEN_STORAGE_KEY, token);
  storage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
};

export const clearAuthSession = (): void => {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(USER_STORAGE_KEY);
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  sessionStorage.removeItem(USER_STORAGE_KEY);
};

export const getStoredUser = (): StoredUser | null => {
  const raw = getFromStorages(USER_STORAGE_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as StoredUser;
  } catch {
    clearAuthSession();
    return null;
  }
};
