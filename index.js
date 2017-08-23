const assert = require('assert');
const Path = require('path');
const URL = require('url');
const JSDOM = require('jsdom');
const cheerio = require('cheerio');
const fs = require('fs-promise');
const _ = require('lodash');
const delay = require('promise-delay');
const Debug = require('debug')
const helpers = require('./helpers');
const utils = require('./utils');

const debug = Debug('koa-ssr');
const debugJSDOM = Debug('koa-ssr:jsdom');
const debugJSDOMClient = Debug('koa-ssr:jsdom-client');

const readFile = _.memoize(f => fs.readFile(f, 'utf8'));

module.exports = function koaSSRmiddleware(root, opts) {

  assert(root, 'root directory is required to serve files');

  if (!opts) {
    opts = {}
  }

  if (!opts.index && !opts.html) {
    opts.index = 'index.html'
  }

  if (opts.index) {
    opts.html = fs.readFileSync(Path.join(root, opts.index), 'utf8')
  }

  opts.timeout = opts.timeout || 5000;

  if ((!opts.cache && opts.cache !== false) || opts.cache === true) {
    opts.cache = {}
  }

  const inputHtmlDom = cheerio.load(opts.html);
  // Because JSDOM doesn't execute script with defer/async attribute: https://github.com/tmpvar/jsdom/issues?q=defer+OR+async
  const modifiedScriptTags = {};
  inputHtmlDom('body script').each((i, e) => {
    e = inputHtmlDom(e);
    if (e.attr('defer') || e.attr('async')) {
      modifiedScriptTags[e.attr('src')] = e.attr('defer') ? 'defer' : e.attr('async') ? 'async' : false;
      e.attr('defer', false)
      e.attr('async', false)
    }
  });
  debug({ modifiedScriptTags })

  const inputHtml = inputHtmlDom.html();
  debug({ inputHtml })

  opts.jsdom = opts.jsdom || {};

  if (opts.console && opts.jsdom.virtualConsole) {
    throw new Error('Provide either `opts.console` or `opts.jsdom.virtualConsole`, not both');
  }

  const JSDOMVirtualConsole = new JSDOM.VirtualConsole().sendTo(utils.createJSDOMVirtualConsole(opts.console || debugJSDOMClient, Boolean(opts.console)));

  opts.modulesLoadedEventLabel = 'onModulesLoaded'

  opts.render = opts.render || ((ctx, html) => ctx.body = html);

  if (opts.resourceLoader && opts.jsdom.resourceLoader) {
    throw new Error('Provide either `opts.resourceLoader` or `opts.jsdom.resourceLoader`, not both');
  }

  const defaultJSDOMResourceLoader = (res, cb) => {
    debugJSDOM('Loading resource (default):', res.url.pathname);
    readFile(Path.join(root, res.url.pathname))
      .then(asset => {
        debugJSDOM('Loaded resource (default):', res.url.pathname);
        cb(null, asset);
      })
      .catch(err => {
        debugJSDOM(`Couldn't load resource (default):`, res.url.pathname);
        cb(err)
      });
  };

  opts.resourceLoader = opts.resourceLoader || ((res, cb, def) => def(res, cb));

  const JSDOMResourceLoader = (res, cb) => opts.resourceLoader(res, cb, (_res, _cb) => {
    if (_cb && _cb !== cb) {
      debugJSDOM('default resourceLoader callback intercepted')
    }
    if (_res && !_cb) {
      debugJSDOM('Warning: opts.resourceLoader partially called `def` (no callback). Using default')
    }
    defaultJSDOMResourceLoader(_res || res, _cb || cb)
  });

  return async function koaSSR(ctx) {

    const fullUrl = ctx.protocol + '://' + ctx.host + ctx.originalUrl;
    debug({ fullUrl })


    if (opts.cache) {
      let cache
      if (typeof opts.cache === 'function') {
        cache = opts.cache(ctx)
      } else {
        cache = opts.cache[ctx.originalUrl]
      }

      if (cache && cache.then) {
        cache = await cache;
      }

      if (cache) {
        return opts.render(ctx, cache)
      }
    }

    debugJSDOM('Loading...')
    const startTime = new Date();
    const totalTime = () => (Date.now() - startTime) + 'ms';

    const dom = new JSDOM.JSDOM(opts.html, Object.assign({
      url: fullUrl,
      features: {
        FetchExternalResources: ['script', 'link', 'css'],
        QuerySelector: true,
      },
      resourceLoader: JSDOMResourceLoader,
      virtualConsole: JSDOMVirtualConsole,
    }, opts.jsdom, {
      beforeParse: window => {
        debugJSDOM('[beforeParse]')

        if (opts.jsdom.beforeParse) {
          opts.jsdom.beforeParse(window)
        }
      },
    }));
    debugJSDOM('loaded');

    // restore modifiedScriptTags (async/defer)
    for (const script of dom.window.document.querySelectorAll('script')) {
      const src = URL.parse(script.src).path;
      if (src in modifiedScriptTags) {
        script.setAttribute(modifiedScriptTags[src], true);
      }
    }
    debugJSDOM(`restored modifiedScriptTags`);

    let preCache = dom.serialize();
    debugJSDOM(`serialized preCache`);

    if (opts.preCache) {
      preCache = await utils.handleUserHtmlModification([opts.preCache, 'opts.preCache'], [ctx, preCache, dom])
    }

    let final;

    if (typeof opts.cache === 'function') {
      final = await utils.handleUserHtmlModification([opts.cache, 'opts.cache'], [ctx, preCache, dom])
    }

    final = final || preCache;

    if (typeof opts.cache === 'object') {
      opts.cache[ctx.originalUrl] = final;
      debug(`cached to memory`, ctx.originalUrl, 'total', Object.keys(opts.cache).length);
    }

    debug(`final opts.render in`, totalTime());

    return opts.render(ctx, final, dom);
  }
}

Object.assign(exports, helpers);
