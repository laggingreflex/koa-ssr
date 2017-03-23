const URL = require('url');
const fs = require('fs-promise');
const _ = require('lodash');

exports.cacheToDisk = function cacheToDiskHelper(opts) {
  if (!opts) {
    opts = {}
  }

  opts.parseUrl = opts.parseUrl || (url => URL.parse(url).path) || 'home';
  opts.filename = opts.filename || (url => '.cache/' + _.kebabCase(url));

  const cacheIndex = {};

  return function cacheToDisk(ctx, html) {
    const url = opts.parseUrl(ctx.url);
    const filename = opts.filename(url);
    if (html) {
      return fs.outputFile(filename, html).then(() => {
        cacheIndex[filename] = true;
        return html;
      });
    }
    if (cacheIndex[filename]) {
      ctx.type = 'html';
      return fs.createReadStream(filename);
    }
    return fs.access(filename, fs.constants.R_OK).then(() => {
      cacheIndex[filename] = true;
      ctx.type = 'html';
      return fs.createReadStream(filename);
    }).catch(_.noop);
  }
}
