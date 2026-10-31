import { describe, expect, it } from 'vitest';
import {
  activeLineIndex,
  findDailyPlaylistId,
  mapDiss,
  mapFeed,
  mapSongDetail,
  parseLrc,
  toPlaylist,
  toSong,
} from './mappers';

const rawSong = {
  id: 718824583,
  mid: '004EALe94Pdesa',
  name: '雾雨一夜',
  title: '雾雨一夜',
  interval: 156,
  songtype: 0,
  isonly: 0,
  singer: [
    { id: 1, mid: '001', name: 'MISFITS文咏曜' },
    { id: 0, mid: '', name: '法宝' },
  ],
  album: { id: 1, mid: '002MWx8X1YOeA0', name: '雾雨一夜' },
  file: {
    media_mid: '002XAVtz3yW45w',
    size_128mp3: 2510892,
    size_320mp3: 6276590,
    size_flac: 0,
  },
  pay: { pay_play: 1 },
};

describe('歌曲映射', () => {
  it('映射基础字段、封面、media_mid 与最高音质', () => {
    const song = toSong(rawSong);
    expect(song).not.toBeNull();
    expect(song?.mid).toBe('004EALe94Pdesa');
    expect(song?.singers.map((s) => s.name)).toEqual(['MISFITS文咏曜', '法宝']);
    expect(song?.mediaMid).toBe('002XAVtz3yW45w');
    expect(song?.maxQuality).toBe('320');
    expect(song?.cover).toContain('T002R300x300M000002MWx8X1YOeA0');
    expect(song?.duration).toBe(156);
    expect(song?.payPlay).toBe(1);
    expect(song?.playable).toBe(true);
  });

  it('无音源文件时标记为不可播', () => {
    const song = toSong({ ...rawSong, file: { media_mid: 'x' } });
    expect(song?.playable).toBe(false);
    expect(song?.maxQuality).toBeUndefined();
  });

  it('缺少 mid 返回 null，实体解码成正常字符', () => {
    expect(toSong({ name: 'x' })).toBeNull();
    expect(toSong({ ...rawSong, name: 'A &amp; B' })?.name).toBe('A & B');
  });

  it('从 track_info 映射歌曲详情', () => {
    const song = mapSongDetail({ track_info: rawSong });
    expect(song?.name).toBe('雾雨一夜');
  });

  it('歌单里的 songtype 是来源标记，songType 只认 type（0/1）', () => {
    // 实测歌单接口返回 type: 0、songtype: 13；把 13 传给 vkey 会得到 101404 / purl 为空
    expect(toSong({ ...rawSong, type: 0, songtype: 13 })?.songType).toBe(0);
    expect(toSong({ ...rawSong, type: 1, songtype: 13 })?.songType).toBe(1);
    expect(toSong({ ...rawSong, type: undefined, songtype: 13 })?.songType).toBe(0);
  });
});

describe('歌单映射', () => {
  it('映射歌单详情与总数', () => {
    const data = {
      dirinfo: {
        id: 7011264340,
        dirid: 14,
        title: '电子 · 房间里的单人舞池',
        picurl: 'http://qpic.y.qq.com/cover/600',
        desc: '跳舞不需要舞台',
        songnum: 76,
        listennum: 146608,
        host_nick: '穿着皮鞋跳大神',
        tag: [{ name: '电子' }, { name: '跳舞' }],
      },
      songlist: [rawSong],
      total_song_num: 76,
    };
    const result = mapDiss(data);
    expect(result.playlist.title).toBe('电子 · 房间里的单人舞池');
    expect(result.playlist.songCount).toBe(76);
    expect(result.playlist.tags).toEqual(['电子', '跳舞']);
    expect(result.playlist.cover.startsWith('https://')).toBe(true);
    expect(result.songs).toHaveLength(1);
    expect(result.total).toBe(76);
  });

  it('收藏歌单的 Playlist.basic 结构也能映射', () => {
    const playlist = toPlaylist(
      {
        Playlist: {
          basic: {
            tid: 9356905767,
            dirid: 777,
            title: '1000首抖音热歌',
            desc: 'desc',
            cover: { default_url: 'https://p1.music.126.net/x.jpg' },
            song_cnt: 1044,
            play_cnt: 3737674,
            creator: { nick: '张大佛爷' },
            v_tag: [{ name: '流行' }],
          },
        },
      },
      'public',
    );
    expect(playlist?.id).toBe(9356905767);
    expect(playlist?.songCount).toBe(1044);
    expect(playlist?.creator).toBe('张大佛爷');
    expect(playlist?.kind).toBe('public');
  });

  it('自建歌单的 dirName / picUrl / songNum 也能映射', () => {
    const playlist = toPlaylist(
      {
        dirId: 1,
        dirName: '深夜循环',
        tid: 9771376220,
        songNum: 30,
        play_cnt: 12,
        picUrl: 'http://music-file.y.qq.com/a.jpg',
        nick: '',
        v_tag: [],
      },
      'created',
    );
    expect(playlist?.title).toBe('深夜循环');
    expect(playlist?.cover).toBe('https://music-file.y.qq.com/a.jpg');
    expect(playlist?.songCount).toBe(30);
    expect(playlist?.dirid).toBe(1);
    expect(playlist?.kind).toBe('created');
  });

  it('收藏歌单扁平结构的 logo 作为封面', () => {
    const playlist = toPlaylist(
      {
        tid: 1363710122,
        dirId: 1,
        name: '收藏来的歌单',
        songnum: 68,
        logo: 'http://y.qq.com/mediastyle/global/img/playlist_300.png',
        albumPicUrl: 'http://y.gtimg.cn/music/photo_new/T002R300x300M000abc.jpg',
        nickname: 'someone',
        dirType: 0,
      },
      'collected',
    );
    expect(playlist?.title).toBe('收藏来的歌单');
    expect(playlist?.cover).toBe('https://y.qq.com/mediastyle/global/img/playlist_300.png');
    expect(playlist?.creator).toBe('someone');
    expect(playlist?.songCount).toBe(68);
  });
});

