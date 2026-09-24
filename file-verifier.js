// Checks that an upload is really an image by looking at its first bytes (not the extension),
// and reads the width/height from the header so huge images get rejected before decoding.
// No SVG on purpose since it can contain scripts.
(function () {
  'use strict';

  function UserFacingError(message, detail) {
    this.userMessage = message;
    this.detail = detail;
  }
  var MSG_NOT_PHOTO = "That file isn't a photo this page can use. Choose a JPEG, PNG, WebP, GIF, or HEIC image.";
  var MSG_DAMAGED = "That photo looks damaged and couldn't be read. Try a different one.";

  function readBytes(file, start, length) {
    var blob = file.slice(start, start + length);
    if (blob.arrayBuffer) return blob.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(new Uint8Array(fr.result)); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsArrayBuffer(blob);
    });
  }
  function u16be(b, i) { return (b[i] << 8) | b[i + 1]; }
  function u16le(b, i) { return b[i] | (b[i + 1] << 8); }
  function u24le(b, i) { return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16); }
  function u32be(b, i) { return ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]; }
  function i32le(b, i) { return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24); }
  function ascii(b, i, n) { return String.fromCharCode.apply(null, Array.prototype.slice.call(b, i, i + n)); }

  function jpegSize(file) {
    // walk the markers until we hit a SOF, that's where the size is
    var SOF = [0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF];
    var pos = 2, steps = 0;
    function next() {
      if (pos >= file.size || ++steps > 2000) return Promise.reject(new UserFacingError(MSG_DAMAGED, 'JPEG: no frame header'));
      return readBytes(file, pos, 9).then(function (b) {
        if (b.length < 4 || b[0] !== 0xFF) throw new UserFacingError(MSG_DAMAGED, 'JPEG: bad marker at ' + pos);
        var m = b[1];
        if (m === 0xFF) { pos += 1; return next(); }                       // fill byte
        if (SOF.indexOf(m) !== -1) {
          if (b.length < 9) throw new UserFacingError(MSG_DAMAGED, 'JPEG: short frame header');
          return { width: u16be(b, 7), height: u16be(b, 5) };
        }
        if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { pos += 2; return next(); } // no length
        if (m === 0xD9 || m === 0xDA) throw new UserFacingError(MSG_DAMAGED, 'JPEG: image data before frame header');
        var len = u16be(b, 2);
        if (len < 2) throw new UserFacingError(MSG_DAMAGED, 'JPEG: bad segment length');
        pos += 2 + len;
        return next();
      });
    }
    return next();
  }

  function isobmffSize(file) {
    // heic/avif keep the size in 'ispe' boxes, there can be a few so take the biggest
    return readBytes(file, 0, Math.min(file.size, 1048576)).then(function (b) {
      var best = null;
      for (var i = 4; i + 16 <= b.length; i++) {
        if (b[i] === 0x69 && b[i + 1] === 0x73 && b[i + 2] === 0x70 && b[i + 3] === 0x65) { // 'ispe'
          var w = u32be(b, i + 8), h = u32be(b, i + 12);
          if (!best || w * h > best.width * best.height) best = { width: w, height: h };
        }
      }
      if (!best) throw new UserFacingError(MSG_DAMAGED, 'HEIF/AVIF: no ispe box');
      return best;
    });
  }

  function inspectFile(file, maxPixels) {
    return readBytes(file, 0, 64).then(function (b) {
      if (b.length < 16) throw new UserFacingError(MSG_NOT_PHOTO, 'too short');

      // PNG
      if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && ascii(b, 12, 4) === 'IHDR') {
        return { format: 'png', width: u32be(b, 16), height: u32be(b, 20) };
      }
      // JPEG
      if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) {
        return jpegSize(file).then(function (s) { return { format: 'jpeg', width: s.width, height: s.height }; });
      }
      // GIF
      if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') {
        return { format: 'gif', width: u16le(b, 6), height: u16le(b, 8) };
      }
      // WebP
      if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
        var cc = ascii(b, 12, 4);
        if (cc === 'VP8X') return { format: 'webp', width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
        if (cc === 'VP8 ') return { format: 'webp', width: u16le(b, 26) & 0x3FFF, height: u16le(b, 28) & 0x3FFF };
        if (cc === 'VP8L') {
          return {
            format: 'webp',
            width: 1 + (b[21] | ((b[22] & 0x3F) << 8)),
            height: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0F) << 10))
          };
        }
        throw new UserFacingError(MSG_DAMAGED, 'WebP: unknown chunk ' + cc);
      }
      // BMP
      if (b[0] === 0x42 && b[1] === 0x4D) {
        return { format: 'bmp', width: Math.abs(i32le(b, 18)), height: Math.abs(i32le(b, 22)) };
      }
      // HEIC / AVIF
      if (ascii(b, 4, 4) === 'ftyp') {
        var brand = ascii(b, 8, 4);
        if (/^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1|avif|avis)$/.test(brand)) {
          return isobmffSize(file).then(function (s) { return { format: brand === 'avif' || brand === 'avis' ? 'avif' : 'heic', width: s.width, height: s.height }; });
        }
      }
      throw new UserFacingError(MSG_NOT_PHOTO, 'unrecognised signature');
    }).then(function (info) {
      checkPixels(info.width, info.height, maxPixels);
      return info;
    });
  }

  function checkPixels(w, h, maxPixels) {
    if (!(w > 0 && h > 0)) throw new UserFacingError(MSG_DAMAGED, 'zero or invalid size ' + w + 'x' + h);
    if (!(maxPixels > 0)) throw new Error('checkPixels: maxPixels must be a positive number');
    var mp = w * h;
    if (mp > maxPixels) {
      throw new UserFacingError(
        'That image is ' + w + ' x ' + h + ' pixels, which is over the ' +
        Math.round(maxPixels / 1e6) + '-megapixel limit. Choose a smaller photo.',
        'pixel limit: ' + w + 'x' + h);
    }
  }

  window.GoochemsFileVerifier = Object.freeze({
    inspectFile: inspectFile,
    checkPixels: checkPixels,
    UserFacingError: UserFacingError,
    MSG_NOT_PHOTO: MSG_NOT_PHOTO,
    MSG_DAMAGED: MSG_DAMAGED
  });
})();
