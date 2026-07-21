import { api, getToken, setToken } from "./api.js";

let currentUser = null;

export function user() {
  return currentUser;
}

export function hasSession() {
  return Boolean(getToken());
}

export async function restoreSession() {
  if (!hasSession()) return null;
  try {
    const data = await api.me();
    currentUser = data.user;
    return currentUser;
  } catch {
    clearSession();
    return null;
  }
}

export function acceptSession(data) {
  setToken(data.token);
  currentUser = data.user;
}

export function clearSession() {
  setToken("");
  currentUser = null;
}

export async function signOut() {
  try {
    if (hasSession()) await api.logout();
  } finally {
    clearSession();
  }
}
