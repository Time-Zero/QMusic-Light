import type { Account } from '@qmusic/shared-types';
import { asObj, str } from '../qq/mappers';
import { unwrapCgi, type ApiTransport } from '../qq/client';

/** QQ 头像常返回 http:// 链接，统一升级成 https，避免 WebView 混合内容拦截 */
function httpsUrl(url: string): string {
  return url.startsWith('http://') ? `https://${url.slice(7)}` : url;
}

/**
 * 用户资料：老 CGI `fcg_get_profile_homepage.fcg` 已下线（实测 200 空包），
 * 改用 musicu 的 `music.UserInfo.userInfoServer / GetLoginUserInfo`（文档 §3.4）
 */
export class AccountService {
  constructor(private readonly transport: ApiTransport) {}

  async profile(uin: string, base: Account): Promise<Account> {
    try {
      const raw = await this.transport.call({
        module: 'music.UserInfo.userInfoServer',
        method: 'GetLoginUserInfo',
        param: {},
      });
      const data = asObj(unwrapCgi(raw, 'music.UserInfo.userInfoServer/GetLoginUserInfo'));
      const info = asObj(data.info);
      return {
        ...base,
        nickname: str(info.nick, info.nickname, base.nickname, `QQ ${uin}`),
        avatar: httpsUrl(str(info.logo, info.headpic, info.avatar, base.avatar)),
      };
    } catch {
      return base;
    }
  }
}
