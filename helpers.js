const Path = require('path');
const URL = require('url');
const fs = require('fs-promise');
const _ = require('lodash');
const Debug = require('debug')
const utils = require('./utils')

exports.cacheToDisk = function cacheToDiskHelper(opts) {
  const debug = Debug('koa-ssr:helpers:cacheToDisk');

  if (!opts) {
    opts = {}
  }

  opts.parseUrl = opts.parseUrl || (url => URL.parse(url).pathname);
  opts.dir = opts.dir || '.ssr-cache';
  opts.filename = opts.filename || (url => Path.join(opts.dir, (_.kebabCase(url) || 'index') + '.html'));
  opts.invalidatePrevious = opts.invalidatePrevious || false;

  const cacheIndex = {};

  return function cacheToDisk(ctx, html, window, serialize) {
    debug({ 'ctx.url': ctx.url });
    const url = opts.parseUrl(ctx.url);
    debug({ url });
    const filename = opts.filename(url);
    debug({ filename });
    if (html) {
      debug('Caching...', { filename, html: html.substr(0, 10) })
      return fs.outputFile(filename, html).then(() => {
        cacheIndex[filename] = true;
        debug('cached')
        return html;
      });
    }
    if (cacheIndex[filename]) {
      ctx.type = 'html';
      debug('returning from cache...')
      return fs.createReadStream(filename)
        .once('error', () => {
          debug('cache invalidated')
          cacheIndex[filename] = false
        });
    }
    if (!opts.invalidatePrevious) {
      return fs.access(filename, fs.constants.R_OK).then(() => {
        debug('pre-existing in cache')
        cacheIndex[filename] = true;
        ctx.type = 'html';
        return fs.createReadStream(filename);
      }).catch(_.noop);
    }
  }
}
