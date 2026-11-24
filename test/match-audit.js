// 离线体检：拿本机 D:\SMX-音乐 的真实曲目，跑一遍桌面版同一套联网匹配（封面 + 歌词），
// 统计命中率并打印失败清单，用来定位"很多歌匹配不到"到底卡在哪一环。
// 用法：node match-audit.js [样本数] [曲库目录]
'use strict';
const fs = require('fs');
const path = require('path');
const online = require(path.join('E:\\AI相关\\工作目录-个人\\20261115-MusicSMX-重置版\\src\\online.js'));

const LIMIT = parseInt(process.argv[2] || '40', 10);

// --- 极简 ID3v2 读取（只取 TIT2/TPE1/TALB，够用就行） ---
function decodeId3Text(buf) {
  // 1=utf16, 2=utf16be, 3=utf8, 0=latin1
  const enc = buf[0];
  let body = buf.slice(1);
  if (enc === 1 || enc === 2) {
    if (enc === 1) { // utf16 + BOM
      const bom = body.slice(0, 2).toString('hex');
      body = bom === 'fffe' ? body.slice(2) : body;
      let s = '';
      for (let i = 0; i + 1 < body.length; i += 2) s += String.fromCharCode(body.readUInt16BE(i));
      // 处理代理对
      try { s = Buffer.from(body).toString(enc === 1 && bom !== 'fffe' ? 'utf16le' : 'utf16le'); } catch (e) {}
      return s.replace(/\u0000/g, '').trim();
    }
    return Buffer.from(body).toString('utf16be').replace(/\u0000/g, '').trim();
  }
  if (enc === 3) return body.toString('utf8').replace(/\u0000/g, '').trim();
  return body.toString('latin1').replace(/\u0000/g, '').trim();
}

function readTags(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(10);
    fs.readSync(fd, head, 0, 10, 0);
    if (head.slice(0, 3).toString('latin1') !== 'ID3') { fs.closeSync(fd); return {}; }
    const ver = head[3];
    const flags = head[5];
    const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 10);
    fs.closeSync(fd);

    const out = {};
    let pos = 0;
    if (flags & 0x40) { // 扩展头
      const extLen = ver >= 4
        ? ((buf[0] & 0x7f) << 21 | (buf[1] & 0x7f) << 14 | (buf[2] & 0x7f) << 7 | (buf[3] & 0x7f))
        : buf.readUInt32BE(0) + 4;
      pos = extLen;
    }
    const idLen = ver >= 3 ? 4 : 3;
    const headLen = ver >= 3 ? 10 : 6;
    while (pos + headLen < buf.length) {
      const id = buf.slice(pos, pos + idLen).toString('latin1');
      if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
      let fsize;
      if (ver >= 4) {
        fsize = ((buf[pos + 4] & 0x7f) << 21) | ((buf[pos + 5] & 0x7f) << 14) | ((buf[pos + 6] & 0x7f) << 7) | (buf[pos + 7] & 0x7f);
      } else {
        fsize = buf.readUInt32BE(pos + 4);
      }
      const data = buf.slice(pos + headLen, pos + headLen + fsize);
      if (id === 'TIT2') out.title = decodeId3Text(data);
      else if (id === 'TPE1') out.artist = decodeId3Text(data);
      else if (id === 'TALB') out.album = decodeId3Text(data);
      pos += headLen + fsize;
    }
    return out;
  } catch (e) {
    return {};
  }
}

function guessFromName(file) {
  const base = path.basename(file).replace(/\.(mp3|flac|m4a|ogg|wav)$/i, '')
    .replace(/^\d{1,3}[\.\-_\s]+/, '');
  // 与安卓端 guessFromName 同步：优先按「空格 - 空格」切，三段即 歌手/标题/专辑
  const parts = base.split(/\s+[-－—]\s+/);
  if (parts.length >= 3) return { artist: parts[0].trim(), title: parts[1].trim(), album: parts[2].trim() };
  if (parts.length === 2) return { artist: parts[0].trim(), title: parts[1].trim() };
  return { title: base.trim() };
}

(async function main() {
  const roots = ['D:\\SMX-音乐'];
  let files = [];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(mp3|flac|m4a|ogg|wav)$/i.test(e.name)) files.push(p);
      }
    };
    walk(r);
  }
  // 均匀抽样，覆盖各个子目录
  files.sort();
  const step = Math.max(1, Math.floor(files.length / LIMIT));
  const sample = files.filter((_, i) => i % step === 0).slice(0, LIMIT);

  const results = [];
  for (const f of sample) {
    const tags = readTags(f);
    let artist = tags.artist || '';
    let title = tags.title || '';
    if (!title || !artist) {
      const g = guessFromName(f);
      artist = artist || g.artist || '';
      title = title || g.title || '';
    }
    let cover = null, lyrics = null, err = '';
    try { cover = await online.searchCover(artist, title); } catch (e) { err += 'cover:' + e.message + ' '; }
    try { lyrics = await online.searchLyrics(artist, title, 0); } catch (e) { err += 'lyrics:' + e.message; }
    results.push({
      file: path.basename(f),
      artist, title,
      cover: !!(cover && cover.url), coverFrom: cover && cover.source,
      lyrics: !!(lyrics && lyrics.lrc), lyricsFrom: lyrics && lyrics.source, lyricsName: lyrics && lyrics.songName,
      err
    });
  }

  const okCover = results.filter(r => r.cover).length;
  const okLyric = results.filter(r => r.lyrics).length;
  console.log(JSON.stringify({
    sample: results.length,
    coverOk: okCover, coverFail: results.length - okCover,
    lyricOk: okLyric, lyricFail: results.length - okLyric
  }, null, 0));
  console.log('--- 失败明细 ---');
  for (const r of results) {
    if (r.cover && r.lyrics) continue;
    console.log([
      r.cover ? 'C+' : 'C-', r.lyrics ? 'L+' : 'L-',
      JSON.stringify(r.artist), JSON.stringify(r.title), '|', r.file, r.err || ''
    ].join(' '));
  }
  console.log('--- 全部（抽查命中质量）---');
  for (const r of results) console.log([r.cover ? 'C+' : 'C-', r.lyrics ? 'L+' : 'L-', JSON.stringify(r.artist), JSON.stringify(r.title), '->', r.lyricsName || ''].join(' '));
})();
