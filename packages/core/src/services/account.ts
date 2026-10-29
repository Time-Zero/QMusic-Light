import type { Account } from '@qmusic/shared-types';
import { asObj, num, str } from '../qq/mappers';
import type { ApiTransport } from '../qq/client';

/** 用户资料走老 CGI（文档 §3.4），g_tk 由平台层用 musickey 计算 */
export class AccountService {
  constructor(private readonly transport: ApiTransport) {}

  async profile(uin: string, base: Account): Promise<Account> {
    try {
      const raw = asObj(
        await this.transport.legacy({
          host: 'c6.y.qq.com',
          path: '/rsc/fcgi-bin/fcg_get_profile_homepage.fcg',
          query: {
            userid: uin,
            format: 'json',
            inCharset: 'utf8',
            outCharset: 'utf-8',
            notice: 0,
            platform: 'yqq.json',
            needNewCode: 0,
          },
        }),
      );
      const data = asObj(raw.data);
      const creator = asObj(data.creator);
      const vip = asObj(creator.vip);
      return {
        ...base,
        nickname: str(creator.nick, creator.nickname, base.nickname, `QQ ${uin}`),
        avatar: str(creator.headpic, creator.avatar, base.avatar),
        encryptUin: str(creator.encrypt_uin, creator.encryptUin, base.encryptUin),
        vipLevel: num(vip.vip_level, vip.level, base.vipLevel),
        vipLabel: str(vip.vip_name, vip.name) || base.vipLabel,
      };
    } catch {
      return base;
    }
  }
}