describe('推荐流映射', () => {
  const feed = {
    v_shelf: [
      {
        id: 203,
        v_niche: [
          {
            v_card: [
              {
                type: 500,
                id: '7110294730',
                title: '致当年暗恋的我',
                cover: 'https://qpic.y.qq.com/x/300?n=1',
                miscellany: { cnt_content: '101.2W 播放' },
              },
              { type: 300, id: 'video', title: '视频' },
            ],
          },
        ],
      },
      {
        id: 302,
        v_niche: [
          {
            v_card: [{ type: 700, id: 'daily', title: '每日30首', miscellany: {} }],
          },
        ],
      },
    ],
  };

  it('过滤未支持的卡片类型，并给出货架兜底标题', () => {
    const sections = mapFeed(feed);
    expect(sections).toHaveLength(2);
    expect(sections[0].cards).toHaveLength(1);
    expect(sections[0].cards[0].type).toBe('playlist');
    expect(sections[0].cards[0].playlistId).toBe(7110294730);
    expect(sections[0].title).toBe('精选歌单');
    expect(sections[1].cards[0].type).toBe('function');
  });

  it('功能入口卡的封面支持对象形态', () => {
    const sections = mapFeed({
      v_shelf: [
        {
          v_niche: [
            {
              v_card: [
                {
                  type: 700,
                  id: '99',
                  title: '猜你喜欢',
                  cover: { default_url: 'http://qpic.y.qq.com/radio/600?n=1' },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(sections[0].cards[0].cover).toBe('https://qpic.y.qq.com/radio/600?n=1');
  });

  it('能从推荐流里找到每日 30 首的 disstid', () => {
    expect(findDailyPlaylistId(feed)).toBe(0);

    const withDaily = {
      v_shelf: [
        {
          v_niche: [
            {
              v_card: [{ title: '每日30首', id: 8899, miscellany: {} }],
            },
          ],
        },
      ],
    };
    expect(findDailyPlaylistId(withDaily)).toBe(8899);

    const withScheme = {
      v_shelf: [
        {
          v_niche: [
            {
              v_card: [{ title: '每日 30 首', scheme: 'qqmusic://x?disstid=7788&y=1' }],
            },
          ],
        },
      ],
    };
    expect(findDailyPlaylistId(withScheme)).toBe(7788);
  });
});

describe('歌词解析', () => {
  it('合并翻译、支持一行多时间戳与 offset', () => {
    const lrc = ['[ti:test]', '[offset:0]', '[00:01.00]第一行', '[00:02.50][00:03.00]第二行'].join('\n');
    const lines = parseLrc(lrc, '[00:02.50]翻译');
    expect(lines).toEqual([
      { time: 1, text: '第一行', trans: undefined },
      { time: 2.5, text: '第二行', trans: '翻译' },
      { time: 3, text: '第二行', trans: undefined },
    ]);
  });

  it('按时间定位当前行', () => {
    const lines = parseLrc('[00:01.00]a\n[00:05.00]b\n[00:09.00]c');
    expect(activeLineIndex(lines, 0)).toBe(-1);
    expect(activeLineIndex(lines, 1)).toBe(0);
    expect(activeLineIndex(lines, 6)).toBe(1);
    expect(activeLineIndex(lines, 100)).toBe(2);
    expect(activeLineIndex([], 10)).toBe(-1);
  });
});
