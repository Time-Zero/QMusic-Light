import type { Account } from '@qmusic/shared-types';
import { create } from 'zustand';

export type SessionStatus = 'loading' | 'guest' | 'authed';

interface SessionState {
  status: SessionStatus;
  account?: Account;
  /** 登录态过期（续期失败），需要重新扫码 */
  expired: boolean;
  setAccount: (account?: Account) => void;
  setStatus: (status: SessionStatus) => void;
  setExpired: (expired: boolean) => void;
  reset: () => void;
}

export const useSessionStore = create<SessionState>()((set) => ({
  status: 'loading',
  account: undefined,
  expired: false,
  setAccount: (account) =>
    set({ account, status: account ? 'authed' : 'guest', expired: false }),
  setStatus: (status) => set({ status }),
  setExpired: (expired) => set({ expired, status: 'guest' }),
  reset: () => set({ account: undefined, status: 'guest', expired: false }),
}));

export const useAccount = () => useSessionStore((s) => s.account);
export const useIsAuthed = () => useSessionStore((s) => Boolean(s.account));
